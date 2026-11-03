// 猫窝共用：token、接口、图标、小工具。
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

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
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 21V5M9 7h6"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    chevronRight: '<path d="M9 6l6 6-6 6"/>',
    cat: '<path d="M4 20c0-5 2-8 8-8s8 3 8 8"/><path d="M5.5 13.5L4 5l5 4M18.5 13.5L20 5l-5 4"/><path d="M9.5 16.2c.4.5.9.5 1.3 0M13.2 16.2c.4.5.9.5 1.3 0"/>',
    gamepad: '<path d="M7 8h10a5 5 0 0 1 4.6 7l-.6 1.4a2.6 2.6 0 0 1-4.4.5L15 15H9l-1.6 1.9a2.6 2.6 0 0 1-4.4-.5L2.4 15A5 5 0 0 1 7 8z"/><path d="M7.5 10.5v3M6 12h3"/><circle cx="15.5" cy="11" r=".6"/><circle cx="17.5" cy="13" r=".6"/>',
    notebook: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M5 7H3.5M5 12H3.5M5 17H3.5"/><circle cx="12" cy="13" r="1.6"/><circle cx="9.6" cy="10.2" r=".7"/><circle cx="12" cy="9.2" r=".7"/><circle cx="14.4" cy="10.2" r=".7"/>',
    helmet: '<path d="M4.5 16.5V15a7.5 7.5 0 0 1 15 0v1.5"/><rect x="2" y="16.5" width="20" height="3" rx="1.5"/><path d="M10 8.2V6h4v2.2M8 9.5l1 5M16 9.5l-1 5"/>',
    plug: '<path d="M9 7V3M15 7V3"/><path d="M7 7h10v4a5 5 0 0 1-10 0z"/><path d="M12 16v2a3 3 0 0 1-3 3H6"/>',
    robot: '<rect x="4" y="8" width="16" height="11" rx="4"/><path d="M12 8V5"/><circle cx="12" cy="4" r="1"/><circle cx="9" cy="13.5" r="1"/><circle cx="15" cy="13.5" r="1"/><path d="M2 12.5v3M22 12.5v3"/>',
    bug: '<rect x="7" y="7" width="10" height="13" rx="5"/><path d="M12 7v13M9 7.5a3 3 0 0 1 6 0"/><path d="M3 9l4 2M21 9l-4 2M3 14h4M21 14h-4M4 20l3.5-2.5M20 20l-3.5-2.5"/>',
    paw: '<circle cx="7" cy="9" r="1.8"/><circle cx="11" cy="6" r="1.8"/><circle cx="15.5" cy="7" r="1.8"/><circle cx="18.5" cy="11" r="1.8"/><path d="M8.5 17.5c0-3 2-5.5 4.5-5.5s4 2 4 4.5-1.7 3.5-4 3.5-4.5 0-4.5-2.5z"/>',
    camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    archive: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v10h14V9M10 13h4"/>',
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

  // A round avatar: the uploaded picture, or the first character of the name.
  const avatar = (who, cls = '') =>
    `<div class="avatar ${cls}">${who && who.avatar ? `<img src="${esc(who.avatar)}" alt="" loading="lazy">` : esc(initial(who && who.name))}</div>`;

  // The four buttons at the bottom of 我的 / 游戏 / 日记 / 开发中.
  const TABS = [['me', '/me', '我的', 'cat'], ['games', '/', '游戏', 'gamepad'], ['diary', '/diary', '日记', 'notebook'], ['dev', '/dev', '开发中…', 'helmet']];
  function tabbar(active) {
    const el = document.createElement('div');
    el.className = 'tabbar';
    el.innerHTML = `<nav aria-label="主要页面">${TABS.map(([id, href, label, ic]) =>
      `<a href="${href}" class="${id === active ? 'on' : ''}" ${id === active ? 'aria-current="page"' : ''}>${icon(ic, 24, 1.6)}<span>${label}</span></a>`).join('')}</nav>`;
    document.body.appendChild(el);
    document.body.classList.add('has-tabbar');
  }

  // A panel that slides up from the bottom. Returns the panel element; close() removes it.
  function sheet(html) {
    const mask = document.createElement('div');
    mask.className = 'sheet-mask';
    mask.innerHTML = `<div class="sheet-panel" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div>`;
    const panel = mask.firstElementChild;
    const close = () => { mask.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    mask.addEventListener('click', e => { if (e.target === mask) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(mask);
    panel.close = close;
    return panel;
  }

  // Picks a picture, crops it to a square, shrinks it to 320px and uploads it as the avatar of account `id`.
  function pickAvatar(id) {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'image/*';
      input.onchange = async () => {
        const file = input.files[0];
        if (!file) return;
        try {
          const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error('这张图打不开')); i.src = URL.createObjectURL(file); });
          const side = Math.min(img.naturalWidth, img.naturalHeight), size = Math.min(320, side);
          const c = document.createElement('canvas'); c.width = c.height = size;
          c.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
          URL.revokeObjectURL(img.src);
          const blob = await new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.88));
          const res = await fetch(`/api/avatar/${id}`, { method: 'PUT', headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'image/jpeg' }, body: blob });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || '上传失败');
          toast('头像换好了'); resolve(data);
        } catch (err) { toast(err.message); reject(err); }
      };
      input.click();
    });
  }

  return { token, setToken, api, icon, GAME_ICON, GAME_TINT, esc, fmtDate, fmtClock, fmtDuration, fmtSilence, toast, copy, initial, toLogin, avatar, tabbar, sheet, pickAvatar };
})();
