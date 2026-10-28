const BOARD_SIZE = 15;

class GomokuGame {
  constructor(gameId, players, fromDb = null) {
    if (fromDb) {
      // Restore from database
      this.gameId = fromDb.game_id;
      this.gameType = fromDb.game_type;
      this.players = fromDb.players;
      this.board = fromDb.board;
      this.currentPlayerIndex = fromDb.current_player_index;
      this.currentPlayer = fromDb.current_player;
      this.status = fromDb.status;
      this.winner = fromDb.winner;
      this.moves = fromDb.moves;
      this.createdAt = fromDb.created_at;
      this.finishedAt = fromDb.finished_at;
    } else {
      this.gameId = gameId;
      this.gameType = 'gomoku';
      this.players = players.slice(0, 2);
      this.board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
      this.currentPlayerIndex = 0;
      this.currentPlayer = this.players[0];
      this.status = 'playing';
      this.winner = null;
      this.moves = [];
      this.createdAt = new Date().toISOString();
      this.finishedAt = null;
    }
    this.symbols = { [this.players[0]]: '●', [this.players[1]]: '○' };
  }

  makeMove(player, { row, col }) {
    if (this.status !== 'playing') return { error: '游戏已结束' };
    if (player !== this.currentPlayer) return { error: `现在轮到 ${this.currentPlayer} 落子，不是 ${player}` };
    if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return { error: `坐标超出范围 (0-${BOARD_SIZE - 1})` };
    if (this.board[row][col] !== null) return { error: `位置 (${row}, ${col}) 已有棋子` };

    this.board[row][col] = player;
    this.moves.push({ player, row, col, symbol: this.symbols[player], timestamp: new Date().toISOString() });

    if (this.checkWin(row, col, player)) {
      this.status = 'finished';
      this.winner = player;
      this.finishedAt = new Date().toISOString();
      return { message: `${player} (${this.symbols[player]}) 在 (${row}, ${col}) 落子，五子连珠！${player} 获胜！🎉`, board: this.getPublicState() };
    }

    if (this.moves.length >= BOARD_SIZE * BOARD_SIZE) {
      this.status = 'finished';
      this.winner = null;
      this.finishedAt = new Date().toISOString();
      return { message: '棋盘已满，平局！', board: this.getPublicState() };
    }

    this.currentPlayerIndex = 1 - this.currentPlayerIndex;
    this.currentPlayer = this.players[this.currentPlayerIndex];
    return { message: `${player} (${this.symbols[player]}) 在 (${row}, ${col}) 落子`, board: this.getPublicState() };
  }

  checkWin(row, col, player) {
    const directions = [[0,1],[1,0],[1,1],[1,-1]];
    for (const [dr, dc] of directions) {
      let count = 1;
      for (let i = 1; i < 5; i++) {
        const r = row + dr*i, c = col + dc*i;
        if (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && this.board[r][c] === player) count++;
        else break;
      }
      for (let i = 1; i < 5; i++) {
        const r = row - dr*i, c = col - dc*i;
        if (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && this.board[r][c] === player) count++;
        else break;
      }
      if (count >= 5) return true;
    }
    return false;
  }

  getPublicState() {
    return {
      gameId: this.gameId, gameType: this.gameType, players: this.players, symbols: this.symbols,
      board: this.board, currentPlayer: this.currentPlayer, status: this.status, winner: this.winner,
      moveCount: this.moves.length, lastMove: this.moves.length > 0 ? this.moves[this.moves.length - 1] : null,
    };
  }

  getStateForPlayer(player) {
    let text = this.getBoardString();
    text += `\n\n游戏状态: ${this.status}`;
    text += `\n玩家: ${this.players.map(p => `${p}(${this.symbols[p]})`).join(' vs ')}`;
    if (this.status === 'playing') {
      text += `\n轮到: ${this.currentPlayer} (${this.symbols[this.currentPlayer]})`;
    } else {
      text += this.winner ? `\n胜者: ${this.winner}` : '\n结果: 平局';
    }
    if (this.moves.length > 0) {
      const last = this.moves[this.moves.length - 1];
      text += `\n上一步: ${last.player} 在 (${last.row}, ${last.col})`;
    }
    return text;
  }

  getBoardString() {
    let s = '   ';
    for (let c = 0; c < BOARD_SIZE; c++) s += (c < 10 ? ' ' + c : c) + ' ';
    s += '\n';
    for (let r = 0; r < BOARD_SIZE; r++) {
      s += (r < 10 ? ' ' + r : r) + ' ';
      for (let c = 0; c < BOARD_SIZE; c++) {
        const cell = this.board[r][c];
        s += cell ? ' ' + this.symbols[cell] + ' ' : ' · ';
      }
      s += '\n';
    }
    return s;
  }

  getFullHistory() {
    return {
      gameId: this.gameId, gameType: this.gameType, players: this.players,
      winner: this.winner, status: this.status, moves: this.moves,
      createdAt: this.createdAt, finishedAt: this.finishedAt,
    };
  }
}

module.exports = { GomokuGame, BOARD_SIZE };
