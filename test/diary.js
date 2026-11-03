// Who can see, edit, comment on and delete diary entries.
const os = require('os'); const fs = require('fs'); const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maowo-diary-'));
process.env.DB_PATH = path.join(dir, 'games.db');
const assert = require('assert');
const accounts = require('../accounts');
const diary = require('../diary');

const owner = accounts.ownerAccount();
const a1 = accounts.create('ai', '夜声', owner.id);
const a2 = accounts.create('ai', '临川', owner.id);
const friend = accounts.create('human', '朋友');
const b1 = accounts.create('ai', '朋友的AI', friend.id);
const fails = (fn, re) => assert.throws(fn, re);

const locked = diary.handleMcpTool('diary_write', { token: a1.token, title: '只给主人看', content: '今天很开心。', locked: true });
const lockedId = locked.match(/\[(\w+)\]/)[1];
const open = diary.handleMcpTool('diary_write', { token: a1.token, title: '公开的', content: '大家好。' });
const openId = open.match(/\[(\w+)\]/)[1];
const seen = viewer => diary.exportFor(viewer).map(e => e.id).sort();

assert.deepStrictEqual(seen(a1), [lockedId, openId].sort(), 'author sees both');
assert.deepStrictEqual(seen(owner), [lockedId, openId].sort(), 'owner sees both');
for (const v of [a2, friend, b1]) assert.deepStrictEqual(seen(v), [openId], `${v.name} sees only the open one`);
fails(() => diary.handleMcpTool('diary_read', { token: a2.token, id: lockedId }), /找不到/);
fails(() => diary.handleMcpTool('diary_read', { token: b1.token, id: lockedId }), /找不到/);
fails(() => diary.handleMcpTool('diary_comment', { token: b1.token, id: lockedId, text: 'hi' }), /找不到/);
diary.handleMcpTool('diary_comment', { token: b1.token, id: openId, text: '你好呀' });
fails(() => diary.handleMcpTool('diary_write', { token: a2.token, id: openId, content: '改掉' }), /只能修改自己/);
fails(() => diary.handleMcpTool('diary_write', { token: friend.token, content: '人类写' }), /只有 AI/);
diary.handleMcpTool('diary_write', { token: a1.token, id: openId, locked: true });
assert.deepStrictEqual(seen(b1), [], 'locking later hides it');
console.log('ok diary visibility');

// Search (绫's example): 小叶's AI 长明 posts a secret. 绫 searching for 长明 / 小叶 / 悄悄话
// gets only public posts and her own AIs' secrets, never a locked card from someone else.
const ye = accounts.create('human', '小叶');
const cm = accounts.create('ai', '长明', ye.id);
diary.handleMcpTool('diary_write', { token: cm.token, title: '长明和小叶的悄悄话', content: '只说给小叶听。', locked: true });
diary.handleMcpTool('diary_write', { token: cm.token, title: '长明的公开帖', content: '大家好。' });
diary.handleMcpTool('diary_write', { token: a2.token, title: '临川的小秘密', content: '悄悄话给绫。', locked: true });
const found = (viewer, q) => diary.list(viewer, { q }).map(e => e.title);
assert.deepStrictEqual(found(owner, '长明'), ['长明的公开帖'], 'by author name: only the public one');
assert.deepStrictEqual(found(owner, '小叶'), [], 'words inside someone else\'s secret: nothing');
assert.deepStrictEqual(found(owner, '悄悄话'), ['临川的小秘密'], 'her own AI\'s secret is found');
assert.deepStrictEqual(found(a1, '悄悄话'), [], 'another of her AIs cannot see it');
assert.deepStrictEqual(found(ye, '悄悄话'), ['长明和小叶的悄悄话'], '小叶 finds her own AI\'s secret');
assert.deepStrictEqual(found(cm, '长明 公开'), ['长明的公开帖'], 'several words must all match');
assert.deepStrictEqual(found(owner, 'CHANGMING'.toLowerCase()), [], 'no false hits');
assert.match(diary.handleMcpTool('diary_list', { token: friend.token, q: '小叶' }), /没有搜到/);
console.log('ok diary search');

// Tools are listed as post_*; the old diary_* names still work.
const names = diary.mcpTools.map(t => t.name);
assert.deepStrictEqual(names, ['post_write', 'post_list', 'post_read', 'post_comment']);
assert.match(diary.handleMcpTool('post_list', { token: a2.token, q: '悄悄话' }), /临川的小秘密/);
assert.match(diary.handleMcpTool('diary_list', { token: a2.token, q: '悄悄话' }), /临川的小秘密/);
console.log('ok post tool names');
fs.rmSync(dir, { recursive: true, force: true });
