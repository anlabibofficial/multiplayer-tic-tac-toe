const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingInterval: 10000,
  pingTimeout: 5000
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

const WIN_COMBOS = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // Rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // Columns
  [0, 4, 8], [2, 4, 6]             // Diagonals
];

function generateUniqueRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do {
    let suffix = '';
    for (let i = 0; i < 4; i++) {
      suffix += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    id = `GRID${suffix}`;
  } while (rooms.has(id));
  return id;
}

function clearAllRoomTimers(room) {
  if (!room) return;
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  if (room.countdownInterval) {
    clearInterval(room.countdownInterval);
    room.countdownInterval = null;
  }
  if (room.progressionTimer) {
    clearTimeout(room.progressionTimer);
    room.progressionTimer = null;
  }
  if (room.deathMatchTimer) {
    clearTimeout(room.deathMatchTimer);
    room.deathMatchTimer = null;
  }
  if (room.graceTimer) {
    clearTimeout(room.graceTimer);
    room.graceTimer = null;
  }
  if (room.reconnectTimer) {
    clearTimeout(room.reconnectTimer);
    room.reconnectTimer = null;
  }
}

function clearTurnTimer(room) {
  if (room && room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
}

function serializeScores(room) {
  const scores = {};
  room.players.forEach(p => {
    const s = room.scores[p.token] || 0;
    scores[p.id] = s;
    scores[p.token] = s;
  });
  return scores;
}

function serializeRoom(room) {
  return {
    id: room.id,
    format: room.format,
    targetWins: room.targetWins,
    players: room.players.map(p => ({
      id: p.id,
      token: p.token,
      name: p.name,
      symbol: p.symbol,
      isConnected: p.isConnected
    })),
    board: room.board,
    round: room.round,
    scores: serializeScores(room),
    isDeathMatch: room.isDeathMatch,
    matchStarted: room.matchStarted
  };
}

io.on('connection', (socket) => {
  let userRoomId = null;
  let userPlayerToken = null;

  // 1. Inspect Room
  socket.on('check_room', ({ roomId }) => {
    let cleanId = (roomId || '').trim().toUpperCase();
    if (!cleanId) cleanId = generateUniqueRoomId();

    const room = rooms.get(cleanId);
    if (!room) {
      socket.emit('room_status', { exists: false, roomId: cleanId });
    } else if (room.players.length >= 2 && room.players.every(p => p.isConnected)) {
      socket.emit('room_status', { exists: true, isFull: true, roomId: cleanId });
    } else {
      const host = room.players[0];
      socket.emit('room_status', {
        exists: true,
        isFull: false,
        roomId: cleanId,
        hostName: host ? host.name : 'Host',
        format: room.format
      });
    }
  });

  // 2. Create or Join Room
  socket.on('join_or_create', ({ roomId, playerName, format, playerToken }) => {
    let cleanId = (roomId || '').trim().toUpperCase();
    if (!cleanId) cleanId = generateUniqueRoomId();
    userPlayerToken = playerToken;

    let room = rooms.get(cleanId);
    if (!room) {
      const selectedFormat = [3, 5].includes(Number(format)) ? Number(format) : 3;
      room = {
        id: cleanId,
        format: selectedFormat,
        targetWins: Math.ceil(selectedFormat / 2),
        players: [],
        board: Array(9).fill(null),
        round: 1,
        scores: {},
        currentTurn: null,
        turnTimer: null,
        countdownInterval: null,
        progressionTimer: null,
        deathMatchTimer: null,
        graceTimer: null,
        reconnectTimer: null,
        isDeathMatch: false,
        deathMatchAnnounced: false,
        turnDuration: 15, // Updated to 15-second standard turn
        matchStarted: false,
        isMatchOver: false,
        lastRoundWinner: null,
        rematchVotes: new Set()
      };
      rooms.set(cleanId, room);
    }

    let existingPlayer = room.players.find(p => p.token === playerToken);
    if (existingPlayer) {
      existingPlayer.id = socket.id;
      existingPlayer.isConnected = true;
      if (playerName) existingPlayer.name = playerName.trim().substring(0, 12);
    } else {
      if (room.players.length >= 2) {
        socket.emit('error_message', 'Room is already full.');
        return;
      }

      const symbol = room.players.length === 0 ? 'X' : 'O';
      const player = {
        id: socket.id,
        token: playerToken,
        name: (playerName || `Player ${room.players.length + 1}`).trim().substring(0, 12),
        symbol: symbol,
        isConnected: true
      };

      room.players.push(player);
      room.scores[playerToken] = 0;
      existingPlayer = player;
    }

    socket.join(cleanId);
    userRoomId = cleanId;

    socket.emit('joined', { player: existingPlayer, roomState: serializeRoom(room) });
    io.to(cleanId).emit('room_update', { players: room.players });

    if (room.players.length === 2 && room.players.every(p => p.isConnected)) {
      if (!room.matchStarted && !room.countdownInterval) {
        startCountdown(room);
      }
    }
  });

  // 3. Rejoin Room
  socket.on('rejoin_room', ({ roomId, playerToken, playerName }) => {
    if (!roomId || !playerToken) return;
    const cleanId = roomId.trim().toUpperCase();
    const room = rooms.get(cleanId);
    if (!room) {
      socket.emit('left_room_success');
      return;
    }

    const player = room.players.find(p => p.token === playerToken);
    if (!player) {
      socket.emit('left_room_success');
      return;
    }

    userRoomId = cleanId;
    userPlayerToken = playerToken;
    socket.join(cleanId);

    const oldSocketId = player.id;
    player.id = socket.id;
    player.isConnected = true;
    if (playerName) player.name = playerName.trim().substring(0, 12);

    if (room.currentTurn === oldSocketId) {
      room.currentTurn = socket.id;
    }

    if (room.graceTimer) {
      clearTimeout(room.graceTimer);
      room.graceTimer = null;
    }
    if (room.reconnectTimer) {
      clearTimeout(room.reconnectTimer);
      room.reconnectTimer = null;
      io.to(cleanId).emit('player_reconnected', { player });
    }

    socket.emit('joined', { player, roomState: serializeRoom(room) });
    io.to(cleanId).emit('room_update', { players: room.players });

    if (!room.matchStarted && room.players.length === 2 && room.players.every(p => p.isConnected)) {
      if (!room.countdownInterval) {
        startCountdown(room);
      }
    } else if (room.matchStarted && !room.isMatchOver) {
      socket.emit('round_start', {
        round: room.round,
        format: room.format,
        targetWins: room.targetWins,
        board: room.board,
        currentTurn: room.currentTurn,
        scores: serializeScores(room),
        isDeathMatch: room.isDeathMatch,
        turnDuration: room.turnDuration
      });
    }
  });

  // 4. Move Execution
  socket.on('make_move', ({ cellIndex }) => {
    if (!userRoomId) return;
    const room = rooms.get(userRoomId);
    if (!room || room.players.length < 2) return;
    if (room.currentTurn !== socket.id) return;
    if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex > 8) return;
    if (room.board[cellIndex] !== null) return;

    processMove(room, cellIndex);
  });

  // 5. Voluntary Leave Match
  socket.on('leave_room', () => {
    cleanupPlayerExit(socket, true);
  });

  // 6. Rematch Request
  socket.on('request_rematch', () => {
    if (!userRoomId) return;
    const room = rooms.get(userRoomId);
    if (!room) return;

    room.rematchVotes.add(userPlayerToken || socket.id);
    io.to(userRoomId).emit('rematch_status', { votes: room.rematchVotes.size });

    if (room.rematchVotes.size === 2) {
      clearAllRoomTimers(room);
      room.round = 1;
      room.isDeathMatch = false;
      room.deathMatchAnnounced = false;
      room.turnDuration = 15; // Reset to 15s on rematch
      room.matchStarted = false;
      room.isMatchOver = false;
      room.lastRoundWinner = null;
      room.rematchVotes.clear();
      room.players.forEach(p => room.scores[p.token] = 0);
      startCountdown(room);
    }
  });

  // 7. Disconnect Handler
  socket.on('disconnect', () => {
    cleanupPlayerExit(socket, false);
  });

  function cleanupPlayerExit(s, isVoluntary = false) {
    if (!userRoomId) return;
    const room = rooms.get(userRoomId);
    if (!room) return;

    const roomId = userRoomId;
    const player = room.players.find(p => p.token === userPlayerToken || p.id === s.id);

    if (player && player.id !== s.id) {
      return;
    }

    s.leave(roomId);
    userRoomId = null;

    if (!player) return;
    player.isConnected = false;

    if (isVoluntary) {
      clearAllRoomTimers(room);
      const remainingPlayer = room.players.find(p => p.token !== player.token);
      room.players = room.players.filter(p => p.token !== player.token);
      delete room.scores[player.token];

      if (remainingPlayer && room.matchStarted && !room.isMatchOver) {
        io.to(roomId).emit('opponent_forfeited', {
          leaverName: player.name,
          winner: remainingPlayer
        });
      }
      rooms.delete(roomId);
      s.emit('left_room_success');
      return;
    }

    if (!room.matchStarted) {
      if (room.countdownInterval) {
        clearInterval(room.countdownInterval);
        room.countdownInterval = null;
        io.to(roomId).emit('countdown_cancelled', {
          message: `${player.name} is reconnecting. Pausing duel...`
        });
      }

      io.to(roomId).emit('player_status_change', {
        players: room.players.map(p => ({
          id: p.id,
          name: p.name,
          symbol: p.symbol,
          isConnected: p.isConnected
        }))
      });

      if (room.graceTimer) clearTimeout(room.graceTimer);
      room.graceTimer = setTimeout(() => {
        if (room.players.some(p => !p.isConnected)) {
          clearAllRoomTimers(room);
          rooms.delete(roomId);
          io.to(roomId).emit('room_abandoned');
        }
      }, 90000);

      return;
    }

    if (room.matchStarted && !room.isMatchOver) {
      io.to(roomId).emit('player_temporarily_disconnected', {
        name: player.name,
        graceSeconds: 15
      });

      if (room.reconnectTimer) clearTimeout(room.reconnectTimer);
      room.reconnectTimer = setTimeout(() => {
        if (!player.isConnected && !room.isMatchOver) {
          clearAllRoomTimers(room);
          const remainingPlayer = room.players.find(p => p.token !== player.token);
          if (remainingPlayer) {
            io.to(roomId).emit('opponent_forfeited', {
              leaverName: player.name,
              winner: remainingPlayer
            });
          }
          rooms.delete(roomId);
        }
      }, 15000);
    }
  }
});

