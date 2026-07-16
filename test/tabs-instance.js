// Simule UNE autre fenêtre VS Code : publie ses libellés d'onglets Claude via
// tabs.js, puis attend. argv[2] = sandbox (faux HOME), argv[3..] = libellés.
const Module = require('module');
const os = require('os');
const path = require('path');

const SANDBOX = process.argv[2];
const LABELS = process.argv.slice(3);
os.homedir = () => SANDBOX;

const stub = {
  window: {
    tabGroups: {
      all: [{
        viewColumn: 1,
        isActive: true,
        tabs: LABELS.map((label) => ({ label, input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } })),
      }],
      onDidChangeTabs: () => ({ dispose() {} }),
    },
  },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'vscode') return stub;
  return origLoad.call(this, req, ...rest);
};

const { createTabTracker } = require(path.join(__dirname, '..', 'tabs.js'));
const tracker = createTabTracker({});
process.stdout.write(JSON.stringify({ ready: true, pid: process.pid }) + '\n');

// Filet : ne jamais laisser traîner un process de test.
setTimeout(() => { tracker.dispose(); process.exit(0); }, 20000);
process.on('SIGTERM', () => { tracker.dispose(); process.exit(0); });
