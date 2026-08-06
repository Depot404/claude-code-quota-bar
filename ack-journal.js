// ============================================================================
// Journal d'instrumentation du chemin d'accusé de lecture (étape 18, phase 1).
//
// POURQUOI CE FICHIER EXISTE — cinq fois de suite (2026-07-15, 2026-07-22,
// 2026-08-05 matin, 2026-08-05 soir), des conversations terminées sont passées
// « ✓ lu » (pâle) sans que personne ne les ait consultées, et cinq fois le
// correctif a été déduit des SYMPTÔMES : on reconstituait a posteriori une
// séquence plausible (dwell, rename_tab, ouverture programmatique) et on
// bouchait ce trou-là. Chaque bouchon a tenu quelques jours. La méthode est en
// cause, pas la sagacité : le chemin d'ack dépend d'événements VS Code, d'un
// registre de process et de trois horodatages qu'on ne peut PAS rejouer après
// coup — un banc ne prouve que ce qu'on a déjà imaginé.
//
// D'où ce journal : chaque décision réelle du chemin d'ack laisse une ligne,
// chez l'user, en conditions réelles. Au prochain ✓ pâle fautif, la ligne dit
// POURQUOI les gardes ont laissé passer — plus rien à deviner. Le correctif
// (phase 2) n'a le droit de partir que d'une ligne fautive en main.
//
// CE QUE CE MODULE N'EST PAS — il ne décide rien, il n'influence rien. Aucun
// appelant ne doit changer de comportement selon ce qu'il journalise : toute
// écriture est enveloppée (un disque plein ne doit jamais casser le panneau),
// et l'absence de journal ne change strictement aucun verdict.
//
// FORMAT — un objet JSON par ligne (JSONL), append seul :
//   { ts, at, pid, event, ... }   ts = epoch ms, at = ISO **heure locale**
// Le fichier est LOCAL (~/.claude/), jamais publié : il contient des titres de
// conversations. Ne jamais l'embarquer dans un .vsix ni dans un repo public.
//
// CONCURRENCE — plusieurs fenêtres VS Code écrivent le même fichier. Chaque
// ligne porte son `pid` pour les démêler. [non vérifié] l'atomicité d'un append
// concurrent sous Windows n'est pas garantie : le LECTEUR (readJournal) tolère
// donc une ligne illisible plutôt que de supposer un fichier parfait.
//
// ROTATION — au-delà de MAX_BYTES, le fichier courant devient `.1` (la
// génération précédente est écrasée) et on repart d'un fichier vide. Pas une
// troncature en place : l'incident qu'on chasse arrive SANS prévenir, perdre le
// mégaoctet qui le précède serait perdre la preuve.
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_BYTES = 1024 * 1024;

// Résolu à CHAQUE écriture, jamais mémorisé : les bancs redirigent HOME (ou
// posent QUOTABAR_ACK_JOURNAL) et doivent être suivis, même s'ils le font après
// le require. Le coût — deux appels triviaux sur un événement rare — est nul
// devant le risque d'écrire dans le vrai journal de l'user depuis un test.
// `QUOTABAR_ACK_JOURNAL=off` (ou `0`) coupe le journal sans toucher au code.
function journalPath() {
  const override = process.env.QUOTABAR_ACK_JOURNAL;
  if (override === 'off' || override === '0') return null;
  if (override) return override;
  try { return path.join(os.homedir(), '.claude', 'quotabar-ack-journal.jsonl'); } catch { return null; }
}

// Heure LOCALE avec son décalage (2026-08-06T14:03:21.123+02:00) : ce journal
// se relit à côté d'un constat de l'user (« regarde, ✓ pâle à 14 h »), jamais
// dans un fuseau abstrait. `ts` reste l'epoch ms pour les calculs d'écart.
function localIso(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
    + `${sign}${p(Math.trunc(off / 60))}:${p(off % 60)}`;
}

function rotateIfNeeded(file) {
  try {
    if (fs.statSync(file).size <= MAX_BYTES) return;
    fs.renameSync(file, file + '.1');
  } catch {}   // fichier absent (premier écrit) ou rotation impossible : on écrit quand même
}

// L'unique porte d'écriture. `event` = nom court et stable (un grep dessus doit
// suffire à isoler une phase du chemin d'ack) ; `fields` = TOUT le contexte de
// la décision, sans filtrage : un champ manquant le jour de l'incident, c'est
// une 6e récidive.
function logEvent(event, fields) {
  const file = journalPath();
  if (!file) return;
  const ts = Date.now();
  try {
    rotateIfNeeded(file);
    fs.appendFileSync(file, JSON.stringify({ ts, at: localIso(ts), pid: process.pid, event, ...fields }) + '\n');
  } catch {}
}

// Lecture (bancs + analyse de la phase 2). Une ligne illisible est ignorée, pas
// fatale : cf. la note de concurrence en tête de fichier.
function readJournal(file) {
  const target = file || journalPath();
  if (!target) return [];
  let raw = '';
  try { raw = fs.readFileSync(target, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

// ── Anti-bavardage ──────────────────────────────────────────────────────────
// `ackConversations()` est rappelée à CHAQUE recompute d'état (une conv qui
// écrit son transcript en produit des dizaines par minute). Journaliser le même
// verdict à l'identique noierait la ligne fautive dans le bruit — et un journal
// illisible ne sert à rien. On ne journalise donc qu'un CHANGEMENT de verdict
// pour une clé donnée, en reportant le nombre de répétitions tues : l'histoire
// reste complète, la lecture reste possible.
//
// Ce qui n'est JAMAIS filtré (l'appelant ne passe pas par ici) : la pose d'un
// ack. C'est l'événement qu'on chasse, il se journalise à chaque fois.
function createVerdictFilter() {
  const last = new Map();   // clé → { sig, skipped }
  return {
    // → null si rien à écrire (verdict identique au précédent), sinon le nombre
    //   de répétitions tues depuis la dernière ligne écrite pour cette clé.
    take(key, sig) {
      const prev = last.get(key);
      if (prev && prev.sig === sig) { prev.skipped++; return null; }
      last.set(key, { sig, skipped: 0 });
      return { repeatsSkipped: prev ? prev.skipped : 0 };
    },
    // Une conv qui disparaît (onglet fermé, ack posé) ne doit pas garder son
    // verdict en mémoire : si elle revient, sa première ligne doit être écrite.
    forget(key) { last.delete(key); },
    size() { return last.size; },
  };
}

module.exports = { logEvent, readJournal, journalPath, localIso, createVerdictFilter, MAX_BYTES };
