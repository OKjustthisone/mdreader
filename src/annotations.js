export const HIGHLIGHT_COLORS = {
  yellow: { label: '暖黄', value: '#f3d87a' },
  green: { label: '浅绿', value: '#acd0a8' },
  blue: { label: '雾蓝', value: '#a9cbe9' },
  pink: { label: '柔粉', value: '#ebbbcb' },
};
export function textNodes(root) {
  const walker = root.ownerDocument.createTreeWalker(root, 4);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}
export function captureSelection(root, selection = window.getSelection()) {
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const before = range.cloneRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  const end = start + range.toString().length;
  const text = root.textContent;
  if (!text.slice(start, end).trim()) return null;
  return {
    start, end, quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - 40), start),
    suffix: text.slice(end, end + 40),
  };
}
export function locateAnchor(text, note) {
  const contextMatches = (!note.prefix || text.slice(Math.max(0, note.start - note.prefix.length), note.start) === note.prefix) && (!note.suffix || text.slice(note.end, note.end + note.suffix.length) === note.suffix);
  if (text.slice(note.start, note.end) === note.quote && contextMatches && (note.prefix || note.suffix || note.quote === text)) return { start: note.start, end: note.end };
  if (!note.quote) return null;
  let cursor = 0;
  const matches = [];
  while (cursor <= text.length) {
    const start = text.indexOf(note.quote, cursor);
    if (start === -1) break;
    const end = start + note.quote.length;
    let score = 0;
    if (note.prefix && text.slice(Math.max(0, start - note.prefix.length), start) === note.prefix) score += 2;
    if (note.suffix && text.slice(end, end + note.suffix.length) === note.suffix) score += 2;
    matches.push({ start, end, score });
    cursor = start + 1;
  }
  matches.sort((a, b) => b.score - a.score);
  if (matches.length === 1 || (matches[0]?.score > (matches[1]?.score ?? -1))) return { start: matches[0].start, end: matches[0].end };
  return null; // Ambiguous after source edits: keep the note, never mark the wrong text.
}
export function applyAnnotations(root, notes) {
  root.querySelectorAll('mark[data-annotations]').forEach(mark => mark.replaceWith(...mark.childNodes));
  root.normalize();
  const text = root.textContent;
  const anchors = notes.map(note => ({ ...note, anchor: locateAnchor(text, note) }));
  let offset = 0;
  for (const node of textNodes(root)) {
    const start = offset;
    const end = start + node.length;
    offset = end;
    const intersecting = anchors.filter(note => note.anchor && note.anchor.start < end && note.anchor.end > start);
    if (!intersecting.length) continue;
    const boundaries = [...new Set([0, node.length, ...intersecting.flatMap(note => [Math.max(0, note.anchor.start - start), Math.min(node.length, note.anchor.end - start)])])].sort((a, b) => a - b);
    const fragment = root.ownerDocument.createDocumentFragment();
    for (let i = 0; i < boundaries.length - 1; i++) {
      const from = boundaries[i], to = boundaries[i + 1];
      const value = node.textContent.slice(from, to);
      const active = intersecting.filter(note => note.anchor.start < start + to && note.anchor.end > start + from);
      if (!active.length) { fragment.append(value); continue; }
      const mark = root.ownerDocument.createElement('mark');
      mark.dataset.annotations = active.map(note => note.id).join(' ');
      mark.dataset.color = active.at(-1).color || 'yellow';
      mark.className = active.some(note => note.comment) ? 'has-comment' : '';
      mark.title = active.map(note => note.comment || '文本高亮').join('\n');
      mark.textContent = value;
      fragment.append(mark);
    }
    node.replaceWith(fragment);
  }
  return anchors.filter(note => !note.anchor).map(note => note.id);
}
