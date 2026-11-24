// Agent activity forwarder.
//
// One localhost process that gathers everything we can observe about a running
// Claude Code session and rebroadcasts it as a single event stream:
//
//   hook        POST /hook        payloads from Claude Code HTTP hooks; the reply
//                                 can rewrite a shell command (see teeRewrite)
//   proxy       everything else   pass-through to the Anthropic API, with the
//                                 streaming response teed token by token
//   transcript  file tail         new lines in the session transcript JSONL
//   stdout      file tail         live output of shell commands (tee rewrite)
//
// Clients (the web viewer, later a VS Code extension) connect to ws://…/ws.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.AGENT_VIS_PORT || 4517);
const HOST = '127.0.0.1';
const UPSTREAM = new URL(process.env.AGENT_VIS_UPSTREAM || 'https://api.anthropic.com');
const TEE_STDOUT = process.env.AGENT_VIS_TEE !== '0';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VIEWER = path.join(ROOT, 'viewer', 'index.html');
const TEE_DIR = path.join(os.tmpdir(), 'agent-vis', 'stdout');
const BOOT = Date.now().toString(36);

fs.mkdirSync(TEE_DIR, { recursive: true });

// ---------------------------------------------------------------- event bus

let seq = 0;
const backlog = [];
const BACKLOG_MAX = 3000;
const clients = new Set();

function emit(source, kind, data = {}, session) {
  const ev = { seq: ++seq, ts: Date.now(), source, kind, session: session || undefined, data };
  backlog.push(ev);
  if (backlog.length > BACKLOG_MAX) backlog.shift();
  const text = JSON.stringify(ev);
  for (const ws of clients) if (ws.readyState === 1) ws.send(text);
}

