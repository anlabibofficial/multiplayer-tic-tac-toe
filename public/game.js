// ================= AUDIO ENGINE (NO ASSETS REQUIRED) =================
class AudioFX {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  init() {
    if (!this.ctx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  playPopX() {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(350, t);
    osc.frequency.exponentialRampToValueAtTime(140, t + 0.12);
    g.gain.setValueAtTime(0.2, t);
    g.gain.exponentialRampToValueAtTime(0.01, t + 0.12);
    osc.connect(g);
    g.connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + 0.12);
  }

  playChimeO() {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(620, t);
    osc.frequency.exponentialRampToValueAtTime(880, t + 0.16);
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.01, t + 0.16);
    osc.connect(g);
    g.connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + 0.16);
  }

  playWin() {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, idx) => {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t + idx * 0.1);
      g.gain.setValueAtTime(0.25, t + idx * 0.1);
      g.gain.exponentialRampToValueAtTime(0.001, t + idx * 0.1 + 0.4);
      osc.connect(g);
      g.connect(this.ctx.destination);
      osc.start(t + idx * 0.1);
      osc.stop(t + idx * 0.1 + 0.4);
    });
  }

  playTick(isDanger = false) {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(isDanger ? 800 : 500, t);
    g.gain.setValueAtTime(isDanger ? 0.22 : 0.12, t);
    g.gain.exponentialRampToValueAtTime(0.01, t + 0.05);
    osc.connect(g);
    g.connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + 0.05);
  }

  playAlarm() {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime;
    [300, 450, 600].forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, t + i * 0.1);
      g.gain.setValueAtTime(0.2, t + i * 0.1);
      g.gain.exponentialRampToValueAtTime(0.01, t + i * 0.1 + 0.2);
      osc.connect(g);
      g.connect(this.ctx.destination);
      osc.start(t + i * 0.1);
      osc.stop(t + i * 0.1 + 0.2);
    });
  }
}

const sfx = new AudioFX();

// ================= SESSION TOKEN =================
let playerToken = sessionStorage.getItem('neongrid_player_token');
if (!playerToken) {
  playerToken = 'tok_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
  sessionStorage.setItem('neongrid_player_token', playerToken);
}

// ================= SOCKET & CLIENT STATE =================
const BACKEND_URL = "https://multiplayer-tic-tac-toe-ompz.onrender.com";
const socket = io(BACKEND_URL, {
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 800
});

let myPlayer = null;
let currentRoomId = sessionStorage.getItem('neongrid_active_room') || null;
let isMyTurn = false;
let pendingRoomId = null;
let currentPlayers = [];
let demoAnimationId = null;
let isInviteMode = false;
let selectedFormat = 3;
let currentRoomFormat = 3;
let currentTargetWins = 2;

// Death Match and Match Concluded States
let isDeathMatchMode = false;
let isMatchConcluded = false;

// Turn Timer Tracking (Default 15s)
let turnTimerInterval = null;
let remainingTurnSeconds = 15;
let currentTurnMaxSeconds = 15;

// Client Modal Transition Timers
let roundModalTimeout = null;
let matchModalTimeout = null;
let nextFillTimeout = null;
let deathMatchInterval = null;

function clearPendingUiTimeouts() {
  if (roundModalTimeout) {
    clearTimeout(roundModalTimeout);
    roundModalTimeout = null;
  }
  if (matchModalTimeout) {
    clearTimeout(matchModalTimeout);
    matchModalTimeout = null;
  }
  if (nextFillTimeout) {
    clearTimeout(nextFillTimeout);
    nextFillTimeout = null;
  }
  if (deathMatchInterval) {
    clearInterval(deathMatchInterval);
    deathMatchInterval = null;
  }
}

// DOM Elements
const lobbyScreen = document.getElementById('lobby-screen');
const waitingScreen = document.getElementById('waiting-screen');
const gameScreen = document.getElementById('game-screen');

// Server Status Indicator Elements
const serverStatusPill = document.getElementById('server-status-pill');
const serverStatusText = document.getElementById('server-status-text');

// Lobby Elements
const standardLobbyCard = document.getElementById('standard-lobby-card');
const playerNameInput = document.getElementById('player-name');
const roomIdInput = document.getElementById('room-id');
const btnInspectRoom = document.getElementById('btn-inspect-room');
const formatButtons = document.querySelectorAll('.btn-format');

