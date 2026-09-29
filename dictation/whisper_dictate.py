#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
whisper_dictate.py — local dictation helper for the "New conversation" prompt boxes.

WHY A PROCESS OF ITS OWN: a VS Code webview cannot open the microphone
(getUserMedia is refused, microsoft/vscode#250568 and #113916). The extension
host therefore spawns this helper, which captures the microphone itself
(sounddevice) and transcribes locally with faster-whisper. Nothing leaves the
machine: no network call, no audio written to disk.

PROTOCOL — one JSON object per line, both ways.
  stdin   {"cmd": "start", "id": N}    open the microphone, start a dictation
          {"cmd": "stop", "id": N}     close it, transcribe what is left, then "done"
          {"cmd": "cancel", "id": N}   close it, drop everything, then "done"
  stdout  {"ev": "listening", "id"}              microphone open
          {"ev": "level", "id", "v": 0..1}        input level (~10/s), for the meter
          {"ev": "interim", "id", "text"}         sentence in progress (replaces the previous interim)
          {"ev": "final", "id", "text"}           sentence frozen (replaces the interim)
          {"ev": "done", "id"}                    nothing more will come for this id
          {"ev": "error", "id", "code", "message"}  code: mic-denied | mic-error | engine-missing | engine-error
  Test mode, no microphone: `whisper_dictate.py --file sample.wav` runs the same
  pipeline on a 16 kHz mono WAV and prints the same events.

"IT WRITES WHILE YOU SPEAK" without a streaming engine: the sentence in progress
is re-transcribed every ~1.5 s (beam 1) and REPLACES the interim; a silence
freezes it (full beam) and starts a new segment — so only the current sentence
is ever re-transcribed, whatever the length of the dictation.
Sentences are cut by the Silero voice detector bundled with faster-whisper,
never by a volume threshold: a desk microphone with no automatic gain does not
cross a fixed threshold reliably, Silero recognises speech itself.

Guards against Whisper's known inventions on short or empty audio (measured on
the dictation this helper is modelled on):
  - a segment is only frozen once it holds >= MIN_VOICE_S of speech — a shorter
    one does not constrain the decoder, which then fills in;
  - the vocabulary goes through `hotwords`, never `initial_prompt` (the decoder
    CONTINUES a prompt instead of transcribing), and not at all under
    HOTWORDS_MIN_S of speech (it recites the list);
  - no_repeat_ngram_size=3, temperature 0, plus filters for memorised subtitle
    credits and letter-less segments.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import queue
import re
import site
import sys
import threading
import time

RATE = 16000
BLOCK_S = 0.05              # capture block: 50 ms
TICK_S = 1.5                # interim cadence (audio time)
CHECK_S = 0.4               # how often the voice detector re-reads the segment
SILENCE_S = 1.0             # trailing silence that freezes a sentence
MIN_VOICE_S = 1.2           # speech needed before a sentence may be frozen
SEG_MAX_S = 12.0            # safety valve: freeze anyway past this length
HOTWORDS_MIN_S = 1.0        # under this much speech, no vocabulary is whispered
LEVEL_EVERY_S = 0.1
# Proper nouns a coding prompt is full of. Correct spelling only: the model
# copies the form it is given.
HOTWORDS = ("Claude, Claude Code, VS Code, Opus, Sonnet, Haiku, QuotaSaver, GitHub, "
            "JavaScript, TypeScript, Python, Node, npm, JSON, API, CSS, HTML, webview")

_out_lock = threading.Lock()


def emit(ev: str, **fields) -> None:
    line = json.dumps(dict(ev=ev, **fields), ensure_ascii=True)
    with _out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


# ---- Engine ------------------------------------------------------------------

def _cuda_dlls() -> None:
    """The CUDA DLLs installed by pip (nvidia-cublas-cu12 / nvidia-cudnn-cu12) sit
    in no PATH folder, and ctranslate2.dll loads them through the system loader,
    which ignores os.add_dll_directory() — hence "cublas64_12.dll is not found".
    The process PATH is honoured: prepend the site-packages/nvidia/*/bin folders
    (both site-packages: system and user)."""
    if os.name != "nt":
        return
    roots = list(site.getsitepackages()) + [site.getusersitepackages()]
    dirs = [d for r in roots for d in glob.glob(os.path.join(r, "nvidia", "*", "bin")) if os.path.isdir(d)]
    if dirs:
        os.environ["PATH"] = os.pathsep.join(dirs) + os.pathsep + os.environ.get("PATH", "")
        for d in dirs:
            try:
                os.add_dll_directory(d)
            except OSError:
                pass


