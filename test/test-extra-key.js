// Banc de la clé de rendu ÉTENDUE (2026-08-06) — « la master reste à l'écran
// un moment avant de disparaître ».
//
// CE QUI ÉTAIT CASSÉ : le moteur ne notifie que si `renderKey` change, et cette
// clé ne décrit QUE la liste des conversations. Or le statut d'un groupe (et de
// sa ligne maîtresse) se déduit de sources que la liste ne porte pas — registre
// des sessions vivantes, sessions-state.json, onglet prouvé fermé. Fermer le
// dernier onglet d'un groupe fait donc DEUX choses décalées dans le temps : la
// conv quitte la vue (push), puis, quelques centaines de ms plus tard, la purge
// des hooks bascule la maîtresse en « terminée » — un recompute a bien lieu, mais
// sa clé est identique, donc rien n'est repoussé et le groupe reste affiché
// jusqu'à un événement sans rapport (« ça a disparu quand j'ai créé une
// nouvelle conversation »).
//
// Ce banc prouve les trois moitiés de la correction, sans toucher au disque de
// l'utilisateur (os.homedir monkeypatché avant le require de state.js).
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-extra-key-'));
os.homedir = () => SANDBOX;                       // AVANT le require de state.js
fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });

const state = require(path.join(__dirname, '..', 'state.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

const WS = 'C:\\Users\\Test\\Projets VSCODE\\ExtraKey';
fs.mkdirSync(state.projectDirFor(WS), { recursive: true });

// Moteur d'essai : aucune conversation (le projet est vide), donc `renderKey`
// rend TOUJOURS la même chose — tout onChange observé ici ne peut venir que de
// la clé supplémentaire. C'est exactement la situation du bug : la liste ne
// bouge plus, seul le statut du groupe bascule.
function engineWith(extraKey) {
  const seen = [];
  const engine = state.createStateEngine({
    workspacePath: WS,
    recentMs: 4 * 3600 * 1000,
    maxItems: 12,
    debounceMs: 5,
    tickMs: 3600 * 1000,                          // le tick ne doit pas s'en mêler
    tabs: () => ({ known: false, labels: [], activeLabel: null }),
    extraKey,
    onChange: () => seen.push(Date.now()),
  });
  return { engine, seen };
}

console.log('\n1. La clé supplémentaire change, les conversations non → le panneau est prévenu');
{
  let groupsKey = 'grp:master=idle';
  const { engine, seen } = engineWith(() => groupsKey);
  engine.refresh();                               // amorce (lastKey n'a pas l'extra)
  const after1 = seen.length;
  engine.refresh();                               // rien n'a bougé
  check('rien ne bouge → aucune notification (le garde-fou anti-bruit tient)',
    seen.length === after1, `${seen.length} vs ${after1}`);

  groupsKey = 'grp:master=done-closed';           // la maîtresse vient de basculer
  engine.refresh();
  check('bascule de statut de groupe → onChange (le groupe disparaît tout de suite)',
    seen.length === after1 + 1, `${seen.length} vs ${after1}`);

  groupsKey = 'grp:master=done-closed';
  engine.refresh();
  check('même clé ensuite → plus de notification', seen.length === after1 + 1, String(seen.length));
  engine.dispose();
}

console.log('\n2. Sans clé supplémentaire → comportement d\'avant, à l\'octet près');
{
  const { engine, seen } = engineWith(undefined);
  engine.refresh();
  engine.refresh();
  engine.refresh();
  check('aucune notification quand rien ne change dans la liste', seen.length === 0, String(seen.length));
  engine.dispose();
}

console.log('\n3. Une clé supplémentaire qui jette ne gèle pas le panneau');
{
  // Le doute profite à l'affichage (invariant du module) : si la signature est
  // inutilisable, on notifie plutôt que de rester muet — un push de trop est
  // bénin, un push manquant laisse une ligne morte à l'écran.
  const { engine, seen } = engineWith(() => { throw new Error('boom'); });
  engine.refresh();
  const n = seen.length;
  engine.refresh();
  check('signature en erreur → le panneau continue d\'être poussé',
    seen.length > n, `${seen.length} vs ${n}`);
  engine.dispose();
}

console.log(`\n${pass} ok, ${fail} fail`);
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
