import DOMPurify from 'dompurify';
import { isDiagramSource } from './diagram-source.js';

let runtime;
let renderQueue = Promise.resolve();
const states = new WeakMap();
const font = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
const styles = `
  :host{display:block;margin:24px 0;border:1px solid var(--page-rule);border-radius:8px;overflow:hidden;background:var(--code-bg);color:var(--page-ink);font-family:${font};font-size:12px;line-height:1.6}
  *{box-sizing:border-box}[hidden]{display:none!important}
  header{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--page-rule);font-size:10px;color:var(--page-muted)}
  .label{letter-spacing:1px;margin-right:auto}.scale{min-width:34px;text-align:center;font-variant-numeric:tabular-nums;font-size:10px}
  button{border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:3px 7px;line-height:1.7}
  button:hover{background:var(--accent-soft);color:var(--accent)}button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
  .step{font-size:16px;line-height:1.2}.viewport{padding:20px 14px;overflow:auto;max-height:72vh;scrollbar-width:thin;scrollbar-color:#a5b49555 transparent}
  svg{display:block;margin:auto;max-width:none}svg text{user-select:none}
  .message{padding:26px 16px;text-align:center;font-size:12px;color:var(--page-muted)}.message.error{color:var(--page-ink);text-align:left;white-space:pre-line;overflow-wrap:anywhere}
  ::slotted(pre){margin:0!important;border:0!important;border-radius:0!important;background:transparent!important;max-height:420px;overflow:auto}
`;