class Engine:
    """faster-whisper large-v3-turbo, GPU first, CPU int8 if the GPU refuses — a
    slow dictation beats a dead microphone. Loaded once, in the background, so
    the microphone opens at the first click while the model is still loading."""

    def __init__(self, language: str, model: str):
        self.language = language or None
        self.model_name = model
        self.model = None
        self.error = None
        self.ready = threading.Event()
        threading.Thread(target=self._load, daemon=True).start()

    def _load(self) -> None:
        try:
            _cuda_dlls()
            from faster_whisper import WhisperModel
            from faster_whisper.vad import VadOptions, get_speech_timestamps
            self._vad, self._vad_opts = get_speech_timestamps, VadOptions(min_silence_duration_ms=300)
            try:
                self.model = WhisperModel(self.model_name, device="cuda", compute_type="float16")
            except Exception:  # noqa: BLE001 — any GPU failure falls back to CPU
                self.model = WhisperModel(self.model_name, device="cpu", compute_type="int8")
        except ImportError as exc:
            self.error = ("engine-missing", f"{exc} (pip install --user faster-whisper)")
        except Exception as exc:  # noqa: BLE001
            self.error = ("engine-error", f"{type(exc).__name__}: {exc}")
        self.ready.set()

    def speech(self, audio):
        """Speech spans of `audio`, in seconds: [(start, end), ...]."""
        spans = self._vad(audio, self._vad_opts, sampling_rate=RATE)
        return [(s["start"] / RATE, s["end"] / RATE) for s in spans]

    def transcribe(self, audio, partial: bool, voice_s: float) -> str:
        segments, _info = self.model.transcribe(
            audio, language=self.language,
            beam_size=1 if partial else 5,
            vad_filter=True,
            condition_on_previous_text=False,
            hotwords=HOTWORDS if voice_s >= HOTWORDS_MIN_S else None,
            no_repeat_ngram_size=3,
            temperature=[0.0],
            log_prob_threshold=-0.7,
        )
        kept = [s.text.strip() for s in segments]
        kept = [t for t in kept if t and not _RE_CREDITS.match(t) and any(c.isalpha() for c in t)]
        return _anti_loop(" ".join(kept).strip())


# Subtitle credits Whisper learnt by heart and lays on a swallowed sentence end
# with full confidence (no_speech_prob 0.000): only a pattern catches them. The
# WHOLE segment must be the credit — a sentence merely containing the word passes.
_RE_CREDITS = re.compile(r"^\W*(?:sous[-\s]?titr\w*\b.*|subtitles? by\b.*|.*\bamara\.org\b.*|[♪♫\s]+)\W*$",
                         re.IGNORECASE | re.UNICODE)
_RE_WORD = re.compile(r"\w+", re.UNICODE)


def _anti_loop(text: str) -> str:
    """Last curtain against a stuttering decoder: an immediate repetition of the
    same word beyond two is cut ("very very good" survives, "X, X, X, X" does not)."""
    cuts, run, prev, kept_end = [], 0, None, 0
    for m in _RE_WORD.finditer(text):
        low = m.group(0).lower()
        run = run + 1 if low == prev else 1
        prev = low
        if run <= 2:
            kept_end = m.end()
            continue
        if cuts and cuts[-1][0] <= kept_end <= cuts[-1][1]:
            cuts[-1][1] = m.end()
        else:
            cuts.append([kept_end, m.end()])
    for a, b in reversed(cuts):
        text = text[:a] + text[b:]
    return text.strip()


# ---- Dictation pipeline ------------------------------------------------------

