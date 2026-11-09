// 猫们共用：钥匙面板、选择模型面板、单行输入框。cats.html 和 cat.html 都用。
window.CatKit = (() => {
  const { api, esc, icon } = Maowo;

  // Single-line boxes are <textarea rows="1" class="single">: an <input> makes Android Chrome show
  // its autofill bar (keys / cards / addresses) above the keyboard. Enter does not add a line.
  function oneLine(root) {
    root.querySelectorAll('textarea.single').forEach(t => {
      t.addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
      t.addEventListener('input', () => { if (/\n/.test(t.value)) t.value = t.value.replace(/\n/g, ''); });
    });
  }

  // Each of these speaks the OpenAI format; picking one fills in the address.
  const PRESETS = [
    { name: 'DeepSeek', url: 'https://api.deepseek.com' },
    { name: 'GLM', url: 'https://open.bigmodel.cn/api/paas/v4' },
    { name: 'Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai' },
    { name: '中转站 / 其他', url: '' },
  ];

  const okPill = k => k.ok === true ? '<span class="pill ok">能用</span>' : k.ok === false ? '<span class="pill secret">连不上</span>' : '<span class="pill">还没试</span>';

  // The keys panel. onChange runs after anything changed, so the page can redraw.
  function keys(onChange = () => {}) {
    const panel = Maowo.sheet('<h2>钥匙</h2><div id="ck-body"><div class="small muted">读取中…</div></div>');
    let preset = 0;
    async function draw() {
      const d = await api('/cats');
      const body = panel.querySelector('#ck-body');
      body.innerHTML = `
        <div class="small muted" style="margin-bottom: 14px; line-height: 1.6;">API key 存在你自己的服务器上，填好以后谁都看不到原文，包括你自己。只用 OpenAI 格式的接口。</div>
        ${d.keys.map(k => `<div class="ck-key">
          <div class="n">${esc(k.name)}${okPill(k)}</div>
          <div class="u mono">${esc(k.baseUrl)} · ••••${esc(k.tail)}</div>
          ${k.ok === false && k.error ? `<div class="small" style="color: var(--danger); margin-top: 6px; line-height: 1.5;">${esc(k.error)}</div>` : ''}
          <div class="r"><span class="who">${k.users.length ? esc(k.users.join('、')) + ' 在用' : '还没有猫在用'}</span>
            <button class="btn sm" data-test="${k.id}">测试</button><button class="btn sm" data-change="${k.id}">换 key</button><button class="btn sm danger" data-del="${k.id}">删除</button></div>
        </div>`).join('')}
        <div class="ribbon" style="margin-top: 20px;"><span class="tag" style="font-size: 16px;">新钥匙</span><span class="rule"></span></div>
        <div class="ck-pick">${PRESETS.map((p, i) => `<button type="button" class="${i === preset ? 'on' : ''}" data-preset="${i}">${esc(p.name)}</button>`).join('')}</div>
        <label class="field">名字（自己认得就行）</label><textarea class="single" rows="1" id="ck-name" maxlength="20">${esc(PRESETS[preset].url ? PRESETS[preset].name : '')}</textarea>
        <label class="field">网址${PRESETS[preset].url ? '（已经自动填好了）' : '（中转站给你的地址，一般以 /v1 结尾）'}</label>
        <textarea class="single mono" rows="1" id="ck-url" style="font-size: 13px;" placeholder="https://…/v1">${esc(PRESETS[preset].url)}</textarea>
        <label class="field">API key</label><textarea class="single" rows="1" id="ck-key" placeholder="粘贴在这里" autocomplete="off" spellcheck="false"></textarea>
        <button class="btn primary block" id="ck-save" style="margin-top: 14px;">保存并测试</button>`;
      oneLine(body);
      body.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => { preset = Number(b.dataset.preset); draw(); });
      body.querySelectorAll('[data-test]').forEach(b => b.onclick = () => test(b.dataset.test, b));
      body.querySelectorAll('[data-change]').forEach(b => b.onclick = () => {
        const k = d.keys.find(x => String(x.id) === b.dataset.change);
        const p = Maowo.sheet(`<h2>换 key</h2><div class="small muted" style="line-height: 1.6;">给「${esc(k.name)}」换一个新的 API key，旧的就不用了。</div>
          <textarea class="single" rows="1" id="ck-new" placeholder="粘贴新的 key" autocomplete="off" spellcheck="false" style="margin-top: 14px;"></textarea>
          <button class="btn primary block" id="ck-ok" style="margin-top: 12px;">保存并测试</button>`);
        oneLine(p);
        p.querySelector('#ck-ok').onclick = async () => {
          const v = p.querySelector('#ck-new').value.trim();
          if (!v) return Maowo.toast('先粘贴新的 key');
          try { await api(`/cats/keys/${k.id}`, { method: 'PUT', json: { apiKey: v } }); p.close(); await test(k.id); } catch (err) { Maowo.toast(err.message); }
        };
      });
      body.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        const k = d.keys.find(x => String(x.id) === b.dataset.del);
        if (!confirm(`删除钥匙「${k.name}」？${k.users.length ? `${k.users.join('、')} 会没有钥匙用，要重新选一把。` : ''}`)) return;
        try { await api(`/cats/keys/${k.id}`, { method: 'DELETE' }); await draw(); onChange(); } catch (err) { Maowo.toast(err.message); }
      });
      body.querySelector('#ck-save').onclick = async e => {
        const btn = e.currentTarget;
        btn.disabled = true; btn.textContent = '保存中…';
        try {
          const k = await api('/cats/keys', { json: { name: body.querySelector('#ck-name').value, baseUrl: body.querySelector('#ck-url').value, apiKey: body.querySelector('#ck-key').value } });
          await test(k.id);
        } catch (err) { Maowo.toast(err.message); btn.disabled = false; btn.textContent = '保存并测试'; }
      };
    }
    async function test(id, btn) {
      if (btn) { btn.disabled = true; btn.textContent = '测试中…'; }
      try {
        const r = await api(`/cats/keys/${id}/models`);
        Maowo.toast(r.models.length ? `能用！有 ${r.models.length} 个模型可以选` : '连上了，但它没列出模型，选模型时自己填名字就行');
      } catch (err) { Maowo.toast(`测试没通过：${err.message}`); }
      await draw(); onChange();
    }
    draw().catch(err => Maowo.toast(err.message));
    return panel;
  }

  // Pick a model from what the key's server lists; or type a name.
  function models(keyId, keyName, current, onPick) {
    const panel = Maowo.sheet(`<h2>选择模型</h2>
      <div class="small muted" style="margin-bottom: 12px; line-height: 1.6;">「${esc(keyName)}」这把钥匙能用的模型，是猫窝刚刚去问来的。</div>
      <div class="ck-search"><span class="i">${icon('search', 18, 1.8)}</span><textarea class="single" rows="1" id="cm-q" placeholder="搜一搜，比如 chat"></textarea></div>
      <div id="cm-list"><div class="small muted">正在问…</div></div>
      <div class="small muted" style="margin-top: 12px;">列表里没有？<a href="#" id="cm-own">自己填模型名</a></div>`);
    oneLine(panel);
    let all = [];
    const list = panel.querySelector('#cm-list');
    const draw = () => {
      const q = panel.querySelector('#cm-q').value.trim().toLowerCase();
      const shown = all.filter(m => !q || m.toLowerCase().includes(q));
      list.innerHTML = shown.length ? `<div class="ck-models">${shown.map(m => `<button type="button" class="mono ${m === current ? 'on' : ''}" data-m="${esc(m)}">${esc(m)}${m === current ? `<span class="ck">${icon('check', 18, 2.2)}</span>` : ''}</button>`).join('')}</div>`
        : `<div class="empty" style="padding: 16px 0;">${all.length ? '没有搜到' : '它没有列出模型'}</div>`;
      list.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { panel.close(); onPick(b.dataset.m); });
    };
    panel.querySelector('#cm-q').addEventListener('input', draw);
    panel.querySelector('#cm-own').onclick = e => {
      e.preventDefault();
      const v = prompt('模型名（比如 deepseek-chat）', current || '');
      if (v && v.trim()) { panel.close(); onPick(v.trim()); }
    };
    api(`/cats/keys/${keyId}/models`).then(r => { all = r.models; draw(); })
      .catch(err => { list.innerHTML = `<div class="small" style="color: var(--danger); line-height: 1.6;">问不到模型列表：${esc(err.message)}<br>可以点下面自己填模型名。</div>`; });
    return panel;
  }

  // 面具: 绫's own personas. Each is 通用 or for one cat; each cat wears one (chosen in its settings).
  function masks(onChange = () => {}) {
    const panel = Maowo.sheet('<h2>我的面具</h2><div id="cm-body"><div class="small muted">读取中…</div></div>');
    async function draw() {
      const [list, d] = await Promise.all([api('/cats/masks'), api('/cats')]);
      panel.querySelector('#cm-body').innerHTML = `
        <div class="small muted" style="margin: 4px 0 14px; line-height: 1.6;">面具是<b>你自己</b>的人设：你叫什么、什么样子、和它是什么关系。可以写好几个；每只猫的设置里选一个戴上，它就按这个认识你。角色卡里的 {{user}} 也会换成面具的名字。</div>
        ${list.map(m => `<div class="ck-key">
          <div class="n">${esc(m.name)}<span class="pill">${m.catId ? `只给 ${esc(m.catName || '')}` : '通用'}</span></div>
          <div class="u" style="white-space: pre-wrap; max-height: 4.8em; overflow: hidden;">${esc(m.content || '（没写人设）')}</div>
          <div class="r"><span class="who">${m.wornBy.length ? esc(m.wornBy.join('、')) + ' 面前戴着' : '还没有猫面前戴着'}</span>
            <button class="btn sm" data-edit="${m.id}">编辑</button><button class="btn sm danger" data-del="${m.id}">删除</button></div>
        </div>`).join('') || '<div class="small muted" style="margin-bottom: 12px;">还没有面具。</div>'}
        <button class="btn primary block" id="cm-new" style="margin-top: 8px;">${icon('plus', 18, 2)}新面具</button>`;
      panel.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => edit(list.find(m => m.id === Number(b.dataset.edit)), d.cats));
      panel.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        const m = list.find(x => x.id === Number(b.dataset.del));
        if (!confirm(`删除面具「${m.name}」？${m.wornBy.length ? `${m.wornBy.join('、')} 面前就不戴面具了。` : ''}`)) return;
        try { await api(`/cats/masks/${m.id}`, { method: 'DELETE' }); draw(); onChange(); } catch (err) { Maowo.toast(err.message); }
      });
      panel.querySelector('#cm-new').onclick = () => edit(null, d.cats);
    }
    function edit(m, cats) {
      const f = { name: m ? m.name : '', content: m ? m.content : '', catId: m ? m.catId : null };
      const sheet = Maowo.sheet(`<h2>${m ? '改面具' : '新面具'}</h2>
        <label class="field">名字（你在这个人设里叫什么）</label><textarea class="single" rows="1" id="cm-name" maxlength="30">${esc(f.name)}</textarea>
        <div class="row" style="justify-content: space-between; align-items: flex-end; margin-bottom: 8px;"><label class="field">你的人设</label>
          <button type="button" class="btn sm" id="cm-up">${icon('book', 15, 1.8)}从文件读</button></div>
        <input type="file" id="cm-file" accept=".txt,.md,.markdown,.doc,.docx,text/plain,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden>
        <textarea id="cm-content" rows="7" maxlength="20000" placeholder="比如：高二学生，怕黑，喜欢草莓牛奶。和他是青梅竹马。" style="resize: vertical;">${esc(f.content)}</textarea>
        <label class="field">给谁用</label>
        <div class="ck-pick" id="cm-who"></div>
        <button class="btn primary block" id="cm-save" style="margin-top: 18px;">保存</button>`);
      const q = s => sheet.querySelector(s);
      oneLine(sheet);
      const drawWho = () => {
        q('#cm-who').innerHTML = `<button type="button" class="${f.catId ? '' : 'on'}" data-cat="">通用（每只猫都能用）</button>`
          + cats.map(c => `<button type="button" class="${f.catId === c.id ? 'on' : ''}" data-cat="${c.id}">只给 ${esc(c.name)}</button>`).join('');
        q('#cm-who').querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { f.catId = b.dataset.cat ? Number(b.dataset.cat) : null; drawWho(); });
      };
      drawWho();
      q('#cm-up').onclick = () => q('#cm-file').click();
      q('#cm-file').onchange = async e => {
        const file = e.target.files[0]; e.target.value = '';
        if (!file) return;
        if (q('#cm-content').value.trim() && !confirm(`用「${file.name}」里的文字换掉现在写的人设？`)) return;
        try {
          const res = await fetch(`/api/file-text?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { Authorization: 'Bearer ' + Maowo.token(), 'Content-Type': 'application/octet-stream' }, body: file });
          const out = await res.json(); if (!res.ok) throw new Error(out.error || res.status);
          q('#cm-content').value = out.text.slice(0, 20000);
          Maowo.toast(out.text.length > 20000 ? '太长了，只放了前 2 万字' : `读好了，约 ${out.text.length} 字`);
        } catch (err) { Maowo.toast(err.message); }
      };
      q('#cm-save').onclick = async () => {
        const body = { name: q('#cm-name').value, content: q('#cm-content').value, catId: f.catId };
        try {
          await api(m ? `/cats/masks/${m.id}` : '/cats/masks', { method: m ? 'PUT' : 'POST', json: body });
          sheet.close(); Maowo.toast('保存好了'); draw(); onChange();
        } catch (err) { Maowo.toast(err.message); }
      };
    }
    draw();
  }

  // 预设: how the cats should reply (style, length, format). Each cat uses one or none (in its settings).
  function presets(onChange = () => {}) {
    const panel = Maowo.sheet('<h2>预设</h2><div id="cp-body"><div class="small muted">读取中…</div></div>');
    async function draw() {
      const list = await api('/cats/presets');
      panel.querySelector('#cp-body').innerHTML = `
        <div class="small muted" style="margin: 4px 0 14px; line-height: 1.6;">预设是你要求它<b>怎么回复</b>：文风、人称、长度、格式、要不要写动作描写……每只猫的设置里可以选一套，也可以不用，让它自然地说。可以自己写，也可以导入酒馆的预设 json。</div>
        ${list.map(p => `<div class="ck-key">
          <div class="n">${esc(p.name)}<span class="pill">${p.position === 'bottom' ? '放在最后' : '放在设定里'}</span></div>
          <div class="u" style="white-space: pre-wrap; max-height: 4.8em; overflow: hidden;">${esc(p.content)}</div>
          <div class="r"><span class="who">${p.usedBy.length ? esc(p.usedBy.join('、')) + ' 在用' : '还没有猫在用'}</span>
            <button class="btn sm" data-edit="${p.id}">编辑</button><button class="btn sm danger" data-del="${p.id}">删除</button></div>
        </div>`).join('') || '<div class="small muted" style="margin-bottom: 12px;">还没有预设。</div>'}
        <button class="btn primary block" id="cp-new" style="margin-top: 8px;">${icon('plus', 18, 2)}新预设</button>`;
      panel.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => edit(list.find(p => p.id === Number(b.dataset.edit))));
      panel.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        const p = list.find(x => x.id === Number(b.dataset.del));
        if (!confirm(`删除预设「${p.name}」？${p.usedBy.length ? `${p.usedBy.join('、')} 就不用预设了。` : ''}`)) return;
        try { await api(`/cats/presets/${p.id}`, { method: 'DELETE' }); draw(); onChange(); } catch (err) { Maowo.toast(err.message); }
      });
      panel.querySelector('#cp-new').onclick = () => edit(null);
    }
    function edit(p) {
      const f = { position: p ? p.position : 'top' };
      const sheet = Maowo.sheet(`<h2>${p ? '改预设' : '新预设'}</h2>
        <label class="field">名字</label><textarea class="single" rows="1" id="cp-name" maxlength="30">${esc(p ? p.name : '')}</textarea>
        <div class="row" style="justify-content: space-between; align-items: flex-end; margin-bottom: 8px;"><label class="field">要求它怎么回复</label>
          <button type="button" class="btn sm" id="cp-up">${icon('book', 15, 1.8)}从文件读</button></div>
        <input type="file" id="cp-file" accept=".json,.txt,.md,.markdown,.doc,.docx,application/json,text/plain,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden>
        <textarea id="cp-content" rows="9" maxlength="20000" placeholder="比如：用第三人称写，有动作和神态描写，每次 200 到 400 字，不要替{{user}}说话。" style="resize: vertical;">${esc(p ? p.content : '')}</textarea>
        <div class="small muted" style="margin-top: 6px; line-height: 1.6;">可以写 {{user}}（你戴的面具的名字）和 {{char}}（它的名字）。「从文件读」支持 txt / md / doc / docx，还有酒馆导出的预设 json。</div>
        <label class="field">放在哪</label>
        <div class="ck-pick" id="cp-pos"></div>
        <div class="small muted" id="cp-pos-hint" style="margin-top: 6px; line-height: 1.6;"></div>
        <button class="btn primary block" id="cp-save" style="margin-top: 18px;">保存</button>`);
      const q = s => sheet.querySelector(s);
      oneLine(sheet);
      const drawPos = () => {
        q('#cp-pos').innerHTML = `<button type="button" class="${f.position === 'top' ? 'on' : ''}" data-pos="top">放在设定里</button><button type="button" class="${f.position === 'bottom' ? 'on' : ''}" data-pos="bottom">放在最后</button>`;
        q('#cp-pos-hint').textContent = f.position === 'top' ? '和 System prompt 放在一起，省钱，大多数时候够用。' : '每次贴在你最新那句话后面，它最听话（酒馆里「破限 / 后置提示」那种），会多花一点点。';
        q('#cp-pos').querySelectorAll('[data-pos]').forEach(b => b.onclick = () => { f.position = b.dataset.pos; drawPos(); });
      };
      drawPos();
      q('#cp-up').onclick = () => q('#cp-file').click();
      q('#cp-file').onchange = async e => {
        const file = e.target.files[0]; e.target.value = '';
        if (!file) return;
        if (q('#cp-content').value.trim() && !confirm(`用「${file.name}」里的内容换掉现在写的？`)) return;
        try {
          const res = await fetch(`/api/cats/presets/file?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { Authorization: 'Bearer ' + Maowo.token(), 'Content-Type': 'application/octet-stream' }, body: file });
          const out = await res.json(); if (!res.ok) throw new Error(out.error || res.status);
          q('#cp-content').value = out.content;
          if (!q('#cp-name').value.trim()) q('#cp-name').value = out.name;
          Maowo.toast(out.cut ? '太长了，只放了前 2 万字' : `读好了，约 ${out.content.length} 字`);
        } catch (err) { Maowo.toast(err.message); }
      };
      q('#cp-save').onclick = async () => {
        const body = { name: q('#cp-name').value, content: q('#cp-content').value, position: f.position };
        try {
          await api(p ? `/cats/presets/${p.id}` : '/cats/presets', { method: p ? 'PUT' : 'POST', json: body });
          sheet.close(); Maowo.toast('保存好了'); draw(); onChange();
        } catch (err) { Maowo.toast(err.message); }
      };
    }
    draw();
  }

  // Styles for the two panels, added once.
  const css = document.createElement('style');
  css.textContent = `
    textarea.single { resize: none; height: 44px; overflow: hidden; white-space: nowrap; }
    .ck-key { padding: 14px; border-radius: 16px; background: var(--card); border: 1px solid var(--border); margin-bottom: 10px; }
    .ck-key .n { font-family: "Noto Serif SC", serif; font-weight: 700; font-size: 16px; display: flex; align-items: center; gap: 8px; }
    .ck-key .u { font-size: 12px; color: var(--muted); margin-top: 6px; word-break: break-all; }
    .ck-key .r { display: flex; gap: 6px; margin-top: 10px; align-items: center; flex-wrap: wrap; }
    .ck-key .r .who { font-size: 12px; color: var(--text2); flex-grow: 1; min-width: 80px; }
    .ck-pick { display: flex; gap: 6px; flex-wrap: wrap; }
    .ck-pick button { padding: 8px 12px; border-radius: 12px; border: 1px solid var(--border); background: var(--white); font: inherit; font-size: 13px; color: var(--text); cursor: pointer; }
    .ck-pick button.on { background: var(--accent-soft); border-color: var(--accent-line); color: var(--accent-hover); font-weight: 600; }
    .ck-search { position: relative; margin-bottom: 12px; } .ck-search textarea { padding-left: 40px; }
    .ck-search .i { position: absolute; left: 13px; top: 12px; color: var(--muted); }
    .ck-models { border-radius: 14px; background: var(--card); border: 1px solid var(--border); overflow: hidden; }
    .ck-models button { width: 100%; display: flex; align-items: center; gap: 10px; padding: 13px 14px; font-size: 14px; border: none; background: none; color: var(--text); text-align: left; cursor: pointer; word-break: break-all; }
    .ck-models button + button { border-top: 1px solid var(--border); }
    .ck-models button.on { color: var(--accent-hover); font-weight: 600; background: var(--accent-soft); }
    .ck-models .ck { margin-left: auto; color: var(--accent); display: flex; }
  `;
  document.head.appendChild(css);

  return { keys, models, masks, presets, oneLine, PRESETS };
})();
