import { marked } from 'marked';
import createDOMPurify from 'dompurify';
export function renderMarkdown(text, win = window) {
  const purifier = createDOMPurify(win);
  const renderer = new marked.Renderer();
  // Model-provided raw HTML is shown as text, never interpreted.
  renderer.html = ({ text }) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  renderer.image = ({ text }) => text || '';
  const html = marked.parse(text || '', { gfm: true, breaks: true, renderer });
  const clean = purifier.sanitize(html, {
    ALLOWED_TAGS: ['p','br','h1','h2','h3','h4','h5','h6','strong','em','del','blockquote','ul','ol','li','hr','pre','code','table','thead','tbody','tr','th','td','a'],
    ALLOWED_ATTR: ['href','title','class','start'], ALLOW_DATA_ATTR: false,
  });
  const template = win.document.createElement('template');
  template.innerHTML = clean;
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
