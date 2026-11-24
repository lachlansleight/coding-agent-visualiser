// Draws the store: sessions across the stage, a mosaic of tiles inside each,
// and the commit graph in the rail. Runs once per animation frame.
import { ENV, SIZE_STEPS, LIMITS } from './config.js';
import { levelOf, isGated, replyTextOf, commandOf, shellKindOf, toolLabel } from './model.js';
import { Mosaic, layoutSessions, layoutGraph } from './layout.js';
import { renderMarkdown, highlightLines } from './markdown.js';
import { esc, clamp, relPath, baseName, langOf, fmtDuration, fmtAgo, fmtCount, truncate } from './util.js';

const GAP = 6; // space between tiles
const HEAD = 30; // session header height
const STRIP = 34; // thickness of a collapsed session
const ROW = 24; // commit graph row height
const LANE = 14; // commit graph lane width

const sizeStep = (level) => {
  for (const [min, share] of SIZE_STEPS) if (level >= min) return share;
  return 0;
};

const setText = (el, text) => {
  if (el.textContent !== text) el.textContent = text;
};

export class View {
  constructor(store, settings, els) {
    this.store = store;
    this.settings = settings;
    this.stage = els.stage;
    this.rail = els.rail;
    this.empty = els.empty;
    this.app = els.app;
    this.views = new Map(); // session id -> view state
    this.lastFrame = 0;
    this.size = { w: this.stage.clientWidth, h: this.stage.clientHeight };
    new ResizeObserver(() => {
      this.size = { w: this.stage.clientWidth, h: this.stage.clientHeight };
    }).observe(this.stage);
    this.graph = { key: '', at: 0 };
  }

  frame(now) {
    const dt = Math.min(120, now - (this.lastFrame || now));
    this.lastFrame = now;
    const sessions = [...this.store.sessions.values()].sort((a, b) => a.firstSeen - b.firstSeen);

    for (const [id, v] of this.views) {
      if (!this.store.sessions.has(id)) {
        v.el.remove();
        this.views.delete(id);
      }
    }
    for (const s of sessions) if (!this.views.has(s.id)) this.views.set(s.id, this.createSession(s));
    this.empty.hidden = sessions.length > 0;

    // The session that acted most recently is the one being followed.
    let focus = null;
    for (const s of sessions) if (!focus || s.lastActivity > focus.lastActivity) focus = s;

    const minOpen = this.settings.minOpenSec * 1000;
    const ease = 1 - Math.exp(-dt / LIMITS.openEaseMs);
    for (const s of sessions) {
      const v = this.views.get(s.id);
      const want =
        this.settings.expandAll ||
        v.pinned ||
        s === focus ||
        now - s.lastActivity < LIMITS.activeWindowMs ||
        (v.isOpen && now - v.openedAt < minOpen);
      if (want && !v.isOpen) v.openedAt = now;
      v.isOpen = want;
      const target = want ? 1 : 0;
      v.open += (target - v.open) * ease;
      if (Math.abs(target - v.open) < 0.003) v.open = target;
    }

    this.drawRail(focus, sessions, now);

    const stage = { x: 0, y: 0, w: this.size.w, h: this.size.h };
    const { row, rects } = layoutSessions(stage, sessions.map((s) => this.views.get(s.id)), STRIP);
    sessions.forEach((s, i) => this.drawSession(s, this.views.get(s.id), rects[i], row, now, dt, s === focus));
  }

  // ---------------------------------------------------------------- sessions

