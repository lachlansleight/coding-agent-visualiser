// Turns the forwarder's raw event stream into what the screen shows:
// sessions, each holding "tiles" (one per thing the agent is doing), each tile
// with an envelope that rises while the thing is happening and falls afterwards.
import { ENV, RELEASE_HOLD, LIMITS } from './config.js';
import { parsePartialObject, pathKey, baseName, classifyShell, stripTee } from './util.js';

const FILE_OPS = { Read: 'read', Write: 'write', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit' };
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'LS', 'WebSearch', 'ToolSearch']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);

function familyOf(name) {
  if (FILE_OPS[name]) return 'file';
  if (SHELL_TOOLS.has(name)) return 'shell';
  if (SEARCH_TOOLS.has(name)) return 'search';
  if (AGENT_TOOLS.has(name)) return 'agent';
  return 'tool';
}

// A tool's name as shown to people: connector tools lose their mcp__ plumbing.
export const toolLabel = (name) => String(name || '').replace(/^mcp__/, '').replace(/__/g, ' · ');

// ---------------------------------------------------------------- envelope

export function isGated(tile, now) {
  return tile.gates.size > 0 || now < tile.holdUntil;
}

// 0..1: how present a tile is at time `now`.
export function levelOf(tile, now) {
  const env = ENV[tile.env];
  let level;
  if (isGated(tile, now)) {
    level = Math.min(1, tile.base + (now - tile.onAt) / env.attack);
  } else {
    const floor = env.floor || 0;
    const x = (now - Math.max(tile.offAt, tile.holdUntil)) / env.release;
    if (x >= 1) level = floor;
    else {
      const y = x < RELEASE_HOLD ? 0 : (x - RELEASE_HOLD) / (1 - RELEASE_HOLD);
      level = Math.max(floor, 1 - y * y * (3 - 2 * y));
    }
  }
  if (tile.evictAt) level = Math.min(level, Math.max(0, 1 - (now - tile.evictAt) / 500));
  return level;
}

function rise(tile, ts) {
  if (!isGated(tile, ts)) {
    tile.base = levelOf(tile, ts);
    tile.onAt = ts;
  }
  tile.evictAt = 0;
  tile.holdUntil = Math.max(tile.holdUntil, ts + ENV[tile.env].attack + LIMITS.minGateMs);
  tile.pulseAt = ts;
}

function openGate(tile, gate, ts) {
  rise(tile, ts);
  tile.gates.add(gate);
}

function closeGate(tile, gate, ts) {
  if (tile.gates.delete(gate) && tile.gates.size === 0) tile.offAt = ts;
}

// Something momentary happened: light the tile without holding it open.
function touch(tile, ts) {
  rise(tile, ts);
  if (tile.gates.size === 0) tile.offAt = ts;
}

// ---------------------------------------------------------------- store

export class Store {
  constructor() {
    this.sessions = new Map();
    this.changed = 0; // bumped whenever the set of sessions changes
  }

  reset() {
    this.sessions.clear();
    this.changed++;
  }