// Keep the original code in the light DOM, even while the SVG is visible. This
// leaves article.textContent and existing text anchors unchanged during async
// rendering, theme changes, source toggles and annotation updates. The drawing
// and its controls live in a shadow tree, isolated from document styles/anchors.
export function prepareDiagrams(root) {
  for (const code of root.querySelectorAll('pre > code')) {
    const language = [...code.classList].find(item => item.startsWith('language-'))?.slice(9).toLowerCase();
    if (language !== 'mermaid' && (language || !isDiagramSource(code.textContent))) continue;
    const pre = code.parentElement;
    const host = document.createElement('div');
    host.className = 'mermaid-block';
    host.dataset.diagramState = 'pending';
    pre.replaceWith(host);
    pre.slot = 'source';
    host.append(pre);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${styles}</style><header><span class="label">MERMAID</span><button class="step" data-control="out" aria-label="缩小图表" title="缩小图表">−</button><span class="scale">适应</span><button class="step" data-control="in" aria-label="放大图表" title="放大图表">+</button><button data-control="fit" title="适应宽度">适应</button><button data-control="source" aria-expanded="false">查看源码</button></header><div class="message" role="status">正在绘制图表…</div><div class="viewport" hidden></div><div class="source" hidden><slot name="source"></slot></div>`;
    const state = { source: code.textContent, host, shadow, token: 0, signature: '', zoom: 1, fit: true, svg: null };
    states.set(host, state);
    shadow.addEventListener('click', event => {
      const control = event.target.closest('[data-control]')?.dataset.control;
      if (!control) return;
      if (control === 'source') {
        const sourceView = shadow.querySelector('.source');
        sourceView.hidden = !sourceView.hidden;
        event.target.textContent = sourceView.hidden ? '查看源码' : '收起源码';
        event.target.setAttribute('aria-expanded', String(!sourceView.hidden));
        return;
      }
      if (!state.svg) return;
      if (control === 'fit') state.fit = true;
      else { state.fit = false; state.zoom = Math.min(3, Math.max(.15, state.zoom + (control === 'in' ? .25 : -.25))); }
      sizeDiagram(state);
    });
    // The SVG only needs resizing when its container changes; no new layout or
    // text measurements are necessary for window/reader width changes.
    const observer = new ResizeObserver(() => {
      if (!host.isConnected) { observer.disconnect(); return; }
      if (state.svg && state.fit) sizeDiagram(state);
    });
    observer.observe(host);
    state.observer = observer;
  }
}
export function disposeDiagrams(root) {
  root.querySelectorAll('.mermaid-block').forEach(host => states.get(host)?.observer.disconnect());
}
function sizeDiagram(state) {
  const viewport = state.shadow.querySelector('.viewport');
  const box = state.svg.viewBox.baseVal;
  if (!box.width || !box.height) return;
  if (state.fit) state.zoom = Math.min(1, Math.max(.05, (viewport.clientWidth - 28) / box.width));
  state.svg.style.width = `${box.width * state.zoom}px`;
  state.svg.style.height = `${box.height * state.zoom}px`;
  state.shadow.querySelector('.scale').textContent = `${Math.round(state.zoom * 100)}%`;
}
function configuration(root) {
  const dark = document.documentElement.dataset.ui === 'dark';
  const background = getComputedStyle(root).getPropertyValue('--page').trim() || '#fbfaf7';
  const ink = dark ? '#dce3d7' : '#353a32';
  return {
    startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
    maxTextSize: 50000, maxEdges: 500, htmlLabels: false, layout: 'dagre',
    theme: 'base', fontFamily: font, logLevel: 'fatal',
    // Author-supplied init/frontmatter cannot change extension security or inject
    // global theme CSS. Ordinary diagram styles remain confined to its SVG.
    secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'htmlLabels', 'flowchart', 'layout', 'theme', 'themeVariables', 'themeCSS', 'fontFamily', 'dompurifyConfig'],
    themeVariables: {
      darkMode: dark, background, mainBkg: background, primaryColor: dark ? '#354633' : '#e8eedf',
      primaryTextColor: ink, primaryBorderColor: dark ? '#899d77' : '#8d9f7b',
      lineColor: dark ? '#b0bf9f' : '#7e8e70', secondaryColor: dark ? '#31433f' : '#e7efea',
      tertiaryColor: dark ? '#444334' : '#f3eddb', textColor: ink,
      edgeLabelBackground: background, fontSize: '16px',
    },
    flowchart: { htmlLabels: false, useMaxWidth: false, curve: 'basis' },
  };
}
function displayError(state, error) {
  state.host.dataset.diagramState = 'error';
  const message = state.shadow.querySelector('.message');
  message.hidden = false;
  message.classList.add('error');
  const detail = String(error?.message || error || '未知错误').split('\n').slice(0, 6).join('\n');
  message.textContent = `图表暂时无法绘制，源码已保留。\n${detail}`;
  state.shadow.querySelector('.source').hidden = false;
  const button = state.shadow.querySelector('[data-control="source"]');
  button.textContent = '收起源码'; button.setAttribute('aria-expanded', 'true');
}
export async function renderDiagrams(root, isCurrent = () => true) {
  const hosts = [...root.querySelectorAll('.mermaid-block')];
  if (!hosts.length) return;
  const config = configuration(root);
  const signature = JSON.stringify(config);
  const tasks = hosts.map(host => {
    const state = states.get(host);
    if (!state || state.signature === signature) return;
    state.signature = signature;
    const token = ++state.token;
    const valid = () => host.isConnected && root.contains(host) && isCurrent() && token === state.token;
    const task = renderQueue.then(async () => {
      if (!valid()) return;
      let scratch;
      try {
        if (state.source.length > config.maxTextSize) throw new Error('图表定义超过 50,000 字符，请拆分为较小的图表。');
        runtime ||= import('mermaid').then(module => module.default);
        const mermaid = await runtime;
        if (!valid()) return;
        mermaid.initialize(config);
        scratch = document.createElement('div');
        scratch.className = 'mermaid-measure';
        scratch.setAttribute('aria-hidden', 'true');
        Object.assign(scratch.style, { position: 'fixed', left: '-100000px', top: '0', visibility: 'hidden', pointerEvents: 'none' });
        document.body.append(scratch);
        const id = `inkstone-diagram-${crypto.randomUUID()}`;
        const { svg } = await mermaid.render(id, state.source, scratch);
        if (!valid()) return;
        const safe = DOMPurify.sanitize(svg, {
          USE_PROFILES: { svg: true, svgFilters: true }, RETURN_DOM_FRAGMENT: true,
          FORBID_TAGS: ['foreignObject', 'script', 'a', 'image'],
          ALLOW_DATA_ATTR: false,
        });
        const element = safe.querySelector('svg');
        if (!element) throw new Error('没有生成有效的 SVG 图表');
        const viewport = state.shadow.querySelector('.viewport');
        viewport.replaceChildren(element);
        state.svg = element;
        element.setAttribute('role', 'img');
        element.setAttribute('aria-label', 'Mermaid 图表');
        state.shadow.querySelector('.message').hidden = true;
        viewport.hidden = false;
        host.dataset.diagramState = 'ready';
        sizeDiagram(state);
      } catch (error) {
        if (valid()) displayError(state, error);
      } finally { scratch?.remove(); }
    });
    // Serializing initialization with rendering keeps dark/light configurations
    // and concurrent documents from sharing the wrong global Mermaid settings.
    renderQueue = task.catch(() => {});
    return task;
  });
  await Promise.all(tasks);
}