  createSession(s) {
    const el = document.createElement('section');
    el.className = 'session';
    el.innerHTML =
      '<header class="s-head" title="Click to keep this session open">' +
      '<span class="s-dot"></span><span class="s-name"></span><span class="s-phase"></span>' +
      '<span class="s-spacer"></span><span class="s-stats"></span><span class="s-pin">pinned</span>' +
      '</header><div class="s-body"></div>';
    this.stage.append(el);
    const v = {
      el,
      head: el.querySelector('.s-head'),
      dot: el.querySelector('.s-dot'),
      name: el.querySelector('.s-name'),
      phase: el.querySelector('.s-phase'),
      stats: el.querySelector('.s-stats'),
      body: el.querySelector('.s-body'),
      mosaic: new Mosaic(),
      tiles: new Map(), // tile key -> tile view
      rects: new Map(),
      open: 0,
      isOpen: false,
      openedAt: 0,
      pinned: false,
      headAt: 0,
      box: '',
    };
    v.head.addEventListener('click', () => {
      v.pinned = !v.pinned;
      el.classList.toggle('pinned', v.pinned);
    });
    return v;
  }

  drawSession(s, v, rect, row, now, dt, isFocus) {
    const box = `${rect.x.toFixed(1)},${rect.y.toFixed(1)},${rect.w.toFixed(1)},${rect.h.toFixed(1)}`;
    if (box !== v.box) {
      v.box = box;
      v.el.style.transform = `translate(${rect.x.toFixed(1)}px, ${rect.y.toFixed(1)}px)`;
      v.el.style.width = rect.w.toFixed(1) + 'px';
      v.el.style.height = rect.h.toFixed(1) + 'px';
    }
    const collapsed = v.open < 0.5;
    v.el.classList.toggle('collapsed', collapsed);
    v.el.classList.toggle('upright', collapsed && row);
    v.el.classList.toggle('focus', isFocus);

    if (now - v.headAt > 200) {
      v.headAt = now;
      this.drawHead(s, v, now);
    }

    const showBody = v.open > 0.04;
    v.body.hidden = !showBody;
    if (!showBody) return;

    // Tiles: add views for new tiles, let departed ones shrink away.
    for (const [key, tile] of s.tiles) {
      if (!v.tiles.has(key)) v.tiles.set(key, this.createTile(v, key, tile));
    }
    const weightEase = 1 - Math.exp(-dt / LIMITS.weightEaseMs);
    for (const [key, tv] of v.tiles) {
      const tile = s.tiles.get(key);
      tv.level = tile ? levelOf(tile, now) : 0;
      const target = tile ? ENV[tile.env].weight * sizeStep(tv.level) * tv.need : 0;
      tv.weight += (target - tv.weight) * weightEase;
      if (!tile && tv.weight < 0.004) {
        tv.el.remove();
        v.mosaic.remove(key);
        v.tiles.delete(key);
      }
    }

    const area = { x: GAP / 2, y: 0, w: Math.max(0, rect.w - GAP), h: Math.max(0, rect.h - HEAD - GAP / 2) };
    v.rects.clear();
    v.mosaic.layout(area, (key) => v.tiles.get(key)?.weight || 0, v.rects);

    for (const [key, tv] of v.tiles) {
      const tile = s.tiles.get(key);
      const r = v.rects.get(key);
      const w = r ? r.w - GAP : 0;
      const h = r ? r.h - GAP : 0;
      const visible = w >= 40 && h >= 22;
      if (visible !== tv.visible) {
        tv.visible = visible;
        tv.el.hidden = !visible;
      }
      if (!visible) continue;
      const tileBox = `${(r.x + GAP / 2).toFixed(1)},${(r.y + GAP / 2).toFixed(1)},${w.toFixed(1)},${h.toFixed(1)}`;
      const moved = tileBox !== tv.box;
      if (moved) {
        tv.box = tileBox;
        tv.el.style.transform = `translate(${(r.x + GAP / 2).toFixed(1)}px, ${(r.y + GAP / 2).toFixed(1)}px)`;
        tv.el.style.width = w.toFixed(1) + 'px';
        tv.el.style.height = h.toFixed(1) + 'px';
        const size = this.fontSize(tv.kind, w, h);
        if (size !== tv.fontSize) {
          tv.fontSize = size;
          tv.el.style.setProperty('--fs', size + 'px');
        }
        tv.el.classList.toggle('short', h < 64);
      }
      if (!tile) continue;

      const gated = isGated(tile, now);
      if (gated !== tv.gated) {
        tv.gated = gated;
        tv.el.classList.toggle('gated', gated);
      }
      const level = Math.round(tv.level * 50) / 50;
      if (level !== tv.shownLevel) {
        tv.shownLevel = level;
        tv.el.style.setProperty('--level', level);
      }
      const pulse = Math.round(clamp(1 - (now - tile.pulseAt) / 700, 0, 1) * 10) / 10;
      if (pulse !== tv.shownPulse) {
        tv.shownPulse = pulse;
        tv.el.style.setProperty('--pulse', pulse);
      }

      const wait = gated ? 80 : 0;
      let drew = false;
      if (tile.version !== tv.version && now - tv.drawnAt >= wait) {
        tv.version = tile.version;
        tv.drawnAt = now;
        this.drawTile(s, tile, tv, now);
        drew = true;
      } else if (tv.meta && now - tv.metaAt > 200) {
        tv.metaAt = now;
        setText(tv.metaEl, tv.meta(now));
      }
      if (drew || moved) this.scrollTile(tv);
    }
  }