class Dictation:
    """One dictation, fed audio blocks. Everything is measured in AUDIO time, so
    the same code runs live and on a file (the test bench)."""

    def __init__(self, engine: Engine, did):
        import numpy as np
        self.np = np
        self.engine, self.id = engine, did
        self.seg = np.zeros(0, dtype=np.float32)
        self.since_check = 0.0
        self.since_interim = 0.0
        self.interim = ""
        self.speech_s = 0.0

    def _secs(self, a) -> float:
        return len(a) / RATE

    def feed(self, block, backlog_s: float = 0.0) -> None:
        self.seg = self.np.concatenate([self.seg, block])
        dt = self._secs(block)
        self.since_check += dt
        self.since_interim += dt
        if self.since_check < CHECK_S or not self.engine.ready.is_set() or self.engine.model is None:
            return
        self.since_check = 0.0
        seg_s = self._secs(self.seg)
        spans = self.engine.speech(self.seg)
        if not spans:
            # Nothing said yet: keep only the last second, never accumulate silence.
            if seg_s > 3.0:
                self.seg = self.seg[-RATE:]
            return
        self.speech_s = sum(e - s for s, e in spans)
        tail = seg_s - spans[-1][1]
        if tail >= SILENCE_S and (self.speech_s >= MIN_VOICE_S or seg_s > SEG_MAX_S):
            self._freeze()
        elif seg_s > SEG_MAX_S + 8:
            self._freeze()            # speech without a pause for 20 s: freeze anyway
        elif self.since_interim >= TICK_S and backlog_s < 1.0:
            # Behind the microphone by more than a second: skip the interim and
            # catch up — the sentence will be frozen with the full beam anyway.
            self.since_interim = 0.0
            text = self.engine.transcribe(self.seg, True, self.speech_s)
            if text and text != self.interim:
                self.interim = text
                emit("interim", id=self.id, text=text)

    def _freeze(self) -> None:
        text = self.engine.transcribe(self.seg, False, self.speech_s)
        if text or self.interim:
            emit("final", id=self.id, text=text)
        self.seg = self.np.zeros(0, dtype=self.np.float32)
        self.interim, self.speech_s, self.since_interim = "", 0.0, 0.0

    def finish(self) -> None:
        """Stop pressed: what is left is transcribed whatever its length — a short
        utterance is still what the user said."""
        self.engine.ready.wait()
        if self.engine.model is None or not len(self.seg):
            if self.interim:
                emit("final", id=self.id, text="")
            return
        spans = self.engine.speech(self.seg)
        if not spans:
            if self.interim:
                emit("final", id=self.id, text="")
            return
        self.speech_s = sum(e - s for s, e in spans)
        self._freeze()


# ---- Microphone --------------------------------------------------------------

def _windows_denies_mic() -> bool:
    """Windows privacy settings refusing desktop apps the microphone. Read only:
    the helper never changes anything on the system."""
    if os.name != "nt":
        return False
    try:
        import winreg
    except ImportError:
        return False
    base = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone"
    for hive, key in ((winreg.HKEY_LOCAL_MACHINE, base), (winreg.HKEY_CURRENT_USER, base),
                      (winreg.HKEY_CURRENT_USER, base + r"\NonPackaged")):
        try:
            with winreg.OpenKey(hive, key) as k:
                if str(winreg.QueryValueEx(k, "Value")[0]).lower() == "deny":
                    return True
        except OSError:
            pass
    return False


MIC_DENIED = "Windows privacy settings do not let desktop apps use the microphone."


