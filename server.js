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
  }
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
  if (room.abandonTimer) {
    clearTimeout(room.abandonTimer);
    room.abandonTimer = null;
  }
}

function clearTurnTimer(room) {
  if (room && room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
}

io.on('connection', (socket) => {
  let userRoomId = null;

  // 1. Inspect Room
  socket.on('check_room', ({ roomId }) => {
    let cleanId = (roomId || '').trim().toUpperCase();
    if (!cleanId) {
      cleanId = generateUniqueRoomId();
    }

    const room = rooms.get(cleanId);
    if (!room) {
      socket.emit('room_status', { exists: false, roomId: cleanId });
    } else if (room.players.length >= 2 && !room.hostDisconnected) {
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
  socket.on('join_or_create', ({ roomId, playerName, format }) => {
    let cleanId = (roomId || '').trim().toUpperCase();
    if (!cleanId) {
      cleanId = generateUniqueRoomId();
    }
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
        abandonTimer: null,
        hostDisconnected: false,
        isDeathMatch: false,
        deathMatchAnnounced: false,
        turnDuration: 30,
        isMatchOver: false,
        lastRoundWinner: null,
        rematchVotes: new Set()
      };
      rooms.set(cleanId, room);
    }

    if (room.players.length >= 2 && !room.hostDisconnected) {
      socket.emit('error_message', 'Room is already full.');
      return;
    }

    const symbol = room.players.length === 0 ? 'X' : 'O';
    const player = {
      id: socket.id,
      name: (playerName || `Player ${room.players.length + 1}`).trim().substring(0, 12),
      symbol: symbol
    };

    room.players.push(player);
    room.scores[socket.id] = 0;
    socket.join(cleanId);
    userRoomId = cleanId;

    socket.emit('joined', { player, roomState: serializeRoom(room) });
    io.to(cleanId).emit('room_update', { players: room.players });

    // Only start countdown if both players are present and host is not backgrounded
    if (room.players.length === 2 && !room.hostDisconnected) {
      startCountdown(room);
    }
  });

  // 3. Rejoin Room (After mobile backgrounding/tab switch)
  socket.on('rejoin_waiting_room', ({ roomId, playerName }) => {
    const cleanId = (roomId || '').trim().toUpperCase();
    const room = rooms.get(cleanId);
    if (!room) {
      socket.emit('left_room_success');
      return;
    }

    if (room.abandonTimer) {
      clearTimeout(room.abandonTimer);
      room.abandonTimer = null;
    }

    room.hostDisconnected = false;
    userRoomId = cleanId;
    socket.join(cleanId);

    // Reconnect host slot (Symbol X)
    let hostPlayer = room.players.find(p => p.symbol === 'X') || room.players[0];
    if (hostPlayer) {
      const oldId = hostPlayer.id;
      delete room.scores[oldId];
      hostPlayer.id = socket.id;
      if (playerName) hostPlayer.name = playerName;
      room.scores[socket.id] = 0;
    } else {
      hostPlayer = {
        id: socket.id,
        name: playerName || 'Host',
        symbol: 'X'
      };
      room.players.unshift(hostPlayer);
      room.scores[socket.id] = 0;
    }

    socket.emit('joined', { player: hostPlayer, roomState: serializeRoom(room) });
    io.to(cleanId).emit('room_update', { players: room.players });

    // If opponent already joined while host was sharing link, start the match
    if (room.players.length === 2 && !room.countdownInterval && !room.currentTurn) {
      startCountdown(room);
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

  // 5. Leave Room (Voluntary Exit / Concede)
  socket.on('leave_room', () => {
    cleanupPlayerExit(socket, true);
  });

  // 6. Rematch Handler
  socket.on('request_rematch', () => {
    if (!userRoomId) return;
    const room = rooms.get(userRoomId);
    if (!room) return;

    room.rematchVotes.add(socket.id);
    io.to(userRoomId).emit('rematch_status', { votes: room.rematchVotes.size });

    if (room.rematchVotes.size === 2) {
      clearAllRoomTimers(room);
      room.round = 1;
      room.isDeathMatch = false;
      room.deathMatchAnnounced = false;
      room.turnDuration = 30;
      room.isMatchOver = false;
      room.lastRoundWinner = null;
      room.rematchVotes.clear();
      room.players.forEach(p => room.scores[p.id] = 0);
      startCountdown(room);
    }
  });

  // 7. Disconnect Handler (Socket drop / App backgrounded)
  socket.on('disconnect', () => {
    cleanupPlayerExit(socket, false);
  });

  function cleanupPlayerExit(s, isVoluntary = false) {
    if (!userRoomId) return;
    const room = rooms.get(userRoomId);
    if (!room) return;

    const roomId = userRoomId;
    userRoomId = null;
    s.leave(roomId);

    // CASE A: Host backgrounding app while waiting for challenger (Grace Period)
    if (!isVoluntary && room.players.length === 1 && !room.isMatchOver) {
      room.hostDisconnected = true;
      if (room.abandonTimer) clearTimeout(room.abandonTimer);

      // Keep room alive for 90 seconds while host copies/shares link
      room.abandonTimer = setTimeout(() => {
        if (room.hostDisconnected) {
          clearAllRoomTimers(room);
          rooms.delete(roomId);
        }
      }, 90000);
      return;
    }

    // CASE B: Voluntary leave or active match disconnect
    clearAllRoomTimers(room);
    const leavingPlayer = room.players.find(p => p.id === s.id);
    const remainingPlayer = room.players.find(p => p.id !== s.id);

    room.players = room.players.filter(p => p.id !== s.id);
    delete room.scores[s.id];

    if (room.players.length === 0) {
      rooms.delete(roomId);
    } else if (remainingPlayer) {
      if (!room.isMatchOver) {
        io.to(roomId).emit('opponent_forfeited', {
          leaverName: leavingPlayer ? leavingPlayer.name : 'Opponent',
          winner: remainingPlayer
        });
      }
      rooms.delete(roomId);
    }

    s.emit('left_room_success');
  }
});

function serializeRoom(room) {
  return {
    id: room.id,
    format: room.format,
    targetWins: room.targetWins,
    players: room.players,
    board: room.board,
    round: room.round,
    scores: room.scores,
    isDeathMatch: room.isDeathMatch
  };
}

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
    if (!rooms.has(room.id) || room.players.length < 2) {
      clearInterval(room.countdownInterval);
      room.countdownInterval = null;
      return;
    }

    counter--;
    if (counter > 0) {
      io.to(room.id).emit('countdown_tick', { count: counter });
    } else {
      clearInterval(room.countdownInterval);
      room.countdownInterval = null;
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
    scores: room.scores,
    isDeathMatch: room.isDeathMatch,
    turnDuration: room.turnDuration
  });

  startTurnTimer(room);
}

function startTurnTimer(room) {
  clearTurnTimer(room);
  const duration = room.turnDuration || 30;
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
    room.scores[player.id]++;
    room.lastRoundWinner = player;
  } else if (isDraw) {
    room.lastRoundWinner = null;
  }

  if (winningCombo || isDraw) {
    const [p1, p2] = room.players;
    let matchEnding = false;

    if (room.isDeathMatch) {
      if (room.lastRoundWinner) {
        matchEnding = true;
      }
    } else {
      const reachedTarget = room.scores[p1.id] >= room.targetWins || room.scores[p2.id] >= room.targetWins;
      const formatCompleted = room.round >= room.format;

      if (reachedTarget || formatCompleted) {
        if (room.scores[p1.id] !== room.scores[p2.id]) {
          matchEnding = true;
        }
      }
    }

    io.to(room.id).emit('cell_updated', { cellIndex, symbol: player.symbol });
    io.to(room.id).emit('round_over', {
      winner: winningCombo ? player : null,
      winningCombo,
      scores: room.scores,
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
        io.to(room.id).emit('match_over', { matchWinner: room.lastRoundWinner, scores: room.scores });
      } else {
        room.round++;
        startCountdown(room);
      }
      return;
    }

    const reachedTarget = room.scores[p1.id] >= room.targetWins || room.scores[p2.id] >= room.targetWins;
    const formatCompleted = room.round >= room.format;

    if (reachedTarget || formatCompleted) {
      let matchWinner = null;
      if (room.scores[p1.id] > room.scores[p2.id]) matchWinner = p1;
      else if (room.scores[p2.id] > room.scores[p1.id]) matchWinner = p2;

      if (matchWinner) {
        room.isMatchOver = true;
        io.to(room.id).emit('match_over', { matchWinner, scores: room.scores });
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
  room.turnDuration = 10;

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
