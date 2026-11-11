// The 「⋯」 menu of a cat's windows (main line and stories): switch between them, start a story,
// tell the main line about a story, pick a theme, and the few things about the cat itself.
// opts: { catId, cat, story (null on the main line), onPlay (main line only), onChange() }
window.StoryMenu = (() => {
  const { api, esc, icon } = Maowo;
  const css = document.createElement('style');
  css.textContent = `
    .sm-sec { font-size: 12px; letter-spacing: .1em; color: var(--muted); margin: 16px 2px 8px; }
    .sm-row { width: 100%; display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 14px; border: 1px solid var(--border); background: var(--white); font: inherit; color: var(--text); margin-bottom: 8px; cursor: pointer; text-align: left; text-decoration: none; }
    .sm-row.cur { border-color: var(--accent-line); background: var(--accent-soft); }
    .sm-row .t { flex: 1; min-width: 0; }
    .sm-row b { display: block; font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sm-row small { display: block; font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 1px; }
    .sm-row svg { flex-shrink: 0; color: var(--text2); }
    .sm-row.dash { border-style: dashed; border-color: var(--accent-line); color: var(--accent); justify-content: center; font-weight: 600; background: transparent; }
    .sm-row.dash svg { color: var(--accent); }
    .sm-acts { display: flex; gap: 8px; flex-wrap: wrap; }
    .sm-acts .btn { flex: 1 1 auto; }
    .sm-switch { width: 100%; display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 14px; background: var(--white); border: 1px solid var(--border); font: inherit; font-size: 14px; color: var(--text); text-align: left; cursor: pointer; margin-top: 12px; }
    .sm-switch .t { flex: 1; } .sm-switch .s { display: block; font-size: 12px; color: var(--muted); margin-top: 2px; line-height: 1.5; }
    .sm-switch i { width: 46px; height: 28px; border-radius: 14px; background: var(--ok-text); position: relative; flex-shrink: 0; }
    .sm-switch i::after { content: ''; position: absolute; top: 3px; left: 21px; width: 22px; height: 22px; border-radius: 50%; background: #fff; }
    .sm-switch.off i { background: var(--line); } .sm-switch.off i::after { left: 3px; }
    .sm-pick { display: flex; gap: 8px; flex-wrap: wrap; }
    .sm-pick button { padding: 8px 12px; border-radius: 12px; border: 1px solid var(--border); background: var(--white); font: inherit; font-size: 13px; color: var(--text); cursor: pointer; }
    .sm-pick button.on { background: var(--accent-soft); border-color: var(--accent-line); color: var(--accent-hover); font-weight: 600; }`;
  document.head.appendChild(css);
  const when = iso => { const d = new Date(iso), n = new Date(); return d.toDateString() === n.toDateString() ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : `${d.getMonth() + 1}月${d.getDate()}日`; };
  const themePick = (themes, cur, none) => `<div class="sm-pick">${[{ id: null, name: none }, ...themes].map(t => `<button type="button" class="${(cur || null) === t.id ? 'on' : ''}" data-theme="${t.id || ''}">${esc(t.name)}</button>`).join('')}</div>`;

  async function open(o) {
    const panel = Maowo.sheet(`<h2>${esc(o.cat.name)}</h2><div id="sm-body"><div class="small muted">读取中…</div></div>`);
    const [stories, themes] = await Promise.all([api(`/cats/${o.catId}/stories`), ChatTheme.list()]);
    const cur = o.story ? o.story.id : null;
    panel.querySelector('#sm-body').innerHTML = `
      <div class="sm-sec">主线</div>
      <a class="sm-row ${cur ? '' : 'cur'}" href="/cats/${o.catId}">${icon('chat', 20, 1.7)}<span class="t"><b>和${esc(o.cat.name)}的日常</b><small>记得你的它；游戏、发帖都在这里</small></span></a>
      <div class="sm-sec">故事</div>
      ${stories.map(s => `<a class="sm-row ${cur === s.id ? 'cur' : ''}" href="/cats/${o.catId}/s/${s.id}">${icon('story', 20, 1.7)}<span class="t"><b>${esc(s.title)}</b>
        <small>${s.withMemory ? '带着主线的记忆' : '从零开始'} · ${when(s.updatedAt)}${s.told ? ' · 已告诉主线' : ''}${s.last ? ' · ' + esc(s.last) : ''}</small></span></a>`).join('')}
      <button type="button" class="sm-row dash" id="sm-new">${icon('plus', 18, 2)}开一段新故事</button>
      ${o.story ? `<div class="sm-sec">这一段</div>
        <div class="sm-acts"><button class="btn" id="sm-tell">${icon('send', 16, 1.9)}告诉主线的它</button><button class="btn" id="sm-edit">改名字</button><button class="btn danger" id="sm-del">删掉这段</button></div>` : ''}
      <div class="sm-sec">${o.story ? '这一段的主题' : '它的主题'}</div>
      ${themePick(themes, o.story ? o.story.themeId : o.cat.themeId, o.story ? '跟着它的' : '默认（暖纸）')}
      ${themes.length ? '' : '<div class="small muted" style="margin-top: 8px;">还没有主题。在「猫们的设置 → 主题」里做一套。</div>'}
      <div class="sm-sec">这只猫</div>
      <div class="sm-acts">
        ${o.onPlay ? `<button class="btn" id="sm-play">${icon('gamepad', 17, 1.7)}一起玩游戏</button>` : ''}
        <button class="btn" id="sm-mute">${icon(o.cat.mute ? 'bell' : 'bellOff', 17, 1.7)}${o.cat.mute ? '关掉免打扰' : '免打扰'}</button>
        <a class="btn" href="/cats/${o.catId}/settings">${icon('sliders', 17, 1.7)}它的设置</a>
      </div>`;
    const on = (id, fn) => { const el = panel.querySelector(id); if (el) el.onclick = fn; };
    const guard = fn => async () => { try { await fn(); } catch (err) { Maowo.toast(err.message); } };
    on('#sm-new', () => { panel.close(); start(o, themes); });
    on('#sm-play', () => { panel.close(); o.onPlay(); });
    on('#sm-mute', guard(async () => { await api(`/cats/${o.catId}`, { method: 'PUT', json: { mute: !o.cat.mute } }); panel.close(); Maowo.toast(o.cat.mute ? '关了免打扰' : '开了免打扰：它说话不出红点，消息照样留着'); o.onChange(); }));
    on('#sm-tell', () => { panel.close(); tell(o); });
    on('#sm-edit', () => { panel.close(); rename(o); });
    on('#sm-del', guard(async () => {
      if (!confirm(`删掉「${o.story.title}」这段故事？里面的内容都会没有。${o.story.told ? '已经告诉主线的摘要还留在主线里。' : ''}`)) return;
      await api(`/cats/${o.catId}/stories/${o.story.id}`, { method: 'DELETE' });
      Maowo.go(`/cats/${o.catId}`);
    }));
    panel.querySelectorAll('[data-theme]').forEach(b => b.onclick = guard(async () => {
      const themeId = b.dataset.theme ? Number(b.dataset.theme) : null;
      if (o.story) await api(`/cats/${o.catId}/stories/${o.story.id}`, { method: 'PUT', json: { themeId } });
      else await api(`/cats/${o.catId}`, { method: 'PUT', json: { themeId } });
      panel.close(); o.onChange();
    }));
  }

  // 开一段新故事: she writes the setting, the cat writes first.
  function start(o, themes) {
    const f = { withMemory: true, themeId: null };
    const p = Maowo.sheet(`<h2>开一段新故事</h2>
      <div class="small muted" style="margin: 4px 0 12px; line-height: 1.6;">写一段背景设定，或者直接告诉它你想看什么。发出去以后，${esc(o.cat.name)}会先开场。这段故事和主线、和别的故事都互不相干。</div>
      <textarea id="sn-setting" rows="6" maxlength="8000" placeholder="比如：雨夜，便利店。你是值夜班的店员，我是进来躲雨的客人，我们以前见过一面。" style="resize: vertical;"></textarea>
      <label class="field">名字（可不填）</label><textarea class="single" rows="1" id="sn-title" maxlength="24" placeholder="比如：雨夜便利店"></textarea>
      <button type="button" class="sm-switch" id="sn-mem"><span class="t">带上主线的记忆<span class="s" id="sn-mem-s"></span></span><i></i></button>
      ${themes.length ? `<label class="field">这一段的主题</label><div id="sn-themes"></div>` : ''}
      <button class="btn primary block" id="sn-go" style="margin-top: 18px;">开始</button>`);
    const q = s => p.querySelector(s);
    q('#sn-title').addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
    const draw = () => {
      q('#sn-mem').classList.toggle('off', !f.withMemory);
      q('#sn-mem-s').textContent = f.withMemory ? '它认识你：带着小本本和前情提要进去，只是换个地方演' : '它不认识你：只带人设，一切照你写的设定来（也更省额度）';
      const box = q('#sn-themes');
      if (box) { box.innerHTML = themePick(themes, f.themeId, '跟着它的'); box.querySelectorAll('[data-theme]').forEach(b => b.onclick = () => { f.themeId = b.dataset.theme ? Number(b.dataset.theme) : null; draw(); }); }
    };
    q('#sn-mem').onclick = () => { f.withMemory = !f.withMemory; draw(); };
    draw();
    q('#sn-go').onclick = async e => {
      e.target.disabled = true;
      try {
        const st = await api(`/cats/${o.catId}/stories`, { json: { setting: q('#sn-setting').value, title: q('#sn-title').value, withMemory: f.withMemory, themeId: f.themeId } });
        Maowo.go(`/cats/${o.catId}/s/${st.id}`);
      } catch (err) { e.target.disabled = false; Maowo.toast(err.message); }
    };
  }

  // 告诉主线的它: a summary, hers or written by the cat.
  function tell(o) {
    const p = Maowo.sheet(`<h2>告诉主线的它</h2>
      <div class="small muted" style="margin: 4px 0 12px; line-height: 1.6;">把这段故事的摘要放进主线的记忆里，平时的${esc(o.cat.name)}就知道你们演过这一段。这段故事还留着，可以接着演。${o.story.told ? '<br>之前已经告诉过一次了，再告诉会多一条。' : ''}</div>
      <textarea id="st-text" rows="6" maxlength="1500" placeholder="自己写一段摘要。不写的话，点下面让它自己总结。" style="resize: vertical;"></textarea>
      <div class="row" style="margin-top: 12px;"><button class="btn" id="st-auto">让它自己总结</button><button class="btn primary" id="st-ok">就告诉它这段</button></div>`);
    const q = s => p.querySelector(s);
    const send = async (text, btn) => {
      btn.disabled = true;
      const old = btn.textContent; btn.textContent = text ? '正在告诉…' : '它在总结…';
      try { const r = await api(`/cats/${o.catId}/stories/${o.story.id}/tell`, { json: { text } }); p.close(); Maowo.toast('告诉主线的它了'); Maowo.sheet(`<h2>主线的它知道了</h2><div class="detail-pre" style="margin-top: 10px; white-space: pre-wrap; line-height: 1.7; font-size: 14px;">${esc(r.text)}</div>`); o.onChange(); }
      catch (err) { btn.disabled = false; btn.textContent = old; Maowo.toast(err.message); }
    };
    q('#st-auto').onclick = e => send('', e.target);
    q('#st-ok').onclick = e => { const t = q('#st-text').value.trim(); if (!t) return Maowo.toast('先写一段，或者点「让它自己总结」'); send(t, e.target); };
  }

  function rename(o) {
    const p = Maowo.sheet(`<h2>改名字</h2><textarea class="single" rows="1" id="sr-title" maxlength="24">${esc(o.story.title)}</textarea><button class="btn primary block" id="sr-ok" style="margin-top: 14px;">保存</button>`);
    p.querySelector('#sr-title').addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
    p.querySelector('#sr-ok').onclick = async () => {
      try { await api(`/cats/${o.catId}/stories/${o.story.id}`, { method: 'PUT', json: { title: p.querySelector('#sr-title').value } }); p.close(); o.onChange(); } catch (err) { Maowo.toast(err.message); }
    };
  }
  return { open };
})();
