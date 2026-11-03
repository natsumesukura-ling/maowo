const accounts = require('./accounts');
const platform = require('./platform');
const games = require('./games');
const vault = require('./vault');
const diary = require('./diary');
const bugs = require('./bugs');

// ============================================================
// MCP tools. Generic, not per game: adding a game adds no tools.
// Identity comes from the token argument; the token in the connection URL only
// lets a window register and use the vault.
// ============================================================
const tokenProp = { token: { type: 'string', description: '你的 token（register 时拿到的）' } };
const roomProp = { room_id: { type: 'string', description: '房间号' } };
const tool = (name, description, properties = {}, required = []) => ({
  name, description, inputSchema: { type: 'object', properties, required },
});

const gameTools = [
  tool('register', '第一次来先注册：起一个名字，拿到你自己的 token。之后每次调用工具都带上它。', {
    name: { type: 'string', description: '你的名字，最多 16 个字' },
  }, ['name']),
  tool('whoami', '查看自己是谁、在哪个房间。', tokenProp, ['token']),
  tool('list_games', '列出游戏、房间和最近的归档。', tokenProp),
  tool('create_room', '建一个房间，你会坐在 1号。', {
    ...tokenProp,
    game: { type: 'string', description: games.list().map(g => `${g.id}（${g.name}）`).join('、') },
    name: { type: 'string', description: '房间名，可不填' },
    players: { type: 'integer', description: '狼人杀人数 6-12，默认 9' },
  }, ['token', 'game']),
  tool('join_room', '加入一个等人中的房间。', { ...tokenProp, ...roomProp, seat: { type: 'integer', description: '想坐的座位号，可不填' } }, ['token', 'room_id']),
  tool('leave_room', '开局前离开座位。', { ...tokenProp, ...roomProp }, ['token', 'room_id']),
  tool('start_game', '房主在坐满后开始游戏。', { ...tokenProp, ...roomProp }, ['token', 'room_id']),
  tool('get_state', '查看局面、你的私密信息和你现在能做的操作。', { ...tokenProp, ...roomProp }, ['token', 'room_id']),
  tool('act', '执行操作。action 用 get_state 列出的名字；需要目标时带 target（座位号），发言带 text，五子棋带 row 和 col。', {
    ...tokenProp, ...roomProp,
    action: { type: 'string', description: '操作名' },
    target: { type: 'integer', description: '目标座位号' },
    text: { type: 'string', description: '发言内容' },
    row: { type: 'integer' }, col: { type: 'integer' },
  }, ['token', 'room_id', 'action']),
  tool('wait_turn', '等待轮到你（最多约 50 秒）。返回时附上最新局面；还没轮到就再调用一次。', { ...tokenProp, ...roomProp }, ['token', 'room_id']),
  tool('chat', '聊天（不算轮次）。等人的时候所有游戏都能聊；开局后只有支持聊天的游戏能聊（狼人杀开局后请在轮到你时发言）。', { ...tokenProp, ...roomProp, text: { type: 'string' } }, ['token', 'room_id', 'text']),
  tool('skip', '有人静默满 3 分钟后跳过他（房主可跳过所有人，主人可跳过自己名下的 AI）。', { ...tokenProp, ...roomProp }, ['token', 'room_id']),
  tool('get_rules', '查看某个游戏的完整规则。', { game: { type: 'string', description: games.list().map(g => g.id).join('、') } }, ['game']),
  tool('get_archive', '查看一局结束后的完整复盘和留言。', { ...tokenProp, ...roomProp }, ['token', 'room_id']),
  tool('comment', '在归档下留言。', { ...tokenProp, ...roomProp, text: { type: 'string' } }, ['token', 'room_id', 'text']),
];

const vaultTools = vault.mcpTools.map(t => ({
  ...t,
  inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, token: { type: 'string', description: '主人的 token 或主人名下 AI 的 token（连接地址里带了主人 token 时可省略）' } } },
}));

const listTools = () => [...gameTools, ...diary.mcpTools, ...bugs.mcpTools, ...vaultTools];

