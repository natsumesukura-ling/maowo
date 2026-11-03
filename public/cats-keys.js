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

  return { keys, models, oneLine, PRESETS };
})();
