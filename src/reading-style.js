// 阅读样式的单一数据源：扩展页面与浏览器原生打开的 file:// 阅读页共用，
// 保证同一套设置在两种模式下呈现一致的观感。
export const defaults = { theme: 'paper', background: '#fbfaf7', font: 'system', fontSize: 17, width: 100, lineHeight: 1.9, outlineSize: 11 };
export const themes = { paper: '#fbfaf7', white: '#ffffff', sage: '#eef3eb', night: '#202624' };
export const fonts = {
  system: 'ReaderSystem, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
  song: '"Songti SC", "Noto Serif CJK SC", SimSun, serif',
  serif: 'Georgia, "Times New Roman", "Songti SC", SimSun, serif',
  mono: '"SFMono-Regular", Menlo, Consolas, "PingFang SC", monospace',
};
const number = (value, min, max, fallback) => (Number.isFinite(+value) ? Math.min(max, Math.max(min, +value)) : fallback);
// 宽容地整理任意来源（本机记录 / 跨浏览器同步 / 旧版本）的样式设置。
// 不做旧像素宽度迁移——那是扩展页面按阅读区宽度换算的，留在 app 的 normalizeWidth。
export function coerceReadingStyle(raw) {
  const source = { ...defaults, ...raw };
  return {
    theme: Object.hasOwn(themes, source.theme) || source.theme === 'custom' ? source.theme : 'paper',
    background: /^#[0-9a-f]{6}$/i.test(source.background) ? source.background : defaults.background,
    font: Object.hasOwn(fonts, source.font) ? source.font : defaults.font,
    fontSize: number(source.fontSize, 12, 32, defaults.fontSize),
    width: number(source.width, 40, 100, defaults.width),
    lineHeight: number(source.lineHeight, 1.3, 2.6, defaults.lineHeight),
    outlineSize: number(source.outlineSize, 10, 20, defaults.outlineSize),
  };
}
// 把（已整理的）设置写成阅读区的 CSS 变量与明暗标记
export function applyReadingStyle(root, settings) {
  const rgb = settings.background.slice(1).match(/../g).map(value => parseInt(value, 16));
  const dark = (rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114) < 140;
  root.dataset.ui = dark ? 'dark' : 'light';
  const color = dark ? ['#dce3d7', '#95a18f', '#465042', 'rgba(197,216,180,.055)'] : ['#353a32', '#858a7f', 'rgba(80,96,66,.14)', 'rgba(92,106,75,.065)'];
  for (const [key, value] of Object.entries({ '--page': settings.background, '--page-ink': color[0], '--page-muted': color[1], '--page-rule': color[2], '--code-bg': color[3], '--reader-font': fonts[settings.font], '--font-size': `${settings.fontSize}px`, '--outline-size': `${settings.outlineSize}px`, '--text-width': `${(settings.width * 4) / 5}%`, '--line-height': settings.lineHeight })) root.style.setProperty(key, value);
}
