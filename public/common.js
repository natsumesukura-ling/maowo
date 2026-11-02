// 猫窝共用：token、接口、图标、小工具。
const Maowo = (() => {
  const KEY = 'maowo-token';
  const token = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
  const setToken = t => { try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch {} };

  const toLogin = () => { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search + location.hash); };

  async function api(path, opts = {}) {
    if (!token()) { toLogin(); throw new Error('需要登录'); }
    const res = await fetch('/api' + path, {
      method: opts.method || (opts.json ? 'POST' : 'GET'),
      headers: { Authorization: 'Bearer ' + token(), ...(opts.json ? { 'Content-Type': 'application/json' } : {}) },
      body: opts.json ? JSON.stringify(opts.json) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { setToken(''); toLogin(); throw new Error('token 不对'); }
    if (!res.ok) throw new Error(data.error || '出错了');
    return data;
  }

  const PATHS = {
    back: '<path d="M15 18l-6-6 6-6"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M17.9 17.9A10.1 10.1 0 0 1 12 19C5.5 19 2 12 2 12a18.5 18.5 0 0 1 5.1-5.9M9.9 5.2A9.1 9.1 0 0 1 12 5c6.5 0 10 7 10 7a18.6 18.6 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2M2 2l20 20"/>',
    grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
    card: '<rect x="6" y="3" width="12" height="18" rx="2.5"/><path d="M9.5 9.5l5 5"/>',
    chevronDown: '<path d="M6 9l6 6 6-6"/>',
    chevronUp: '<path d="M6 15l6-6 6 6"/>',
    box: '<path d="M4 4h16v4H4zM5 8v12h14V8M10 12h4"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  };
  const icon = (name, size = 18, width = 1.8) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;

  const GAME_ICON = { werewolf: 'moon', gomoku: 'grid', uno: 'card' };
  const GAME_TINT = { werewolf: 'background:#F5E4DC;color:#8F3F22', gomoku: 'background:#E6EBE0;color:#3E5230', uno: 'background:#E3E9F1;color:#2F4A6B' };

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const fmtDate = iso => { const d = new Date(iso); return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`; };
  const fmtClock = iso => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const fmtDuration = ms => {
    const m = Math.max(1, Math.round(ms / 60000));
    return m >= 60 ? `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分` : ''}` : `${m} 分`;
  };
  const fmtSilence = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };

  function toast(msg) {
    let t = document.getElementById('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.style.display = 'none'; }, 2600);
  }

  async function copy(text, done = '已复制') {
    try { await navigator.clipboard.writeText(text); toast(done); }
    catch { prompt('复制下面的内容', text); }
  }

  const initial = name => String(name || '?').slice(0, 1);

  return { token, setToken, api, icon, GAME_ICON, GAME_TINT, esc, fmtDate, fmtClock, fmtDuration, fmtSilence, toast, copy, initial, toLogin };
})();
