// Turns the forwarder's API proxy on or off for every Claude Code session, by
// setting or removing ANTHROPIC_BASE_URL in the user-level settings file.
//
//   node scripts/user-proxy.mjs on | off | status
//
// While it is on, every session depends on the forwarder running. Nothing else
// in the settings file is read out or changed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mode = process.argv[2];
const PORT = process.env.AGENT_VIS_PORT || 4517;
const TARGET = `http://127.0.0.1:${PORT}`;
const file = path.join(os.homedir(), '.claude', 'settings.json');

if (!['on', 'off', 'status'].includes(mode)) {
  console.error('usage: node scripts/user-proxy.mjs on | off | status');
  process.exit(1);
}

const raw = fs.readFileSync(file, 'utf8');
const bom = raw.startsWith('﻿') ? '﻿' : '';
const settings = JSON.parse(raw.slice(bom.length));
const current = settings.env?.ANTHROPIC_BASE_URL;

if (mode === 'status') {
  console.log(current ? `proxy setting is on: ${current}` : 'proxy setting is off');
  process.exit(0);
}
if (current && current !== TARGET) {
  console.error(`ANTHROPIC_BASE_URL is already set to something else (${current}); leaving it alone`);
  process.exit(1);
}

if (mode === 'on') {
  try {
    const r = await fetch(`${TARGET}/health`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) throw new Error();
  } catch {
    console.error('the forwarder is not running (npm start); not changing settings');
    process.exit(1);
  }
  if (current === TARGET) {
    console.log('proxy setting is already on');
    process.exit(0);
  }
  settings.env = { ...(settings.env || {}), ANTHROPIC_BASE_URL: TARGET };
} else {
  if (!current) {
    console.log('proxy setting is already off');
    process.exit(0);
  }
  delete settings.env.ANTHROPIC_BASE_URL;
  if (Object.keys(settings.env).length === 0) delete settings.env;
}

const indent = /^\{\r?\n([ \t]+)"/.exec(raw.slice(bom.length))?.[1] ?? '  ';
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
let out = JSON.stringify(settings, null, indent).replace(/\n/g, eol);
if (/\n$/.test(raw)) out += eol;
fs.writeFileSync(file, bom + out);
console.log(`proxy setting turned ${mode} in ${file}`);
