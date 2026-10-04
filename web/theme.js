const KEY = 'echo-theme';
const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
function savedTheme() {
  try { const saved = localStorage.getItem(KEY); return saved === 'dark' || saved === 'light' ? saved : null; } catch { return null; }
}
function apply(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#15131b' : '#faf9fc');
  window.dispatchEvent(new CustomEvent('echo-theme-change', { detail: theme }));
  return theme;
}
export function setTheme(theme) {
  if (!['light', 'dark'].includes(theme)) throw new Error('Choose light or dark appearance.');
  try { localStorage.setItem(KEY, theme); } catch {}
  return apply(theme);
}
export function currentTheme() { return document.documentElement.dataset.theme || (media?.matches ? 'dark' : 'light'); }
if (typeof document !== 'undefined') {
  apply(savedTheme() || (media?.matches ? 'dark' : 'light'));
  media?.addEventListener('change', () => { if (!savedTheme()) apply(media.matches ? 'dark' : 'light'); });
  window.addEventListener('storage', event => { if (event.key === KEY || event.key === null) apply(savedTheme() || (media?.matches ? 'dark' : 'light')); });
  window.echoTheme = { current: currentTheme, set: setTheme };
}