function checkWin(board, symbol) {
  for (const combo of WIN_COMBOS) {
    if (combo.every(idx => board[idx] === symbol)) {
      return combo;
    }
  }
  return null;
}

function startCountdown(room) {
  clearAllRoomTimers(room);
  let counter = 3;
  io.to(room.id).emit('countdown_tick', { count: counter });

  room.countdownInterval = setInterval(() => {
    if (!rooms.has(room.id) || room.players.length < 2 || !room.players.every(p => p.isConnected)) {
      clearInterval(room.countdownInterval);
      room.countdownInterval = null;
      io.to(room.id).emit('countdown_cancelled', { message: 'Player reconnecting. Pausing start...' });
      return;
    }

    counter--;
    if (counter > 0) {
      io.to(room.id).emit('countdown_tick', { count: counter });
    } else {
      clearInterval(room.countdownInterval);
      room.countdownInterval = null;
      room.matchStarted = true;
      startRound(room);
    }
  }, 1000);
}

function startRound(room) {
  clearAllRoomTimers(room);
  room.board = Array(9).fill(null);
  const starterIndex = (room.round - 1) % 2;
  room.currentTurn = room.players[starterIndex].id;

  io.to(room.id).emit('round_start', {
    round: room.round,
    format: room.format,
    targetWins: room.targetWins,
    board: room.board,
    currentTurn: room.currentTurn,
    scores: serializeScores(room),
    isDeathMatch: room.isDeathMatch,
    turnDuration: room.turnDuration
  });

  startTurnTimer(room);
}

