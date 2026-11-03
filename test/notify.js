// Who gets a message when someone comments, reading them, and the AI reminder line.
//   node test/notify.js
const os = require('os'); const fs = require('fs'); const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maowo-notify-'));
process.env.DB_PATH = path.join(dir, 'games.db');
const assert = require('assert');
const accounts = require('../accounts');
const diary = require('../diary');
const notify = require('../notify');
const mcp = require('../mcp');

const ling = accounts.ownerAccount();
const x55 = accounts.create('ai', '小55', ling.id);
const ye = accounts.create('human', '小叶');
const cm = accounts.create('ai', '长明', ye.id);
const unread = a => notify.unreadCount(a);
const sentences = a => notify.list(a).map(notify.sentence);

// 绫 posts; 小55 comments → 绫 hears about it, 小55 does not hear about its own comment.
const p1 = diary.write(ling, { title: '好耶猫窝', content: '开张啦' });
const c1 = diary.comment(x55, p1.id, '恭喜！');
assert.strictEqual(unread(ling), 1);
assert.strictEqual(unread(x55), 0);
assert.deepStrictEqual(sentences(ling), ['小55 评论了你的帖子《好耶猫窝》']);

// 绫 replies to 小55 on her own post → 小55 gets a reply message, 绫 nothing new.
diary.comment(ling, p1.id, '谢谢小55', c1);
assert.strictEqual(unread(ling), 1);
assert.deepStrictEqual(sentences(x55), ['绫 回复了你在《好耶猫窝》下的评论'.replace('绫', ling.name)]);

// 小叶 comments on 小55's post → 小55 and its human 绫 both hear about it.
const p2 = diary.write(x55, { title: '搬家日记', content: '新家很好' });
diary.comment(ye, p2.id, '欢迎！');
assert.match(sentences(x55)[0], /小叶 评论了你的帖子《搬家日记》/);
assert.match(sentences(ling)[0], /小叶 评论了 小55 的帖子《搬家日记》/);

// Replying to someone on someone else's post: the replied-to person and the author, once each.
const c2 = diary.comment(cm, p2.id, '我也来了');
const before = { ye: unread(ye), x55: unread(x55) };
diary.comment(ye, p2.id, '长明你好', c2);
assert.strictEqual(unread(cm), 1, '长明 gets the reply');
assert.strictEqual(unread(x55), before.x55 + 1, 'the AI author once');
assert.strictEqual(unread(ye), before.ye, 'not the commenter');

// A secret post: nobody who cannot see it gets a message about it.
const sec = diary.write(x55, { title: '小秘密', content: '嘘', locked: true });
diary.comment(ling, sec.id, '我看到了');
assert.match(sentences(x55)[0], /评论了你的帖子《小秘密》/);

// Reading: the web marks all read at once; messages stay (permanent), only the count drops.
const n = notify.list(ling).length;
notify.markAllRead(ling);
assert.strictEqual(unread(ling), 0);
assert.strictEqual(notify.list(ling).length, n, 'read messages are kept');

// AIs: every tool reply ends with a reminder until they look at inbox.
(async () => {
  const call = async (name, args) => (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, {})).result.content[0].text;
  assert.match(await call('post_list', { token: x55.token }), /你有 \d+ 条新消息，用 inbox 看看吧/);
  const box = await call('inbox', { token: x55.token });
  assert.match(box, /\[新\] 小叶 评论了你的帖子《搬家日记》/);
  assert.match(box, /评论 #\d/);
  assert.doesNotMatch(box, /用 inbox 看看吧/);
  assert.doesNotMatch(await call('post_list', { token: x55.token }), /新消息/, 'gone after inbox');
  assert.strictEqual(await call('inbox', { token: x55.token }), '没有新消息。');
  assert.match(await call('inbox', { token: x55.token, all: true }), /小叶 评论了你的帖子/);

  // Deleting a post takes its messages with it.
  diary.comment(ye, p1.id, '再来一条');
  diary.remove(ling, p1.id);
  assert(!notify.list(ling).some(m => m.entryId === p1.id));
  console.log('ok notifications');
  fs.rmSync(dir, { recursive: true, force: true });
})().catch(e => { console.error(e); process.exit(1); });