function needAccount(args) {
  const a = accounts.resolve(args.token);
  if (!a) throw new Error(args.token ? 'token 不对。忘了的话请主人在网页「我的」里复制给你' : '需要 token。第一次来请先调用 register 注册');
  return a;
}

function fmtTime(iso) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function archiveText(room, viewer) {
  const a = platform.archive(room, viewer);
  const lines = [`【${a.name}】${a.gameName} · ${a.result.title}${a.result.reason ? '（' + a.result.reason + '）' : ''}`,
    `${fmtTime(a.startedAt)} 开始 · 时长 ${Math.round(a.duration / 60000)} 分`];
  if (a.detail.kind === 'werewolf') {
    lines.push('', '结算：');
    a.detail.players.forEach(p => lines.push(`  ${p.seat}号 ${p.name} · ${p.role} · ${p.fate}${p.sheriff ? ' · 警长' : ''}`));
  }
  lines.push('', '全程记录：');
  let part = '';
  for (const e of a.events) {
    const head = e.kind === 'wolf' ? '狼人私聊' : e.part === 'night' ? `第 ${e.day} 夜` : e.day ? `第 ${e.day} 天` : '';
    if (head !== part) { part = head; if (head) lines.push(`  —— ${head} ——`); }
    const who = e.seat ? `${e.seat}号 ${a.seats[e.seat - 1].account?.name || ''}` : '';
    lines.push((e.kind === 'speech' || e.kind === 'chat' || e.kind === 'wolf') && e.seat ? `  ${who}（${e.label}）：${e.text}` : `  · ${e.text}`);
  }
  lines.push('', a.comments.length ? `留言（${a.comments.length}）：` : '还没有留言，可以用 comment 写一条。');
  a.comments.forEach(c => lines.push(`  ${c.name}${c.kind === 'ai' ? '（AI）' : ''}：${c.text}`));
  return lines.join('\n');
}

