// 猫窝共用：token、接口、图标、小工具。
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

const Maowo = (() => {
  const KEY = 'maowo-token';
  // The four tab pages run inside the tab shell (shell.html) as frames. Links and redirects
  // from a frame go to the whole window, not just the frame.
  let framed = false;
  try { framed = window.top !== window && window.top.location.origin === location.origin; } catch {}
  if (framed) document.head.insertAdjacentHTML('afterbegin', '<base target="_top">');
  const topWin = framed ? window.top : window;
  const go = url => { topWin.location.href = url; };
  const token = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
  const setToken = t => { try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch {} };

  const toLogin = () => { const l = topWin.location; go('/login?next=' + encodeURIComponent(l.pathname + l.search + l.hash)); };

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
    drama: '<path d="M5 4h14v7a7 7 0 0 1-14 0z"/><path d="M9 9h.01M15 9h.01"/><path d="M9.5 13.5a3.5 3.5 0 0 0 5 0"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    retry: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
    chevronDown: '<path d="M6 9l6 6 6-6"/>',
    chevronUp: '<path d="M6 15l6-6 6 6"/>',
    box: '<path d="M4 4h16v4H4zM5 8v12h14V8M10 12h4"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 21V5M9 7h6"/>',
    rules: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 21V5M9 7h6M9 11h6"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    chevronRight: '<path d="M9 6l6 6-6 6"/>',
    cat: '<path d="M4 20c0-5 2-8 8-8s8 3 8 8"/><path d="M5.5 13.5L4 5l5 4M18.5 13.5L20 5l-5 4"/><path d="M9.5 16.2c.4.5.9.5 1.3 0M13.2 16.2c.4.5.9.5 1.3 0"/>',
    gamepad: '<path d="M7 8h10a5 5 0 0 1 4.6 7l-.6 1.4a2.6 2.6 0 0 1-4.4.5L15 15H9l-1.6 1.9a2.6 2.6 0 0 1-4.4-.5L2.4 15A5 5 0 0 1 7 8z"/><path d="M7.5 10.5v3M6 12h3"/><circle cx="15.5" cy="11" r=".6"/><circle cx="17.5" cy="13" r=".6"/>',
    notebook: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M5 7H3.5M5 12H3.5M5 17H3.5"/><circle cx="12" cy="13" r="1.6"/><circle cx="9.6" cy="10.2" r=".7"/><circle cx="12" cy="9.2" r=".7"/><circle cx="14.4" cy="10.2" r=".7"/>',
    chat: '<path d="M4.5 4.5h15a1.5 1.5 0 0 1 1.5 1.5v9.5a1.5 1.5 0 0 1-1.5 1.5H11l-4.5 3.5V17h-2A1.5 1.5 0 0 1 3 15.5V6a1.5 1.5 0 0 1 1.5-1.5z"/><circle cx="8.5" cy="10.8" r=".7"/><circle cx="12" cy="10.8" r=".7"/><circle cx="15.5" cy="10.8" r=".7"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.7"/><path d="M21 15.5l-5-5-9 9.5"/>',
    poll: '<path d="M5 20V11M12 20V5M19 20v-6"/>',
    bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
    bellOff: '<path d="M6 16.5V11a6 6 0 0 1 9.2-5.1M18 11v5.5l1.5 2H9"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/><path d="M4 4l16 16"/>',
    sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2.5 2.5M14 9l2 2"/>',
    share: '<circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="M8.2 10.8l7.6-4.1M8.2 13.2l7.6 4.1"/>',
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

  // Puts html into el only when it differs from what was put there last time, so a refresh
  // with nothing new does not rebuild the pictures (they would flash). Returns whether it changed.
  function setHtml(el, html) {
    if (el._maowoHtml === html) return false;
    el.innerHTML = html;
    el._maowoHtml = html;
    return true;
  }

  // The rules of a game, in a bottom panel. 【...】 lines become headings, "- " lines a list.
  async function showRules(gameId) {
    try {
      const r = await api(`/games/${gameId}/rules`);
      const lines = r.text.split('\n');
      let html = '', list = false;
      const endList = () => { if (list) { html += '</ul>'; list = false; } };
      for (const raw of lines.slice(1)) {
        const line = raw.trim();
        if (!line) { endList(); continue; }
        const head = line.match(/^【(.+?)】(.*)$/);
        if (head) { endList(); html += `<h3 style="font-family: 'Noto Serif SC', serif; font-size: 16px; margin: 18px 0 6px;">${esc(head[1])}</h3>${head[2] ? `<p style="margin: 0 0 6px;">${esc(head[2])}</p>` : ''}`; continue; }
        if (line.startsWith('- ')) { if (!list) { html += '<ul style="margin: 0; padding-left: 20px;">'; list = true; } html += `<li style="margin: 4px 0;">${esc(line.slice(2))}</li>`; continue; }
        endList(); html += `<p style="margin: 4px 0;">${esc(line)}</p>`;
      }
      endList();
      sheet(`<h2>${esc(r.name)} · 规则</h2><div style="font-size: 14px; line-height: 1.75; color: var(--text2);">${html}</div>`);
    } catch (err) { toast(err.message); }
  }

  // A back button that returns to the page you came from (inside maowo), else to `fallback`.
  function backTo(el, fallback) {
    el.href = fallback;
    el.addEventListener('click', e => {
      let fromHere = false;
      try { fromHere = !!document.referrer && new URL(document.referrer).origin === location.origin && history.length > 1; } catch {}
      if (fromHere) { e.preventDefault(); history.back(); }
    });
  }

  // A round avatar: the uploaded picture, or the first character of the name.
  const avatar = (who, cls = '') =>
    `<div class="avatar ${cls}">${who && who.avatar ? `<img src="${esc(who.avatar)}" alt="" loading="lazy">` : esc(initial(who && who.name))}</div>`;

  // The four buttons at the bottom of 我的 / 游戏 / 聊天 / 猫们.
  const TABS = [['cats', '/cats', '猫们', 'paw'], ['games', '/', '游戏', 'gamepad'], ['diary', '/diary', '聊天', 'chat'], ['me', '/me', '我的', 'cat']];
  function tabbar(active) {
    document.body.classList.add('has-tabbar');
    if (framed) return; // the shell draws the buttons
    const el = document.createElement('div');
    el.className = 'tabbar';
    el.innerHTML = `<nav aria-label="主要页面">${TABS.map(([id, href, label, ic]) =>
      `<a href="${href}" class="${id === active ? 'on' : ''}" ${id === active ? 'aria-current="page"' : ''}>${icon(ic, 24, 1.6)}<span>${label}</span></a>`).join('')}</nav>`;
    document.body.appendChild(el);
  }

  // A panel that slides up from the bottom. Returns the panel element; close() removes it.
  function sheet(html) {
    const mask = document.createElement('div');
    mask.className = 'sheet-mask';
    mask.innerHTML = `<div class="sheet-panel" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div>`;
    const panel = mask.firstElementChild;
    // In the shell, hide its buttons while the panel is open so they do not cover it.
    // Panels can stack (the crop panel opens over the AI panel), so count them.
    const tell = () => { if (framed) topWin.postMessage({ maowo: 'sheet', open: sheet.count > 0 }, location.origin); };
    let closed = false;
    const close = () => { if (closed) return; closed = true; mask.remove(); document.removeEventListener('keydown', onKey); sheet.count--; tell(); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    mask.addEventListener('click', e => { if (e.target === mask) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(mask);
    sheet.count = (sheet.count || 0) + 1;
    tell();
    panel.close = close;
    return panel;
  }

  // Picks a picture, lets you place it in a round frame (drag to move, pinch or slider to zoom),
  // then shrinks the framed part to 320px and uploads it as the avatar of account `id`.
  function pickAvatar(id) {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'image/*';
      input.onchange = async () => {
        const file = input.files[0];
        if (!file) return;
        let img;
        try {
          img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error('这张图打不开')); i.src = URL.createObjectURL(file); });
        } catch (err) { toast(err.message); return reject(err); }
        cropAvatar(img, id).then(resolve, reject).finally(() => URL.revokeObjectURL(img.src));
      };
      input.click();
    });
  }

  function cropAvatar(img, id) {
    return new Promise((resolve, reject) => {
      const V = Math.min(280, window.innerWidth - 64); // the round frame, in CSS px
      const W = img.naturalWidth, H = img.naturalHeight;
      const minS = Math.max(V / W, V / H), maxS = minS * 5;
      let s = minS, x = (V - W * s) / 2, y = (V - H * s) / 2;
      const panel = sheet(`<h2>调整头像</h2>
        <div class="small muted" style="margin-bottom: 14px;">拖动挪位置，两指捏合或者拉下面的滑条放大缩小</div>
        <div id="crop" style="position: relative; width: ${V}px; height: ${V}px; margin: 0 auto; border-radius: 50%; overflow: hidden; touch-action: none; cursor: grab; background: var(--card); box-shadow: 0 0 0 3px var(--white), 0 0 0 4px var(--border);">
          <img id="crop-img" src="${img.src}" alt="" draggable="false" style="position: absolute; left: 0; top: 0; transform-origin: 0 0; max-width: none; user-select: none; -webkit-user-select: none; pointer-events: none;">
        </div>
        <input id="crop-zoom" type="range" min="0" max="1000" value="0" aria-label="放大缩小" style="margin: 18px 0 4px; padding: 0; accent-color: var(--accent);">
        <div class="row" style="margin-top: 12px; flex-wrap: nowrap;">
          <button class="btn" id="crop-cancel" style="flex: 1;">取消</button>
          <button class="btn primary" id="crop-ok" style="flex: 2;">就这样</button>
        </div>`);
      const box = panel.querySelector('#crop'), pic = panel.querySelector('#crop-img'), zoom = panel.querySelector('#crop-zoom');
      const clamp = () => { x = Math.min(0, Math.max(V - W * s, x)); y = Math.min(0, Math.max(V - H * s, y)); };
      const draw = () => { clamp(); pic.style.transform = `translate(${x}px, ${y}px) scale(${s})`; zoom.value = String(Math.round((s - minS) / (maxS - minS) * 1000)); };
      // Zoom to `next` keeping the point (cx, cy) of the frame still.
      const zoomAt = (next, cx, cy) => { next = Math.min(maxS, Math.max(minS, next)); x = cx - (cx - x) * next / s; y = cy - (cy - y) * next / s; s = next; draw(); };
      draw();

      const pts = new Map();
      let last = null; // previous single-finger position, or previous pinch { d, cx, cy }
      const local = e => { const r = box.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
      const pinch = () => { const [a, b] = [...pts.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }; };
      box.addEventListener('pointerdown', e => { box.setPointerCapture(e.pointerId); pts.set(e.pointerId, local(e)); last = pts.size === 2 ? pinch() : local(e); });
      box.addEventListener('pointermove', e => {
        if (!pts.has(e.pointerId)) return;
        pts.set(e.pointerId, local(e));
        if (pts.size === 2) {
          const p = pinch();
          if (last && last.d) { x += p.cx - last.cx; y += p.cy - last.cy; zoomAt(s * p.d / last.d, p.cx, p.cy); }
          last = p;
        } else if (pts.size === 1) {
          const p = local(e);
          if (last && last.d === undefined) { x += p.x - last.x; y += p.y - last.y; draw(); }
          last = p;
        }
      });
      const up = e => { pts.delete(e.pointerId); last = pts.size === 1 ? [...pts.values()][0] : null; };
      box.addEventListener('pointerup', up); box.addEventListener('pointercancel', up);
      box.addEventListener('wheel', e => { e.preventDefault(); const p = local(e); zoomAt(s * (e.deltaY < 0 ? 1.1 : 1 / 1.1), p.x, p.y); }, { passive: false });
      zoom.addEventListener('input', () => zoomAt(minS + (maxS - minS) * Number(zoom.value) / 1000, V / 2, V / 2));

      let done = false;
      const close = panel.close;
      panel.close = () => { close(); if (!done) reject(new Error('cancelled')); };
      panel.querySelector('#crop-cancel').onclick = () => panel.close();
      panel.querySelector('#crop-ok').onclick = async () => {
        const btn = panel.querySelector('#crop-ok');
        btn.disabled = true; btn.textContent = '上传中…';
        try {
          const size = Math.min(320, Math.round(V / s));
          const c = document.createElement('canvas'); c.width = c.height = Math.max(64, size);
          c.getContext('2d').drawImage(img, -x / s, -y / s, V / s, V / s, 0, 0, c.width, c.height);
          const blob = await new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.9));
          const res = await fetch(`/api/avatar/${id}`, { method: 'PUT', headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'image/jpeg' }, body: blob });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || '上传失败');
          done = true; panel.close(); toast('头像换好了'); resolve(data);
        } catch (err) { btn.disabled = false; btn.textContent = '就这样'; toast(err.message); }
      };
    });
  }

  // A vote line from the werewolf log (「放逐投票：1号→5号，2号 弃票…」) as a small box grouped by who
  // got the votes: 「5号 星野 · 8.5 票 ← 1、2、3、4（1.5）号」. null if the line is not a vote line.
  function voteBox(text, nameOf) {
    const m = String(text).match(/^(放逐投票|加赛投票|警长投票)：(.+)$/);
    if (!m) return null;
    const groups = new Map(); const abstain = [];
    for (const part of m[2].split('，')) {
      let x = part.match(/^(\d+)号→(\d+)号(?:（([\d.]+) 票）)?$/);
      if (x) {
        const t = Number(x[2]), w = x[3] ? Number(x[3]) : 1;
        if (!groups.has(t)) groups.set(t, { voters: [], score: 0 });
        const g = groups.get(t); g.voters.push(w !== 1 ? `${x[1]}（${w}）` : x[1]); g.score += w;
        continue;
      }
      x = part.match(/^(\d+)号 弃票$/);
      if (x) { abstain.push(x[1]); continue; }
      return null; // not in the format we know: show it as plain text
    }
    const rows = [...groups.entries()].sort((a, b) => b[1].score - a[1].score);
    const top = rows.length ? rows[0][1].score : 0;
    const nm = n => { const v = nameOf ? nameOf(n) : ''; return v ? ` ${esc(v)}` : ''; };
    return `<div class="votebox"><div class="vb-title">${esc(m[1])}</div>
      ${rows.map(([t, g]) => `<div class="vb-row ${g.score === top ? 'top' : ''}"><div class="vb-to">${t}号${nm(t)}<span class="vb-n">${g.score} 票</span></div>
        <div class="vb-from">${g.voters.join('、')} 号投的</div></div>`).join('')}
      ${abstain.length ? `<div class="vb-row abstain"><div class="vb-to">弃票</div><div class="vb-from">${abstain.join('、')} 号</div></div>` : ''}
    </div>`;
  }

  // Ask the shell to refresh the red dot on 我的 (after reading messages).
  const tellUnread = () => { if (framed) topWin.postMessage({ maowo: 'unread' }, location.origin); };

  return { voteBox, tellUnread, token, setToken, api, icon, GAME_ICON, GAME_TINT, esc, fmtDate, fmtClock, fmtDuration, fmtSilence, toast, copy, initial, toLogin, go, framed, setHtml, showRules, backTo, avatar, tabbar, sheet, pickAvatar };
})();