  session(id, ts) {
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        id,
        cwd: '',
        name: id.slice(0, 8),
        model: '',
        firstSeen: ts,
        lastEvent: ts,
        lastActivity: ts,
        ended: false,
        hasProxy: false,
        phase: { name: 'idle', detail: '', since: ts },
        turnStart: 0,
        turnEnd: 0,
        turnTokens: 0,
        contextTokens: 0,
        tiles: new Map(),
        tools: new Map(), // tool_use id -> call record
        requests: new Map(), // proxy request number -> { lineage, blocks }
        lineages: new Map(), // request fingerprint -> { main, agentId }
        mainLineage: null,
        agents: new Map(), // agent id -> { id, type, toolId, done }
        unclaimedAgents: [], // started subagents whose requests we have not seen yet
        staleReply: new Set(), // reply tiles to clear when their next text starts
        git: null,
      };
      this.sessions.set(id, s);
      this.changed++;
    }
    return s;
  }

  // ---- tiles

  tile(s, key, kind, env, ts) {
    let tile = s.tiles.get(key);
    if (!tile) {
      tile = {
        key,
        kind,
        env,
        createdAt: ts,
        gates: new Set(),
        base: 0,
        onAt: ts,
        offAt: ts,
        holdUntil: 0,
        evictAt: 0,
        pulseAt: ts,
        version: 0,
        lineage: null,
        agentId: null,
      };
      s.tiles.set(key, tile);
      this.trim(s, ts);
    }
    return tile;
  }

  // Too many tiles: hurry the oldest quiet ones out.
  trim(s, ts) {
    const extra = s.tiles.size - LIMITS.maxTilesPerSession;
    if (extra <= 0) return;
    const quiet = [...s.tiles.values()]
      .filter((t) => !isGated(t, ts) && !t.evictAt && t.kind !== 'reply')
      .sort((a, b) => Math.max(a.offAt, a.holdUntil) - Math.max(b.offAt, b.holdUntil));
    for (const tile of quiet.slice(0, extra)) tile.evictAt = ts;
  }

  // Who a tile belongs to: null for the main agent, or { id, type } for a subagent.
  agentOf(s, tile) {
    const id = tile.agentId || (tile.lineage && s.lineages.get(tile.lineage)?.agentId);
    if (id) return s.agents.get(id) || { id, type: 'subagent' };
    if (tile.lineage && s.lineages.has(tile.lineage) && !s.lineages.get(tile.lineage).main) return { id: null, type: 'subagent' };
    return null;
  }

  textTile(s, kind, lineage, ts) {
    const main = !lineage || lineage === s.mainLineage;
    const key = `${kind}:${main ? 'main' : lineage}`;
    const env = kind === 'reply' ? (main ? 'reply' : 'subreply') : 'thinking';
    const tile = this.tile(s, key, kind, env, ts);
    tile.lineage = main ? null : lineage;
    tile.segments ||= [];
    return tile;
  }

  // ---- tool calls

  call(s, id, name, ts, lineage) {
    let call = s.tools.get(id);
    if (!call) {
      call = { id, name, family: familyOf(name), op: FILE_OPS[name] || null, lineage: lineage || null, agentId: null, input: {}, complete: {}, buffer: '', state: 'calling', startedAt: ts, result: null, error: null, live: '', tileKey: null };
      s.tools.set(id, call);
      if (s.tools.size > 400) s.tools.delete(s.tools.keys().next().value);
    }
    if (lineage && !call.lineage) call.lineage = lineage;
    return call;
  }

  // Makes sure a call has a tile once we know enough to place it. File tools
  // share one tile per file, so they wait until the path has arrived.
  place(s, call, ts) {
    if (call.tileKey) return s.tiles.get(call.tileKey) || null;
    let key;
    let env;
    if (call.family === 'file') {
      const path = call.input.file_path || call.input.notebook_path;
      if (!path || call.complete.file_path === false) return null;
      key = `file:${pathKey(path)}`;
      env = call.op === 'read' ? 'read' : 'write';
    } else {
      key = `tool:${call.id}`;
      env = { shell: 'shell', search: 'search', agent: 'agent', tool: 'tool' }[call.family];
    }
    const tile = this.tile(s, key, call.family, env, ts);
    tile.env = env;
    tile.call = call;
    tile.lineage = call.lineage;
    tile.agentId = call.agentId;
    call.tileKey = key;
    if (call.state !== 'done' && call.state !== 'failed') openGate(tile, call.id, ts);
    else touch(tile, ts);
    tile.version++;
    return tile;
  }

  finish(s, call, ts, keepOpen = false) {
    const tile = call.tileKey && s.tiles.get(call.tileKey);
    if (!tile) return;
    if (!keepOpen) closeGate(tile, call.id, ts);
    tile.pulseAt = ts;
    tile.version++;
  }

  // ---- event intake

  apply(ev) {
    if (!ev.session) return;
    const ts = ev.ts;
    const s = this.session(ev.session, ts);
    s.lastEvent = Math.max(s.lastEvent, ts);
    if (ev.source === 'hook') this.onHook(s, ev.kind, ev.data || {}, ts);
    else if (ev.source === 'proxy') this.onProxy(s, ev.kind, ev.data || {}, ts);
    else if (ev.source === 'stdout') this.onStdout(s, ev.data || {}, ts);
    else if (ev.source === 'transcript') this.onTranscript(s, ev.kind, ev.data || {}, ts);
    else if (ev.source === 'git') this.onGit(s, ev.data || {}, ts);
  }

  active(s, ts) {
    s.lastActivity = Math.max(s.lastActivity, ts);
    s.ended = false;
  }

  phase(s, name, detail, ts) {
    s.phase = { name, detail: detail || '', since: ts };
  }

  onHook(s, kind, d, ts) {
    if (d.cwd && d.cwd !== s.cwd) {
      s.cwd = d.cwd;
      s.name = baseName(d.cwd) || s.name;
    }
    if (kind === 'UserPromptSubmit') {
      this.active(s, ts);
      s.turnStart = ts;
      s.turnEnd = 0;
      s.turnTokens = 0;
      this.phase(s, 'starting', '', ts);
      for (const key of s.tiles.keys()) if (key.startsWith('reply:')) s.staleReply.add(key);
      const tile = this.tile(s, 'prompt', 'prompt', 'prompt', ts);
      const text = String(d.prompt || '');
      const notice = /^\s*<task-notification>/.test(text);
      tile.notice = notice;
      tile.text = notice ? (/<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1] || 'Background task finished').trim() : text;
      tile.version++;
      touch(tile, ts);
    } else if (kind === 'PreToolUse') {
      this.active(s, ts);
      const call = this.call(s, d.tool_use_id || `hook-${ts}`, d.tool_name, ts);
      call.input = d.tool_input || {};
      call.complete = {};
      call.state = 'running';
      call.startedAt = ts;
      if (d.agent_id) this.claimAgent(s, call, d.agent_id, d.agent_type);
      const tile = this.place(s, call, ts);
      if (tile) {
        openGate(tile, call.id, ts);
        tile.agentId = call.agentId;
        tile.version++;
      }
      this.phase(s, 'running', toolLabel(d.tool_name), ts);
    } else if (kind === 'PostToolUse' || kind === 'PostToolUseFailure') {
      this.active(s, ts);
      const call = this.call(s, d.tool_use_id || `hook-${ts}`, d.tool_name, ts);
      if (d.tool_input && !Object.keys(call.input).length) call.input = d.tool_input;
      if (d.agent_id) this.claimAgent(s, call, d.agent_id, d.agent_type);
      call.durationMs = d.duration_ms;
      if (kind === 'PostToolUse') {
        call.state = 'done';
        call.result = d.tool_response ?? null;
      } else {
        call.state = 'failed';
        call.error = String(d.error || 'failed');
      }
      this.place(s, call, ts);
      // A subagent launched in the background keeps running after its tool call returns.
      const background = call.family === 'agent' && call.result?.isAsync;
      if (background) {
        call.state = 'running';
        this.linkAgent(s, call, call.result.agentId);
      }
      this.finish(s, call, ts, background);
      this.phase(s, 'working', '', ts);
    } else if (kind === 'SubagentStart') {
      this.active(s, ts);
      const agent = this.agent(s, d.agent_id, d.agent_type);
      s.unclaimedAgents.push(agent.id);
      if (!agent.toolId) {
        // tie it to the oldest agent tool call that has no subagent yet
        for (const call of s.tools.values()) {
          if (call.family === 'agent' && !call.subagent && call.state !== 'failed') {
            this.linkAgent(s, call, agent.id);
            break;
          }
        }
      }
    } else if (kind === 'SubagentStop') {
      this.active(s, ts);
      const agent = this.agent(s, d.agent_id, d.agent_type);
      agent.done = true;
      s.unclaimedAgents = s.unclaimedAgents.filter((id) => id !== agent.id);
      const call = agent.toolId && s.tools.get(agent.toolId);
      if (call) {
        if (call.state === 'running' || call.state === 'calling') call.state = 'done';
        call.summary = d.last_assistant_message || call.summary;
        this.finish(s, call, ts);
      }
      for (const tile of s.tiles.values()) {
        if (this.agentOf(s, tile)?.id === agent.id && tile.kind !== 'agent') {
          for (const gate of [...tile.gates]) closeGate(tile, gate, ts);
        }
      }
    } else if (kind === 'Stop') {
      this.active(s, ts);
      s.turnEnd = ts;
      this.phase(s, 'idle', '', ts);
      if (!s.hasProxy && d.last_assistant_message) this.replyText(s, d.last_assistant_message, ts);
      // nothing of the main agent's is still happening once it stops
      for (const tile of s.tiles.values()) {
        if (this.agentOf(s, tile)) continue;
        if (tile.kind === 'agent' && tile.call?.state === 'running') continue;
        for (const gate of [...tile.gates]) closeGate(tile, gate, ts);
      }
    } else if (kind === 'Notification') {
      this.phase(s, 'needs you', d.message || d.title || '', ts);
    } else if (kind === 'SessionEnd') {
      s.ended = true;
      this.phase(s, 'ended', '', ts);
      for (const tile of s.tiles.values()) for (const gate of [...tile.gates]) closeGate(tile, gate, ts);
    }
  }

  agent(s, id, type) {
    let agent = s.agents.get(id);
    if (!agent) s.agents.set(id, (agent = { id, type: type || 'subagent', toolId: null, done: false }));
    if (type) agent.type = type;
    return agent;
  }

  linkAgent(s, call, agentId) {
    if (!agentId) return;
    const agent = this.agent(s, agentId);
    agent.toolId = call.id;
    call.subagent = agentId;
    if (call.input?.subagent_type && agent.type === 'subagent') agent.type = call.input.subagent_type;
  }

  // A hook told us which subagent made this call; remember that for the
  // request fingerprint too, so the subagent's text and thinking get its label.
  claimAgent(s, call, agentId, agentType) {
    this.agent(s, agentId, agentType);
    call.agentId = agentId;
    const lineage = call.lineage && s.lineages.get(call.lineage);
    if (lineage && !lineage.main && lineage.agentId !== agentId) {
      lineage.agentId = agentId;
      s.unclaimedAgents = s.unclaimedAgents.filter((id) => id !== agentId);
      for (const tile of s.tiles.values()) if (tile.lineage === call.lineage) tile.version++;
    }
  }

  onProxy(s, kind, d, ts) {
    if (kind === 'request') {
      // Only requests that carry tools belong to an agent loop; the rest are
      // housekeeping (titles, summaries) and are not shown.
      if (!d.tools || !d.stream) return;
      s.hasProxy = true;
      if (d.model) s.model = d.model;
      const hash = d.systemHash || 'main';
      if (!s.lineages.has(hash)) {
        if (s.unclaimedAgents.length) s.lineages.set(hash, { main: false, agentId: s.unclaimedAgents.shift() });
        else if (!s.mainLineage) {
          s.mainLineage = hash;
          s.lineages.set(hash, { main: true, agentId: null });
        } else s.lineages.set(hash, { main: false, agentId: null });
      }
      s.requests.set(d.req, { lineage: hash, blocks: new Map() });
      if (s.requests.size > 60) s.requests.delete(s.requests.keys().next().value);
      return;
    }
    const request = s.requests.get(d.req);
    if (!request) return;
    const lineage = request.lineage;
    const gate = `${d.req}:${d.index}`;

    if (kind === 'stream.content_block_start') {
      this.active(s, ts);
      const block = { type: d.block, toolId: d.id };
      request.blocks.set(d.index, block);
      if (d.block === 'thinking') {
        const tile = this.textTile(s, 'thinking', lineage, ts);
        // Keep the previous thought on screen until this one has words of its
        // own: some steps send a thinking block with no text at all.
        tile.text ||= '';
        tile.replaceText = true;
        tile.startedAt = ts;
        tile.endedAt = 0;
        tile.version++;
        openGate(tile, gate, ts);
        this.phase(s, 'thinking', '', ts);
      } else if (d.block === 'text') {
        const tile = this.textTile(s, 'reply', lineage, ts);
        if (s.staleReply.delete(tile.key)) tile.segments = [];
        tile.segments.push({ id: gate, text: '' });
        tile.version++;
        openGate(tile, gate, ts);
        this.phase(s, 'writing', '', ts);
      } else if (d.block === 'tool_use' || d.block === 'server_tool_use') {
        const call = this.call(s, d.id, d.name, ts, lineage);
        this.place(s, call, ts);
        this.phase(s, 'calling', toolLabel(d.name), ts);
      }
    } else if (kind === 'stream.content_block_delta') {
      this.active(s, ts);
      const block = request.blocks.get(d.index);
      if (!block) return;
      if (block.type === 'thinking') {
        const tile = this.textTile(s, 'thinking', lineage, ts);
        if (d.text) {
          if (tile.replaceText) tile.text = '';
          tile.replaceText = false;
          tile.text = (tile.text + d.text).slice(-LIMITS.replyChars);
          tile.version++;
        }
        tile.pulseAt = ts;
      } else if (block.type === 'text') {
        const tile = this.textTile(s, 'reply', lineage, ts);
        const segment = tile.segments.find((x) => x.id === gate);
        if (segment && d.text) {
          segment.text += d.text;
          tile.version++;
          tile.pulseAt = ts;
        }
      } else if (block.toolId && d.delta === 'input_json_delta') {
        const call = s.tools.get(block.toolId);
        if (!call || call.state !== 'calling') return;
        call.buffer += d.text || '';
        const parsed = parsePartialObject(call.buffer);
        call.input = parsed.fields;
        call.complete = parsed.complete;
        const tile = this.place(s, call, ts);
        if (tile) {
          tile.version++;
          tile.pulseAt = ts;
        }
      }
    } else if (kind === 'stream.content_block_stop') {
      const block = request.blocks.get(d.index);
      if (!block) return;
      if (block.type === 'thinking') {
        const tile = this.textTile(s, 'thinking', lineage, ts);
        tile.endedAt = ts;
        tile.version++;
        closeGate(tile, gate, ts);
      } else if (block.type === 'text') {
        const tile = this.textTile(s, 'reply', lineage, ts);
        tile.version++;
        closeGate(tile, gate, ts);
      } else if (block.toolId) {
        const call = s.tools.get(block.toolId);
        if (call) {
          for (const key of Object.keys(call.complete)) call.complete[key] = true;
          const tile = this.place(s, call, ts);
          if (tile) tile.version++;
        }
      }
    } else if (kind === 'stream.message_delta') {
      const usage = d.usage || {};
      s.turnTokens += usage.output_tokens || 0;
      if (lineage === s.mainLineage) {
        s.contextTokens = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
      }
    }
  }

  onStdout(s, d, ts) {
    const call = s.tools.get(d.tool_use_id);
    if (!call) return;
    this.active(s, ts);
    call.live = (call.live + (d.text || '')).slice(-LIMITS.outputChars);
    const tile = call.tileKey && s.tiles.get(call.tileKey);
    if (tile) {
      tile.version++;
      tile.pulseAt = ts;
    }
  }

  // Sessions with no proxied stream (the desktop app) still get their text
  // from the transcript, a block at a time.
  onTranscript(s, kind, d, ts) {
    if (s.hasProxy || kind !== 'assistant' || !Array.isArray(d.blocks)) return;
    for (const block of d.blocks) {
      if (block.type === 'text' && block.text) this.replyText(s, block.text, ts);
      if (block.type === 'thinking') {
        this.active(s, ts);
        const tile = this.textTile(s, 'thinking', null, ts);
        tile.text = block.thinking || '';
        tile.startedAt = d.thinkingDurationMs ? ts - d.thinkingDurationMs : ts;
        tile.endedAt = ts;
        tile.version++;
        touch(tile, ts);
      }
    }
  }

  replyText(s, text, ts) {
    this.active(s, ts);
    const tile = this.textTile(s, 'reply', null, ts);
    if (s.staleReply.delete(tile.key)) tile.segments = [];
    if (tile.segments.some((x) => x.text === text)) return;
    tile.segments.push({ id: `t${ts}`, text });
    tile.version++;
    touch(tile, ts);
  }

  onGit(s, d, ts) {
    const known = new Set((s.git?.commits || []).map((c) => c.sha));
    const first = !s.git;
    const arrivals = new Map(s.git?.arrivals || []);
    for (const c of d.commits || []) if (!first && !known.has(c.sha)) arrivals.set(c.sha, ts);
    s.git = { cwd: d.cwd, branch: d.branch, head: d.head, commits: d.commits || [], arrivals, version: (s.git?.version || 0) + 1 };
  }

  // ---- housekeeping, once per frame

  tick(now) {
    for (const [id, s] of this.sessions) {
      const idle = now - s.lastEvent;
      if (idle > LIMITS.sessionIdleMs || (s.ended && idle > LIMITS.sessionEndedMs)) {
        this.sessions.delete(id);
        this.changed++;
        continue;
      }
      for (const [key, tile] of s.tiles) {
        if (!isGated(tile, now) && levelOf(tile, now) <= 0.0005) s.tiles.delete(key);
      }
    }
  }
}

// The text a reply tile shows: every message of the turn so far.
export function replyTextOf(tile) {
  const text = tile.segments.map((x) => x.text).filter((t) => t.trim()).join('\n\n');
  return text.length > LIMITS.replyChars ? text.slice(-LIMITS.replyChars) : text;
}

// The command a shell call ran, without the forwarder's live-output prefix.
export const commandOf = (call) => stripTee(call.input?.command || '');
export const shellKindOf = (call) => classifyShell(call.input?.command || '');
