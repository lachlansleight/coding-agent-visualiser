// Records the forwarder's live event stream to a JSONL file, for replay in the
// visualiser (http://127.0.0.1:4517/?replay=<name>).
//
//   node scripts/record.mjs recordings/<name>.jsonl [--idle <seconds>]
//
// Only events that happen after the recorder starts are kept. Stop with Ctrl+C,
// or pass --idle to stop automatically once activity has paused that long.
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2];
if (!out) {
  console.error('usage: node scripts/record.mjs recordings/<name>.jsonl');
  process.exit(1);
}
const PORT = process.env.AGENT_VIS_PORT || 4517;
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
const stream = fs.createWriteStream(out);
const started = Date.now();
let count = 0;

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
ws.onopen = () => console.log(`recording to ${out}`);
ws.onmessage = (e) => {
  const ev = JSON.parse(e.data);
  if (ev.hello || ev.resend || ev.ts < started) return;
  stream.write(e.data + '\n');
  count++;
};
ws.onerror = () => {
  console.error('could not reach the forwarder; is it running (npm start)?');
  process.exit(1);
};
const finish = () => stream.end(() => {
  console.log(`\n${count} events recorded`);
  process.exit(0);
});
ws.onclose = finish;

// Optional: `--idle <seconds>` stops once events have started and then paused that long.
const idleAt = process.argv.indexOf('--idle');
if (idleAt > 0) {
  const idleMs = Number(process.argv[idleAt + 1] || 20) * 1000;
  let last = 0;
  ws.addEventListener('message', () => (last = Date.now()));
  setInterval(() => {
    if (count > 0 && Date.now() - last > idleMs) finish();
  }, 1000);
}
process.on('SIGINT', finish);
process.on('SIGTERM', finish);
