// Turns the forwarder's API proxy on or off for every Claude Code session, by
// setting or removing ANTHROPIC_BASE_URL in the user-level settings file.
//
//   node scripts/user-proxy.mjs on | off | status
//
// While it is on, every terminal session depends on the forwarder running. The
// desktop app ignores this setting. Nothing else in the settings file is read
// out or changed.
import { FORWARDER, settingsPath, readSettings, writeSettings, forwarderRunning } from './user-settings.mjs';

const mode = process.argv[2];
if (!['on', 'off', 'status'].includes(mode)) {
  console.error('usage: node scripts/user-proxy.mjs on | off | status');
  process.exit(1);
}

const { settings, format } = readSettings();
const current = settings.env?.ANTHROPIC_BASE_URL;

if (mode === 'status') {
  console.log(current ? `proxy setting is on: ${current}` : 'proxy setting is off');
  process.exit(0);
}
if (current && current !== FORWARDER) {
  console.error(`ANTHROPIC_BASE_URL is already set to something else (${current}); leaving it alone`);
  process.exit(1);
}

if (mode === 'on') {
  if (!(await forwarderRunning())) {
    console.error('the forwarder is not running (npm start); not changing settings');
    process.exit(1);
  }
  if (current === FORWARDER) {
    console.log('proxy setting is already on');
    process.exit(0);
  }
  settings.env = { ...(settings.env || {}), ANTHROPIC_BASE_URL: FORWARDER };
} else {
  if (!current) {
    console.log('proxy setting is already off');
    process.exit(0);
  }
  delete settings.env.ANTHROPIC_BASE_URL;
  if (Object.keys(settings.env).length === 0) delete settings.env;
}

writeSettings(settings, format);
console.log(`proxy setting turned ${mode} in ${settingsPath}`);
