import { marked } from 'marked';
import createDOMPurify from 'dompurify';

const EMPHASIS_BOUNDARY = '\uFEFF\uE000';
const quotedCjkEmphasis = /(\*{2,3})([“‘「『《〈][^*\n]+[”’」』》〉])\1(?=\p{Script=Han})/gu;

function normalizeProseLine(line) {
  let output = '', cursor = 0;
  while (cursor < line.length) {
    const opening = line.indexOf('`', cursor);
    if (opening < 0) return output + line.slice(cursor).replace(quotedCjkEmphasis, `$1$2$1${EMPHASIS_BOUNDARY}`);
    let ticks = 1;
    while (line[opening + ticks] === '`') ticks++;
    const delimiter = '`'.repeat(ticks);
    const closing = line.indexOf(delimiter, opening + ticks);
    if (closing < 0) return output + line.slice(cursor).replace(quotedCjkEmphasis, `$1$2$1${EMPHASIS_BOUNDARY}`);
    output += line.slice(cursor, opening).replace(quotedCjkEmphasis, `$1$2$1${EMPHASIS_BOUNDARY}`);
    output += line.slice(opening, closing + ticks);
    cursor = closing + ticks;
  }
  return output;
}

function normalizeCjkEmphasis(markdown) {
  let fenceCharacter, fenceLength = 0;
  return String(markdown || '').split(/(\r?\n)/).map(part => {
    if (/^\r?\n$/.test(part)) return part;
    if (fenceCharacter) {
      const closing = new RegExp(`^ {0,3}\\${fenceCharacter}{${fenceLength},}[ \\t]*$`);
      if (closing.test(part)) { fenceCharacter = undefined; fenceLength = 0; }
      return part;
    }
    const opening = part.match(/^ {0,3}(`{3,}|~{3,})/);
    if (opening) {
      fenceCharacter = opening[1][0]; fenceLength = opening[1].length;
      return part;
    }
    return normalizeProseLine(part);
  }).join('');
}

export function renderMarkdown(text, win = window) {
  const purifier = createDOMPurify(win);
  const renderer = new marked.Renderer();
  // Model-provided raw HTML is shown as text, never interpreted.
  renderer.html = ({ text }) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  renderer.image = ({ text }) => text || '';
  const html = marked.parse(normalizeCjkEmphasis(text), { gfm: true, breaks: true, renderer });
  const clean = purifier.sanitize(html, {
    ALLOWED_TAGS: ['p','br','h1','h2','h3','h4','h5','h6','strong','em','del','blockquote','ul','ol','li','hr','pre','code','table','thead','tbody','tr','th','td','a'],
    ALLOWED_ATTR: ['href','title','class','start'], ALLOW_DATA_ATTR: false,
  });
  const template = win.document.createElement('template');
  template.innerHTML = clean;
  const walker = win.document.createTreeWalker(template.content, win.NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (!walker.currentNode.parentElement?.closest('code'))
      walker.currentNode.data = walker.currentNode.data.replaceAll(EMPHASIS_BOUNDARY, '');
  }
  for (const link of template.content.querySelectorAll('a')) {
    if (!/^(https?:\/\/|mailto:)/i.test(link.getAttribute('href') || '')) link.removeAttribute('href');
    link.setAttribute('target', '_blank'); link.setAttribute('rel', 'noopener noreferrer');
  }
  for (const pre of [...template.content.querySelectorAll('pre')]) {
    const wrap = win.document.createElement('div'); wrap.className = 'code-block';
    const head = win.document.createElement('div'); head.className = 'code-head';
    const label = win.document.createElement('span');
    label.textContent = pre.querySelector('code')?.className.replace('language-', '') || 'code';
    const button = win.document.createElement('button');
    button.type = 'button'; button.dataset.codeCopy = ''; button.textContent = 'Copy code';
    head.append(label, button); pre.replaceWith(wrap); wrap.append(head, pre);
  }
  for (const table of [...template.content.querySelectorAll('table')]) {
    const wrap = win.document.createElement('div'); wrap.className = 'table-scroll';
    table.replaceWith(wrap); wrap.append(table);
  }
  return template.innerHTML;
}
