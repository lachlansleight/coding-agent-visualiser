// Small helpers shared by the model and the views.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ESCAPES[c]);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---- paths

export const normPath = (p) => String(p ?? '').replace(/\\/g, '/');
export const pathKey = (p) => normPath(p).toLowerCase();
export const baseName = (p) => normPath(p).replace(/\/+$/, '').split('/').pop() || '';

// A path shown relative to the session's folder when it lies inside it.
export function relPath(p, cwd) {
  const full = normPath(p);
  const root = normPath(cwd).replace(/\/+$/, '');
  if (root && full.toLowerCase().startsWith(root.toLowerCase() + '/')) return full.slice(root.length + 1);
  return full;
}

const LANG_BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell',
  json: 'json', jsonl: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', md: 'markdown', html: 'xml',
  xml: 'xml', svg: 'xml', css: 'css', scss: 'scss', sql: 'sql', lua: 'lua', r: 'r', diff: 'diff',
};
export const langOf = (p) => LANG_BY_EXT[baseName(p).split('.').pop().toLowerCase()] || '';

// ---- time and numbers

export function fmtDuration(ms) {
  if (ms < 0 || !Number.isFinite(ms)) return '';
  if (ms < 10000) return (ms / 1000).toFixed(1) + 's';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtAgo(unixSeconds, now) {
  const s = Math.max(0, Math.round(now / 1000 - unixSeconds));
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

export const fmtCount = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n ?? 0));

export const truncate = (s, max) => (s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s);

// ---- streamed tool input

// Reads the top-level fields of a JSON object that is still arriving. String
// values are returned as far as they have got; `complete[key]` says whether the
// value has finished. Used to show a file path, command or file content while
// the model is still writing the tool call.
export function parsePartialObject(text) {
  const fields = {};
  const complete = {};
  const n = text.length;
  let i = text.indexOf('{');
  if (i < 0) return { fields, complete };
  i++;
  const skipSpace = () => {
    while (i < n && /\s/.test(text[i])) i++;
  };
  const readString = () => {
    i++; // opening quote
    let out = '';
    while (i < n) {
      const c = text[i];
      if (c === '"') {
        i++;
        return [out, true];
      }
      if (c === '\\') {
        if (i + 1 >= n) return [out, false];
        const e = text[i + 1];
        if (e === 'u') {
          if (i + 6 > n) return [out, false];
          out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
        } else {
          out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' }[e] ?? e;
          i += 2;
        }
        continue;
      }
      out += c;
      i++;
    }
    return [out, false];
  };

  while (i < n) {
    skipSpace();
    if (text[i] === ',') {
      i++;
      continue;
    }
    if (text[i] !== '"') break;
    const [key, keyClosed] = readString();
    if (!keyClosed) break;
    skipSpace();
    if (text[i] !== ':') break;
    i++;
    skipSpace();
    if (i >= n) break;
    if (text[i] === '"') {
      const [value, closed] = readString();
      fields[key] = value;
      complete[key] = closed;
      if (!closed) break;
      continue;
    }
    // number, boolean, null, array or object: take it only once it has ended
    const start = i;
    let depth = 0;
    let inString = false;
    let ended = false;
    for (; i < n; i++) {
      const c = text[i];
      if (inString) {
        if (c === '\\') i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        if (depth === 0) {
          ended = true;
          break;
        }
        depth--;
      } else if (c === ',' && depth === 0) {
        ended = true;
        break;
      }
    }
    if (!ended) break;
    try {
      fields[key] = JSON.parse(text.slice(start, i));
      complete[key] = true;
    } catch {
      break;
    }
  }
  return { fields, complete };
}

// ---- shell commands

// The forwarder prefixes Bash commands so their output can be watched live.
// Two forms: the current one sources a helper script; early recordings used an inline redirect.
const TEE_PREFIX = /^(?:\. '[^']*tee\.sh' '[^']*'; |exec > >\(tee -a '[^']*'\) 2> >\(tee -a '[^']*' >&2\); )/;
export const stripTee = (command) => String(command ?? '').replace(TEE_PREFIX, '');

const SEARCHERS = new Set(['grep', 'rg', 'find', 'fd', 'ag', 'ack', 'ls', 'dir', 'tree', 'where', 'which', 'locate', 'select-string', 'get-childitem', 'gci', 'findstr']);
const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'type', 'get-content', 'gc', 'wc', 'stat', 'file', 'pwd', 'jq', 'du', 'df']);
const WRITERS = new Set(['mkdir', 'touch', 'rm', 'rmdir', 'mv', 'cp', 'tee', 'chmod', 'ln', 'new-item', 'ni', 'remove-item', 'set-content', 'add-content', 'out-file', 'copy-item', 'move-item']);
const GIT_READ = new Set(['show', 'log', 'diff', 'status', 'blame', 'branch', 'remote', 'describe', 'rev-parse']);
const GIT_SEARCH = new Set(['grep', 'ls-files']);
const INSTALLERS = /^(npm|pnpm|yarn|pip|pip3|cargo|go|brew|apt|apt-get|choco|winget)$/;

// A rough guess at what a shell command does: 'read', 'search', 'write' or 'run'.
export function classifyShell(command) {
  const text = stripTee(command);
  if (/(^|[^0-9&>=-])>>?\s*(?!\/dev\/null|&|\$null)[^\s&|;]/.test(text)) return 'write';
  const kinds = new Set();
  for (const segment of text.split(/&&|\|\||[;|\n]/)) {
    const words = segment.trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    const first = (words[0] || '').toLowerCase().replace(/^.*[\\/]/, '').replace(/\.exe$/, '');
    const second = (words[1] || '').toLowerCase();
    if (!first || first === 'cd' || first === 'echo' || first === 'printf' || first === 'sleep') continue;
    if (first === 'git') kinds.add(GIT_READ.has(second) ? 'read' : GIT_SEARCH.has(second) ? 'search' : 'write');
    else if (first === 'sed') kinds.add(/\s-i/.test(segment) ? 'write' : 'read');
    else if (INSTALLERS.test(first) && /^(install|i|ci|add|remove|uninstall|update|upgrade)$/.test(second)) kinds.add('write');
    else if (WRITERS.has(first)) kinds.add('write');
    else if (SEARCHERS.has(first)) kinds.add('search');
    else if (READERS.has(first)) kinds.add('read');
    else kinds.add('run');
  }
  for (const kind of ['write', 'run', 'search', 'read']) if (kinds.has(kind)) return kind;
  return 'run';
}