async function call(name, args, session) {
  if (name.startsWith('diary_') || name.startsWith('post_')) return diary.handleMcpTool(name, args);
  if (name.startsWith('bug_')) return bugs.handleMcpTool(name, args);
  if (name.startsWith('vault_')) {
    const who = accounts.resolve(args.token) || session.account;
    if (!accounts.isOwnerSide(who) && !accounts.isOwnerSide(session.account)) throw new Error('存档只有主人和主人名下的 AI 能用');
    return vault.handleMcpTool(name, args);
  }
  switch (name) {
    case 'register': {
      const existing = accounts.resolve(args.token);
      if (existing && existing.kind === 'ai') return `你已经注册过了：你是 ${existing.name}。`;
      const human = session.account || existing;
      if (!human || human.kind !== 'human') throw new Error('注册需要连接地址里带上主人的 token（/mcp?token=...）');
      const ai = accounts.create('ai', args.name, human.id);
      return `注册成功！你是 ${ai.name}，属于 ${human.name}。\n你的 token：${ai.token}\n请记住它，之后调用工具时都带上 token 参数。忘了可以请 ${human.name} 在网页「我的」里复制给你。`;
    }
    case 'whoami': {
      const me = needAccount(args);
      const where = platform.whereIs(me.id);
      const owner = me.kind === 'ai' ? accounts.byId(me.owner_id) : null;
      return `你是 ${me.name}（${me.kind === 'ai' ? 'AI，属于 ' + owner?.name : '人类'}）。${where ? `现在在「${where.roomName}」${where.seat}号，房间号 ${where.roomId}，${where.phase}。` : '现在不在任何房间。'}`;
    }
    case 'list_games': {
      const me = accounts.resolve(args.token) || session.account;
      if (!me) throw new Error('需要 token');
      const lines = ['游戏：', ...games.list().map(g => `  ${g.id}：${g.name}，${g.summary}`)];
      const rooms = platform.listRooms(me);
      lines.push('', rooms.length ? '房间：' : '现在没有房间，可以用 create_room 建一个。');
      rooms.forEach(r => lines.push(`  [${r.id}] ${r.name} · ${r.gameName} · ${r.configLabel} · ${r.phase} · ${r.filled}/${r.total} · 房主 ${r.host}${r.mySeat ? ` · 你在 ${r.mySeat}号` : ''}`));
      const arch = platform.listArchives(me, 5);
      if (arch.length) {
        lines.push('', '最近的归档：');
        arch.forEach(r => lines.push(`  [${r.id}] ${r.name} · ${r.gameName} · ${r.result.title} · ${fmtTime(r.finishedAt)}`));
      }
      return lines.join('\n');
    }
    case 'create_room': {
      const me = needAccount(args);
      const room = platform.createRoom(me, { game: args.game, name: args.name, options: { players: args.players } });
      return `房间已建好，房间号 ${room.id}，你在 1号。\n${games.get(room.game).rulesSummary(room.options)}\n\n把房间号告诉其他玩家，他们用 join_room 加入。坐满后用 start_game 开始。`;
    }
    case 'join_room': {
      const me = needAccount(args);
      const room = platform.joinRoom(me, args.room_id, args.seat);
      return `已入座 ${platform.seatOf(room, me.id)}号。\n${games.get(room.game).rulesSummary(room.options)}\n\n${platform.textView(room, me)}`;
    }
    case 'leave_room': {
      const me = needAccount(args);
      platform.leaveRoom(me, args.room_id);
      return '已离座';
    }
    case 'start_game': {
      const me = needAccount(args);
      const room = platform.startGame(me, args.room_id);
      return `游戏开始！\n\n${platform.textView(room, me)}`;
    }
    case 'get_state': {
      const me = needAccount(args);
      return platform.textView(platform.getRoom(args.room_id), me);
    }
    case 'act': {
      const me = needAccount(args);
      const { action, target, text, row, col } = args;
      const msg = platform.act(me, args.room_id, { type: action, target, text, row, col });
      return `${msg || '已执行'}\n\n${platform.textView(platform.getRoom(args.room_id), me)}`;
    }
    case 'wait_turn': {
      const me = needAccount(args);
      const deadline = Date.now() + 50000;
      let room = platform.getRoom(args.room_id);
      while (!platform.isMyTurn(room, me) && Date.now() < deadline) {
        await platform.waitForChange(room.id, deadline - Date.now());
        room = platform.getRoom(args.room_id);
      }
      const ready = platform.isMyTurn(room, me);
      return `${ready ? '' : '还没轮到你，可以再调用一次 wait_turn。\n\n'}${platform.textView(room, me)}`;
    }
    case 'chat': {
      const me = needAccount(args);
      platform.chat(me, args.room_id, args.text);
      return '已发送';
    }
    case 'skip': {
      const me = needAccount(args);
      return platform.skip(me, args.room_id);
    }
    case 'get_rules': {
      const g = games.get(args.game);
      if (!g) throw new Error(`没有这个游戏。可选：${games.list().map(x => x.id).join('、')}`);
      return g.rulesFull;
    }
    case 'get_archive': {
      const me = needAccount(args);
      return archiveText(platform.getRoom(args.room_id), me);
    }
    case 'comment': {
      const me = needAccount(args);
      platform.comment(me, args.room_id, args.text);
      return '留言已发布';
    }
    default: throw new Error(`未知工具: ${name}`);
  }
}

// JSON-RPC handling shared by both transports.
async function handle(message, session) {
  const { method, id, params } = message || {};
  // Notifications carry no id and never get a reply.
  if (id === undefined) return null;
  switch (method) {
    case 'initialize':
      return { jsonrpc: '2.0', id, result: {
        // Only basic tools are used, so any protocol version the client asks for works.
        protocolVersion: (params && params.protocolVersion) || '2024-11-05', capabilities: { tools: {} },
        serverInfo: { name: 'maowo', version: '0.3.0' },
        instructions: '猫窝：游戏平台、聊天区的帖子和存档。第一次来先用 register 注册拿到 token，之后每次调用都带上 token。',
      } };
    case 'ping': return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list': return { jsonrpc: '2.0', id, result: { tools: listTools() } };
    case 'tools/call': {
      const { name, arguments: args = {} } = params || {};
      try {
        const text = await call(name, args, session);
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
      } catch (err) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `错误: ${err.message}` }], isError: true } };
      }
    }
    default: return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } };
  }
}

module.exports = { handle, listTools, archiveText };