// Deep copy with long strings shortened, so one huge file read can't flood clients.
function clip(value, max = 4000, depth = 0) {
  if (typeof value === 'string') {
    return value.length > max ? `${value.slice(0, max)}…[+${value.length - max} chars]` : value;
  }
  if (value === null || typeof value !== 'object' || depth > 12) return value;
  if (Array.isArray(value)) return value.map((v) => clip(v, max, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = clip(v, max, depth + 1);
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- file tails

// Polls a growing file and hands over each new span of bytes.
function tailFile(file, { fromStart = false, intervalMs = 150, onData }) {
  let pos = 0;
  let busy = false;
  let stopped = false;
  if (!fromStart) {
    try {
      pos = fs.statSync(file).size;
    } catch {}
  }
  const tick = () => {
    if (busy || stopped) return;
    fs.stat(file, (err, st) => {
      if (err || busy || stopped) return;
      if (st.size < pos) pos = 0; // truncated or replaced
      if (st.size === pos) return;
      busy = true;
      const chunks = [];
      fs.createReadStream(file, { start: pos, end: st.size - 1 })
        .on('data', (c) => chunks.push(c))
        .on('error', () => (busy = false))
        .on('end', () => {
          const buf = Buffer.concat(chunks);
          pos += buf.length;
          busy = false;
          if (buf.length) onData(buf);
        });
    });
  };
  const timer = setInterval(tick, intervalMs);
  return {
    tick,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

// --- session transcript

const transcripts = new Map(); // path -> tail

function tailTranscript(file, session) {
  if (transcripts.has(file)) return;
  let rest = '';
  const decoder = new StringDecoder('utf8');
  const tail = tailFile(file, {
    intervalMs: 200,
    onData(buf) {
      const lines = (rest + decoder.write(buf)).split('\n');
      rest = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        emit('transcript', entry.type || 'unknown', summariseTranscript(entry), entry.sessionId || session);
      }
    },
  });
  transcripts.set(file, tail);
  emit('forwarder', 'transcript_tail_started', { file }, session);
}

function summariseTranscript(entry) {
  const out = {};
  for (const k of ['subtype', 'uuid', 'parentUuid', 'isSidechain', 'timestamp', 'thinkingDurationMs', 'thinkingDisplay', 'requestId']) {
    if (entry[k] !== undefined) out[k] = entry[k];
  }
  const msg = entry.message;
  if (msg && typeof msg === 'object') {
    out.role = msg.role;
    out.messageId = msg.id;
    out.stop_reason = msg.stop_reason;
    out.usage = msg.usage;
    const content = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content;
    if (Array.isArray(content)) {
      out.blocks = content.map((b) => {
        if (b.type === 'thinking') {
          return { type: 'thinking', chars: (b.thinking || '').length, signatureChars: (b.signature || '').length, thinking: clip(b.thinking || '', 2000) };
        }
        if (b.type === 'text') return { type: 'text', chars: b.text.length, text: clip(b.text, 2000) };
        if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: clip(b.input, 1000) };
        if (b.type === 'tool_result') return { type: 'tool_result', tool_use_id: b.tool_use_id, is_error: b.is_error, content: clip(b.content, 1000) };
        return { type: b.type };
      });
    }
  } else {
    // non-message bookkeeping lines: keep the keys so we can see what exists
    out.keys = Object.keys(entry);
  }
  return out;
}

// --- live shell stdout

const stdoutTails = new Map(); // tool_use_id -> { tail, file }

function startStdoutTail(id, file, session) {
  const decoder = new StringDecoder('utf8');
  const tail = tailFile(file, {
    fromStart: true,
    intervalMs: 80,
    onData(buf) {
      const text = decoder.write(buf);
      if (text) emit('stdout', 'chunk', { tool_use_id: id, text: clip(text, 8000) }, session);
    },
  });
  stdoutTails.set(id, { tail, file });
}

function stopStdoutTail(id) {
  const entry = stdoutTails.get(id);
  if (!entry) return;
  stdoutTails.delete(id);
  // give the last bytes a moment to land, then clean up
  setTimeout(() => {
    entry.tail.tick();
    setTimeout(() => {
      entry.tail.stop();
      fs.rm(entry.file, { force: true }, () => {});
    }, 300);
  }, 200);
}

// ---------------------------------------------------------------- hooks

// Reply for a Bash PreToolUse hook: prefix the command so its stdout and stderr
// are also appended to a file we tail. The command itself is otherwise untouched.
function teeRewrite(p) {
  const id = String(p.tool_use_id || `t${Date.now()}`).replace(/[^\w-]/g, '');
  const file = path.join(TEE_DIR, `${id}.log`).replace(/\\/g, '/');
  fs.writeFileSync(file, '');
  startStdoutTail(id, file, p.session_id);
  const prefix = `exec > >(tee -a '${file}') 2> >(tee -a '${file}' >&2); `;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { ...p.tool_input, command: prefix + p.tool_input.command },
    },
  };
}

async function handleHook(req, res) {
  let p;
  try {
    p = JSON.parse((await readBody(req)).toString('utf8'));
  } catch {
    res.writeHead(400).end();
    return;
  }
  const kind = p.hook_event_name || 'unknown';
  emit('hook', kind, clip(p), p.session_id);
  if (p.transcript_path) tailTranscript(p.transcript_path, p.session_id);

  let reply = null;
  if (kind === 'PreToolUse' && p.tool_name === 'Bash' && TEE_STDOUT && typeof p.tool_input?.command === 'string') {
    reply = teeRewrite(p);
  }
  if ((kind === 'PostToolUse' || kind === 'PostToolUseFailure') && p.tool_use_id) {
    stopStdoutTail(String(p.tool_use_id).replace(/[^\w-]/g, ''));
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(reply ? JSON.stringify(reply) : '');
}

// ---------------------------------------------------------------- API proxy

const upstreamAgent = new (UPSTREAM.protocol === 'https:' ? https : http).Agent({ keepAlive: true });
const upstreamLib = UPSTREAM.protocol === 'https:' ? https : http;
let reqCounter = 0;

// Header values that are safe and useful to show. Credentials are never emitted.
const SHOWN_HEADERS = /^(anthropic-version|anthropic-beta|user-agent|x-app|content-type)$|session|request-id/i;
const SECRET_HEADERS = /authorization|api-key|cookie|token/i;

function describeHeaders(headers) {
  const shown = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SHOWN_HEADERS.test(k) && !SECRET_HEADERS.test(k)) shown[k] = clip(String(v), 600);
  }
  return { names: Object.keys(headers), shown };
}

