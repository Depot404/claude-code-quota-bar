#!/usr/bin/env node
// Lib partagée : id de modèle API → nom affichable, et détection de la fenêtre
// de contexte. Require() côté hooks (~/.claude/scripts/) ET côté extension
// (state.js require ./hooks/model-id.js — hooks/ est inclus dans le .vsix).
//
// Source canonique : Tools/ClaudeCodeQuotaBar/hooks/. Ne pas éditer la copie
// déployée dans ~/.claude/scripts/ — éditer ici puis relancer install.ps1.

const fs = require('fs');
const os = require('os');
const path = require('path');

// ZÉRO liste de modèles en dur (décision plan 2026-07-15) : toute table
// `claude-opus-4-8 → Opus 4.8` est fausse le jour où un modèle sort ou
// disparaît (vécu : Fable 5 apparu puis suspendu, affichage « aux fraises »).
// On parse le SCHÉMA de l'id, qui lui est stable :
//   claude-<famille>-<major>[-<minor>][-<date 8 chiffres>][[<tag>]]
// Exemples réels vérifiés sur transcripts (2026-07-15) :
//   claude-opus-4-8[1m]        → Opus 4.8
//   claude-haiku-4-5-20251001  → Haiku 4.5
//   claude-fable-5             → Fable 5
// major/minor bornés à 2 chiffres : sinon `claude-opus-4-20251001` lirait la
// date comme un minor (« Opus 4.20251001 »).
const MODEL_ID_RE = /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?(?:\[([a-z0-9]+)\])?$/i;

function parseModelId(id) {
  if (!id || typeof id !== 'string') return null;
  const m = id.match(MODEL_ID_RE);
  if (!m) return null;
  return {
    family: m[1].toLowerCase(),
    major: m[2],
    minor: m[3] || null,
    tag: m[4] ? m[4].toLowerCase() : null,
  };
}

// Id non reconnu → on rend l'id BRUT plutôt qu'un nom inventé ou « Claude ».
// L'user voit tout de suite qu'un schéma nouveau est apparu.
function modelIdToDisplay(id) {
  const p = parseModelId(id);
  if (!p) return id || null;
  const family = p.family[0].toUpperCase() + p.family.slice(1);
  return p.minor ? `${family} ${p.major}.${p.minor}` : `${family} ${p.major}`;
}

// Famille de l'alias modèle [1m] de settings.json (ex. "opus[1m]" → "opus"),
// ou null. La FAMILLE compte : un alias global opus[1m] ne dit rien d'une conv
// qui tourne en haiku — appliquer 1M à tous les modèles sous-estimait leur ctx%
// (constat 2026-07-15, settings réel opus[1m] + convs Haiku).
function settings1mFamily() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
    const m = typeof s.model === 'string' && s.model.match(/^([a-z]+)\[1m\]$/i);
    return m ? m[1].toLowerCase() : null;
  } catch { return null; }
}

// Fenêtre de contexte (dénominateur du ctx%), du signal le plus SÛR au plus faible :
//  1) CLAUDE_CODE_DISABLE_1M_CONTEXT=1 → 200k, l'user a tranché
//  2) usage observé > 200k ⇒ forcément 1M (sinon la conv aurait compacté).
//     Garde empirique imparable, donc placée avant toute heuristique (plan lot 2).
//  3) tag [1m] dans l'id du modèle servi (claude-opus-4-8[1m]) → 1M
//  4) alias modèle [1m] dans settings.json → 1M, SEULEMENT si la famille de
//     l'alias est celle du modèle servi (opus[1m] global ≠ conv haiku 1M)
//  5) heuristique générationnelle — DERNIER recours, faillible :
//     depuis la génération 5 (Fable 5, Sonnet 5…), 1M est la fenêtre PAR DÉFAUT
//     sans tag [1m] ni opt-in (doc « What's new in Claude Sonnet 5 », vérifié
//     2026-07-15 — incident : Sonnet 5 à 120k affiché ctx 60% au lieu de 12%).
//     Donc : major ≥ 5 → 1M. Le dur-codage résiduel se limite au legacy FIGÉ
//     (Opus 4.7/4.8, seuls modèles 4.x en 1M) qui ne bougera plus jamais.
//     Un futur modèle ≥ 5 à fenêtre 200k serait sur-estimé ici — risque accepté,
//     signalé par un ctx% anormalement bas.
function detectContextWindow(modelId, tokens) {
  if (process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1') return 200000;
  if (tokens > 200000) return 1000000;
  const p = parseModelId(modelId);
  if (p && p.tag === '1m') return 1000000;
  if (p && p.family === settings1mFamily()) return 1000000;
  if (p && parseInt(p.major, 10) >= 5) return 1000000;
  if (p && p.family === 'opus' && p.major === '4' && (p.minor === '7' || p.minor === '8')) return 1000000;
  return 200000;
}

module.exports = { parseModelId, modelIdToDisplay, detectContextWindow, settings1mFamily };
