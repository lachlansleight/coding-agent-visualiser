// Page bootstrap: settings, the live connection (or a replayed recording),
// and the frame loop.
//
//   /                          live, from the forwarder's websocket
//   /?replay=sample            replay recordings/sample.jsonl in real time
//   /?replay=sample&speed=3    faster;  &loop=1 to repeat
import { DEFAULT_SETTINGS } from './config.js';
import { Store } from './model.js';
import { View } from './render.js';

const $ = (id) => document.getElementById(id);

// ---- settings (remembered per browser; the page works without storage)

const settings = { ...DEFAULT_SETTINGS };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem('agent-vis-settings') || '{}'));
} catch {}
const saveSettings = () => {
  try {
    localStorage.setItem('agent-vis-settings', JSON.stringify(settings));
  } catch {}
};

const expandAll = $('opt-expand-all');
const minOpen = $('opt-min-open');
const showGraph = $('opt-graph');
expandAll.checked = settings.expandAll;
minOpen.value = settings.minOpenSec;
showGraph.checked = settings.showGraph;
expandAll.addEventListener('change', () => {
  settings.expandAll = expandAll.checked;
  saveSettings();
});
minOpen.addEventListener('change', () => {
  settings.minOpenSec = Math.min(120, Math.max(0, Number(minOpen.value) || 0));
  saveSettings();
});
showGraph.addEventListener('change', () => {
  settings.showGraph = showGraph.checked;
  saveSettings();
});

// ---- store and view

const store = new Store();
const view = new View(store, settings, { app: $('app'), stage: $('stage'), rail: $('rail'), empty: $('empty') });
const conn = $('conn');
const params = new URLSearchParams(location.search);

function frame() {
  const now = Date.now();
  store.tick(now);
  view.frame(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- live

function connect() {
  let boot = null;
  let lastSeq = 0;
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    conn.textContent = 'live';
    conn.className = 'up';
  };
  ws.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.hello) {
      if (boot !== null && boot !== ev.boot) store.reset(); // the forwarder restarted
      if (boot !== ev.boot) lastSeq = 0;
      boot = ev.boot;
      return;
    }
    if (!ev.resend) {
      if (ev.seq <= lastSeq) return;
      lastSeq = ev.seq;
    }
    store.apply(ev);
  };
  ws.onclose = () => {
    conn.textContent = 'disconnected';
    conn.className = 'down';
    setTimeout(connect, 1000);
  };
}

// ---- replay

async function replay(name, speed, loop) {
  conn.textContent = 'replay';
  conn.className = 'replay';
  const info = $('replay-info');
  let events;
  try {
    const res = await fetch(`/recordings/${encodeURIComponent(name)}.jsonl`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    events = (await res.text()).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (e) {
    info.textContent = `could not load recording "${name}" (${e.message})`;
    return;
  }
  if (!events.length) {
    info.textContent = `recording "${name}" is empty`;
    return;
  }
  const first = events[0].ts;
  const span = (events[events.length - 1].ts - first) / speed;
  for (;;) {
    store.reset();
    const started = Date.now();
    let next = 0;
    await new Promise((done) => {
      const step = () => {
        const elapsed = Date.now() - started;
        // Events are re-stamped so the envelopes run against the present.
        while (next < events.length && (events[next].ts - first) / speed <= elapsed) {
          const ev = events[next++];
          store.apply({ ...ev, ts: started + (ev.ts - first) / speed });
        }
        info.textContent = `${name}  ${Math.min(elapsed, span) / 1000 | 0}s / ${span / 1000 | 0}s${speed !== 1 ? `  ×${speed}` : ''}`;
        if (next < events.length) requestAnimationFrame(step);
        else done();
      };
      step();
    });
    if (!loop) break;
    await new Promise((r) => setTimeout(r, 8000));
  }
}

if (params.get('replay')) replay(params.get('replay'), Math.max(0.1, Number(params.get('speed')) || 1), params.has('loop'));
else connect();

// For poking at state from the browser console.
window.agentVis = { store, view, settings };