const inviteLobbyCard = document.getElementById('invite-lobby-card');
const inviteHostName = document.getElementById('invite-host-name');
const inviteRoomCode = document.getElementById('invite-room-code');
const inviteFormatBadge = document.getElementById('invite-format-badge');
const invitePlayerNameInput = document.getElementById('invite-player-name');
const btnAcceptInvite = document.getElementById('btn-accept-invite');
const btnDeclineInvite = document.getElementById('btn-decline-invite');

// Synchronized Audio Toggles
const audioButtons = document.querySelectorAll('.audio-toggle');
audioButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    sfx.init();
    sfx.muted = !sfx.muted;
    audioButtons.forEach(b => b.innerText = sfx.muted ? '🔇' : '🔊');
  });
});

// Waiting Room Elements
const displayRoomCode = document.getElementById('display-room-code');
const btnCopyLink = document.getElementById('btn-copy-link');
const btnCancelWaiting = document.getElementById('btn-cancel-waiting');

// Room Inspector Modal Elements
const inspectorModal = document.getElementById('room-inspector-modal');
const inspectorIcon = document.getElementById('inspector-icon');
const inspectorTitle = document.getElementById('inspector-title');
const inspectorDetails = document.getElementById('inspector-details');
const inspectorCode = document.getElementById('inspector-code');
const inspectorHost = document.getElementById('inspector-host');
const inspectorMode = document.getElementById('inspector-mode');
const inspectorDesc = document.getElementById('inspector-desc');
const btnModalConfirm = document.getElementById('btn-modal-confirm');
const btnModalCancel = document.getElementById('btn-modal-cancel');

// Forfeit Modal Elements
const btnForfeit = document.getElementById('btn-forfeit');
const forfeitModal = document.getElementById('forfeit-modal');
const btnCancelForfeit = document.getElementById('btn-cancel-forfeit');
const btnConfirmForfeit = document.getElementById('btn-confirm-forfeit');

// Game HUD
const p1Name = document.getElementById('p1-name');
const p2Name = document.getElementById('p2-name');
const p1Tag = document.getElementById('p1-tag');
const p2Tag = document.getElementById('p2-tag');
const p1WinText = document.getElementById('p1-win-text');
const p2WinText = document.getElementById('p2-win-text');
const p1PipsContainer = document.getElementById('p1-pips');
const p2PipsContainer = document.getElementById('p2-pips');
const roundTitle = document.getElementById('round-title');
const turnBanner = document.getElementById('turn-banner');

const turnTimerBadge = document.getElementById('turn-timer-badge');
const turnTimerSec = document.getElementById('turn-timer-sec');
const turnTimerBar = document.getElementById('turn-timer-bar');

const cells = document.querySelectorAll('.cell');
const strikeLine = document.getElementById('strike-line');

// Modals & Overlays
const countdownModal = document.getElementById('countdown-modal');
const countdownNum = document.getElementById('countdown-num');

// Sudden Death Modal
const deathMatchModal = document.getElementById('deathmatch-modal');
const deathMatchSec = document.getElementById('deathmatch-sec');
const deathMatchProgressFill = document.getElementById('deathmatch-progress-fill');

// Round Outcome Card
const roundModal = document.getElementById('round-modal');
const roundCardContainer = document.getElementById('round-card-container');
const roundResultBadge = document.getElementById('round-result-badge');
const roundModalTitle = document.getElementById('round-modal-title');
const scP1Name = document.getElementById('sc-p1-name');
const scP1Score = document.getElementById('sc-p1-score');
const scP2Name = document.getElementById('sc-p2-name');
const scP2Score = document.getElementById('sc-p2-score');
const roundModalSubtitle = document.getElementById('round-modal-subtitle');
const nextProgressFill = document.getElementById('next-progress-fill');

// Match Over Modal
const victoryModal = document.getElementById('victory-modal');
const victoryCard = document.getElementById('victory-card');
const victoryIcon = document.getElementById('victory-icon');
const victoryTitle = document.getElementById('victory-title');
const victorySubtitle = document.getElementById('victory-subtitle');
const rematchCounter = document.getElementById('rematch-counter');
const btnRematch = document.getElementById('btn-rematch');
const btnLeaveMatch = document.getElementById('btn-leave-match');

// Format Selection
formatButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    formatButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedFormat = parseInt(btn.dataset.format, 10);
  });
});

// Forfeit Modal Listeners
btnForfeit.addEventListener('click', () => {
  forfeitModal.classList.remove('hidden');
});

