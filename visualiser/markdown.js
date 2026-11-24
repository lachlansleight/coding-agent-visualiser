// Text rendering: syntax highlighting split into lines, and a small markdown
// renderer that copes with text that is still being written.
import hljs from '/vendor/highlight/es/highlight.min.js';
import { esc } from './util.js';

// Highlights code and returns one HTML string per line. A token that spans
// lines (a block comment, a template string) is closed and reopened at each
// line break so every line stands alone.
export function highlightLines(code, lang) {
  let html;
  try {
    html = lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value : esc(code);
  } catch {
    html = esc(code);
  }
  const lines = [];
  const open = [];
  let line = '';
  const tag = /<span class="([^"]*)">|<\/span>|\n/g;
  let last = 0;
  let m;
  while ((m = tag.exec(html))) {
    line += html.slice(last, m.index);
    last = tag.lastIndex;
    if (m[0] === '\n') {
      lines.push(line + '</span>'.repeat(open.length));
      line = open.map((c) => `<span class="${c}">`).join('');
    } else if (m[0] === '</span>') {
      open.pop();
      line += m[0];
    } else {
      open.push(m[1]);
      line += m[0];
    }
  }
  lines.push(line + html.slice(last) + '</span>'.repeat(open.length));
  return lines;
}

function inline(text) {
  let out = esc(text);
  const code = [];
  out = out.replace(/`([^`\n]+)`/g, (_, c) => {
    code.push(c);
    return `\u0000${code.length - 1}\u0000`;
  });
  out = out
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*\n]*)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '<span class="md-link">$1</span>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${code[i]}</code>`);
}

// Markdown to HTML: headings, lists, code fences, quotes, tables, emphasis.
// An unclosed code fence is treated as running to the end, so a reply looks
// right while it streams.
export function renderMarkdown(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const html = [];
  let paragraph = [];
  let list = null; // 'ul' | 'ol'
  const flushParagraph = () => {
    if (paragraph.length) html.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (list) html.push(`</${list}>`);
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```\s*([\w+-]*)/.exec(line);
    if (fence) {
      flushParagraph();
      closeList();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      const lang = { js: 'javascript', ts: 'typescript', sh: 'bash', shell: 'bash', py: 'python', yml: 'yaml' }[fence[1]] || fence[1];
      html.push(`<pre class="md-code"><code>${highlightLines(body.join('\n'), lang).join('\n')}</code></pre>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushParagraph();
      closeList();
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      i--;
      const cells = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).map((r) => r.trim().slice(1, -1).split('|').map((c) => c.trim()));
      html.push('<table class="md-table">' + cells.map((r, n) => `<tr>${r.map((c) => (n === 0 ? `<th>${inline(c)}</th>` : `<td>${inline(c)}</td>`)).join('')}</tr>`).join('') + '</table>');
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      const level = Math.min(4, heading[1].length);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      const kind = /\d/.test(item[2]) ? 'ol' : 'ul';
      if (list !== kind) {
        closeList();
        html.push(`<${kind}>`);
        list = kind;
      }
      html.push(`<li class="${item[1].length >= 2 ? 'nested' : ''}">${inline(item[3])}</li>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushParagraph();
      closeList();
      html.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`);
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      flushParagraph();
      closeList();
      html.push('<hr>');
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      // continuation of the previous list item
      html[html.length - 1] = html[html.length - 1].replace(/<\/li>$/, ` ${inline(line.trim())}</li>`);
      continue;
    }
    closeList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  closeList();
  return html.join('');
}
