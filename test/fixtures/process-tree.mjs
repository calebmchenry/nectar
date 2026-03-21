#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const heartbeatPath = process.argv[2];
if (!heartbeatPath) {
  process.stderr.write('usage: node process-tree.mjs <heartbeat-path>\n');
  process.exit(2);
}

const grandchildScript = `
const fs = require('node:fs');
const target = process.argv[1];
const beat = () => { try { fs.appendFileSync(target, 'g\\n'); } catch {} };
beat();
setInterval(beat, 80);
`;

const childScript = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const target = process.argv[1];
const beat = () => { try { fs.appendFileSync(target, 'c\\n'); } catch {} };
beat();
spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}, target], { stdio: 'ignore' });
setInterval(beat, 80);
`;

const beat = () => {
  try {
    appendFileSync(heartbeatPath, 'p\n');
  } catch {
    // ignore transient fs errors in fixture process
  }
};

beat();
spawn(process.execPath, ['-e', childScript, heartbeatPath], { stdio: 'ignore' });
setInterval(beat, 80);