  drawHead(s, v, now) {
    setText(v.name, s.name);
    const p = s.phase;
    const timed = p.name === 'thinking' || p.name === 'running' || p.name === 'writing' || p.name === 'calling';
    setText(v.phase, [p.name, p.detail && truncate(p.detail, 60), timed ? fmtDuration(now - p.since) : ''].filter(Boolean).join(' '));
    v.el.dataset.phase = p.name.replace(/\s/g, '-');
    const stats = [];
    if (s.turnStart) stats.push(fmtDuration((s.turnEnd || now) - s.turnStart));
    if (s.turnTokens) stats.push(`${fmtCount(s.turnTokens)} tokens out`);
    if (s.contextTokens) stats.push(`context ${fmtCount(s.contextTokens)}`);
    const running = [...s.agents.values()].filter((a) => !a.done).length;
    if (running) stats.push(`${running} subagent${running > 1 ? 's' : ''}`);
    if (s.model) stats.push(s.model.replace(/^claude-/, ''));
    setText(v.stats, stats.join('  ·  '));
  }

  // ---------------------------------------------------------------- tiles

  createTile(v, key, tile) {
    const el = document.createElement('article');
    el.className = 'tile';
    el.dataset.kind = tile.kind;
    el.hidden = true;
    el.innerHTML =
      '<header class="t-head"><span class="t-label"></span><span class="t-agent" hidden></span>' +
      '<span class="t-title"></span><span class="t-meta"></span></header><div class="t-body"></div>';
    v.body.append(el);
    v.mosaic.add(key, (k) => v.tiles.get(k)?.weight || 0);
    return {
      el,
      kind: tile.kind,
      labelEl: el.querySelector('.t-label'),
      agentEl: el.querySelector('.t-agent'),
      titleEl: el.querySelector('.t-title'),
      metaEl: el.querySelector('.t-meta'),
      bodyEl: el.querySelector('.t-body'),
      weight: 0,
      need: 1,
      level: 0,
      version: -1,
      drawnAt: 0,
      metaAt: 0,
      meta: null,
      visible: false,
      box: '',
      scroll: 'top',
    };
  }

  fontSize(kind, w, h) {
    const side = Math.sqrt(w * h);
    const raw = kind === 'reply' ? clamp(side / 30, 13, 21) : kind === 'thinking' || kind === 'prompt' || kind === 'agent' ? clamp(side / 34, 12, 17) : clamp(side / 42, 10.5, 14);
    return Math.round(raw * 2) / 2;
  }

  scrollTile(tv) {
    const body = tv.bodyEl;
    if (tv.scroll === 'bottom') body.scrollTop = body.scrollHeight;
    else if (tv.scroll === 'top') body.scrollTop = 0;
    else if (tv.scroll === 'mark') {
      const mark = body.querySelector('.mark');
      if (mark) body.scrollTop = Math.max(0, mark.offsetTop - body.clientHeight / 3);
    }
  }