btnCancelForfeit.addEventListener('click', () => {
  forfeitModal.classList.add('hidden');
});

btnConfirmForfeit.addEventListener('click', () => {
  forfeitModal.classList.add('hidden');
  socket.emit('leave_room');
  returnToLobby();
});

// ================= SERVER STATUS & LIFECYCLE =================
function setServerStatus(state) {
  if (!serverStatusPill || !serverStatusText) return;
  serverStatusPill.classList.remove('waking', 'online', 'offline');

  if (state === 'online') {
    serverStatusPill.classList.add('online');
    serverStatusText.innerText = 'SERVER ONLINE';
    btnInspectRoom.disabled = false;
    btnAcceptInvite.disabled = false;
  } else if (state === 'offline') {
    serverStatusPill.classList.add('offline');
    serverStatusText.innerText = 'SERVER OFFLINE';
    btnInspectRoom.disabled = true;
    btnAcceptInvite.disabled = true;
  } else {
    serverStatusPill.classList.add('waking');
    serverStatusText.innerText = 'WAKING UP SERVER...';
    btnInspectRoom.disabled = true;
    btnAcceptInvite.disabled = true;
  }
}

setServerStatus('waking');

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (currentRoomId && socket.connected) {
      socket.emit('rejoin_room', {
        roomId: currentRoomId,
        playerToken,
        playerName: myPlayer ? myPlayer.name : (sessionStorage.getItem('neongrid_player_name') || '')
      });
    }
  }
});

// Socket Connection Lifecycle Handlers
socket.on('connect', () => {
  setServerStatus('online');

  if (currentRoomId) {
    socket.emit('rejoin_room', {
      roomId: currentRoomId,
      playerToken,
      playerName: myPlayer ? myPlayer.name : (sessionStorage.getItem('neongrid_player_name') || '')
    });
  } else if (isInviteMode && pendingRoomId) {
    socket.emit('check_room', { roomId: pendingRoomId });
  }
});

socket.on('disconnect', (reason) => {
  if (reason === 'io server disconnect') {
    setServerStatus('offline');
  } else {
    setServerStatus('waking');
  }
});

socket.on('connect_error', () => {
  setServerStatus('waking');
});

// URL Auto-Detect Invite Mode
const urlParams = new URLSearchParams(window.location.search);
const inviteParam = urlParams.get('room');

if (inviteParam) {
  const cleanCode = inviteParam.trim().toUpperCase();
  pendingRoomId = cleanCode;
  isInviteMode = true;

  standardLobbyCard.classList.add('hidden');
  inviteLobbyCard.classList.remove('hidden');
  inviteRoomCode.innerText = cleanCode;
  inviteHostName.innerText = 'Connecting...';
  btnAcceptInvite.disabled = true;

  if (socket.connected) {
    socket.emit('check_room', { roomId: pendingRoomId });
  }
}

// 1. Inspect Room
btnInspectRoom.addEventListener('click', () => {
  sfx.init();
  const roomId = roomIdInput.value.trim().toUpperCase();
  pendingRoomId = roomId;
  isInviteMode = false;

  socket.emit('check_room', { roomId });
});

socket.on('room_status', ({ exists, isFull, roomId, hostName, format, error }) => {
  if (error) return alert(error);

  pendingRoomId = roomId;
  if (!roomIdInput.value.trim() && !isInviteMode) {
    roomIdInput.value = roomId;
  }

  if (isInviteMode) {
    if (exists && !isFull) {
      standardLobbyCard.classList.add('hidden');
      inviteLobbyCard.classList.remove('hidden');
      inviteHostName.innerText = hostName || 'Host';
      inviteRoomCode.innerText = roomId;
      inviteFormatBadge.innerText = `BEST OF ${format || 3}`;
      btnAcceptInvite.disabled = false;
      invitePlayerNameInput.focus();
      return;
    } else {
      isInviteMode = false;
      alert(isFull ? `Room ${roomId} is currently full.` : `Room ${roomId} was not found or has expired.`);
      resetUrlParams();
      standardLobbyCard.classList.remove('hidden');
      inviteLobbyCard.classList.add('hidden');
      return;
    }
  }

  inspectorModal.classList.remove('hidden');

  if (isFull) {
    inspectorIcon.innerText = '🚫';
    inspectorTitle.innerText = 'Room Full';
    inspectorDetails.style.display = 'none';
    inspectorDesc.innerText = `Room ${roomId} is full with 2 active combatants.`;
    btnModalConfirm.style.display = 'none';
    btnModalCancel.innerText = 'Back';
  } else if (exists) {
    inspectorIcon.innerText = '⚔️';
    inspectorTitle.innerText = 'Room Found!';
    inspectorDetails.style.display = 'flex';
    inspectorCode.innerText = roomId;
    inspectorHost.innerText = hostName || 'Challenger';
    inspectorMode.innerText = `BEST OF ${format || 3}`;
    inspectorDesc.innerText = 'Join the duel in this arena?';
    btnModalConfirm.style.display = 'inline-block';
    btnModalConfirm.innerText = 'JOIN ARENA';
    btnModalCancel.innerText = 'Cancel';
  } else {
    inspectorIcon.innerText = '✨';
    inspectorTitle.innerText = 'Create Arena?';
    inspectorDetails.style.display = 'flex';
    inspectorCode.innerText = roomId;
    inspectorHost.innerText = playerNameInput.value.trim() || 'You (Host)';
    inspectorMode.innerText = `BEST OF ${selectedFormat}`;
    inspectorDesc.innerText = `Room does not exist yet. Launch as host?`;
    btnModalConfirm.style.display = 'inline-block';
    btnModalConfirm.innerText = 'CREATE ARENA';
    btnModalCancel.innerText = 'Cancel';
  }
});

