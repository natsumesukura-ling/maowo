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
fs.rmSync(dir, { recursive: true, force: true });