  drawTile(s, tile, tv, now) {
    const draw = DRAW[tile.kind] || DRAW.tool;
    const out = draw(s, tile, now, this.store);
    tv.el.dataset.tone = out.tone;
    setText(tv.labelEl, out.label);
    setText(tv.titleEl, out.title || '');
    tv.titleEl.title = out.title || '';
    const agent = this.store.agentOf(s, tile);
    tv.agentEl.hidden = !agent;
    if (agent) setText(tv.agentEl, agent.type);
    tv.el.classList.toggle('sub', !!agent);
    tv.meta = typeof out.meta === 'function' ? out.meta : null;
    setText(tv.metaEl, typeof out.meta === 'function' ? out.meta(now) : out.meta || '');
    tv.bodyEl.innerHTML = out.html;
    tv.need = out.need;
    tv.scroll = out.scroll || 'top';
  }

  // ---------------------------------------------------------------- commit graph

  drawRail(focus, sessions, now) {
    // Follow the focused session's repository; fall back to any session that has one.
    const s = (focus?.git && focus) || sessions.find((x) => x.git) || null;
    const show = this.settings.showGraph && !!s && this.app.clientWidth >= 760;
    if (this.app.classList.contains('with-rail') !== show) this.app.classList.toggle('with-rail', show);
    if (!show) return;
    const rows = Math.max(1, Math.floor((this.rail.clientHeight - 40) / ROW));
    const key = `${s.id}:${s.git.version}:${rows}`;
    if (key === this.graph.key && now - this.graph.at < 30000) return;
    this.graph = { key, at: now };

    const commits = s.git.commits.slice(0, rows);
    const { rows: placed, edges, width } = layoutGraph(commits);
    const x = (col) => 12 + col * LANE;
    const y = (row) => row * ROW + ROW / 2;
    const bottom = commits.length * ROW;
    const paths = edges.map((e) => {
      const x1 = x(e.fromCol);
      const y1 = y(e.fromRow);
      const xl = x(e.lane);
      const x2 = x(e.toCol);
      const y2 = e.toRow === null ? bottom : y(e.toRow);
      let d = `M${x1} ${y1}`;
      let yy = y1;
      if (xl !== x1) {
        yy = Math.min(y2, y1 + ROW);
        d += ` C${x1} ${y1 + ROW / 2} ${xl} ${y1 + ROW / 2} ${xl} ${yy}`;
      }
      if (x2 !== xl && e.toRow !== null) {
        const turn = Math.max(yy, y2 - ROW);
        d += ` L${xl} ${turn} C${xl} ${turn + ROW / 2} ${x2} ${turn + ROW / 2} ${x2} ${y2}`;
      } else d += ` L${xl} ${y2}`;
      return `<path d="${d}" class="lane-${e.lane % 6}"/>`;
    });
    const dots = placed.map((r, i) => `<circle cx="${x(r.col)}" cy="${y(i)}" r="${r.commit.sha === s.git.head ? 5 : 3.5}" class="lane-${r.col % 6}${r.commit.sha === s.git.head ? ' head' : ''}"/>`);
    const pad = 12 + width * LANE + 4;
    const list = placed.map((r) => {
      const c = r.commit;
      const arrived = s.git.arrivals.get(c.sha);
      const fresh = arrived && now - arrived < 30000;
      const refs = c.refs
        .map((ref) => ref.replace(/^HEAD -> /, '').replace(/^tag: /, ''))
        .filter((ref) => ref && ref !== 'HEAD' && !ref.includes('/HEAD'))
        .slice(0, 2)
        .map((ref) => `<span class="g-ref">${esc(truncate(ref, 18))}</span>`)
        .join('');
      return (
        `<div class="g-row${fresh ? ' fresh' : ''}${c.sha === s.git.head ? ' head' : ''}" style="padding-left:${pad}px" title="${esc(c.subject)}">` +
        `<span class="g-subject">${esc(truncate(c.subject, LIMITS.commitSubjectChars))}</span>${refs}` +
        `<span class="g-meta">${fmtAgo(c.time, now)}</span></div>`
      );
    });
    this.rail.innerHTML =
      `<div class="g-head"><span class="g-repo">${esc(baseName(s.git.cwd))}</span><span class="g-branch">${esc(s.git.branch)}</span></div>` +
      `<div class="g-rows"><svg width="${pad}" height="${bottom}" viewBox="0 0 ${pad} ${bottom}">${paths.join('')}${dots.join('')}</svg>${list.join('')}</div>`;
  }
}

