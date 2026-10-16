import * as db from './db.js';

const stateKey = 'panel-layout';
const minWidth = 200;
const maxWidth = 520;
const readerMinWidth = 360;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
function normalize(raw) {
  const width = value => Number.isFinite(value) ? clamp(value, minWidth, maxWidth) : null;
  return { left: width(raw?.left), right: width(raw?.right) };
}

export async function initResizablePanels({ onError, onSave } = {}) {
  const panels = [
    { name: 'left', element: document.getElementById('sidebar'), handle: document.getElementById('left-panel-resizer'), variable: '--sidebar-width', direction: 1 },
    { name: 'right', element: document.getElementById('right-panel'), handle: document.getElementById('right-panel-resizer'), variable: '--right-panel-width', direction: -1 },
  ];
  let preferred = normalize(await db.get('state', stateKey));
  let drag = null;
  let frame;
  let revision = 0;
  const pendingWidths = new Set();
  const fail = error => onError?.(error);
  const visible = panel => getComputedStyle(panel.element).display !== 'none';
  const docked = panel => !['absolute', 'fixed'].includes(getComputedStyle(panel.element).position);
  const defaultWidth = panel => parseFloat(getComputedStyle(panel.element).getPropertyValue('--default-panel-width'));

  function fit() {
    const width = document.querySelector('.app-shell').clientWidth;
    const shown = panels.filter(visible);
    const dockedPanels = shown.filter(docked);
    const sizes = Object.fromEntries(panels.map(panel => [panel.name, preferred[panel.name] ?? defaultWidth(panel)]));
    const available = Math.max(0, width - readerMinWidth);
    const total = dockedPanels.reduce((sum, panel) => sum + sizes[panel.name], 0);
    if (total > available) {
      // Reduce visible docked panels proportionally; narrowing a window must
      // never overwrite the larger size the user chose on a wider window.
      const floor = Math.min(minWidth, available / dockedPanels.length);
      const extra = total - floor * dockedPanels.length;
      const room = Math.max(0, available - floor * dockedPanels.length);
      for (const panel of dockedPanels) sizes[panel.name] = floor + (extra ? (sizes[panel.name] - floor) / extra * room : 0);
    }
    for (const panel of panels) {
      if (!shown.includes(panel)) continue;
      let limit = maxWidth;
      if (!docked(panel)) {
        const left = panels[0];
        const occupied = panel.name === 'right' && shown.includes(left) && docked(left) ? sizes.left : 0;
        limit = Math.min(maxWidth, Math.max(120, width - occupied - 48));
        sizes[panel.name] = Math.min(sizes[panel.name], limit);
      } else {
        const other = dockedPanels.filter(item => item !== panel).reduce((sum, item) => sum + sizes[item.name], 0);
        limit = Math.min(maxWidth, Math.max(120, available - other));
      }
      const size = Math.round(sizes[panel.name]);
      panel.element.style.setProperty(panel.variable, `${size}px`);
      panel.handle.setAttribute('aria-valuemin', String(Math.min(minWidth, limit)));
      panel.handle.setAttribute('aria-valuemax', String(Math.floor(limit)));
      panel.handle.setAttribute('aria-valuenow', String(size));
      panel.handle.setAttribute('aria-valuetext', `${size} 像素`);
    }
  }
  function scheduleFit() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(fit);
  }
  async function persist(panel) {
    const keys = new Set([...pendingWidths, panel.name]);
    const values = Object.fromEntries([...keys].map(key => [key, preferred[key]]));
    pendingWidths.clear();
    await db.mutate('state', stateKey, old => ({ ...normalize(old), ...values }));
    onSave?.();
  }
  function setWidth(panel, width) {
    const min = +panel.handle.getAttribute('aria-valuemin');
    const max = +panel.handle.getAttribute('aria-valuemax');
    // During an explicit resize, keep the other visible panel where it is.
    // Window resizing alone preserves preferences, but a fresh user adjustment
    // commits the visible layout so the dragged edge follows the pointer.
    for (const other of panels.filter(item => item !== panel && visible(item))) {
      const shownWidth = Math.round(other.element.getBoundingClientRect().width);
      if (Math.abs(shownWidth - (preferred[other.name] ?? defaultWidth(other))) > 1) {
        preferred[other.name] = shownWidth;
        pendingWidths.add(other.name);
      }
    }
    preferred[panel.name] = Math.round(clamp(width, min, max));
    pendingWidths.add(panel.name);
    revision++;
    fit();
  }
  function finish(cancelled = false) {
    if (!drag) return;
    const current = drag;
    drag = null;
    document.body.classList.remove('resizing-panels');
    current.panel.handle.classList.remove('is-resizing');
    if (current.panel.handle.hasPointerCapture(current.pointerId)) current.panel.handle.releasePointerCapture(current.pointerId);
    if (cancelled) {
      preferred = current.previous;
      pendingWidths.clear();
      revision++;
      fit();
    } else if (current.moved) persist(current.panel).catch(fail);
  }
  for (const panel of panels) {
    panel.handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || drag) return;
      event.preventDefault();
      fit();
      drag = { panel, pointerId: event.pointerId, startX: event.clientX, startWidth: panel.element.getBoundingClientRect().width, previous: { ...preferred }, moved: false };
      panel.handle.setPointerCapture(event.pointerId);
      panel.handle.classList.add('is-resizing');
      document.body.classList.add('resizing-panels');
      panel.handle.focus({ preventScroll: true });
    });
    panel.handle.addEventListener('pointermove', event => {
      if (!drag || drag.panel !== panel || event.pointerId !== drag.pointerId) return;
      const delta = (event.clientX - drag.startX) * panel.direction;
      if (Math.abs(delta) < 1 && !drag.moved) return;
      drag.moved = true;
      setWidth(panel, drag.startWidth + delta);
    });
    panel.handle.addEventListener('pointerup', event => { if (drag?.pointerId === event.pointerId) finish(); });
    panel.handle.addEventListener('pointercancel', () => finish(true));
    panel.handle.addEventListener('lostpointercapture', () => finish(true));
    panel.handle.addEventListener('dblclick', () => {
      preferred[panel.name] = null;
      revision++;
      fit();
      persist(panel).catch(fail);
    });
    panel.handle.addEventListener('keydown', event => {
      if (event.key === 'Escape' && drag) { event.preventDefault(); event.stopPropagation(); finish(true); return; }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      fit();
      const size = panel.element.getBoundingClientRect().width;
      const change = (event.shiftKey ? 40 : 10) * panel.direction * (event.key === 'ArrowRight' ? 1 : -1);
      const value = event.key === 'Home' ? +panel.handle.getAttribute('aria-valuemin') : event.key === 'End' ? +panel.handle.getAttribute('aria-valuemax') : size + change;
      setWidth(panel, value);
      persist(panel).catch(fail);
    });
  }
  window.addEventListener('blur', () => finish(true));
  window.addEventListener('resize', scheduleFit, { passive: true });
  // Fit revealed panels before painting so their edge/drag handle never jumps
  // from a responsive default to the saved width on the following frame.
  new MutationObserver(fit).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(fit).observe(panels[1].element, { attributes: true, attributeFilter: ['hidden'] });
  db.onChange(type => {
    if (!(Array.isArray(type) ? type : [type]).includes('state') || drag) return;
    const requestedAt = revision;
    db.get('state', stateKey).then(value => {
      if (drag || revision !== requestedAt) return;
      preferred = normalize(value);
      fit();
    }).catch(fail);
  });
  fit();
}