btnModalCancel.addEventListener('click', () => {
  inspectorModal.classList.add('hidden');
});

btnModalConfirm.addEventListener('click', () => {
  inspectorModal.classList.add('hidden');
  const playerName = playerNameInput.value.trim();
  sessionStorage.setItem('neongrid_player_name', playerName);
  socket.emit('join_or_create', {
    roomId: pendingRoomId,
    playerName,
    format: selectedFormat,
    playerToken
  });
});

btnAcceptInvite.addEventListener('click', () => {
  sfx.init();
  const playerName = invitePlayerNameInput.value.trim();
  sessionStorage.setItem('neongrid_player_name', playerName);
  socket.emit('join_or_create', {
    roomId: pendingRoomId,
    playerName,
    playerToken
  });
});

btnDeclineInvite.addEventListener('click', () => {
  resetUrlParams();
  isInviteMode = false;
  pendingRoomId = null;
  inviteLobbyCard.classList.add('hidden');
  standardLobbyCard.classList.remove('hidden');
});

// 2. Room Joined
socket.on('joined', ({ player, roomState }) => {
  myPlayer = player;
  currentRoomId = roomState.id;
  sessionStorage.setItem('neongrid_active_room', currentRoomId);
  currentRoomFormat = roomState.format;
  currentTargetWins = roomState.targetWins;
  currentPlayers = roomState.players;
  isDeathMatchMode = false;
  isMatchConcluded = false;

  displayRoomCode.innerText = currentRoomId;
  setupPipsUI(currentTargetWins);

  lobbyScreen.classList.remove('active');

  if (roomState.players.length === 1) {
    waitingScreen.classList.add('active');
    startDemoMiniCanvas();
  } else if (roomState.matchStarted) {
    waitingScreen.classList.remove('active');
    gameScreen.classList.add('active');
    updateHudPlayers(currentPlayers, roomState.scores);
  }
});

btnCopyLink.addEventListener('click', () => {
  const url = new URL(window.location.href);
  url.search = `?room=${encodeURIComponent(currentRoomId)}`;
  const link = url.toString();

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link).then(() => {
      btnCopyLink.innerText = '✓ COPIED';
      setTimeout(() => btnCopyLink.innerText = '🔗 COPY LINK', 1500);
    }).catch(() => prompt('Copy Arena Link:', link));
  } else {
    prompt('Copy Arena Link:', link);
  }
});

btnCancelWaiting.addEventListener('click', () => {
  socket.emit('leave_room');
  returnToLobby();
});

btnLeaveMatch.addEventListener('click', () => {
  socket.emit('leave_room');
  returnToLobby();
});

socket.on('left_room_success', () => {
  returnToLobby();
});

socket.on('room_abandoned', () => {
  alert('Room was closed due to opponent inactivity.');
  returnToLobby();
});

