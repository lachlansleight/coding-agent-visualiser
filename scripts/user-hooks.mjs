// Adds or removes the forwarder's hooks in the user-level Claude Code settings,
// so every Claude Code session on this machine reports to the forwarder.
//
//   node scripts/user-hooks.mjs on | off | status
//
// The hooks are plain HTTP posts to the forwarder. When the forwarder is not
// running they fail quietly and sessions carry on as normal. Other hooks in the
// file are left alone.
import { FORWARDER, settingsPath, readSettings, writeSettings } from './user-settings.mjs';

const mode = process.argv[2];
if (!['on', 'off', 'status'].includes(mode)) {
  console.error('usage: node scripts/user-hooks.mjs on | off | status');
  process.exit(1);
}

const URL = `${FORWARDER}/hook`;
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'SubagentStart', 'SubagentStop', 'Stop', 'PreCompact', 'SessionEnd'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']); // these take a matcher
const isOurs = (hook) => hook && hook.type === 'http' && hook.url === URL;
const hasOurs = (groups) => Array.isArray(groups) && groups.some((g) => Array.isArray(g.hooks) && g.hooks.some(isOurs));

const { settings, format } = readSettings();
const installed = EVENTS.filter((event) => hasOurs(settings.hooks?.[event]));

if (mode === 'status') {
  if (installed.length === EVENTS.length) console.log(`hooks are on (${installed.length} events) in ${settingsPath}`);
  else if (installed.length) console.log(`hooks are partly on (${installed.length} of ${EVENTS.length} events); run "on" to complete them`);
  else console.log('hooks are off');
  process.exit(0);
}

if (mode === 'on') {
  if (installed.length === EVENTS.length) {
    console.log('hooks are already on');
    process.exit(0);
  }
  settings.hooks ||= {};
  for (const event of EVENTS) {
    if (hasOurs(settings.hooks[event])) continue;
    const group = { hooks: [{ type: 'http', url: URL, timeout: 2 }] };
    if (TOOL_EVENTS.has(event)) group.matcher = '*';
    (settings.hooks[event] ||= []).push(group);
  }
} else {
  if (!installed.length) {
    console.log('hooks are already off');
    process.exit(0);
  }
  for (const event of Object.keys(settings.hooks)) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((g) => (Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) } : g))
      .filter((g) => !Array.isArray(g.hooks) || g.hooks.length);
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
}

writeSettings(settings, format);
console.log(`hooks turned ${mode} in ${settingsPath}`);
