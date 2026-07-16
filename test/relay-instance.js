// Simule UNE instance de l'extension (une fenêtre VS Code) qui possède l'onglet
// « Relais inter-fenêtres t… ». Écoute le relais et rapporte tout sur stdout.
const Module = require('module');
const path = require('path');
const EXT = path.join(__dirname, '..');

const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');

const stub = {
  window: {
    tabGroups: {
      all: [{
        viewColumn: 1,
        isActive: true,
        tabs: [
          { label: 'autre.md', input: { viewType: 'default' } },
          { label: 'Relais inter-fenêtres t…', input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } },
        ],
      }],
    },
  },
  commands: { executeCommand: async (cmd, arg) => say({ event: 'command', cmd, arg }) },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'vscode') return stub;
  return origLoad.call(this, req, ...rest);
};

// Les logs de focus.js (dont le résultat réel du raise) partent sur console.log.
console.log = (...a) => say({ event: 'log', msg: a.join(' ') });

const focus = require(path.join(EXT, 'focus.js'));
const relay = focus.createFocusRelay();
say({ event: 'ready', pid: process.pid });

process.on('SIGTERM', () => { relay.dispose(); process.exit(0); });
setTimeout(() => { relay.dispose(); process.exit(0); }, 20000);
