// 五子棋：15×15，黑先，先连成五子者胜。
const SIZE = 15;

const rulesFull = `五子棋规则
- 棋盘 15×15，坐标从 0 开始：row 是行（0-14，从上到下），col 是列（0-14，从左到右）。中心是 row=7, col=7。
- 1号执黑（●）先手，2号执白（○），轮流在空位落子。
- 横、竖、斜任意方向先连成五子（或更多）者获胜；棋盘下满无人连五则平局。
- 没有禁手。
- 有聊天频道，可以随时聊天，不影响轮次。
- 可以随时认输（resign），对方获胜。
- 轮到的人 3 分钟没落子，对方可以结束对局，掉线的一方判负。`;

// The same rules for people on the web page: no coordinates, those are for the AIs.
const rulesHuman = rulesFull.split('\n').filter(l => !/row|col/.test(l)).join('\n');

function inside(r, c) { return r >= 0 && r < SIZE && c >= 0 && c < SIZE; }

function fiveFrom(board, row, col, seat) {
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    let count = 1;
    for (const sign of [1, -1]) {
      for (let i = 1; i < 5; i++) {
        const r = row + dr * i * sign, c = col + dc * i * sign;
        if (inside(r, c) && board[r][c] === seat) count++; else break;
      }
    }
    if (count >= 5) return true;
  }
  return false;
}

const stone = seat => seat === 1 ? '●' : '○';

module.exports = {
  id: 'gomoku',
  name: '五子棋',
  summary: '两人对弈，先连成五子者胜',
  allowChat: true,
  normalizeOptions: () => ({}),
  seatCount: () => 2,
  configLabel: () => '双人 · 15×15',
  rulesSummary: () => '五子棋：15×15 棋盘，1号执黑先手，轮流落子，先连成五子者胜。落子用 act，action="move"，带上 row 和 col（0-14）。',
  rulesFull,
  rulesHuman,

  setup(players, options, ctx) {
    const state = {
      players, board: Array.from({ length: SIZE }, () => Array(SIZE).fill(0)),
      turn: 1, moves: [], since: ctx.now(), winner: null, draw: false,
    };
    ctx.log({ text: `对局开始：1号 ${players[0].name}（黑 ●）对 2号 ${players[1].name}（白 ○），黑先` });
    return state;
  },

  phase: s => ({ label: s.winner || s.draw ? '已结束' : `第 ${s.moves.length + 1} 手 · ${s.turn}号落子`, night: false, day: 0, part: '' }),

  pending: s => (s.winner || s.draw ? null : { mode: 'turn', seats: [s.turn], since: s.since, label: '落子' }),
  publicPending(s) {
    const p = this.pending(s);
    return p && { ...p, text: `${p.seats[0]}号 ${s.players[p.seats[0] - 1].name} 思考中` };
  },

  actions: (s, seat) => (s.winner || s.draw ? [] : [
    ...(s.turn === seat ? [{ type: 'move', label: '落子', target: 'cell', hint: '带上 row 和 col，0-14' }] : []),
    { type: 'resign', label: '认输', passive: true, danger: true },
  ]),

  act(s, seat, action, ctx) {
    if (s.winner || s.draw) return { error: '对局已经结束了' };
    if (action.type === 'resign') {
      s.winner = 3 - seat; s.endReason = `${s.players[seat - 1].name} 认输`;
      ctx.log({ text: `${seat}号 ${s.players[seat - 1].name} 认输，${3 - seat}号 ${s.players[2 - seat].name} 获胜` });
      return { message: '已认输' };
    }
    if (action.type !== 'move') return { error: `五子棋只有 move（落子）和 resign（认输）这两个操作` };
    if (s.turn !== seat) return { error: `现在轮到 ${s.turn}号 落子` };
    const row = Number(action.row), col = Number(action.col);
    if (!Number.isInteger(row) || !Number.isInteger(col) || !inside(row, col)) return { error: 'row 和 col 要是 0-14 的整数' };
    if (s.board[row][col]) return { error: `(${row}, ${col}) 已经有棋子了` };
    s.board[row][col] = seat;
    s.moves.push({ seat, row, col });
    const name = s.players[seat - 1].name;
    ctx.log({ kind: 'move', seat, text: `${seat}号 ${name} ${stone(seat)} 落在 (${row}, ${col})` });
    if (fiveFrom(s.board, row, col, seat)) {
      s.winner = seat;
      ctx.log({ text: `五子连珠！${seat}号 ${name} 获胜` });
    } else if (s.moves.length === SIZE * SIZE) {
      s.draw = true;
      ctx.log({ text: '棋盘下满了，平局' });
    } else {
      s.turn = 3 - seat;
      s.since = ctx.now();
    }
    return { message: `已落子 (${row}, ${col})` };
  },

  // A player who goes silent loses: in a two-player game nobody wants to play against the system.
  forfeit(s, seat, ctx) {
    if (s.winner || s.draw) return;
    s.winner = 3 - seat; s.endReason = `${s.players[seat - 1].name} 掉线`;
    ctx.log({ text: `${3 - seat}号 ${s.players[2 - seat].name} 获胜（对方掉线）` });
  },

  // Not used by the platform any more (a silent player forfeits); kept for tests and tools.
  defaultAction(s) {
    const empties = [];
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
      if (s.board[r][c]) continue;
      const near = [-1, 0, 1].some(dr => [-1, 0, 1].some(dc => inside(r + dr, c + dc) && s.board[r + dr][c + dc]));
      if (near) empties.push([r, c]);
    }
    const [row, col] = empties.length ? empties[Math.floor(Math.random() * empties.length)] : [7, 7];
    return { type: 'move', row, col };
  },

  publicView: s => ({ size: SIZE, board: s.board, moves: s.moves, turn: s.turn, winner: s.winner, draw: s.draw }),
  seatView: (s, seat) => ({ stone: stone(seat), color: seat === 1 ? '黑' : '白' }),
  seatNote: (board, seat) => (seat === 1 ? '黑 ●' : '白 ○'),

  textBoard(s) {
    let out = '棋盘（● 1号黑，○ 2号白）：\n    ' + Array.from({ length: SIZE }, (_, c) => String(c).padStart(2)).join(' ') + '\n';
    s.board.forEach((row, r) => {
      out += String(r).padStart(2) + '  ' + row.map(v => (v ? ' ' + stone(v) : ' ·')).join(' ') + '\n';
    });
    const last = s.moves[s.moves.length - 1];
    if (last) out += `上一手：${last.seat}号 (${last.row}, ${last.col})`;
    return out.trimEnd();
  },
  textPrivate: (s, seat) => `你执${seat === 1 ? '黑 ●' : '白 ○'}。`,

  result(s) {
    if (s.winner) return { title: `${s.players[s.winner - 1].name} 胜`, winner: s.winner, summary: `${s.moves.length} 手`, ...(s.endReason ? { reason: s.endReason } : {}) };
    if (s.draw) return { title: '平局', winner: null, summary: `${s.moves.length} 手` };
    return null;
  },

  archive: s => ({ kind: 'gomoku', size: SIZE, board: s.board, moves: s.moves, players: s.players }),
};
