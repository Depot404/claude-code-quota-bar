# Changelog

## [2.13.1] - 2026-07-22

### Fixed
- **The spinner no longer keeps turning after you interrupt a conversation.** Pressing Stop (or Esc) fires no hook at all — the Stop hook does not run on a user interrupt, by design (anthropics/claude-code#45289) — so the `busy` state set by `UserPromptSubmit` was never cleared and the conversation kept spinning until it aged into `stale` after 5 minutes. The state engine now reads the interruption straight from the transcript (the `[Request interrupted by user…]` user message Claude Code writes there) and drops the row to `idle` at once, the same way it already reads `AskUserQuestion`/`ExitPlanMode`. It flips back to `busy` on its own as soon as you send the next prompt.
- **The model name no longer blanks out to `—` mid-conversation.** The last-assistant lookup only reads the final 64 KB of the transcript; a single oversized `tool_result` in the tail (a base64 screenshot, a large file read, a long command output) pushes the last assistant message out of that window, and both the model and the ctx% vanished until an assistant message came back into range. The reader now remembers the last known model/ctx per conversation and keeps showing it instead of clearing it. (The very first moment of a brand-new conversation, before any assistant reply exists, still shows `—` for a second or two — there is nothing to remember yet.)
- **Opening a question no longer steals your keyboard focus.** When a conversation turned to `waiting`/`done`, the event-driven quota refresh would, if the cached claude.ai cookie was stale, launch Brave to re-extract it — and a spawning browser window grabs the foreground for ~230 ms (measured), cutting you off mid-typing. Brave is now started with `--no-startup-window`: the process and its DevTools endpoint come up with no window at all (cookie extraction is browser-level and works without one — verified), so nothing takes the foreground. A circuit breaker also stops re-launching Brave on every fetch when the refresh keeps failing (e.g. the configured Brave profile isn't logged into claude.ai): it falls back to the OAuth token and only retries the browser path after an hour, or immediately on a manual **Refresh**.

## [2.13.0] - 2026-07-19

### Fixed
- **The highlighted conversation now follows the selected tab.** The highlight was driven by `~/.claude/active-session.json` — the conversation that last *received a prompt* — so clicking another Claude tab (in the editor, or via the panel itself) never moved it, and it routinely sat on the wrong row. The tab tracker now remembers the last selected Claude tab of each window (`onDidChangeTabs` for switches inside a group, `onDidChangeTabGroups` for switches between groups) and the snapshot highlights the matching conversation instead. Selecting a non-Claude tab (a file) keeps the last conversation highlighted rather than clearing it. `active-session.json` survives only as a fallback for a window where no Claude tab was ever selected; an active tab whose label matches no listed conversation highlights nothing rather than falling back to a wrong row. The highlight is per-window — each window's panel shows what *that* window is looking at.

## [2.12.7] - 2026-07-17

### Changed
- **Last French example in the README replaced.** `Implémenter lot 4 burn-r…` — a real conversation title from the author's machine, used as the tab-truncation example in an otherwise English document — is now `Refactor auth middlewar…`, matching the screenshot's mock data. Textual survivor of the same problem as the screenshots in 2.12.6.

## [2.12.6] - 2026-07-17

### Changed
- **All screenshots replaced with a single mock-data one.** Every previous screenshot was a real capture of the author's own machine: real conversation titles, in French, on a light theme — published on a public listing page. The listing now carries one image built from mock English conversations (`images/screenshot.png`), on the dark theme, showing **all five states at once** (working, waiting for you, done-unread with the bright ✓, done-read with the dimmed one, stale) above the three quota bars in red/yellow/green with their ▲ pace markers. The old captures (`screenshot-dark-burnrate.png`, `screenshot-states-illustrated.png`) are gone, and their README sections read fine without them.

## [2.12.5] - 2026-07-17

### Fixed
- **Sounds toggle was silently useless without the hooks.** Flagged by the user reviewing the public listing: a Marketplace install that enables 🔊 but never runs **Claude Convs: Install Hooks** would see every conversation stuck at `idle` forever (README § Setup) and therefore never hear anything — nothing told them why. Enabling the toggle (via the icon, or a pre-set `true` found at startup — settings synced from another machine, hand-edited `settings.json`) now checks for `~/.claude/scripts/hook-session-state.js` (the hooks' own marker file) and, if missing, shows a one-time warning offering **Install hooks** / **Enable anyway** / **Turn sounds back off**. Same dismissal style as the existing accessibility-signals conflict prompt — never re-asked once accepted, and moot anyway the moment the hooks actually get installed.

## [2.12.4] - 2026-07-17

### Changed
- **Marketplace listing copy rewritten** after checking what competing Claude Code quota/usage extensions actually offer (Clusage, Claude Quota Tracker, ClaudeProUsage, Claude Code and Codex Assist — all status-bar quota monitors or past-session viewers; none show live per-conversation state, none focus a VS Code window on click, none play distinct done/waiting sounds, none colour quota by projected pace rather than a flat %-used threshold). README hook, `package.json` description and `keywords` updated to lead with those three verified differentiators instead of a feature list.
- **Two new screenshots.** `images/screenshot-dark-burnrate.png` (real capture, dark theme, a genuine red 90%-pace 5h window next to a green 7d one — added to the Burn-rate colouring section) and `images/screenshot-states-illustrated.png` (all five conversation states — busy/waiting/done unread/done read/stale — side by side with mock conversation titles, since no real workspace has all five at once; built from the panel's actual CSS so the styling is real even though the data is a demo, labelled as such in the caption — added to the Conversation state engine section).

## [2.12.3] - 2026-07-16

### Changed
- **`done` sound switched to `ding.wav`.** The user A/B-tested `Windows Ding.wav`, `Windows Notify.wav`, `chimes.wav`, and `ding.wav` against the actual PC speakers and picked `ding.wav` — the shortest/lightest of the set. Played via `System.Media.SoundPlayer(...).PlaySync()` (synchronous, no `Start-Sleep` needed) instead of `SystemSounds.Asterisk`. `waiting` (`SystemSounds.Exclamation`) unchanged.

## [2.12.2] - 2026-07-16

### Fixed
- **Sounds were still silent after 2.12.1**: `detached: true` on the spawn starves powershell.exe of a console on Windows — the process dies in ~150 ms (exit 0) without ever running the command, sleep or not (measured; without `detached` the same spawn lives its full ~1.6 s and plays). Option removed — same recipe as `focus.js`/raiseWindow, which never had the problem. Root-caused by process-watching a real end-of-turn: the claim was written, no powershell ever appeared.
- `package.json` `displayName` and two setting descriptions had their em-dashes mojibake'd (`â€”`) by the 2.12.1 release tooling (PowerShell 5.1 `Get-Content` reads BOM-less UTF-8 as ANSI). Restored.

## [2.12.1] - 2026-07-16

### Fixed
- **Notification sounds were completely silent.** `SystemSound.Play()` is asynchronous (PlaySound `SND_ASYNC`): the hidden PowerShell exited right after the call, killing playback before it started. The spawned command now sleeps 1.5 s after `Play()` — the process is detached and fire-and-forget, so the sleep blocks nothing.

## [2.12.0] - 2026-07-16

### Added
- **`claudeCodeQuotaBar.braveUserDataDir` setting** (default empty). The cookie-based quota fetch path no longer hardcodes `C:\OctopusData\BraveOctopus`: with the setting empty (the marketplace default), that path is skipped cleanly — no browser spawn attempt, no error — and the OAuth fallback is used directly. Set it to a Brave user-data directory with a `claude.ai` session logged in to restore the faster path.
- **`Claude Convs: Install Hooks` command.** Deploys the hooks (`install.ps1`, bundled in the extension) after a modal confirmation listing exactly what gets written (`~/.claude/scripts/`, a `~/.claude/settings.json` backup + additions) — no silent writes outside the extension folder. The panel already worked without hooks (every conversation shown as `idle`); this makes turning on live state a one-click, consent-gated action instead of a manual `.ps1` run.
- README: Requirements/Configuration/Privacy sections rewritten for a marketplace audience — what works with zero config vs. what's opt-in and degrades cleanly, a real screenshot of the panel, and the previously-undocumented `quota-org-id.json`/`quota-brave-pid.json`/`sessions-state.json` privacy entries.

### Changed
- `.vscodeignore`: excluded `test-cdp-fetch.mjs` (a standalone dev script against Brave principal's port 9222, unrelated to the shipped extension) from the packaged `.vsix`.
- `PUBLISH.md` refreshed: the GitHub repo step now comes before the Marketplace publisher step (the README screenshot needs it to render on the listing page), and the stale "status bar" description from the pre-2.0 architecture is gone.

## [2.11.0] - 2026-07-16

### Added
- **Tab detection drift canary.** Every tab↔conversation match (click-to-focus, tab-close removal, read receipts) depends on the official extension's `viewType` staying `claudeVSCodePanel*` — if it's ever renamed, those paths degrade silently, without an exception anywhere. A conversation `busy`/`waiting` with zero Claude tabs detected for over ~2 minutes now logs a warning and shows a small, non-modal `⚠ Claude tabs not detected` line under the conversation list; it clears the moment a tab is seen again.
- **Quota fetch dedup across VS Code windows.** N windows watching the same workspace used to each poll and event-fetch independently against the shared `usage-cache.json`, multiplying calls to `claude.ai` for the same number. A fetch (poll or event-driven) is now skipped if the shared cache was refreshed by any window less than 30 s ago — the panel still updates from that cache. The **Refresh Now** command and the panel's **Refresh** link always force a real fetch regardless, since that's an explicit ask.
- README: documented the `quota-session-key.json` clear-text `sessionKey` cookie under Privacy (same trust level as `.credentials.json`), and the dated failure modes of the "1M context" and "interactive tool" heuristics under Known limitations.

## [2.10.0] - 2026-07-16

### Added
- **Notification sounds**: a system sound plays when a conversation finishes replying (`done`) or hands control back to you (`waiting` — a question, a permission prompt), useful when the panel isn't on screen. **Off by default**, toggled from the new 🔈/🔊 icon at the top of the panel or `claudeCodeQuotaBar.sounds.enabled`. Played from the extension host via a detached, hidden PowerShell (`SystemSounds.Asterisk`/`Exclamation`) — never from the webview, whose JS is suspended exactly when the sound would be needed. Debounced (~2.5 s) against the same Stop-hook-with-feedback rebound the state engine itself corrects, so a turn that isn't really over never rings. Deduplicated across every VS Code window watching the same workspace via a claimed entry in `~/.claude/sound-claims.json` (same lock as `sessions-state.json`, pruned after 24 h like it). See README § Sounds.
- The first time the toggle turns on with VS Code's own `accessibility.signals.chatResponseReceived`/`chatUserActionRequired` set to `sound: "on"`, a one-time prompt offers to turn those off to avoid a double ring; the choice is remembered and never asked again.

## [2.9.0] - 2026-07-16

### Fixed
- **A conversation with no transcript file on disk is no longer shown at all**, instead of a ghost row with no title, no model and no context %. Incident: a session entered `sessions-state.json` via `UserPromptSubmit` with a transcript path for the workspace, but the process was aborted before ever creating that file — the row it produced (`"Conversation"`, `waiting`) couldn't be matched to any tab, couldn't be titled, and the lot-5 presence filter refused to clear it since it had no `ai-title` to trust. A brand-new conversation can legitimately precede its first transcript write by a few seconds — that's not treated as debris, it's simply not rendered yet, and appears the moment the file shows up. An entry stuck without a transcript for more than 5 minutes is dropped from `sessions-state.json` outright (`SessionEnd` isn't reliable enough to count on, see 2.2.0).

## [2.8.0] - 2026-07-16

### Fixed
- **A question asked (`AskUserQuestion`) or a plan awaiting approval (`ExitPlanMode`) now shows `waiting` immediately, instead of keeping the busy spinner until a 60-second-late `idle_prompt` Notification.** Neither tool fires any hook at all ([#13830](https://github.com/anthropics/claude-code/issues/13830), [#13024](https://github.com/anthropics/claude-code/issues/13024)); the `Notification` hook's `idle_prompt` path has a fixed, non-configurable 60 s delay ([#13922](https://github.com/anthropics/claude-code/issues/13922)). Detected straight from the transcript instead: if the last assistant message ends in a `tool_use` for one of these two tools with no matching `tool_result` yet, the conversation is `waiting`, regardless of the hooks' last word. Clears as soon as a `tool_result` (or any later event) shows up. The existing `permission_prompt`/`idle_prompt` paths are untouched.

### Changed
- **The `waiting` icon is now a single, non-animated `?`**, replacing the pulsing dot — one visual state for every kind of "hands you back control" (question, permission, idle), instead of a signal only some of them used to trigger.

## [2.7.0] - 2026-07-16

### Fixed
- **Strict read receipts: only an *observed* act dims the ✓, never a tab left active from before the run.** Incident: a conversation's ✓ dimmed after the tab had simply been sitting open for an hour while work continued elsewhere in the *same* window — "active tab + window focus + 2 s" was satisfied without anyone ever looking at the result. A dwell now only counts if it started **after** the conversation's current run began (`busy_since`, newly persisted per session, stamped on every `UserPromptSubmit`, unlike `since` it survives through to the following `Stop`). Coming to watch a conversation work is an observed act; having been there since before it was even launched no longer is. Decision: a false "unread" is acceptable, a false "read" is not.
- **Clicking a conversation's row in the panel is now an explicit read receipt**, even when its tab is already active and no tab-switch transition will ever fire — the one escape hatch a single-tab workflow needs.

## [2.6.0] - 2026-07-16

### Fixed
- **Quota bars refresh at the moment they'd actually be stale, not just every 5 minutes.** During a fast burn, the panel could show 85% while the real usage was already at 90% — the quota poll only ran on its fixed 5-minute timer. Now, whenever a conversation transitions to `done` or `waiting` (the moment a chunk of usage was just billed), a quota fetch fires immediately. Throttled to at most one event-driven fetch per ~45 s (a burst of conversations finishing together triggers only one), skipped while the panel is hidden, and never triggered by a `busy` state or by a recompute that doesn't actually change any conversation's state (e.g. context % moving mid-run). The 5-minute poll is unchanged and remains the fallback.

## [2.5.0] - 2026-07-15

### Fixed
- **A conversation's `ai-title` is now found no matter where it lands in the transcript.** It was only searched in the first 32 KB and last 64 KB of the file; a real transcript had it at byte 33,349 of a 739 KB file, invisible to both windows. The panel then fell back to the first message as the title, and — since the lot 5 presence filter only trusts `ai-title` to prove a closed tab is really gone — a closed conversation with a buried title stayed in the panel forever. Fixed with an incremental, append-only scan (`scanAiTitleIncremental` in `hooks/transcript.js`): a full scan once per file, then only the newly-written bytes on every subsequent read, cached per file in `state.js`'s transcript reader.

## [2.4.0] - 2026-07-15

### Added
- **A ▲ marker under each quota bar** showing where you should be right now if usage were spread evenly across the window — % of the window elapsed. Fill to its left is on pace; past it, you're burning faster than the clock. 24 h after a weekly reset, it sits at 1/7 ≈ 14.3%. Masked under the same conditions as the burn-rate colour (no reset time, reset already past, window barely started), capped at 100%.
- **The arrow and the burn-rate colour now refresh on their own**, every 30 s, without a network call: both are pure functions of the clock and the reset time, which the webview already has. The tick pauses while the panel isn't visible (`document.hidden`, the Page Visibility API webviews support).
- **A bar for every model-scoped weekly limit the API reports** (`limits[]` entries with `group: "weekly"` and a `scope`, e.g. a promotional Fable allowance) — labelled from `scope.model.display_name`, with **no hardcoded model name or date anywhere**: the bar appears when the API sends the entry and disappears the day it stops. `quotaState()` now exposes a `windows[]` list instead of a fixed `fiveHour`/`sevenDay` pair.

### Changed
- The burn-rate colouring logic itself is unchanged (no window-open damping, per an explicit 2026-07-15 decision) — this release only makes the existing colours self-explanatory and keeps them live between polls.

## [2.3.0] - 2026-07-15

### Fixed
- **The `busy` arc actually spins now.** Two causes, both measured rather than guessed. (1) The CSS carried an `@media (prefers-reduced-motion: reduce)` rule that set `animation: none` — and Chromium derives that preference from `SPI_GETCLIENTAREAANIMATION`, Windows' "Show animations" toggle, which is off on this machine. The rule was therefore *always* on: the spinner had never once spun. It's gone, deliberately: the arc carries the conversation's state, so cutting it removes information (see README → Known limitations). (2) Every state push rebuilt the whole list of DOM nodes, restarting the animation from zero; the list is now rendered incrementally, so nodes survive and keep their rotation.
- **A conversation no longer shows ✓ while it is visibly working.** The `Stop` hook also fires when the turn *continues* — a Stop hook returning feedback (an `exit 2` that sends Claude back to work), or a message typed mid-turn. The `waiting` state already had a "transcript wrote later ⇒ it resumed" correction; `done` now has it too, with two guards: writes within ~2 s of the `Stop` don't count (the turn's last assistant message lands right next to it, so every turn would otherwise bounce back to `busy`), and the fallback stays `done` and never `stale` — once writes stop, the turn really is over.
- **Repeated hook events now stamp their own timestamp** (`hook-session-state.js`). `since` was only re-armed when the *state changed*, but these events repeat identically and each repetition is news. Two consecutive `Stop`s (a Stop hook with feedback, then the real end of turn) left `since` on the *first* one: the end of the turn was read as a resumption — the conversation stayed "working" — and the ✓ never went bright again despite new content. The same flaw hit two consecutive `Notification`s: a second permission prompt was read as a resumption, so the panel showed "working" while Claude was actually waiting for you. Found by running the real hooks in a sandbox, not by reading the code.
- **Conversation titles no longer leak CLI markup.** A conversation opened with a slash-command showed `<command-name>/model</command-name> <co…` as its title: the transcript stores the markup, not `/model opus`, and those entries aren't flagged `isMeta`. Leading `<tag>…</tag>` envelopes are now stripped whole — by shape, not by a list of known tag names, which would just reproduce the bug on the next one the CLI invents — so the fallback title lands on the first real human message. Chevrons inside a sentence ("why does this `<div>` overflow?") are untouched.

### Added
- **Read receipts.** A finished conversation keeps a **bright ✓ until you've actually read it**, then dims to a soft ✓. "Read" = its tab is active *and* the window has focus, held for ~2 s — a dwell that ignores a `Ctrl+Tab` passing through and the neighbour VS Code auto-activates when you close a tab. It also covers the case where the tab was already in front of you as Claude finished (no tab switch will ever fire there, so the `Stop` goes and asks). Stored as `ack_ts` in `sessions-state.json`: survives a restart, and a read in one window dims the ✓ in all of them. A new `Stop` re-arms the bright ✓ on its own.
- `ack.js` — the dwell tracker. The extension is now the *second* writer of `sessions-state.json` (hooks were alone), and goes through the same locked, atomic `updateSession` — never a hand-rolled write.

### Changed
- **The 30-minute `done` fade is gone.** An arbitrary timer knows nothing about you: it erased the ✓ of a result you never read, and kept bright one you'd read 29 minutes ago. Reading is now the only thing that dims it. The natural bound is unchanged — the 4 h recency window still drops the conversation from the panel.
- **No more grey `idle` dot.** A finished conversation reads as a dim ✓ ("nothing running") rather than a grey pellet that made it look pointless. Conversations with no hook state at all (older than the hooks) render the same way.
- The state engine only notifies the panel when something **visible** changes. It used to compare whole snapshots, including `mtime` — rewritten on every transcript line — so a working conversation re-rendered the panel continuously.

## [2.2.0] - 2026-07-15

### Fixed
- **Closing a conversation's tab now removes it from the panel straight away** (~170 ms measured), instead of leaving it there — sometimes for hours. The disappearance used to depend on the `SessionEnd` hook, which doesn't fire on `/exit` or `/clear` ([anthropics/claude-code#17885](https://github.com/anthropics/claude-code/issues/17885), [#6428](https://github.com/anthropics/claude-code/issues/6428)) and is erratic on tab close ([#14760](https://github.com/anthropics/claude-code/issues/14760), [#45424](https://github.com/anthropics/claude-code/issues/45424)); when it stayed silent, the conversation only left once the 4 h recency window or the 30 min `done` fade expired — the "sometimes it works, but with a big latency" the panel used to show. Tab state now comes from VS Code (`onDidChangeTabs`), and the closed session's `sessions-state.json` entry is purged so it can't come back on the next snapshot, nor linger in another window. A tab closed mid-work removes the conversation too, `busy` or not.

### Added
- **Presence filter, applied to every snapshot**: a conversation with no matching tab open in any window is hidden. Running on every snapshot rather than at startup also cleans up the whole backlog for free — tabs closed while VS Code was off, conversations predating this version, conversations predating the hooks entirely (never present in `sessions-state.json`).
- **Tab union across VS Code windows**: each window publishes its Claude tab labels to `~/.claude/panel-tabs/<pid>.json` and judges presence on the union — otherwise each window would hide the conversations open in the others. One file per pid: a single writer per file, so no lock, and a dead window is cleaned up with an `unlink` (liveness by pid).
- `labels.js` — the tab-label ↔ conversation-title matching rule, extracted from `focus.js` and now shared with `state.js`/`tabs.js`. It decides both "where is this conversation's tab" and "is this conversation still open"; a second copy would be a second truth.

### Changed
- `SessionEnd` is downgraded to an opportunistic signal. It's kept (it costs nothing and cleans up when it does fire), but nothing depends on it any more.

### Known limitations
- A conversation whose title is still a fallback (no `ai-title` yet) is never hidden by the presence filter — its title can't be reliably matched against a tab label, so "no matching tab" proves nothing. It leaves the list the old way (4 h of inactivity, or an observed tab close).
- Conversations whose titles share their first 24 characters remain indistinguishable to the tab matcher (unchanged from 2.1.0).

## [2.1.0] - 2026-07-15

### Fixed
- **Clicking a conversation now actually focuses its tab.** The label match introduced in 2.0.0 was exact, but the Claude Code extension truncates tab labels to 24 characters plus an ellipsis (`Implémenter lot 4 burn-r…`) while the panel shows the full `ai-title` — so any conversation with a title longer than 24 characters silently matched nothing. Truncated labels are now matched as a prefix of the title.
- **Burn-rate thresholds now mean what the colours claim.** Red is `pace > 1.0`, i.e. red exactly when the projected end-of-window usage exceeds the quota. The previous defaults (green ≤ 0.8, yellow ≤ 1.2) painted a projection of 120% as merely "yellow". New defaults: `burnRateGreenMax` `0.8` → `0.85`, `burnRateYellowMax` `1.2` → `1.0`.

### Added
- **Cross-window tab focus.** The panel lists the conversations of the *workspace*, which may be open in several VS Code windows — so a clicked tab often lives in another window. The click is relayed through `~/.claude/panel-focus-request.json`; every window's instance watches it, the one owning the tab focuses it and raises its window (`raise-window.ps1`: `EnumWindows` + `SetForegroundWindow`, `AttachThreadInput` retry, taskbar flash as last resort). Measured, not assumed: Windows refuses the plain `SetForegroundWindow` from a background process, so the `AttachThreadInput` retry is what actually raises the window — the script reports which branch won (`raised (attach)`). Stale requests (> 3 s) are ignored, and an instance never answers its own.
- Tabs are now searched in **every editor group**, not just the active one (2.0.0 only looked at the active group, so a conversation in a split never matched).
- `raise-window.ps1 -ListOnly` — lists the VS Code windows the script can see without touching the foreground.

## [2.0.0] - 2026-07-15

### Added
- **Conversations & Quota panel**, docked in VS Code's Secondary Side Bar (right). Lists every recent conversation of the current workspace with its live state (`busy`/`waiting`/`done`/`stale`/`idle`), model, and context-window occupation — reactive via `fs.watch` on `~/.claude/sessions-state.json` and the workspace's transcripts, no polling.
- New hooks (`UserPromptSubmit` extended, `Stop`, `Notification`, `SessionEnd`) write per-session state to `~/.claude/sessions-state.json`, deployed idempotently by `install.ps1`.
- **Burn-rate colouring** on the 5h/7d quota bars: pace = percent used ÷ percent of window elapsed, green ≤ 0.8, yellow ≤ 1.2, red above — thresholds configurable (`claudeCodeQuotaBar.burnRateGreenMax`/`burnRateYellowMax`).
- Zero-hardcoded-model-list resolution (`hooks/model-id.js`): parses the model id schema instead of a lookup table, so a new model family (or one being retired, e.g. Fable 5) never produces a stale/wrong label — an unrecognized id is shown raw.

### Removed
- **The status bar item and its `statusBarAlignment` setting.** Superseded by the panel, which shows the same information (and per-conversation, not just the current tab) with real formatting a status bar text segment can't do. The "Open Usage Page" and "Refresh Now" commands are unchanged.
- All the duplicated status-bar-only model/context resolution code in `extension.js` (`MODEL_ID_MAP`, `referenceTranscriptPath`, `contextLabel`, etc.) — the panel's conversation list gets model/`ctx%` from `state.js` (via `hooks/model-id.js` and `hooks/transcript.js`), the single source of truth shared with the hooks.

### Known limitations (carried over, unchanged)
- Clicking a conversation is best-effort tab focus (VS Code exposes no tab↔session mapping, [microsoft/vscode#158853](https://github.com/microsoft/vscode/issues/158853)); no match → no-op rather than risk focusing the wrong tab.
- Requires VS Code 1.106+ for the Secondary Side Bar contribution.

## [1.5.1] - 2026-06-16

### Fixed
- **Model + `ctx:%` sometimes didn't follow the conversation when switching Claude tabs.** Root cause: both the model scan and the context scan picked the workspace transcript with the **most recent `mtime`**, not the conversation the user is actually working in — so when another tab finished a response, the bar stayed (or flipped) to *that* conversation regardless of focus, producing the "sometimes updates, sometimes not" behaviour. Introduced `referenceTranscriptPath()`: it resolves the **active session** first (`active-session.json` `session_id` → `<session_id>.jsonl`, since the transcript filename equals the session id), falling back to `mtime`-most-recent only when there's no fresh active session. Model and `ctx:%` now read the **same** reference transcript, so they're always mutually consistent and track the conversation where you last submitted a prompt.
- Known limit (unchanged, structural): VS Code does not expose the focused webview tab's session id to a third-party extension ([microsoft/vscode#158853](https://github.com/microsoft/vscode/issues/158853)), so the bar follows "the conversation you last typed in", not "the tab you're looking at". This is deterministic now (no more random flips) but switching to a tab without typing won't change the display.

## [1.5.0] - 2026-06-16

### Added
- **Context window occupation (`ctx:NN%`)** in the status bar, between the model name and the quota windows. The figure is the live `/context`-equivalent: the last assistant message of the active workspace transcript already carries `message.usage`, so occupation is read from the **same parse** as the model — `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` — with no extra source, no network, no cookie.
- **Auto-detected denominator (200k vs 1M).** `detectContextWindow()` resolves the window, most-certain first: (1) always-1M API families (Opus 4.7/4.8, Fable 5); (2) **empirical guard** — any observed usage above 200k is necessarily a 1M session (Claude Code would have compacted otherwise), so the denominator self-corrects; (3) a `[1m]` alias in `settings.json` `model` (covers Sonnet/Opus 4.6 opt-in); (4) else 200k. `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` forces 200k.
- Refresh is wired to the existing reactivity (the `active-session.json` watcher fires on every `UserPromptSubmit`, plus the Claude panel tab-switch and the periodic poll), so `ctx:%` reflects the window state at the start of each turn — what `/context` would report before you send.

### Notes
- VS Code status bar items can't colour a single text segment, so the percentage is plain text (no green/yellow/red sub-colouring like the native CLI statusline). The figure itself is authoritative.

## [1.4.3] - 2026-05-29

### Fixed
- **Model display flipped to the wrong version (`Opus 4.7`) after a window reload**, while showing the correct `Opus 4.8` during active work. Root cause: two Claude Code binaries running concurrently — a long-lived `claude remote-control` session on an older build (`.local\bin`, 2.1.154, which still resolves the `opus` alias to `claude-opus-4-7`) and the VS Code extension (2.1.156, `opus`→`claude-opus-4-8`). The RC session's status line periodically overwrites the **shared global** `~/.claude/current-model.json` with its own (stale) resolution. Right after a reload, on the first prompt, this session's fresh transcript has no assistant message yet, so the `track-active-session.js` hook fell back to that polluted global file and wrote `Opus 4.7` into `active-session.json` — which `modelLabel()` trusted as priority #1. Two fixes: (1) `modelLabel()` now reads the **per-session transcript first** (`message.model` is the real API-served model, never cross-session polluted), before `active-session.json` and the global cache; (2) the `track-active-session.js` hook no longer falls back to `current-model.json` — if the transcript has no model yet it writes nothing, letting the extension's transcript scan provide the truth.

## [1.4.2] - 2026-05-29

### Fixed
- **Model name lost its minor version for un-mapped model IDs.** The active model display relied on a hardcoded `MODEL_ID_MAP` table (frozen at `Opus 4.7`/`4.6`) with a regex fallback `/claude-([^-]+)-(\d+)/` that only captured the major version. For `claude-opus-4-8` (and any future ID not in the table) the fallback produced `Opus 4` — the `-8` was dropped at the dash. Fixed the fallback to `/claude-([a-z]+)-(\d+)-(\d+)/`, which captures `major.minor` and renders `Opus 4.8`, `Sonnet 4.6`, future `5.0`, etc. without any table to maintain (date-suffixed IDs like `claude-haiku-4-5-20251001` are handled too). Same fix applied to the twin `modelIdToDisplay()` in the `track-active-session.js` UserPromptSubmit hook (`~/.claude/scripts/`, outside this repo).

## [1.4.1] - 2026-05-25

### Fixed
- **Brave Octopus not killed after ephemeral spawn** (regression from 1.4.0). `closeOctopusBrave()` relied on async `Browser.close` CDP + a 500 ms `setTimeout` taskkill fallback; in the VSCode extension host, the timeout fired too late and the process stayed alive, leaving 10 Brave processes idle (~1 GB RAM) — defeating the entire point of 1.4.0. Rewritten to save the root `child.pid` at spawn time to `~/.claude/quota-brave-pid.json`, then synchronously `taskkill /PID <pid> /T /F` at close (plus a defense-in-depth PowerShell sweep filtered by `--user-data-dir=*BraveOctopus*`).

## [1.4.0] - 2026-05-25

### Changed
- **Zero persistent browser.** Empirical test on 2026-05-25 confirmed that `claude.ai/api/organizations/{id}/usage` accepts the `sessionKey` cookie alone (no `cf_clearance`, no `__cf_bm`, no TLS spoof needed from a residential IP). The extension now caches `sessionKey` at `~/.claude/quota-session-key.json` and uses a raw `https.get()` per tick. **Steady-state additional RAM: ~0** (vs ~1 GB for a persistent Brave Octopus instance in 1.3.x).
- Brave Octopus is spawned **ephemerally only** when the sessionKey cache is missing, when the API returns 401/403 (session rotated by Anthropic), or when org_id discovery fails. Cookie is extracted via browser-level CDP `Storage.getCookies`, then Brave is killed immediately. Typical refresh: ~10 s, happens roughly once every 30 days when the Anthropic session rotates.
- `refreshSessionKeyViaCdp()` only kills the Brave Octopus it spawned itself — never an instance an on-demand Playwright script may be using.

### Removed
- Persistent Brave Octopus lifecycle (`ensureOctopusBraveWithCDP` at activate, `closeOctopusBrave` at deactivate, dispose subscription).
- In-page `Runtime.evaluate` fetch path (`fetchInPage`, `findClaudeAiTarget`, `discoverOrgIdViaPage`, `fetchUsageViaCDP`).

### Notes
- Status bar tooltip now indicates `via cookie`, `via cookie-refreshed`, or `via oauth` depending on the path used.
- The OAuth fallback (rate-limited) is preserved as last resort.
- If Anthropic ever adds a Cloudflare JS challenge on the usage endpoint, raw `fetch()` will fail and the ephemeral Brave path also won't help — we'd need to bring back in-page fetch. Not a concern in 2026-05.

## [1.3.1] - 2026-05-25

### Fixed
- **`Cannot find module 'ws'` at activation.** The `ws` dependency added in 1.2.0 was excluded from the VSIX bundle by the default `.vscodeignore` (`node_modules/**`). Whitelisted `node_modules/ws/` so the extension can actually load. Note: 1.2.0 and 1.3.0 were both shipped broken — only 1.1.1 (which didn't use `ws`) was ever installable.

## [1.3.0] - 2026-05-25

### Changed
- **CDP target switched from Brave principal (9222) to Brave Octopus (9223).** The user's main Brave is no longer touched — no more `claude.ai/` background tab popping up in the daily browser at every refresh. Brave Octopus runs offscreen (`--window-position=-32000,-32000`) and is invisible by design.
- **Lifecycle bound to extension activation/deactivation**: Brave Octopus is spawned on `activate()` (best-effort, async) and gracefully shut down on `deactivate()` (Browser.close via CDP + taskkill fallback filtered by `--user-data-dir=BraveOctopus`). No orphan process between VSCode sessions.
- `fetchUsageViaCDP()` now calls `ensureOctopusBraveWithCDP()` first, so a fresh tick after a cold spawn waits up to 8 seconds for CDP to be reachable before falling back to OAuth.

### Notes
- The `claude.ai` session must be logged into the Brave Octopus profile (`C:\OctopusData\BraveOctopus\Default`). The OAuth fallback handles the case where it isn't.
- Coexistence with on-demand Playwright scripts (`Tools/BrowserAutomation/connect.mjs::attachToOctopusBrave`): both share the same browser instance via CDP. If a Playwright script is mid-run when VSCode closes, our `closeOctopusBrave()` will tear it down — acceptable trade-off given the rules in the BrowserAutomation CLAUDE.md.

## [1.2.0] - 2026-05-19

### Added
- **CDP path as primary fetch route**: when Brave is running with `--remote-debugging-port=9222` and a claude.ai session is logged in, the extension now fetches usage from `claude.ai/api/organizations/{org_id}/usage` via `Runtime.evaluate` in a background tab. This endpoint uses a **different rate-limit bucket** than `api.anthropic.com/api/oauth/usage`, which is currently subject to persistent 429s (Anthropic issues [#31021](https://github.com/anthropics/claude-code/issues/31021), [#31637](https://github.com/anthropics/claude-code/issues/31637)).
- Background tab on `https://claude.ai/` is reused across refreshes (not opened/closed per tick) — silent and unobtrusive once established.
- `org_id` discovered on first call via `/api/organizations`, cached at `~/.claude/quota-org-id.json` for subsequent runs; re-discovered on 401/403/404.
- OAuth path retained as **fallback** when CDP is unreachable (Brave not running, no claude.ai session).
- Tooltip now indicates the route used (`via cdp` / `via oauth`) and surfaces both error messages when both paths fail.

### Dependencies
- Added `ws@^8.18.0` for raw CDP WebSocket client.

### Notes
- Direct HTTPS fetch from Node with extracted cookies is blocked by Cloudflare (TLS fingerprint mismatch). The `Runtime.evaluate` approach uses Brave's own network stack and bypasses this transparently.

## [1.1.1] - 2026-05-16

### Removed
- Placeholder GitHub URLs (`repository`, `bugs`, `homepage`) from `package.json` — they pointed to a non-existent repo (404).

## [1.1.0] - 2026-05-16

### Added
- Display the **currently active Claude model** (e.g. `Opus 4.7`, `Sonnet 4.6`) at the start of the status bar item. The model name is read from `~/.claude/current-model.json`, which is written by a Claude Code `statusLine` hook (see README).
- If no model info is available (or older than 1 hour), the bar falls back to the previous `Claude` label.

### Changed
- Status bar text format: `$(cloud) <model> | 5h:X% (r:HH:MM)  7d:Y% (r:day HH:MM)` (model + separator + usage).

## [1.0.0] - 2026-05-14

Initial public release.

### Added
- Status bar widget showing Claude Code 5-hour and 7-day usage with reset times.
- Click handler opens `claude.ai/settings/usage`.
- Local cache for offline display.
- Configurable refresh interval (`claudeCodeQuotaBar.refreshIntervalMinutes`).
- Configurable status bar alignment (`claudeCodeQuotaBar.statusBarAlignment`).
- Manual refresh command (`Claude Code Quota: Refresh Now`).