function describeRequestBody(body) {
  let j;
  try {
    j = JSON.parse(body.toString('utf8'));
  } catch {
    return { info: {}, session: undefined };
  }
  const session = /session_([0-9a-f-]{36})/.exec(j.metadata?.user_id || '')?.[1];
  const last = Array.isArray(j.messages) ? j.messages[j.messages.length - 1] : undefined;
  return {
    session,
    info: {
      model: j.model,
      stream: j.stream,
      max_tokens: j.max_tokens,
      thinking: j.thinking,
      output_config: j.output_config,
      messages: j.messages?.length,
      tools: j.tools?.length,
      lastMessageRole: last?.role,
      lastMessageBlocks: Array.isArray(last?.content) ? last.content.map((b) => b.type) : typeof last?.content,
      bodyKeys: Object.keys(j),
    },
  };
}

// Incremental server-sent-events parser.
function sseParser(onEvent) {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  return (chunk) => {
    buf += decoder.write(chunk);
    let m;
    while ((m = /\r?\n\r?\n/.exec(buf))) {
      const raw = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      let event = 'message';
      const data = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) onEvent(event, data.join('\n'));
    }
  };
}

function streamEmitter(req, session) {
  const blocks = new Map(); // index -> { type, name }
  return (event, dataText) => {
    let d;
    try {
      d = JSON.parse(dataText);
    } catch {
      emit('proxy', `stream.${event}`, { req, raw: clip(dataText, 2000) }, session);
      return;
    }
    const type = d.type || event;
    const out = { req };
    if (type === 'message_start') {
      out.messageId = d.message?.id;
      out.model = d.message?.model;
      out.usage = d.message?.usage;
    } else if (type === 'content_block_start') {
      const b = d.content_block || {};
      blocks.set(d.index, { type: b.type, name: b.name });
      out.index = d.index;
      out.block = b.type;
      out.name = b.name;
      out.id = b.id;
      out.start = clip(b, 500);
    } else if (type === 'content_block_delta') {
      const b = blocks.get(d.index) || {};
      const delta = d.delta || {};
      out.index = d.index;
      out.block = b.type;
      out.name = b.name;
      out.delta = delta.type;
      if (delta.type === 'text_delta') out.text = delta.text;
      else if (delta.type === 'thinking_delta') out.text = delta.thinking;
      else if (delta.type === 'input_json_delta') out.text = delta.partial_json;
      else if (delta.type === 'signature_delta') out.signatureChars = (delta.signature || '').length;
      else out.raw = clip(delta, 2000); // anything we don't know about yet
    } else if (type === 'content_block_stop') {
      const b = blocks.get(d.index) || {};
      out.index = d.index;
      out.block = b.type;
      out.name = b.name;
    } else if (type === 'message_delta') {
      out.delta = d.delta;
      out.usage = d.usage;
    } else if (type !== 'message_stop' && type !== 'ping') {
      out.raw = clip(d, 2000);
    }
    emit('proxy', `stream.${type}`, out, session);
  };
}