function startTurnTimer(room) {
  clearTurnTimer(room);
  const duration = room.turnDuration || 15;
  io.to(room.id).emit('turn_timer_start', { duration });

  room.turnTimer = setTimeout(() => {
    handleAutoMove(room);
  }, duration * 1000);
}

function handleAutoMove(room) {
  if (!room || room.players.length < 2) return;
  const emptyIndices = room.board
    .map((val, idx) => (val === null ? idx : null))
    .filter(val => val !== null);

  if (emptyIndices.length === 0) return;

  const randomIdx = emptyIndices[Math.floor(Math.random() * emptyIndices.length)];
  processMove(room, randomIdx);
}

function processMove(room, cellIndex) {
  clearTurnTimer(room);

  const player = room.players.find(p => p.id === room.currentTurn);
  if (!player) return;

  room.board[cellIndex] = player.symbol;

  const winningCombo = checkWin(room.board, player.symbol);
  const isDraw = !winningCombo && room.board.every(cell => cell !== null);

  if (winningCombo) {
    room.scores[player.token] = (room.scores[player.token] || 0) + 1;
    room.lastRoundWinner = player;
  } else if (isDraw) {
    room.lastRoundWinner = null;
  }

  if (winningCombo || isDraw) {
    const [p1, p2] = room.players;
    const p1Score = room.scores[p1.token] || 0;
    const p2Score = room.scores[p2.token] || 0;

    let matchEnding = false;
    if (room.isDeathMatch) {
      if (room.lastRoundWinner) matchEnding = true;
    } else {
      const reachedTarget = p1Score >= room.targetWins || p2Score >= room.targetWins;
      const formatCompleted = room.round >= room.format;
      if (reachedTarget || formatCompleted) {
        if (p1Score !== p2Score) matchEnding = true;
      }
    }

    io.to(room.id).emit('cell_updated', { cellIndex, symbol: player.symbol });
    io.to(room.id).emit('round_over', {
      winner: winningCombo ? player : null,
      winningCombo,
      scores: serializeScores(room),
      round: room.round,
      format: room.format,
      targetWins: room.targetWins,
      isDraw: isDraw,
      isDeathMatch: room.isDeathMatch,
      isMatchOver: matchEnding
    });

    handleRoundProgression(room, matchEnding);
  } else {
    room.currentTurn = room.players.find(p => p.id !== player.id).id;
    io.to(room.id).emit('cell_updated', { cellIndex, symbol: player.symbol });
    io.to(room.id).emit('turn_change', { currentTurn: room.currentTurn });
    startTurnTimer(room);
  }
}

