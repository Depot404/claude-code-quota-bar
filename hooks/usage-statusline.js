#!/usr/bin/env node
//
// statusLine hook Claude Code : rend la ligne de statut native (modèle | dossier
// (branche) | 5h:% | 7j:%) ET écrit le modèle courant dans ~/.claude/current-model.json
// pour l'extension VS Code quota-bar (fallback de dernier recours côté extension).
//
// ATTENTION current-model.json est GLOBAL et partagé entre TOUTES les sessions
// Claude Code. Une session sur un binaire d'une autre version (alias `opus` résolu
// différemment) y écrit sa propre valeur → ce fichier n'est PAS une source fiable du
// modèle d'une session donnée. L'extension le lit en dernier recours seulement ; la
// vérité par session vient du transcript JSONL (message.model).
//
// Source canonique : versionné dans Tools/ClaudeCodeQuotaBar/hooks/, déployé vers
// ~/.claude/scripts/ par install.ps1. Éditer ici, pas la copie déployée.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const MODEL_CACHE_PATH = path.join(require('os').homedir(), '.claude', 'current-model.json');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = input.trim() ? JSON.parse(input) : {};
    // --- Modèle ---
    const modelName = (data.model && data.model.display_name) ? data.model.display_name : '';

    // --- Dossier courant (basename) ---
    const cwd = (data.workspace && data.workspace.current_dir) ? data.workspace.current_dir : (data.cwd || '');
    const dirName = cwd ? path.basename(cwd) : '';

    // --- Branche git ---
    let gitBranch = '';
    if (cwd) {
      try {
        gitBranch = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd,
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 1000,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
        }).toString().trim();
        if (gitBranch === 'HEAD') gitBranch = ''; // detached HEAD, skip
      } catch {}
    }

    // --- Rate limits ---
    const rl = data.rate_limits;

    // Écrit le modèle dans un fichier séparé pour l'extension VS Code quota-bar.
    // (On n'écrit plus dans usage-cache.json — celui-ci appartient à l'extension,
    //  schémas incompatibles, collision si on le partage.)
    if (data.model && data.model.display_name) {
      try {
        fs.writeFileSync(MODEL_CACHE_PATH, JSON.stringify({
          timestamp: Date.now(),
          display_name: data.model.display_name,
          id: data.model.id || null,
        }));
      } catch {}
    }

    // --- Assemblage ---
    const parts = [];

    if (modelName) parts.push(modelName);

    const locationParts = [];
    if (dirName) locationParts.push(dirName);
    if (gitBranch) locationParts.push(`(${gitBranch})`);
    if (locationParts.length) parts.push(locationParts.join(' '));

    if (rl && (rl.five_hour || rl.seven_day)) {
      const usageParts = [];
      if (rl.five_hour) usageParts.push(`5h:${fmt(rl.five_hour)}`);
      if (rl.seven_day) usageParts.push(`7j:${fmt(rl.seven_day)}`);
      parts.push(usageParts.join(' '));
    }

    process.stdout.write(parts.join(' | '));
  } catch (e) {
    process.stdout.write('erreur statusline');
  }
});

function fmt(limit) {
  const pct = Number.isFinite(limit.used_percentage)
    ? Math.round(limit.used_percentage)
    : null;
  const pctStr = pct === null ? '?' : `${pct}%`;
  const reset = limit.resets_at ? formatReset(limit.resets_at) : '?';
  return `${pctStr} (reset ${reset})`;
}

function formatReset(ts) {
  const d = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts);
  if (isNaN(d.getTime())) return '?';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hhmm = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return hhmm;
  const day = d.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '');
  return `${day} ${hhmm}`;
}
