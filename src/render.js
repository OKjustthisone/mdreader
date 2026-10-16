import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';
import markdown from 'highlight.js/lib/languages/markdown';
import { isDiagramSource } from './diagram-source.js';
import { prepareDiagrams, disposeDiagrams } from './diagrams.js';
for (const [name, language] of Object.entries({ javascript, typescript, python, json, bash, css, xml, sql, markdown })) hljs.registerLanguage(name, language);
marked.setOptions({ gfm: true, breaks: false });
marked.use({ renderer: { checkbox({ checked }) { return `<span class="task-checkbox">${checked ? '☑' : '☐'}</span> `; } } });
// fileMode：在浏览器原生打开的 file:// 页面里阅读时，本地图片与 file 链接交给
// 页面自己按所在目录解析（DOMPurify 已挡掉脚本类 URL），无需像扩展页面那样剥离。
export function renderMarkdown(source, root, { fileMode = false } = {}) {
  disposeDiagrams(root);
  const html = isDiagramSource(source) ? marked.parser([{ type: 'code', lang: 'mermaid', text: source.trim() }]) : marked.parse(source);
  root.innerHTML = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'audio', 'video'],
    FORBID_ATTR: ['style', 'srcset', 'id', 'name', 'contenteditable', 'autofocus'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
  const outline = [];
  root.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((heading, index) => {
    heading.id = `heading-${index}`;
    outline.push({ id: heading.id, text: heading.textContent, level: +heading.tagName[1] });
  });
  // Task checkboxes are recreated only from the parser's safe list markup.
  // All navigation is handled by the reader, so untrusted HTML cannot navigate
  // the privileged extension page or access any extension URL.
  root.querySelectorAll('a').forEach(a => {
    const href = a.getAttribute('href') || '';
    a.removeAttribute('target');
    a.removeAttribute('download');
    a.setAttribute('rel', 'noopener noreferrer');
    if (/^(?:javascript|data|vbscript|chrome|chrome-extension):/i.test(href) || (!fileMode && /^file:/i.test(href))) a.removeAttribute('href');
  });
  root.querySelectorAll('img').forEach(img => {
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    const src = img.getAttribute('src') || '';
    if (!fileMode && !/^https?:\/\//i.test(src) && !/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(src)) {
      img.dataset.localPath = src;
      img.removeAttribute('src');
      img.alt = img.alt || '本地图片（请打开所在文件夹）';
    }
  });
  root.querySelectorAll('pre code').forEach(code => {
    const language = [...code.classList].find(item => item.startsWith('language-'))?.slice(9);
    if (language && hljs.getLanguage(language)) {
      code.innerHTML = hljs.highlight(code.textContent, { language, ignoreIllegals: true }).value;
    }
  });
  prepareDiagrams(root);
  return outline;
}
