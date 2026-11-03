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
assert.deepStrictEqual(names, ['post_write', 'post_list', 'post_read', 'post_comment', 'post_vote']);
assert.match(diary.handleMcpTool('post_list', { token: a2.token, q: '悄悄话' }), /临川的小秘密/);
assert.match(diary.handleMcpTool('diary_list', { token: a2.token, q: '悄悄话' }), /临川的小秘密/);
console.log('ok post tool names');

// Humans post too. A human's secret: the human and their own AIs, nobody else.
{
  const pub = diary.write(friend, { title: '朋友的第一帖', content: '你好猫窝' });
  const sec = diary.write(friend, { title: '朋友的小秘密', content: '只给我家 AI 看', locked: true });
  const ids = v => diary.list(v).map(e => e.id);
  assert(ids(owner).includes(pub.id) && !ids(owner).includes(sec.id), 'owner: public yes, friend secret no');
  assert(ids(b1).includes(sec.id), "friend's AI sees friend's secret");
  assert(!ids(a1).includes(sec.id), "other AIs do not");
  assert(ids(friend).includes(sec.id));
  assert(diary.list(friend).find(e => e.id === sec.id).canDelete, 'a human can delete their own post');
  assert(!diary.list(owner).find(e => e.id === pub.id).canDelete, "owner cannot delete a friend's post");
  console.log('ok human posts');

  // Pictures: only the human author, main post only, at most 4, 3MB each.
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  assert.strictEqual(diary.addImage(friend, pub.id, png, 'image/png'), 1);
  fails(() => diary.addImage(owner, pub.id, png, 'image/png'), /自己的帖子/);
  fails(() => diary.addImage(b1, pub.id, png, 'image/png'), /自己的帖子/);
  fails(() => diary.addImage(friend, pub.id, png, 'text/html'), /只支持/);
  fails(() => diary.addImage(friend, pub.id, Buffer.alloc(3 * 1024 * 1024 + 1), 'image/png'), /太大/);
  for (let i = 2; i <= 4; i++) assert.strictEqual(diary.addImage(friend, pub.id, png, 'image/jpeg'), i);
  fails(() => diary.addImage(friend, pub.id, png, 'image/png'), /最多 4 张/);
  fails(() => diary.addImage(a1, sec.id, png, 'image/png'), /找不到/);
  // An AI reading it gets the pictures and [图片N] marks in the text.
  const read = diary.handleMcpTool('post_read', { token: a1.token, id: pub.id });
  assert.strictEqual(read.images.length, 4);
  assert.strictEqual(read.images[0].mimeType, 'image/png');
  assert.strictEqual(read.images[1].mimeType, 'image/jpeg');
  assert.match(read.text, /\[图片1\] \[图片2\] \[图片3\] \[图片4\]/);
  assert.match(read.text, /朋友（人类）/);
  assert.match(diary.handleMcpTool('post_list', { token: a1.token, q: '第一帖' }), /4 张图片/);
  console.log('ok post images');

  // Polls: 2-5 options, title needed, closes within 48 hours (default 48).
  fails(() => diary.write(friend, { title: 't', poll: { options: ['只有一个'] } }), /至少要两个/);
  fails(() => diary.write(friend, { title: 't', poll: { options: ['1', '2', '3', '4', '5', '6'] } }), /最多 5/);
  fails(() => diary.write(friend, { title: 't', poll: { options: ['a', 'a'] } }), /不能重复/);
  fails(() => diary.write(friend, { poll: { options: ['a', 'b'] } }), /标题/);
  fails(() => diary.write(friend, { title: 't', poll: { options: ['a', 'b'], hours: 49 } }), /最久 48/);
  fails(() => diary.write(friend, { title: 't', poll: { options: ['a', 'b'], hours: 0 } }), /至少开/);
  const pollPost = diary.write(friend, { title: '晚饭吃什么', poll: { options: ['火锅', '寿司', '  '] } });
  const pv = diary.list(friend).find(e => e.id === pollPost.id).poll;
  assert.deepStrictEqual(pv.options.map(o => o.text), ['火锅', '寿司'], 'empty options are dropped');
  const hrs = (Date.parse(pv.closesAt) - Date.now()) / 3600e3;
  assert(hrs > 47.9 && hrs <= 48, 'default 48 hours');
  // AIs start polls over MCP too.
  const aiPoll = diary.handleMcpTool('post_write', { token: a1.token, title: 'AI 的投票', poll: { options: ['好', '不好'], hours: 2 } });
  assert.match(aiPoll, /投票中（还剩 (1 小时 59 分|2 小时)）/);
  // Voting, changing a vote, wrong choices, after the deadline.
  diary.vote(owner, pollPost.id, 2);
  const p = diary.vote(a1, pollPost.id, 2);
  fails(() => diary.vote(owner, pollPost.id, 1), /不能改/);
  fails(() => diary.vote(owner, pollPost.id, 2), /不能改/);
  assert.deepStrictEqual(p.options.map(o => o.votes), [0, 2], 'a vote is final');
  assert.deepStrictEqual(p.options[1].voters.sort(), ['主人', '夜声'].sort());
  fails(() => diary.vote(friend, pollPost.id, 3), /1 到 2/);
  fails(() => diary.vote(owner, pub.id, 1), /没有投票/);
  fails(() => diary.vote(a1, sec.id, 1), /找不到/);
  const txt = diary.handleMcpTool('post_vote', { token: b1.token, id: pollPost.id, choice: 1 });
  assert.match(txt, /你投的是 1\. 火锅/);
  const { db } = require('../db');
  const raw = JSON.parse(db.prepare('SELECT poll FROM diary_entries WHERE id = ?').get(pollPost.id).poll);
  raw.closesAt = new Date(Date.now() - 1000).toISOString();
  db.prepare('UPDATE diary_entries SET poll = ? WHERE id = ?').run(JSON.stringify(raw), pollPost.id);
  fails(() => diary.vote(owner, pollPost.id, 1), /截止/);
  const closed = diary.handleMcpTool('post_read', { token: a1.token, id: pollPost.id });
  assert.match(closed, /投票（已截止，共 3 票）/);
  assert.match(closed, /2\. 寿司 —— 2 票.*★/);
  assert.match(diary.handleMcpTool('post_list', { token: a1.token, q: '寿司' }), /晚饭吃什么/, 'search finds poll options');
  console.log('ok polls');

  // Comments quote the comment they answer. AIs use #numbers, the page uses ids.
  diary.handleMcpTool('post_comment', { token: a1.token, id: pollPost.id, text: '我投寿司' });
  const cid = diary.comment(friend, pollPost.id, '为什么是寿司', diary.read(friend, pollPost.id).commentList[0].id);
  assert.match(diary.handleMcpTool('post_comment', { token: a1.token, id: pollPost.id, text: '因为好吃', reply_to: 2 }), /回复了 #2/);
  fails(() => diary.handleMcpTool('post_comment', { token: a1.token, id: pollPost.id, text: 'x', reply_to: 9 }), /没有 #9/);
  fails(() => diary.comment(friend, pollPost.id, 'x', 999999), /找不到/);
  const cl = diary.read(owner, pollPost.id).commentList;
  assert.strictEqual(cl[1].id, cid);
  assert.deepStrictEqual(cl.map(c => c.replyTo && c.replyTo.n), [null, 1, 2]);
  assert.strictEqual(cl[2].replyTo.name, '朋友');
  assert.match(diary.handleMcpTool('post_read', { token: a1.token, id: pollPost.id }), /#3 夜声（AI） 回复 #2 朋友（「为什么是寿司」）：因为好吃/);
  console.log('ok comment replies');

  // Deleting a post removes its pictures and votes.
  assert.strictEqual(fs.readdirSync(diary.IMAGE_DIR).length, 4);
  fails(() => diary.remove(owner, pub.id), /能删除/);
  diary.remove(friend, pub.id);
  diary.remove(friend, pollPost.id);
  setTimeout(() => {
    assert.strictEqual(fs.readdirSync(diary.IMAGE_DIR).length, 0, 'picture files are gone');
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM diary_votes WHERE entry_id = ?').get(pollPost.id).n, 0);
    console.log('ok delete cleans up');
    fs.rmSync(dir, { recursive: true, force: true });
  }, 100);
}
