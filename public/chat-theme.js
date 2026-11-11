// 主题 on the chat pages: turns a theme (a small JSON, see themes.js) into CSS variables on <body>, and
// colors 旁白 (*…*, （…）) and 引用 (“…”, 「…」) inside a message. Used by the cat window, the story window
// and the theme editor's preview. No theme = the built-in warm paper look, nothing highlighted.
window.ChatTheme = (() => {
  const esc = Maowo.esc;
  const rgba = (hex, alpha) => {
    const n = parseInt(String(hex || '#000000').slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(100, alpha)) / 100})`;
  };
  let current = null;
  // el: the element that carries the look (the page's <body>, or the preview box in the editor).
  function apply(theme, el = document.body) {
    if (el === document.body) current = theme || null;
    el.classList.toggle('themed', !!theme);
    const set = (k, v) => (v === null ? el.style.removeProperty(k) : el.style.setProperty(k, v));
    const keys = ['--t-bg', '--t-img', '--t-img-a', '--t-ink', '--t-bar', '--t-bar-blur', '--t-in', '--t-in-blur', '--t-in-r', '--t-in-ink',
      '--t-char', '--t-char-blur', '--t-char-r', '--t-char-ink', '--t-me', '--t-me-blur', '--t-me-r', '--t-me-ink', '--t-narr', '--t-narr-style', '--t-quote', '--t-quote-w'];
    if (!theme) { keys.forEach(k => set(k, null)); return; }
    const t = theme;
    set('--t-bg', t.bg.color);
    set('--t-img', t.bg.image ? `url("${t.bg.image}")` : 'none');
    set('--t-img-a', String(t.bg.imageAlpha / 100));
    set('--t-ink', t.ink);
    set('--t-bar', rgba(t.bar.color, t.bar.alpha)); set('--t-bar-blur', `${t.bar.blur}px`);
    set('--t-in', rgba(t.input.color, t.input.alpha)); set('--t-in-blur', `${t.input.blur}px`); set('--t-in-r', `${t.input.radius}px`); set('--t-in-ink', t.input.ink);
    for (const k of ['char', 'me']) {
      set(`--t-${k}`, rgba(t[k].color, t[k].alpha)); set(`--t-${k}-blur`, `${t[k].blur}px`); set(`--t-${k}-r`, `${t[k].radius}px`); set(`--t-${k}-ink`, t[k].ink);
    }
    set('--t-narr', t.narr.color); set('--t-narr-style', t.narr.italic ? 'italic' : 'normal');
    set('--t-quote', t.quote.color); set('--t-quote-w', t.quote.bold ? '600' : 'inherit');
    if (el === document.body) { const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = t.bg.color; }
  }
  // Escaped HTML of a message with 旁白 and 引用 wrapped in spans, as far as the theme asks for it.
  function rich(text, theme = current) {
    const s = esc(text || '');
    if (!theme || (!theme.narr.on && !theme.quote.on)) return s;
    const quote = /(“[^”\n]{0,400}”|&quot;[^\n]{0,400}?&quot;|「[^」\n]{0,400}」|『[^』\n]{0,400}』)/g;
    const paint = part => (theme.quote.on ? part.replace(quote, '<span class="quote">$1</span>') : part);
    if (!theme.narr.on) return paint(s);
    // 旁白 first; the words between and inside are then looked at for quotes.
    const narr = /(\*[^*\n]{1,600}\*|（[^（）\n]{1,600}）|\([^()\n]{1,600}\))/g;
    return s.split(narr).map((part, i) => {
      if (i % 2 === 0) return paint(part);
      const inner = theme.narr.hide ? part.slice(1, -1) : part.startsWith('*') ? part.slice(1, -1) : part;
      return `<span class="narr">${paint(inner)}</span>`;
    }).join('');
  }
  // The theme list, read once per page.
  let listP = null;
  const list = () => (listP = listP || Maowo.api('/themes').catch(() => []));
  async function use(themeId) {
    const all = await list();
    const t = themeId ? all.find(x => x.id === themeId) : null;
    apply(t ? t.theme : null);
    return t || null;
  }
  // Starting points for a new theme (values only; the names are just words).
  const STARTS = {
    '暖纸': { bg: { image: '', imageAlpha: 100, color: '#f7eee1' }, ink: '#2a1f17', bar: { color: '#f7eee1', alpha: 100, blur: 0 }, input: { color: '#fffaf3', alpha: 100, blur: 0, radius: 12, ink: '#2a1f17' },
      char: { color: '#fbf5ec', alpha: 100, blur: 0, radius: 18, ink: '#2a1f17' }, me: { color: '#f6e2cc', alpha: 100, blur: 0, radius: 18, ink: '#2a1f17' },
      narr: { on: true, color: '#85715f', italic: true, hide: false }, quote: { on: true, color: '#96491d', bold: false } },
    '水蓝': { bg: { image: '', imageAlpha: 100, color: '#a9c8e4' }, ink: '#16283a', bar: { color: '#ffffff', alpha: 45, blur: 16 }, input: { color: '#74b2dd', alpha: 40, blur: 16, radius: 14, ink: '#16283a' },
      char: { color: '#ffffff', alpha: 62, blur: 10, radius: 14, ink: '#16283a' }, me: { color: '#74b2dd', alpha: 72, blur: 10, radius: 14, ink: '#10243a' },
      narr: { on: true, color: '#4a6b8a', italic: true, hide: false }, quote: { on: true, color: '#0e4e86', bold: true } },
    '夜色': { bg: { image: '', imageAlpha: 100, color: '#1c1b36' }, ink: '#ede9f6', bar: { color: '#1e1c37', alpha: 55, blur: 16 }, input: { color: '#2c2a4e', alpha: 70, blur: 16, radius: 14, ink: '#ede9f6' },
      char: { color: '#282646', alpha: 66, blur: 10, radius: 14, ink: '#ede9f6' }, me: { color: '#7e68be', alpha: 60, blur: 10, radius: 14, ink: '#f4f0ff' },
      narr: { on: true, color: '#a9a3c9', italic: true, hide: false }, quote: { on: true, color: '#f1c988', bold: false } },
  };
  return { apply, rich, list, use, rgba, STARTS, get current() { return current; } };
})();