function handleRoundProgression(room, matchEnding = false) {
  clearTurnTimer(room);
  const [p1, p2] = room.players;
  const transitionDelay = matchEnding ? 1500 : 3400;

  room.progressionTimer = setTimeout(() => {
    room.progressionTimer = null;
    if (!rooms.has(room.id) || room.players.length < 2) return;

    if (room.isDeathMatch) {
      if (room.lastRoundWinner) {
        room.isMatchOver = true;
        io.to(room.id).emit('match_over', {
          matchWinner: room.lastRoundWinner,
          scores: serializeScores(room)
        });
      } else {
        room.round++;
        startCountdown(room);
      }
      return;
    }

    const p1Score = room.scores[p1.token] || 0;
    const p2Score = room.scores[p2.token] || 0;
    const reachedTarget = p1Score >= room.targetWins || p2Score >= room.targetWins;
    const formatCompleted = room.round >= room.format;

    if (reachedTarget || formatCompleted) {
      let matchWinner = null;
      if (p1Score > p2Score) matchWinner = p1;
      else if (p2Score > p1Score) matchWinner = p2;

      if (matchWinner) {
        room.isMatchOver = true;
        io.to(room.id).emit('match_over', { matchWinner, scores: serializeScores(room) });
      } else {
        initiateDeathMatch(room);
      }
    } else {
      room.round++;
      startCountdown(room);
    }
  }, transitionDelay);
}

function initiateDeathMatch(room) {
  room.isDeathMatch = true;
  room.deathMatchAnnounced = true;
  room.turnDuration = 8; // Updated to 8-second blitz turns

  io.to(room.id).emit('death_match_announced', { intermissionSeconds: 10 });

  room.deathMatchTimer = setTimeout(() => {
    room.deathMatchTimer = null;
    if (!rooms.has(room.id) || room.players.length < 2) return;
    room.round++;
    startCountdown(room);
  }, 10000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Duel Server online: http://localhost:${PORT}`));