async function handleProxy(req, res) {
  const id = ++reqCounter;
  const started = Date.now();
  const body = await readBody(req);
  const pathOnly = req.url.split('?')[0];
  const isMessages = req.method === 'POST' && /\/v1\/messages$/.test(pathOnly);
  const { info, session } = isMessages ? describeRequestBody(body) : { info: {}, session: undefined };

  emit('proxy', 'request', { req: id, method: req.method, path: pathOnly, bytes: body.length, ...info, headers: describeHeaders(req.headers) }, session);

  const headers = { ...req.headers, host: UPSTREAM.host };
  delete headers['accept-encoding']; // keep the response uncompressed so the stream is readable
  delete headers.connection;

  const up = upstreamLib.request(
    {
      protocol: UPSTREAM.protocol,
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port || undefined,
      path: req.url,
      method: req.method,
      headers,
      agent: upstreamAgent,
    },
    (upRes) => {
      const contentType = String(upRes.headers['content-type'] || '');
      emit('proxy', 'response', { req: id, status: upRes.statusCode, contentType, ms: Date.now() - started }, session);
      res.writeHead(upRes.statusCode, upRes.headers);
      const feed = contentType.includes('text/event-stream') ? sseParser(streamEmitter(id, session)) : null;
      let bytes = 0;
      upRes.on('data', (c) => {
        bytes += c.length;
        res.write(c);
        if (feed) {
          try {
            feed(c);
          } catch (e) {
            emit('forwarder', 'stream_parse_error', { req: id, message: String(e) }, session);
          }
        }
      });
      upRes.on('end', () => {
        res.end();
        emit('proxy', 'response_end', { req: id, bytes, ms: Date.now() - started }, session);
      });
      upRes.on('error', (e) => {
        res.destroy();
        emit('proxy', 'error', { req: id, message: String(e) }, session);
      });
    },
  );
  up.on('error', (e) => {
    emit('proxy', 'error', { req: id, message: String(e) }, session);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('agent-vis proxy: upstream error');
  });
  res.on('close', () => {
    if (!res.writableFinished) up.destroy(); // client went away (e.g. user interrupted)
  });
  up.end(body);
}

// ---------------------------------------------------------------- server

const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

function isLocalHostHeader(req) {
  return LOCAL_HOSTS.has(String(req.headers.host || '').toLowerCase());
}

const server = http.createServer((req, res) => {
  const pathOnly = req.url.split('?')[0];
  const fail = (e) => {
    emit('forwarder', 'error', { message: String(e?.stack || e) });
    if (!res.headersSent) res.writeHead(500);
    res.end();
  };

  if (req.method === 'POST' && pathOnly === '/hook') {
    handleHook(req, res).catch(fail);
  } else if (req.method === 'GET' && (pathOnly === '/' || pathOnly === '/index.html')) {
    if (!isLocalHostHeader(req)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(VIEWER, (err, html) => {
      if (err) {
        res.writeHead(500).end('viewer missing');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    });
  } else if (pathOnly === '/favicon.ico') {
    res.writeHead(204).end(); // the viewer's own request; never send it upstream
  } else if (req.method === 'GET' && pathOnly === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, boot: BOOT, events: seq, clients: clients.size }));
  } else {
    handleProxy(req, res).catch(fail);
  }
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  // Browsers send Origin; only our own page may connect. Non-browser clients send none.
  const origin = req.headers.origin;
  const originOk = !origin || LOCAL_HOSTS.has(origin.replace(/^https?:\/\//, '').toLowerCase());
  if (req.url.split('?')[0] !== '/ws' || !isLocalHostHeader(req) || !originOk) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    ws.send(JSON.stringify({ hello: true, boot: BOOT }));
    for (const ev of backlog) ws.send(JSON.stringify(ev));
  });
});

server.listen(PORT, HOST, () => {
  console.log(`agent-vis forwarder on http://${HOST}:${PORT}`);
  console.log(`  viewer      http://${HOST}:${PORT}/`);
  console.log(`  hooks       POST http://${HOST}:${PORT}/hook`);
  console.log(`  api proxy   ANTHROPIC_BASE_URL=http://${HOST}:${PORT}  ->  ${UPSTREAM.origin}`);
  console.log(`  live stdout ${TEE_STDOUT ? `on (${TEE_DIR})` : 'off'}`);
  emit('forwarder', 'started', { port: PORT, upstream: UPSTREAM.origin, teeStdout: TEE_STDOUT });
});