// ---------------------------------------------------------------- tile content

const linesOf = (text) => (text ? text.split('\n').length : 0);
const needFor = (lines, per, lo = 0.45, hi = 1.6) => clamp(lines / per, lo, hi);

function codeHtml(text, lang, startLine, fromEnd) {
  let lines = highlightLines(text.replace(/\r/g, ''), lang);
  let first = startLine;
  let cut = 0;
  if (lines.length > LIMITS.codeLines) {
    cut = lines.length - LIMITS.codeLines;
    if (fromEnd) {
      lines = lines.slice(cut);
      first += cut;
    } else lines = lines.slice(0, LIMITS.codeLines);
  }
  const rows = lines.map((html, i) => `<div class="ln"><span class="no">${first + i}</span><span class="src">${html || ' '}</span></div>`);
  if (cut && !fromEnd) rows.push(`<div class="more">… ${cut} more lines</div>`);
  return `<div class="code">${rows.join('')}</div>`;
}

function patchHtml(hunks, lang) {
  const out = [];
  let marked = false;
  hunks.forEach((hunk, n) => {
    if (n) out.push('<div class="gap">⋯</div>');
    const html = highlightLines(hunk.lines.map((l) => l.slice(1)).join('\n'), lang);
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    hunk.lines.forEach((line, i) => {
      const sign = line[0];
      const cls = sign === '+' ? 'add' : sign === '-' ? 'del' : '';
      const no = sign === '-' ? oldNo++ : sign === '+' ? newNo++ : (oldNo++, newNo++);
      const mark = cls && !marked ? ' mark' : '';
      if (mark) marked = true;
      out.push(`<div class="ln ${cls}${mark}"><span class="no">${no}</span><span class="sign">${cls ? sign : ''}</span><span class="src">${html[i] || ' '}</span></div>`);
    });
  });
  return `<div class="code diff">${out.join('')}</div>`;
}

function draftDiffHtml(oldText, newText, lang) {
  const side = (text, cls, sign) =>
    highlightLines(text.replace(/\r/g, ''), lang)
      .map((html) => `<div class="ln ${cls}"><span class="no"></span><span class="sign">${sign}</span><span class="src">${html || ' '}</span></div>`)
      .join('');
  return `<div class="code diff">${oldText ? side(oldText, 'del', '-') : ''}${newText ? side(newText, 'add', '+') : ''}</div>`;
}

const runningMeta = (call) => (now) => (call.state === 'running' || call.state === 'calling' ? fmtDuration(now - call.startedAt) : call.durationMs != null ? fmtDuration(call.durationMs) : '');

function resultText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) return result.map((b) => (b && typeof b.text === 'string' ? b.text : JSON.stringify(b))).join('\n');
  if (Array.isArray(result.content)) return resultText(result.content);
  return JSON.stringify(result, null, 1);
}

