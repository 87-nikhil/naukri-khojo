const { spawn } = require('node:child_process');

const children = [
  spawn(process.execPath, ['src/index.js'], { stdio: 'inherit', env: process.env }),
  spawn(process.execPath, ['src/automation/server.js'], { stdio: 'inherit', env: process.env }),
];
let stopping = false;

function stopAll(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(exitCode), 500).unref();
}

for (const child of children) {
  child.on('error', error => {
    console.error(`Could not start a server: ${error.message}`);
    stopAll(1);
  });
  child.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(`A server stopped (${signal || code}). Stopping both processes.`);
      stopAll(code || 1);
    }
  });
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