function returnToLobby() {
  stopTurnTimer();
  clearPendingUiTimeouts();
  stopDemoMiniCanvas();
  sessionStorage.removeItem('neongrid_active_room');

  waitingScreen.classList.remove('active');
  gameScreen.classList.remove('active');
  victoryModal.classList.add('hidden');
  roundModal.classList.add('hidden');
  countdownModal.classList.add('hidden');
  deathMatchModal.classList.add('hidden');
  forfeitModal.classList.add('hidden');
  lobbyScreen.classList.add('active');

  roundTitle.classList.remove('death-match-active');
  victoryCard.classList.remove('state-champion', 'state-defeat');
  btnRematch.style.display = 'inline-block';
  standardLobbyCard.classList.remove('hidden');
  inviteLobbyCard.classList.add('hidden');

  myPlayer = null;
  currentRoomId = null;
  pendingRoomId = null;
  isInviteMode = false;
  isDeathMatchMode = false;
  isMatchConcluded = false;
  currentTurnMaxSeconds = 15;
  resetUrlParams();

  setServerStatus(socket.connected ? 'online' : 'waking');
}

function resetUrlParams() {
  if (window.history.replaceState) {
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

// 3. Opponent Joined & Countdown
socket.on('room_update', ({ players }) => {
  currentPlayers = players;
  if (players.length === 2) {
    stopDemoMiniCanvas();
    waitingScreen.classList.remove('active');
    gameScreen.classList.add('active');
    updateHudPlayers(players);
  }
});

socket.on('countdown_tick', ({ count }) => {
  stopTurnTimer();
  clearPendingUiTimeouts();
  countdownModal.classList.remove('hidden');
  deathMatchModal.classList.add('hidden');
  roundModal.classList.add('hidden');
  victoryModal.classList.add('hidden');
  forfeitModal.classList.add('hidden');
  countdownNum.innerText = count;
  sfx.playTick(false);
});

socket.on('countdown_cancelled', ({ message }) => {
  countdownModal.classList.add('hidden');
  turnBanner.innerText = message || 'Opponent reconnecting...';
  turnBanner.style.color = 'var(--gold-primary)';
});

// Sudden Death Intermission Announcement
socket.on('death_match_announced', ({ intermissionSeconds = 10 }) => {
  stopTurnTimer();
  clearPendingUiTimeouts();
  roundModal.classList.add('hidden');
  countdownModal.classList.add('hidden');
  isDeathMatchMode = true;

  sfx.playAlarm();
  deathMatchModal.classList.remove('hidden');

  let remaining = intermissionSeconds;
  deathMatchSec.innerText = remaining;
  deathMatchProgressFill.style.width = '100%';

  deathMatchInterval = setInterval(() => {
    remaining--;
    if (remaining >= 0) {
      deathMatchSec.innerText = remaining;
      const pct = (remaining / intermissionSeconds) * 100;
      deathMatchProgressFill.style.width = `${pct}%`;
      sfx.playTick(false);
    } else {
      clearInterval(deathMatchInterval);
      deathMatchInterval = null;
    }
  }, 1000);
});

// 4. Round Start
socket.on('round_start', ({ round, format, targetWins, board, currentTurn, scores, isDeathMatch, turnDuration }) => {
  countdownModal.classList.add('hidden');
  deathMatchModal.classList.add('hidden');
  strikeLine.style.strokeDashoffset = '600';

  isDeathMatchMode = !!isDeathMatch;
  currentTurnMaxSeconds = turnDuration || (isDeathMatchMode ? 8 : 15);
  currentRoomFormat = format;
  currentTargetWins = targetWins;

  if (isDeathMatchMode) {
    roundTitle.innerText = '⚡ SUDDEN DEATH';
    roundTitle.classList.add('death-match-active');
  } else {
    roundTitle.innerText = `ROUND ${round} OF ${format}`;
    roundTitle.classList.remove('death-match-active');
  }

  setupPipsUI(targetWins);
  updateHudPlayers(currentPlayers, scores);
  renderBoard(board);
  updateTurnState(currentTurn);
});

// Turn Timer Management
socket.on('turn_timer_start', ({ duration }) => {
  currentTurnMaxSeconds = duration || (isDeathMatchMode ? 8 : 15);
  startTurnTimer(currentTurnMaxSeconds);
});

function startTurnTimer(seconds = 15) {
  stopTurnTimer();
  remainingTurnSeconds = seconds;
  updateTimerUI();

  turnTimerInterval = setInterval(() => {
    remainingTurnSeconds--;
    updateTimerUI();

    const dangerThreshold = currentTurnMaxSeconds <= 8 ? 2 : 4;
    if (remainingTurnSeconds <= dangerThreshold && remainingTurnSeconds > 0) {
      sfx.playTick(true);
    }

    if (remainingTurnSeconds <= 0) {
      stopTurnTimer();
    }
  }, 1000);
}

function stopTurnTimer() {
  if (turnTimerInterval) {
    clearInterval(turnTimerInterval);
    turnTimerInterval = null;
  }
  turnTimerBadge.classList.remove('danger-time');
  if (turnTimerBar) {
    turnTimerBar.style.width = '100%';
    turnTimerBar.style.backgroundColor = 'var(--emerald)';
    turnTimerBar.style.boxShadow = '0 0 14px var(--emerald-glow)';
  }
}

function updateTimerUI() {
  turnTimerSec.innerText = remainingTurnSeconds;

  const pct = Math.max(0, (remainingTurnSeconds / currentTurnMaxSeconds) * 100);
  turnTimerBar.style.width = `${pct}%`;

  // Dynamic thresholds: 8s blitz mode vs 15s standard mode
  const safeLimit = currentTurnMaxSeconds <= 8 ? 4 : 7;
  const warnLimit = currentTurnMaxSeconds <= 8 ? 2 : 3;

  if (remainingTurnSeconds > safeLimit) {
    turnTimerBar.style.backgroundColor = 'var(--emerald)';
    turnTimerBar.style.boxShadow = '0 0 14px var(--emerald-glow)';
    turnTimerBadge.classList.remove('danger-time');
  } else if (remainingTurnSeconds > warnLimit) {
    turnTimerBar.style.backgroundColor = 'var(--gold-primary)';
    turnTimerBar.style.boxShadow = '0 0 14px var(--gold-glow)';
    turnTimerBadge.classList.remove('danger-time');
  } else {
    turnTimerBar.style.backgroundColor = 'var(--ruby)';
    turnTimerBar.style.boxShadow = '0 0 18px var(--ruby-glow)';
    turnTimerBadge.classList.add('danger-time');
  }
}

// 5. Grid Actions
cells.forEach(cell => {
  cell.addEventListener('click', () => {
    const idx = parseInt(cell.dataset.index, 10);
    if (!isMyTurn || cell.innerText !== '') return;
    socket.emit('make_move', { cellIndex: idx });
  });
});

socket.on('cell_updated', ({ cellIndex, symbol }) => {
  const target = cells[cellIndex];
  target.innerText = symbol;
  target.classList.add(symbol === 'X' ? 'cell-x' : 'cell-o');
  target.disabled = true;

  if (symbol === 'X') sfx.playPopX();
  else sfx.playChimeO();
});

socket.on('turn_change', ({ currentTurn }) => {
  updateTurnState(currentTurn);
});

function updateTurnState(currentTurn) {
  isMyTurn = (currentTurn === socket.id || (myPlayer && currentTurn === myPlayer.id));
  const isX = (currentTurn === socket.id ? myPlayer.symbol : (myPlayer.symbol === 'X' ? 'O' : 'X')) === 'X';
  turnBanner.innerText = isMyTurn ? 'YOUR TURN' : `${isX ? 'X' : 'O'}'S TURN`;
  turnBanner.style.color = isMyTurn ? 'var(--gold-primary)' : 'var(--text-muted)';
}

// 6. Round Result Card
socket.on('round_over', ({ winner, winningCombo, scores, round, format, targetWins, isDraw, isDeathMatch, isMatchOver }) => {
  stopTurnTimer();
  clearPendingUiTimeouts();
  updateHudPlayers(currentPlayers, scores);

  const [p1, p2] = currentPlayers;
  const p1Score = scores[p1.token] || scores[p1.id] || 0;
  const p2Score = scores[p2.token] || scores[p2.id] || 0;

  if (winningCombo) {
    drawWinningLine(winningCombo);
  }

  if (winner && (winner.id === socket.id || (myPlayer && winner.token === myPlayer.token))) {
    sfx.playWin();
  }

  if (isMatchOver) {
    return;
  }

  roundModalTimeout = setTimeout(() => {
    roundModal.classList.remove('hidden');
    roundCardContainer.className = 'modal-card round-card';

    roundResultBadge.innerText = isDeathMatch ? 'SUDDEN DEATH ROUND' : `ROUND ${round} OF ${format}`;
    scP1Name.innerText = p1.name;
    scP1Score.innerText = p1Score;
    scP2Name.innerText = p2.name;
    scP2Score.innerText = p2Score;
    roundModalSubtitle.innerText = isDeathMatch 
      ? 'Golden Round: Sudden Death winner claims championship!' 
      : `Target: First to ${targetWins} round wins takes match`;

    if (isDraw) {
      roundCardContainer.classList.add('state-draw');
      roundModalTitle.innerText = 'ROUND DRAW';
    } else if (winner && (winner.id === socket.id || (myPlayer && winner.token === myPlayer.token))) {
      roundCardContainer.classList.add('state-won');
      roundModalTitle.innerText = 'YOU WON THIS ROUND!';
    } else {
      roundCardContainer.classList.add('state-lost');
      roundModalTitle.innerText = 'YOU LOST THIS ROUND';
    }

    nextProgressFill.style.width = '0%';
    nextFillTimeout = setTimeout(() => {
      nextProgressFill.style.width = '100%';
    }, 50);
  }, 900);
});

// 7. Match Over
socket.on('match_over', ({ matchWinner, scores }) => {
  stopTurnTimer();
  clearPendingUiTimeouts();
  isMatchConcluded = true;

  const [p1, p2] = currentPlayers;
  const p1Score = scores[p1.token] || scores[p1.id] || 0;
  const p2Score = scores[p2.token] || scores[p2.id] || 0;

  matchModalTimeout = setTimeout(() => {
    roundModal.classList.add('hidden');
    deathMatchModal.classList.add('hidden');
    victoryModal.classList.remove('hidden');
    btnRematch.style.display = 'inline-block';
    btnRematch.disabled = false;
    rematchCounter.innerText = '0';

    victoryCard.classList.remove('state-champion', 'state-defeat');

    const isMeWinner = matchWinner && (matchWinner.id === socket.id || (myPlayer && matchWinner.token === myPlayer.token));

    if (!matchWinner) {
      victoryIcon.innerText = '🤝';
      victoryTitle.innerText = 'MATCH DRAW!';
      victorySubtitle.innerText = `Identical mastery after match (${p1Score} — ${p2Score}).`;
    } else if (isMeWinner) {
      victoryCard.classList.add('state-champion');
      victoryIcon.innerText = isDeathMatchMode ? '⚡' : '🏆';
      victoryTitle.innerText = isDeathMatchMode ? 'SUDDEN DEATH CHAMPION! ⚡' : 'CHAMPION! 🏆';
      victorySubtitle.innerText = `You won the showdown (${p1Score} vs ${p2Score})!`;
      sfx.playWin();
    } else {
      victoryCard.classList.add('state-defeat');
      victoryIcon.innerText = '💀';
      victoryTitle.innerText = 'DEFEATED';
      victorySubtitle.innerText = `${matchWinner.name} took the match victory.`;
    }
  }, 600);
});

// 8. Instant Match Victory by Forfeit or Disconnect
socket.on('opponent_forfeited', ({ leaverName }) => {
  if (isMatchConcluded) return;

  stopTurnTimer();
  clearPendingUiTimeouts();
  countdownModal.classList.add('hidden');
  deathMatchModal.classList.add('hidden');
  roundModal.classList.add('hidden');
  forfeitModal.classList.add('hidden');
  victoryModal.classList.remove('hidden');

  victoryCard.classList.remove('state-defeat');
  victoryCard.classList.add('state-champion');
  victoryIcon.innerText = '🏆';
  victoryTitle.innerText = 'VICTORY BY FORFEIT! 🏆';
  victorySubtitle.innerText = `${leaverName} conceded or disconnected. You win the match!`;

  btnRematch.style.display = 'none';
  btnLeaveMatch.innerText = 'RETURN TO HOME';

  sfx.playWin();
});

btnRematch.addEventListener('click', () => {
  socket.emit('request_rematch');
  btnRematch.disabled = true;
});

socket.on('rematch_status', ({ votes }) => {
  rematchCounter.innerText = votes;
});

function setupPipsUI(targetWins) {
  p1PipsContainer.innerHTML = '';
  p2PipsContainer.innerHTML = '';
  for (let i = 0; i < targetWins; i++) {
    p1PipsContainer.appendChild(document.createElement('span')).className = 'pip';
    p2PipsContainer.appendChild(document.createElement('span')).className = 'pip';
  }
}

function updateHudPlayers(players, scores = {}) {
  if (!players || players.length < 2) return;
  const p1 = players[0];
  const p2 = players[1];

  p1Name.innerText = p1.name;
  p2Name.innerText = p2.name;

  if (myPlayer) {
    const isP1Me = p1.token === myPlayer.token || p1.id === myPlayer.id;
    p1Tag.innerText = isP1Me ? '(YOU)' : '(OPPONENT)';
    p1Tag.className = `p-role-tag ${isP1Me ? 'tag-you' : 'tag-opp'}`;

    p2Tag.innerText = isP1Me ? '(OPPONENT)' : '(YOU)';
    p2Tag.className = `p-role-tag ${isP1Me ? 'tag-opp' : 'tag-you'}`;
  }

  const p1Wins = scores[p1.token] || scores[p1.id] || 0;
  const p2Wins = scores[p2.token] || scores[p2.id] || 0;

  p1WinText.innerText = `${p1Wins} ${p1Wins === 1 ? 'Win' : 'Wins'}`;
  p2WinText.innerText = `${p2Wins} ${p2Wins === 1 ? 'Win' : 'Wins'}`;

  const p1PipNodes = p1PipsContainer.children;
  const p2PipNodes = p2PipsContainer.children;

  for (let i = 0; i < p1PipNodes.length; i++) {
    p1PipNodes[i].classList.toggle('filled', i < p1Wins);
  }
  for (let i = 0; i < p2PipNodes.length; i++) {
    p2PipNodes[i].classList.toggle('filled', i < p2Wins);
  }
}

function renderBoard(board) {
  cells.forEach((cell, idx) => {
    cell.innerText = board[idx] || '';
    cell.className = 'cell';
    cell.disabled = board[idx] !== null;
    if (board[idx] === 'X') cell.classList.add('cell-x');
    if (board[idx] === 'O') cell.classList.add('cell-o');
  });
}

function drawWinningLine(combo) {
  const first = cells[combo[0]].getBoundingClientRect();
  const last = cells[combo[2]].getBoundingClientRect();
  const gridRect = document.getElementById('ttt-grid').getBoundingClientRect();

  const x1 = first.left + first.width / 2 - gridRect.left;
  const y1 = first.top + first.height / 2 - gridRect.top;
  const x2 = last.left + last.width / 2 - gridRect.left;
  const y2 = last.top + last.height / 2 - gridRect.top;

  strikeLine.setAttribute('x1', x1);
  strikeLine.setAttribute('y1', y1);
  strikeLine.setAttribute('x2', x2);
  strikeLine.setAttribute('y2', y2);

  strikeLine.style.strokeDashoffset = '0';
}

function startDemoMiniCanvas() {
  const canvas = document.getElementById('mini-demo-canvas');
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const cellSize = w / 3;

  let demoBoard = Array(9).fill(null);
  let step = 0;
  const sequence = [4, 0, 2, 6, 8, 1, 7];

  function loop() {
    if (!waitingScreen.classList.contains('active')) return;

    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(cellSize, 10); ctx.lineTo(cellSize, h - 10);
    ctx.moveTo(cellSize * 2, 10); ctx.lineTo(cellSize * 2, h - 10);
    ctx.moveTo(10, cellSize); ctx.lineTo(w - 10, cellSize);
    ctx.moveTo(10, cellSize * 2); ctx.lineTo(w - 10, cellSize * 2);
    ctx.stroke();

    demoBoard.forEach((sym, idx) => {
      if (!sym) return;
      const col = idx % 3;
      const row = Math.floor(idx / 3);
      const cx = col * cellSize + cellSize / 2;
      const cy = row * cellSize + cellSize / 2;

      ctx.lineWidth = 6;
      if (sym === 'X') {
        ctx.strokeStyle = '#f43f5e';
        ctx.beginPath();
        ctx.moveTo(cx - 20, cy - 20); ctx.lineTo(cx + 20, cy + 20);
        ctx.moveTo(cx + 20, cy - 20); ctx.lineTo(cx - 20, cy + 20);
        ctx.stroke();
      } else {
        ctx.strokeStyle = '#06b6d4';
        ctx.beginPath();
        ctx.arc(cx, cy, 22, 0, Math.PI * 2);
        ctx.stroke();
      }
    });

    if (Math.random() < 0.05) {
      if (step < sequence.length) {
        demoBoard[sequence[step]] = (step % 2 === 0) ? 'X' : 'O';
        step++;
      } else {
        demoBoard = Array(9).fill(null);
        step = 0;
      }
    }

    demoAnimationId = requestAnimationFrame(loop);
  }

  loop();
}

function stopDemoMiniCanvas() {
  if (demoAnimationId) {
    cancelAnimationFrame(demoAnimationId);
    demoAnimationId = null;
  }
}
