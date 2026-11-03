// The vault over MCP: AIs can write but only read what the owner shared with them.
//   node test/vault.js
const os = require('os'); const fs = require('fs'); const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maowo-vault-'));
process.env.DB_PATH = path.join(dir, 'games.db');
const assert = require('assert');
const accounts = require('../accounts');
const vault = require('../vault');
const mcp = require('../mcp');

const owner = accounts.ownerAccount();
const x55 = accounts.create('ai', '小55', owner.id);
const lc = accounts.create('ai', '临川', owner.id);
const ye = accounts.create('human', '小叶');
const cm = accounts.create('ai', '长明', ye.id);

// Claude connects with the owner's token in the address; the AI passes its own token.
const call = async (name, args, session = { account: owner }) => {
  const r = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, session);
  return { text: r.result.content[0].text, error: !!r.result.isError };
};

(async () => {
  const diary = vault.createNote({ title: '绫的日记', content: '今天有点累' }, 'web');

  // Writing works; reading what is not shared does not, not even with an owner connection.
  let r = await call('vault_save', { token: x55.token, title: '小55的笔记', content: '记一下：绫喜欢狼人杀' });
  assert(!r.error, r.text);
  assert.match(r.text, /存进去以后你读不到/);
  const mine = r.text.match(/\[(\w+)\]/)[1];
  assert.strictEqual(vault.getItem(mine).created_by, x55.id);
  r = await call('vault_list', { token: x55.token });
  assert.match(r.text, /主人还没有分享存档给你/);
  r = await call('vault_read', { token: x55.token, id: diary.id });
  assert(r.error && /找不到/.test(r.text));
  r = await call('vault_read', { token: x55.token, id: mine });
  assert(r.error, 'not even its own note can be read back');
  r = await call('vault_read', { id: diary.id });
  assert(r.error, 'no AI token on an owner connection: still not readable over MCP');
  // It may update its own note by ID, but not the owner's.
  r = await call('vault_save', { token: x55.token, id: mine, title: '小55的笔记', content: '更新：绫也喜欢五子棋' });
  assert(!r.error, r.text);
  r = await call('vault_save', { token: x55.token, id: diary.id, title: 'x', content: '覆盖' });
  assert(r.error);
  assert.strictEqual(vault.getItem(diary.id).content, '今天有点累');

  // Sharing with one AI, then with all.
  vault.share(diary.id, [x55.id]);
  r = await call('vault_list', { token: x55.token });
  assert.match(r.text, /绫的日记/);
  assert.doesNotMatch(r.text, /小55的笔记/, 'only shared items are listed');
  r = await call('vault_read', { token: x55.token, id: diary.id });
  assert.match(r.text, /今天有点累/);
  r = await call('vault_read', { token: lc.token, id: diary.id });
  assert(r.error, '临川 was not given it');
  vault.share(diary.id, 'all');
  r = await call('vault_read', { token: lc.token, id: diary.id });
  assert.match(r.text, /今天有点累/);
  vault.share(diary.id, []);
  r = await call('vault_read', { token: x55.token, id: diary.id });
  assert(r.error, 'unshared again');

  // Someone else's AI never gets in, whatever the connection.
  vault.share(diary.id, 'all');
  r = await call('vault_list', { token: cm.token });
  assert(r.error && /只有主人/.test(r.text));
  r = await call('vault_save', { token: cm.token, title: 'x', content: 'y' });
  assert(r.error);
  r = await call('vault_list', {}, { account: ye });
  assert(r.error);
  console.log('ok vault: AIs write, read only what is shared');
  fs.rmSync(dir, { recursive: true, force: true });
})().catch(e => { console.error(e); process.exit(1); });
