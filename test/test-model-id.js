#!/usr/bin/env node
// Tests de detectContextWindow() — incident 2026-07-15 : Sonnet 5 (1M natif,
// sans tag [1m]) affiché ctx 60% au lieu de 12% car l'ancienne heuristique
// listait les modèles 1M en dur. Règle désormais générationnelle : major ≥ 5.
// Lancement : node test/test-model-id.js

const { detectContextWindow, modelIdToDisplay } = require('../hooks/model-id');

let fails = 0;
function check(label, ok, got) {
  if (ok) { console.log(`  ok  ${label}`); }
  else { fails++; console.error(`FAIL  ${label} (obtenu: ${got})`); }
}

// Isoler des signaux d'environnement de la machine de test : env var, ET
// settings.json réel (os.homedir() suit USERPROFILE — un alias opus[1m] posé
// par l'user faisait passer TOUTES les attentes 200k à 1M, vécu 2026-07-15).
delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
const os = require('os');
const fsMod = require('fs');
const pathMod = require('path');
const fakeHome = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'quotabar-test-'));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;

function win(id, tokens) { return detectContextWindow(id, tokens); }

// Génération 5 : 1M par défaut, même sous 200k et sans tag.
check('claude-sonnet-5 à 146k → 1M (le bug de l\'incident)', win('claude-sonnet-5', 146000) === 1000000, win('claude-sonnet-5', 146000));
check('claude-fable-5 → 1M', win('claude-fable-5', 50000) === 1000000, win('claude-fable-5', 50000));

// Legacy figé.
check('claude-opus-4-8 → 1M', win('claude-opus-4-8', 50000) === 1000000, win('claude-opus-4-8', 50000));
check('claude-opus-4-7 → 1M', win('claude-opus-4-7', 50000) === 1000000, win('claude-opus-4-7', 50000));
check('claude-haiku-4-5-20251001 → 200k (minor 5 ≠ major 5)', win('claude-haiku-4-5-20251001', 50000) === 200000, win('claude-haiku-4-5-20251001', 50000));
check('claude-sonnet-4-6 → 200k', win('claude-sonnet-4-6', 50000) === 200000, win('claude-sonnet-4-6', 50000));

// Gardes prioritaires.
check('tag [1m] → 1M quel que soit le modèle', win('claude-sonnet-4-6[1m]', 50000) === 1000000, win('claude-sonnet-4-6[1m]', 50000));
check('usage > 200k → 1M même sur id inconnu', win('claude-nouveau-9x-inconnu', 250000) === 1000000, win('claude-nouveau-9x-inconnu', 250000));
check('id non parsable + usage < 200k → 200k', win('quelquechose-de-neuf', 50000) === 200000, win('quelquechose-de-neuf', 50000));

// Garde 4 : l'alias [1m] de settings.json ne vaut que pour SA famille.
fsMod.mkdirSync(pathMod.join(fakeHome, '.claude'), { recursive: true });
fsMod.writeFileSync(pathMod.join(fakeHome, '.claude', 'settings.json'), JSON.stringify({ model: 'sonnet[1m]' }));
check('alias sonnet[1m] → conv sonnet-4-6 en 1M', win('claude-sonnet-4-6', 50000) === 1000000, win('claude-sonnet-4-6', 50000));
check('alias sonnet[1m] → conv haiku reste 200k', win('claude-haiku-4-5-20251001', 50000) === 200000, win('claude-haiku-4-5-20251001', 50000));
fsMod.unlinkSync(pathMod.join(fakeHome, '.claude', 'settings.json'));

process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1';
check('CLAUDE_CODE_DISABLE_1M_CONTEXT=1 → 200k prioritaire', win('claude-sonnet-5', 146000) === 200000, win('claude-sonnet-5', 146000));
delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;

// Le rendu du nom ne casse pas au passage.
check('display Sonnet 5', modelIdToDisplay('claude-sonnet-5') === 'Sonnet 5', modelIdToDisplay('claude-sonnet-5'));

if (fails) { console.error(`\n${fails} échec(s)`); process.exit(1); }
console.log('\nTous les tests model-id passent.');
