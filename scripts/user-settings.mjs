// Reading and writing the user-level Claude Code settings file
// (~/.claude/settings.json) without disturbing what else is in it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PORT = process.env.AGENT_VIS_PORT || 4517;
export const FORWARDER = `http://127.0.0.1:${PORT}`;

// `--file <path>` on the command line points the scripts at another file, for testing.
const flag = process.argv.indexOf('--file');
export const settingsPath = flag > 0 ? path.resolve(process.argv[flag + 1]) : path.join(os.homedir(), '.claude', 'settings.json');

// Returns the parsed settings and how the file was formatted. A missing file is
// treated as empty settings.
export function readSettings() {
  if (!fs.existsSync(settingsPath)) return { settings: {}, format: { exists: false, bom: '', indent: '  ', eol: '\n', finalNewline: true } };
  const raw = fs.readFileSync(settingsPath, 'utf8');
  const bom = raw.startsWith('﻿') ? '﻿' : '';
  const text = raw.slice(bom.length);
  return {
    settings: text.trim() ? JSON.parse(text) : {},
    format: {
      exists: true,
      bom,
      indent: /^\{\r?\n([ \t]+)"/.exec(text)?.[1] ?? '  ',
      eol: raw.includes('\r\n') ? '\r\n' : '\n',
      finalNewline: /\n$/.test(raw),
    },
  };
}

// Writes the settings back in the file's own style. The first time a script
// changes an existing file it leaves a copy beside it.
export function writeSettings(settings, format) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const backup = settingsPath + '.before-agent-vis';
  if (format.exists && !fs.existsSync(backup)) fs.copyFileSync(settingsPath, backup);
  let out = JSON.stringify(settings, null, format.indent).replace(/\n/g, format.eol);
  if (format.finalNewline) out += format.eol;
  fs.writeFileSync(settingsPath, format.bom + out);
}

export async function forwarderRunning() {
  try {
    const r = await fetch(`${FORWARDER}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}