class Mic:
    """Live dictations. The capture callback only queues blocks and reports the
    level; transcription runs in one worker thread, so the microphone keeps
    recording while the GPU works (no word is lost between two sentences)."""

    def __init__(self, engine: Engine):
        self.engine = engine
        self.stream = None
        self.current = None           # state of the dictation in progress

    def start(self, did) -> None:
        if self.current is not None:
            self.stop(self.current["id"], cancel=False)
        if self.engine.ready.is_set() and self.engine.error:
            code, msg = self.engine.error
            emit("error", id=did, code=code, message=msg)
            emit("done", id=did)
            return
        if _windows_denies_mic():
            emit("error", id=did, code="mic-denied", message=MIC_DENIED)
            emit("done", id=did)
            return
        try:
            import numpy as np
            import sounddevice as sd
        except ImportError as exc:
            emit("error", id=did, code="engine-missing", message=f"{exc} (pip install --user sounddevice)")
            emit("done", id=did)
            return
        state = {"id": did, "cancel": False, "last_level": 0.0, "nonzero": False, "t0": time.time(),
                 "rate": RATE}
        q: queue.Queue = queue.Queue()
        state["q"] = q

        def callback(indata, _frames, _time, _status):
            block = indata[:, 0].copy()
            if state["rate"] != RATE:     # device refused 16 kHz: linear resampling
                n = int(round(len(block) * RATE / state["rate"]))
                block = np.interp(np.linspace(0, len(block) - 1, n), np.arange(len(block)), block).astype(np.float32)
            q.put(block)
            peak = float(np.abs(block).max()) if len(block) else 0.0
            if peak > 0:
                state["nonzero"] = True
            now = time.time()
            if now - state["last_level"] >= LEVEL_EVERY_S:
                state["last_level"] = now
                emit("level", id=did, v=round(min(1.0, peak * 4), 2))

        stream = None
        for rate in (RATE, None):
            try:
                if rate is None:
                    rate = int(sd.query_devices(kind="input")["default_samplerate"])
                state["rate"] = rate
                stream = sd.InputStream(samplerate=rate, channels=1, dtype="float32",
                                        blocksize=int(rate * BLOCK_S), callback=callback)
                stream.start()
                break
            except Exception as exc:  # noqa: BLE001
                stream = None
                err = exc
        if stream is None:
            code = "mic-denied" if _windows_denies_mic() else "mic-error"
            emit("error", id=did, code=code, message=MIC_DENIED if code == "mic-denied" else str(err))
            emit("done", id=did)
            return
        self.stream, self.current = stream, state
        emit("listening", id=did)
        threading.Thread(target=self._work, args=(state, q), daemon=True).start()

    def _work(self, state, q) -> None:
        did = state["id"]
        dic = Dictation(self.engine, did)
        warned = False
        try:
            while True:
                block = q.get()
                if block is None:
                    break
                if state["cancel"]:
                    continue
                if not state["nonzero"] and not warned and time.time() - state["t0"] > 2.0:
                    # Two seconds of exact zeros: the device delivers nothing —
                    # typically the privacy switch, sometimes a muted input.
                    warned = True
                    emit("error", id=did, code="mic-denied" if _windows_denies_mic() else "mic-error",
                         message=MIC_DENIED if _windows_denies_mic()
                         else "The microphone delivers only silence (muted, or used exclusively by another app?).")
                dic.feed(block, backlog_s=q.qsize() * BLOCK_S)
            if not state["cancel"]:
                if self.engine.ready.is_set() and self.engine.error:
                    code, msg = self.engine.error
                    emit("error", id=did, code=code, message=msg)
                else:
                    dic.finish()
        except Exception as exc:  # noqa: BLE001
            emit("error", id=did, code="engine-error", message=f"{type(exc).__name__}: {exc}")
        emit("done", id=did)

    def stop(self, did, cancel: bool) -> None:
        state = self.current
        if state is None or state["id"] != did:
            return
        self.current = None
        state["cancel"] = cancel
        try:
            self.stream.stop()
            self.stream.close()
        except Exception:  # noqa: BLE001
            pass
        self.stream = None
        # The worker drains what the callback already queued, then finishes.
        # It is not joined here: stdin keeps being read (a new "start" may come).
        state["q"].put(None)


def run_stdin(engine: Engine) -> None:
    mic = Mic(engine)
    for line in sys.stdin:
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        cmd, did = msg.get("cmd"), msg.get("id")
        if cmd == "start":
            mic.start(did)
        elif cmd in ("stop", "cancel"):
            mic.stop(did, cancel=(cmd == "cancel"))
    # stdin closed = the extension host is gone: close the microphone.
    if mic.current is not None:
        mic.stop(mic.current["id"], cancel=True)


def run_file(engine: Engine, path: str) -> None:
    """Test bench: the same pipeline, fed from a WAV file at full speed."""
    import wave
    import numpy as np
    with wave.open(path, "rb") as w:
        if w.getframerate() != RATE or w.getnchannels() != 1 or w.getsampwidth() != 2:
            emit("error", id=0, code="engine-error", message="test WAV must be 16 kHz mono 16-bit")
            return
        audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    engine.ready.wait()
    if engine.error:
        emit("error", id=0, code=engine.error[0], message=engine.error[1])
        return
    dic = Dictation(engine, 0)
    step = int(RATE * BLOCK_S)
    for i in range(0, len(audio), step):
        dic.feed(audio[i:i + step])
    dic.finish()
    emit("done", id=0)


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--language", default="")
    ap.add_argument("--model", default="large-v3-turbo")
    ap.add_argument("--file", default="")
    args = ap.parse_args()
    engine = Engine(args.language, args.model)
    if args.file:
        run_file(engine, args.file)
    else:
        run_stdin(engine)
    # Leave WITHOUT tearing the model down: on Windows + CUDA, the CUDA DLLs'
    # unload crashes the process with 0xC0000409 after a successful
    # transcription (SYSTRAN/faster-whisper#1293, measured here with 1.2.1 —
    # os._exit still unloads them). Everything has been emitted; the exit code
    # must say so, hence TerminateProcess, which skips the DLL detach.
    sys.stdout.flush()
    if os.name == "nt":
        import ctypes
        k32 = ctypes.windll.kernel32
        k32.GetCurrentProcess.restype = ctypes.c_void_p
        k32.TerminateProcess(ctypes.c_void_p(k32.GetCurrentProcess()), 0)
    os._exit(0)


if __name__ == "__main__":
    main()