const DRAW = {
  reply(s, tile) {
    const text = replyTextOf(tile);
    return {
      tone: 'reply',
      label: 'Reply',
      meta: text ? `${text.trim().split(/\s+/).length} words` : '',
      html: `<div class="md">${renderMarkdown(text)}</div>`,
      // a subagent's reply can be a word or two; the main reply always keeps room
      need: needFor(text.length / 70 + linesOf(text), 16, tile.env === 'subreply' ? 0.2 : 0.5, 1.6),
      scroll: 'bottom',
    };
  },

  thinking(s, tile) {
    const text = tile.text || '';
    return {
      tone: 'thinking',
      label: 'Thinking',
      meta: (now) => fmtDuration((tile.endedAt || now) - tile.startedAt),
      html: text ? `<div class="think">${esc(text)}</div>` : '<div class="think quiet">No thinking text was sent for this step.</div>',
      need: text ? needFor(text.length / 80 + linesOf(text), 14, 0.5, 1.4) : 0.15,
      scroll: 'bottom',
    };
  },

  prompt(s, tile) {
    const text = truncate(tile.text || '', 1500);
    return {
      tone: 'prompt',
      label: tile.notice ? 'Notice' : 'Prompt',
      html: `<div class="prompt-text">${esc(text)}</div>`,
      need: needFor(text.length / 70 + linesOf(text), 12, 0.35, 1),
    };
  },

  file(s, tile) {
    const call = tile.call;
    const input = call.input || {};
    const path = input.file_path || input.notebook_path || '';
    const lang = langOf(path);
    const title = relPath(path, s.cwd);
    if (call.state === 'failed') {
      return { tone: 'fail', label: call.op, title, meta: 'failed', html: `<pre class="out err">${esc(call.error)}</pre>`, need: 0.5 };
    }
    if (call.op === 'read') {
      const file = call.result?.file;
      if (!file || typeof file.content !== 'string') {
        const range = input.offset != null ? `from line ${input.offset}` : '';
        return { tone: 'read', label: 'Read', title, meta: range, html: '<div class="pending">reading…</div>', need: 0.5 };
      }
      const start = file.startLine || 1;
      const count = file.numLines || linesOf(file.content);
      const whole = file.totalLines && count >= file.totalLines;
      return {
        tone: 'read',
        label: 'Read',
        title,
        meta: whole ? `${count} lines` : `lines ${start}–${start + count - 1} of ${file.totalLines || '?'}`,
        html: codeHtml(file.content, lang, start, false),
        need: needFor(count, 24),
      };
    }
    if (call.op === 'write') {
      const content = input.content || '';
      const writing = call.state === 'calling';
      const created = call.result?.type === 'create';
      return {
        tone: 'create',
        label: writing ? 'Writing' : created ? 'New file' : call.result ? 'Rewritten' : 'Write',
        title,
        meta: `${linesOf(content)} lines`,
        html: codeHtml(content, lang, 1, writing),
        need: needFor(linesOf(content), 24),
        scroll: writing ? 'bottom' : 'top',
      };
    }
    // edit
    const hunks = call.result?.structuredPatch;
    if (Array.isArray(hunks) && hunks.length) {
      const all = hunks.flatMap((h) => h.lines);
      const added = all.filter((l) => l[0] === '+').length;
      const removed = all.filter((l) => l[0] === '-').length;
      return { tone: 'edit', label: 'Edit', title, meta: `+${added} −${removed}`, html: patchHtml(hunks, lang), need: needFor(all.length + hunks.length, 22), scroll: 'mark' };
    }
    const oldText = input.old_string || '';
    const newText = input.new_string || '';
    return {
      tone: 'edit',
      label: call.state === 'calling' ? 'Editing' : 'Edit',
      title,
      html: draftDiffHtml(oldText, newText, lang),
      need: needFor(linesOf(oldText) + linesOf(newText), 22),
      scroll: 'bottom',
    };
  },

  shell(s, tile) {
    const call = tile.call;
    const command = commandOf(call);
    const kind = { read: 'reads', search: 'searches', write: 'changes files', run: 'runs' }[shellKindOf(call)];
    let output = call.live;
    if (!output && call.result) {
      const err = String(call.result.stderr || '').replace(/\n?Shell cwd was reset to .*$/m, '');
      output = [call.result.stdout, err].filter(Boolean).join('\n');
    }
    if (!output && call.error) output = call.error;
    const exit = /^Exit code (\d+)/.exec(call.error || '');
    if (exit && output === call.error) output = output.replace(/^Exit code \d+\n?/, '');
    const failed = call.state === 'failed';
    const meta = runningMeta(call);
    return {
      tone: failed ? 'fail' : 'shell',
      label: `Shell · ${kind}`,
      title: call.input?.description || '',
      meta: (now) => [failed ? (exit ? `exit ${exit[1]}` : 'failed') : '', meta(now)].filter(Boolean).join(' · '),
      html: `<div class="cmd"><span class="ps">$</span> ${esc(command)}</div>` + (output ? `<pre class="out">${esc(output.replace(/\r/g, ''))}</pre>` : ''),
      need: needFor(linesOf(command) + linesOf(output) + 1, 18),
      scroll: 'bottom',
    };
  },

  search(s, tile) {
    const call = tile.call;
    const input = call.input || {};
    const r = call.result;
    const query = input.pattern ?? input.query ?? input.path ?? '';
    let body = '';
    let count = '';
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      const files = Array.isArray(r.filenames) ? r.filenames.map((f) => relPath(f, s.cwd)) : [];
      body = r.content || files.join('\n');
      if (r.numLines != null && r.content) count = `${r.numLines} lines`;
      else if (files.length || r.numFiles != null) count = `${r.numFiles ?? files.length} files`;
    } else if (r) body = resultText(r);
    if (call.state === 'failed') body = call.error;
    const where = [input.path && relPath(input.path, s.cwd), input.glob, input.type && `type ${input.type}`].filter(Boolean).join('  ');
    return {
      tone: call.state === 'failed' ? 'fail' : 'search',
      label: call.name,
      title: String(query),
      meta: count || runningMeta(call),
      html: (where ? `<div class="where">in ${esc(where)}</div>` : '') + (body ? `<pre class="out">${esc(truncate(body, LIMITS.outputChars))}</pre>` : call.state === 'done' ? '<div class="pending">no matches</div>' : '<div class="pending">searching…</div>'),
      need: needFor(linesOf(body) + 2, 18, 0.4, 1.4),
    };
  },

  agent(s, tile) {
    const call = tile.call;
    const input = call.input || {};
    const summary = call.summary || (call.result && !call.result.isAsync ? resultText(call.result) : '');
    const done = call.state === 'done';
    return {
      tone: call.state === 'failed' ? 'fail' : 'agent',
      label: 'Subagent',
      title: input.description || input.subagent_type || '',
      meta: (now) => (done ? 'finished' : `running ${fmtDuration(now - call.startedAt)}`),
      html:
        (input.prompt ? `<div class="ask">${esc(truncate(input.prompt, 500))}</div>` : '') +
        (summary ? `<div class="md">${renderMarkdown(truncate(summary, 4000))}</div>` : call.state === 'failed' ? `<pre class="out err">${esc(call.error)}</pre>` : ''),
      need: needFor(linesOf(summary) + summary.length / 70 + 3, 16, 0.45, 1.3),
      scroll: summary ? 'bottom' : 'top',
    };
  },

  tool(s, tile) {
    const call = tile.call;
    const input = Object.entries(call.input || {})
      .map(([k, v]) => `<div class="kv"><span class="k">${esc(k)}</span> ${esc(truncate(typeof v === 'string' ? v : JSON.stringify(v), 300))}</div>`)
      .join('');
    const result = call.state === 'failed' ? call.error : resultText(call.result);
    return {
      tone: call.state === 'failed' ? 'fail' : 'tool',
      label: toolLabel(call.name),
      meta: runningMeta(call),
      html: input + (result ? `<pre class="out">${esc(truncate(result, 2000))}</pre>` : ''),
      need: needFor(Object.keys(call.input || {}).length + linesOf(result) + 1, 16, 0.35, 1.1),
    };
  },
};
