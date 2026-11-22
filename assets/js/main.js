/* ================================================================
   main.js - Controlador da aplicação (Fase 3)
   ================================================================
   - Host: mantém GameEngine, processa mensagens, faz broadcast
   - Client: envia inputs pro host, renderiza estado recebido
   ================================================================ */

const SESSION_KEY = 'coup-online-session';
const SESSION_TTL_MS = 2 * 60 * 1000; // 2 minutos

const CoupApp = {
  role: null,           // 'host' | 'client'
  host: null,
  client: null,
  game: null,           // só existe no host
  myName: '',
  myPlayerId: null,
  roomCode: null,
  players: [],
  lastState: null,      // último estado renderizado (pra consultar no UI)
  timerSeconds: 0,      // 0 = sem timer (visual)
  _autoPassTimer: null, // setTimeout handle do auto-pass (host)
  _autoPassKey: null,   // identifica a fase/pending atual pra detectar mudanças
  AUTO_PASS_MS: 20000,  // 20s — se ninguém contestar/bloquear, passa automático
  _autoActionTimer: null, // setTimeout handle do auto-skip do turno (renda automática)
  _autoActionKey: null,
  _reconnecting: false, // flag durante tentativa de reconexão automática

  // ---------------------------------------------------------------
  // Auto-pass (host)
  // ---------------------------------------------------------------

  _scheduleAutoPass(state) {
    if (CoupApp.role !== 'host' || !CoupApp.game) return;

    const AUTO_PHASES = ['await-challenge', 'await-block', 'await-block-challenge'];
    const inAutoPhase = AUTO_PHASES.includes(state.phase) && state.status === 'playing';

    // Chave única: fase + quem iniciou o pending + tipo
    const pending = state.pending || {};
    const key = inAutoPhase
      ? `${state.phase}|${pending.actorId || ''}|${pending.type || ''}|${pending.blockerId || ''}`
      : null;

    if (!inAutoPhase) {
      CoupApp._clearAutoPass();
      return;
    }

    // Fase/pending mudou? Reinicia o timer.
    if (CoupApp._autoPassKey !== key) {
      CoupApp._clearAutoPass();
      CoupApp._autoPassKey = key;
      CoupApp._autoPassTimer = setTimeout(() => CoupApp._fireAutoPass(key), CoupApp.AUTO_PASS_MS);
    }
  },

  _clearAutoPass() {
    if (CoupApp._autoPassTimer) {
      clearTimeout(CoupApp._autoPassTimer);
      CoupApp._autoPassTimer = null;
    }
    CoupApp._autoPassKey = null;
  },

  _fireAutoPass(expectedKey) {
    if (!CoupApp.game || CoupApp._autoPassKey !== expectedKey) return;
    const s = CoupApp.game.state;
    const pending = s.pending;
    if (!pending) return;
    // O timer já disparou. NÃO zeramos _autoPassKey depois do loop: cada pass dispara
    // _emit -> _scheduleAutoPass, que pode já ter armado o timer da PRÓXIMA fase
    // (ex.: contestação -> bloqueio). Zerar a chave deixava esse timer órfão e o jogo travava.
    CoupApp._autoPassTimer = null;
    const eligible = CoupApp.game._eligibleResponders ? CoupApp.game._eligibleResponders() : (s.eligibleResponders || []);
    // Passa cada responder que ainda não respondeu
    eligible.forEach(id => {
      if (!pending.responses || !pending.responses[id]) {
        CoupApp._processInput(id, { type: 'action:pass' });
      }
    });
  },

  // ---------------------------------------------------------------
  // Auto-skip do turno (host) — se o jogador atual demorar demais,
  // o host faz Renda automática (ou Golpe se ele tiver 10+ moedas).
  // Só roda se o host habilitou timerSeconds > 0 no lobby.
  // ---------------------------------------------------------------

  _scheduleAutoAction(state) {
    if (CoupApp.role !== 'host' || !CoupApp.game) return;
    const enabled = CoupApp.timerSeconds && CoupApp.timerSeconds > 0;
    const inAction = state.phase === 'action' && state.status === 'playing';

    if (!enabled || !inAction) {
      CoupApp._clearAutoAction();
      return;
    }

    // state bruto não tem currentPlayerId — usa turnIndex
    const currentId = state.players[state.turnIndex]?.id;
    if (!currentId) { CoupApp._clearAutoAction(); return; }

    const key = `${currentId}|action|${state.version || 0}`;
    // Só reagendar se mudou o jogador (não o version — senão reseta a cada _emit)
    const currentKeyOwner = (CoupApp._autoActionKey || '').split('|')[0];
    if (currentKeyOwner !== currentId) {
      CoupApp._clearAutoAction();
      CoupApp._autoActionKey = currentId + '|action';
      const ms = CoupApp.timerSeconds * 1000;
      CoupApp._autoActionTimer = setTimeout(() => CoupApp._fireAutoAction(CoupApp._autoActionKey), ms);
    }
  },

  _clearAutoAction() {
    if (CoupApp._autoActionTimer) {
      clearTimeout(CoupApp._autoActionTimer);
      CoupApp._autoActionTimer = null;
    }
    CoupApp._autoActionKey = null;
  },

  _fireAutoAction(expectedKey) {
    if (!CoupApp.game || CoupApp._autoActionKey !== expectedKey) return;
    const s = CoupApp.game.state;
    if (s.phase !== 'action' || s.status !== 'playing') return;
    const current = s.players[s.turnIndex];
    if (!current || !current.alive) return;

    let action = 'income';
    let targetId = null;
    if (current.coins >= 10) {
      // Regra obrigatória: golpe. Escolhe o primeiro alvo vivo diferente dele.
      const target = s.players.find(p => p.alive && p.id !== current.id);
      if (!target) return;
      action = 'coup';
      targetId = target.id;
    }
    // Log de aviso antes da ação
    if (CoupApp.game._log) CoupApp.game._log(`⏰ Tempo esgotado — ${current.name} jogou ${action === 'coup' ? 'Golpe automático' : 'Renda automática'}.`);
    CoupApp._processInput(current.id, { type: 'action:play', action, targetId });
    CoupApp._autoActionTimer = null;
    CoupApp._autoActionKey = null;
  },

  // ---------------------------------------------------------------
  // Envio de comandos (client OU host)
  // ---------------------------------------------------------------

  sendResponse(response, character = null) {
    const msg = { type: `action:${response}` };
    if (character) msg.character = character;
    CoupApp._dispatchInput(msg);
  },

  sendPlayAction(action, targetId = null) {
    CoupApp._dispatchInput({ type: 'action:play', action, targetId });
  },

  sendLoseCard(cardIndex) {
    CoupApp._dispatchInput({ type: 'action:lose-card', cardIndex });
  },

  sendExchange(keepIndexes) {
    CoupApp._dispatchInput({ type: 'action:exchange-select', keepIndexes });
  },

  _dispatchInput(msg) {
    if (CoupApp.role === 'host') {
      // Processa direto no engine
      CoupApp._processInput(CoupApp.myPlayerId, msg);
    } else if (CoupApp.role === 'client') {
      CoupApp.client.send(msg);
    }
  },

  // ---------------------------------------------------------------
  // Host: processa input (próprio ou vindo de um client)
  // ---------------------------------------------------------------

  _processInput(playerId, msg) {
    if (!CoupApp.game) return;
    if (!msg || typeof msg !== 'object') return;
    let result;
    switch (msg.type) {
      case 'action:play':
        result = CoupApp.game.playAction(playerId, msg.action, msg.targetId);
        break;
      case 'action:pass':
        result = CoupApp.game.pass(playerId);
        break;
      case 'action:challenge':
        result = CoupApp.game.challenge(playerId);
        break;
      case 'action:block':
        result = CoupApp.game.block(playerId, msg.character);
        break;
      case 'action:lose-card':
        result = CoupApp.game.loseCard(playerId, msg.cardIndex);
        break;
      case 'action:exchange-select':
        result = CoupApp.game.exchangeSelect(playerId, msg.keepIndexes);
        break;
      default:
        console.warn('[host] mensagem desconhecida:', msg);
        return;
    }
    if (result && result.error) {
      // Devolve erro pra quem mandou
      if (playerId === CoupApp.myPlayerId) {
        UI.toast(result.error);
      } else {
        CoupApp.host.sendTo(playerId, { type: 'error', message: result.error });
      }
    }
  },

  // ---------------------------------------------------------------
  // Host: despacha o estado (sanitizado) pra cada jogador.
  // Injeta a flag `disconnected` puxada da lista do CoupHost
  // pra UI conseguir mostrar badge de "reconectando".
  // ---------------------------------------------------------------
  _broadcastState() {
    if (!CoupApp.game || !CoupApp.host) return;
    const hostPlayers = CoupApp.host.players || [];
    const dcMap = {};
    hostPlayers.forEach(p => { if (p.disconnected) dcMap[p.id] = true; });

    CoupApp.players.forEach(p => {
      const s = CoupApp.game.getStateFor(p.id);
      s.players = s.players.map(pp => ({ ...pp, disconnected: !!dcMap[pp.id] }));
      if (p.id === CoupApp.myPlayerId) {
        CoupApp.lastState = s;
        UI.renderGame(s, CoupApp.myPlayerId, CoupApp.roomCode);
      } else if (!dcMap[p.id]) {
        // Só envia pra quem está conectado (desconectados pegam no rejoin:ack)
        CoupApp.host.sendTo(p.id, { type: 'game:state', state: s });
      }
    });
  }
};

// ================================================================
// Binds de botões principais (menu / lobby)
// ================================================================

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;

  switch (action) {
    case 'goto-home':    UI.showScreen('home'); break;
    case 'goto-create':  UI.showScreen('create'); break;
    case 'goto-join':    UI.showScreen('join'); break;
    case 'create-room':  handleCreateRoom(); break;
    case 'join-room':    handleJoinRoom(); break;
    case 'start-game':   handleStartGame(); break;
    case 'leave-room':   handleLeaveRoom(); break;
    case 'leave-game':   handleLeaveGame(); break;
    case 'return-to-lobby': handleReturnToLobby(); break;
    case 'cancel-target': UI.hideTargetPicker(); break;
    case 'kick-player':  handleKickPlayer(btn); break;
    case 'show-rules':   document.getElementById('modal-rules')?.classList.remove('hidden'); break;
    case 'show-themes':  renderThemePicker(); document.getElementById('modal-themes')?.classList.remove('hidden'); break;
    case 'close-themes': document.getElementById('modal-themes')?.classList.add('hidden'); break;
    case 'pick-theme':   pickTheme(btn.dataset.theme); break;
    case 'close-rules':  document.getElementById('modal-rules')?.classList.add('hidden'); break;
  }
});

// Fechar modal de regras clicando no backdrop ou com ESC
document.getElementById('modal-rules')?.addEventListener('click', e => {
  if (e.target.id === 'modal-rules') e.target.classList.add('hidden');
});
document.getElementById('modal-themes')?.addEventListener('click', e => {
  if (e.target.id === 'modal-themes') e.target.classList.add('hidden');
});

/** Monta a lista de temas com prévia (3 cartas) e marca o atual. */
function renderThemePicker() {
  const list = document.getElementById('theme-list');
  if (!list) return;
  const current = CardTheme.get();
  list.innerHTML = '';
  Object.entries(CARD_THEMES).forEach(([id, t]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.action = 'pick-theme';
    b.dataset.theme = id;
    b.className = 'theme-option' + (id === current ? ' selected' : '');
    const thumbs = ['duke', 'contessa', 'assassin'].map(c =>
      `<img src="assets/cards/${id}/${CHARACTERS[c.toUpperCase()].file}.webp" alt="" loading="lazy">`).join('');
    b.innerHTML = `<span class="theme-thumbs">${thumbs}</span>
      <span class="theme-name">${escapeHTML(t.name)}${id === current ? ' ✓' : ''}</span>`;
    list.appendChild(b);
  });
}

function pickTheme(id) {
  if (!id || !CARD_THEMES[id]) return;
  CardTheme.set(id);
  renderThemePicker();
  // Re-renderiza a mesa com o tema novo (se estiver numa partida)
  if (CoupApp.lastState && CoupApp.myPlayerId) {
    UI.renderGame(CoupApp.lastState, CoupApp.myPlayerId, CoupApp.roomCode);
  }
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.getElementById('modal-themes')?.classList.add('hidden');
    const rules = document.getElementById('modal-rules');
    if (rules && !rules.classList.contains('hidden')) rules.classList.add('hidden');
  }
});

function handleKickPlayer(btn) {
  if (CoupApp.role !== 'host' || !CoupApp.host) return;
  const peerId = btn.dataset.peerId;
  const name = btn.dataset.playerName || 'esse jogador';
  if (!peerId) return;
  if (!confirm(`Remover ${name} da sala?`)) return;
  CoupApp.host.kickPlayer(peerId);
}

// ================================================================
// Botões de ação do jogo (renda, imposto, etc.)
// ================================================================

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-game-action]');
  if (!btn || btn.disabled) return;
  const action = btn.dataset.gameAction;
  const def = ACTIONS[action];
  if (!def) return;

  if (def.targetRequired) {
    // Abre picker de alvo
    const state = CoupApp.lastState;
    if (!state) return;
    const targets = state.players.filter(p => p.alive && p.id !== CoupApp.myPlayerId);
    if (targets.length === 0) { UI.toast('Sem alvos disponíveis.'); return; }
    UI.showTargetPicker(`Escolha o alvo de ${ACTION_LABEL[action]}`, targets, (targetId) => {
      CoupApp.sendPlayAction(action, targetId);
    });
  } else {
    CoupApp.sendPlayAction(action);
  }
});

// ================================================================
// HANDLERS PRINCIPAIS
// ================================================================

function handleCreateRoom() {
  if (CoupApp.host) return; // já está criando/hospedando (evita clique duplo)
  const name = document.getElementById('create-name').value.trim();
  if (!name) { UI.toast('Digite seu nome.'); return; }

  CoupApp.myName = name;
  CoupApp.role = 'host';

  // Cria game engine e wiring da callback pra broadcast
  CoupApp.game = new GameEngine((state) => {
    CoupApp._broadcastState();
    // Auto-pass: se ninguém contestar/bloquear, resolve sozinho (20s)
    CoupApp._scheduleAutoPass(state);
    // Auto-skip: se o jogador atual não agir dentro do timer configurado, joga Renda automática
    CoupApp._scheduleAutoAction(state);
  });

  CoupApp.host = new CoupHost({
    onReady: (roomCode) => {
      CoupApp.roomCode = roomCode;
      CoupApp.myPlayerId = roomCodeToPeerId(roomCode);
      CoupApp.players = CoupApp.host._publicPlayers();
      _saveSession();
      document.getElementById('create-room-code').textContent = roomCode;
      document.getElementById('create-result').classList.remove('hidden');
      setTimeout(() => {
        UI.showScreen('lobby');
        UI.renderLobby(roomCode, CoupApp.players, true);
      }, 900);
    },
    onPlayerJoin: (player) => {
      UI.toast(`${player.name} entrou`);
      CoupApp.players = CoupApp.host._publicPlayers();
      UI.renderLobby(CoupApp.roomCode, CoupApp.players, true);
    },
    onPlayerDisconnect: (player) => {
      if (player) UI.toast(`${player.name} caiu — 90s pra voltar`);
      CoupApp.players = CoupApp.host._publicPlayers();
      if (CoupApp.game && CoupApp.game.state.status === 'playing') {
        CoupApp._broadcastState();
      } else {
        UI.renderLobby(CoupApp.roomCode, CoupApp.players, true);
      }
    },
    onPlayerRejoin: (oldId, newId, player) => {
      // Atualiza o id dentro do state do engine (turnIndex continua válido, é só a referência)
      if (CoupApp.game && CoupApp.game.state.players.length) {
        const gp = CoupApp.game.state.players.find(p => p.id === oldId);
        if (gp) gp.id = newId;
      }
      CoupApp.players = CoupApp.host._publicPlayers();
      UI.toast(`${player.name} voltou`);
      if (CoupApp.game && CoupApp.game.state.status === 'playing') {
        CoupApp._broadcastState();
        // Reenvia config do timer
        CoupApp.host.sendTo(newId, { type: 'game:config', timerSeconds: CoupApp.timerSeconds });
      } else {
        CoupApp.host.sendTo(newId, { type: 'lobby:update', players: CoupApp.players });
        UI.renderLobby(CoupApp.roomCode, CoupApp.players, true);
      }
    },
    onPlayerLeave: (player) => {
      if (player) UI.toast(`${player.name} saiu da sala`);
      CoupApp.players = CoupApp.host._publicPlayers();
      if (CoupApp.game && CoupApp.game.state.status === 'playing') {
        // Jogo em andamento: elimina o jogador e destrava o fluxo
        // (se era a vez dele ou o alvo da jogada, a ação é cancelada).
        if (player) CoupApp.game.forfeitPlayer(player.id);
        else CoupApp._broadcastState();
      } else {
        UI.renderLobby(CoupApp.roomCode, CoupApp.players, true);
      }
    },
    onMessage: (peerId, data) => {
      // Mensagem de um client
      CoupApp._processInput(peerId, data);
    },
    // Impede entrada com sala cheia ou partida em andamento
    canJoin: () => {
      if (CoupApp.game && CoupApp.game.state.status === 'playing') {
        return { ok: false, reason: 'A partida já começou. Espere a próxima rodada.' };
      }
      if (CoupApp.host.players.length >= 6) {
        return { ok: false, reason: 'Sala cheia (máximo 6 jogadores).' };
      }
      return { ok: true };
    },
    onError: (err) => {
      const msg = err && err.type === 'unavailable-id'
        ? 'Não consegui reservar um código. Tente de novo.'
        : 'Não foi possível criar a sala (servidor PeerJS indisponível?). Tente de novo.';
      UI.toast(msg, 4000);
      try { CoupApp.host?.destroy(); } catch (_) {}
      CoupApp.host = null; CoupApp.game = null; CoupApp.role = null;
      document.getElementById('create-result')?.classList.add('hidden');
    }
  });

  CoupApp.host.createRoom(name);
}

function _clientOnMessage(data) {
  switch (data.type) {
    case 'lobby:update':
      CoupApp.players = data.players;
      // Durante um jogo em andamento, só atualizamos a lista (pra refletir
      // disconnect/rejoin no painel de oponentes) — não tiramos o jogador
      // da tela de jogo.
      if (CoupApp.lastState && CoupApp.lastState.status === 'playing') {
        _saveSession();
        break;
      }
      UI.showScreen('lobby');
      UI.renderLobby(CoupApp.roomCode, CoupApp.players, false);
      _saveSession();
      break;

    case 'game:state':
      CoupApp.lastState = data.state;
      UI.showScreen('game');
      UI.renderGame(data.state, CoupApp.myPlayerId, CoupApp.roomCode);
      _saveSession();
      break;

    case 'game:config':
      if (typeof data.timerSeconds === 'number') {
        CoupApp.timerSeconds = data.timerSeconds;
      }
      break;

    case 'rejoin:ack':
      // Host confirmou reconexão — atualiza meu id com o novo peer id
      CoupApp.myPlayerId = data.playerId;
      CoupApp.roomCode = data.roomCode || CoupApp.roomCode;
      CoupApp.players = data.players || CoupApp.players;
      CoupApp._reconnecting = false;
      _saveSession();
      UI.toast('Reconectado!');
      break;

    case 'rejoin:failed':
      UI.toast(data.reason || 'Não foi possível reconectar.');
      _clearSession();
      CoupApp._reconnecting = false;
      setTimeout(() => handleLeaveRoom(), 1200);
      break;

    case 'room:closed':
      UI.toast('O host fechou a sala.');
      _clearSession();
      setTimeout(() => handleLeaveRoom(), 1200);
      break;

    case 'kicked':
      UI.toast(data.reason || 'Você foi removido pelo host.');
      _clearSession();
      CoupApp._reconnecting = false;
      CoupApp._kicked = true; // suprime toast de "Desconectado" quando conn fechar
      setTimeout(() => handleLeaveRoom(), 1500);
      break;

    case 'join:rejected':
      UI.toast(data.reason || 'Não foi possível entrar na sala.', 4000);
      CoupApp._kicked = true; // suprime o "desconectado" quando o host fechar a conexão
      setTimeout(() => handleLeaveRoom(), 1500);
      break;

    case 'room:back-to-lobby':
      UI.toast('Voltando pro lobby...');
      CoupApp.lastState = null;
      document.getElementById('modal-end')?.classList.add('hidden');
      UI._prevState = null;
      UI._prevMyId = null;
      UI.showScreen('lobby');
      UI.renderLobby(CoupApp.roomCode, CoupApp.players, false);
      break;

    case 'error':
      UI.toast(data.message || 'Erro');
      break;

    default:
      console.log('[client] msg:', data);
  }
}

function handleJoinRoom() {
  if (CoupApp.client) return; // já tentando entrar (evita clique duplo)
  const name = document.getElementById('join-name').value.trim();
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  if (!name) { UI.toast('Digite seu nome.'); return; }
  if (!code) { UI.toast('Digite o código da sala.'); return; }

  CoupApp.myName = name;
  CoupApp.role = 'client';
  CoupApp.roomCode = code;

  CoupApp.client = new CoupClient({
    onConnected: (myId) => {
      CoupApp.myPlayerId = myId;
      _saveSession();
      UI.toast('Conectado! Entrando no lobby...');
    },
    onMessage: _clientOnMessage,
    onDisconnect: () => {
      if (CoupApp._reconnecting) return; // reconexão em andamento
      if (CoupApp._kicked) return;        // kick já avisou e vai sair sozinho
      if (!CoupApp.role) return;          // já saiu
      // (o toast com o motivo já foi mostrado pelo peer.js, se for falha de conexão)
      setTimeout(() => handleLeaveRoom(), 1500);
    }
  });

  CoupApp.client.joinRoom(code, name);
}

function handleStartGame() {
  if (CoupApp.role !== 'host') return;
  const active = CoupApp.players.filter(p => !p.disconnected);
  if (active.length < 2) { UI.toast('Mínimo 2 jogadores conectados.'); return; }
  if (active.length > 6) { UI.toast('Máximo 6 jogadores.'); return; }

  // Lê config do timer do lobby
  const tToggle = document.getElementById('lobby-timer-toggle');
  const tSeconds = document.getElementById('lobby-timer-seconds');
  if (tToggle && tToggle.checked) {
    const v = parseInt(tSeconds?.value || '30', 10);
    CoupApp.timerSeconds = isNaN(v) ? 30 : Math.max(10, Math.min(120, v));
  } else {
    CoupApp.timerSeconds = 0;
  }
  // Envia a config pros clients
  if (CoupApp.host) CoupApp.host.broadcast({ type: 'game:config', timerSeconds: CoupApp.timerSeconds });

  CoupApp.game.startGame(active);
  UI.showScreen('game');
}

function handleReturnToLobby() {
  // Esconde o modal de fim imediatamente pra quem clicou
  document.getElementById('modal-end')?.classList.add('hidden');

  if (CoupApp.role === 'host') {
    // Limpa timers pendentes
    CoupApp._clearAutoPass();
    CoupApp._clearAutoAction();
    // Reseta o engine do host (novo jogo pode começar)
    if (CoupApp.game) {
      CoupApp.game.state = CoupApp.game._emptyState();
      CoupApp.game.deck.reset();
    }
    // Avisa clientes pra voltarem pro lobby
    if (CoupApp.host) {
      CoupApp.host.broadcast({ type: 'lobby:update', players: CoupApp.players });
      CoupApp.host.broadcast({ type: 'room:back-to-lobby' });
    }
    // Host volta pro lobby
    UI._prevState = null;
    UI._prevMyId = null;
    UI.showScreen('lobby');
    UI.renderLobby(CoupApp.roomCode, CoupApp.players, true);
  } else if (CoupApp.role === 'client') {
    // Client já vai receber lobby:update do host; só força a tela
    UI._prevState = null;
    UI._prevMyId = null;
    UI.showScreen('lobby');
    UI.renderLobby(CoupApp.roomCode, CoupApp.players, false);
  } else {
    // Sem role (caiu fora) — volta pra home
    handleLeaveRoom();
  }
}

function handleLeaveGame() {
  const isHost = CoupApp.role === 'host';
  const msg = isHost
    ? 'Tem certeza? Você é o host — sair vai FECHAR a sala pra todos.'
    : 'Tem certeza que quer sair da sala?';
  if (confirm(msg)) handleLeaveRoom();
}

function handleLeaveRoom() {
  // Host avisa os clients antes de fechar
  if (CoupApp.role === 'host' && CoupApp.host) {
    try { CoupApp.host.broadcast({ type: 'room:closed', reason: 'host-left' }); } catch(_) {}
  }
  CoupApp._clearAutoPass();
  CoupApp._clearAutoAction();
  // Host: pequeno atraso pra mensagem 'room:closed' chegar antes de derrubar as conexões
  const oldHost = CoupApp.host;
  if (oldHost) setTimeout(() => oldHost.destroy(), 250);
  if (CoupApp.client) CoupApp.client.destroy();
  _clearSession();
  Object.assign(CoupApp, {
    role: null, host: null, client: null, game: null,
    myName: '', myPlayerId: null, roomCode: null, players: [], lastState: null,
    timerSeconds: 0, _reconnecting: false, _kicked: false
  });
  document.getElementById('create-result')?.classList.add('hidden');
  UI._prevState = null;
  UI._prevMyId = null;
  UI.showScreen('home');
}

// ================================================================
// PERSISTÊNCIA DE SESSÃO (pra sobreviver a refresh do navegador)
// ================================================================

function _saveSession(extra = {}) {
  if (!CoupApp.roomCode || !CoupApp.role) return;
  const data = {
    role: CoupApp.role,
    roomCode: CoupApp.roomCode,
    playerId: CoupApp.myPlayerId,
    playerName: CoupApp.myName,
    timerSeconds: CoupApp.timerSeconds,
    lastSeen: Date.now(),
    ...extra
  };
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(data)); } catch (_) {}
}

function _loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !data.lastSeen) return null;
    if (Date.now() - data.lastSeen > SESSION_TTL_MS) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return data;
  } catch (_) {
    return null;
  }
}

function _clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
}

/** Tenta recuperar uma sessão de client após refresh.
 *  Host refresh não é suportado (abre a home normalmente). */
function _tryResumeSession() {
  const session = _loadSession();
  if (!session) return false;

  // Host: não dá pra reviver mid-game (state + deck foram-se). Limpa.
  if (session.role === 'host') {
    _clearSession();
    return false;
  }

  if (session.role !== 'client') {
    _clearSession();
    return false;
  }

  // Inicia reconexão de client
  CoupApp.myName = session.playerName;
  CoupApp.role = 'client';
  CoupApp.roomCode = session.roomCode;
  CoupApp.timerSeconds = session.timerSeconds || 0;
  CoupApp._reconnecting = true;

  UI.toast('Reconectando à sala...');

  CoupApp.client = new CoupClient({
    onConnected: (myId) => {
      CoupApp.myPlayerId = myId;
    },
    onMessage: _clientOnMessage,
    onDisconnect: () => {
      if (CoupApp._kicked) return;
      if (CoupApp._reconnecting) {
        UI.toast('Não foi possível reconectar.');
        _clearSession();
        CoupApp._reconnecting = false;
        setTimeout(() => handleLeaveRoom(), 1200);
      } else {
        UI.toast('Desconectado do host.');
        setTimeout(() => handleLeaveRoom(), 1500);
      }
    }
  });

  CoupApp.client.rejoinRoom(session.roomCode, session.playerName, session.playerId);
  return true;
}

// ================================================================
// Fase 4 — Toggle de som e config do timer no lobby
// ================================================================

function wireSoundToggle() {
  const btn = document.getElementById('sound-toggle');
  if (!btn) return;
  const refresh = () => {
    btn.textContent = Sounds.isMuted() ? '🔇' : '🔊';
    btn.title = Sounds.isMuted() ? 'Som desligado (clique pra ligar)' : 'Som ligado (clique pra desligar)';
  };
  refresh();
  btn.addEventListener('click', () => {
    Sounds.toggleMute();
    refresh();
    if (!Sounds.isMuted()) Sounds.click();
  });
}

function wireTimerToggle() {
  const toggle = document.getElementById('lobby-timer-toggle');
  const config = document.getElementById('lobby-timer-config');
  if (!toggle || !config) return;
  toggle.addEventListener('change', () => {
    config.classList.toggle('hidden', !toggle.checked);
  });
}

// ================================================================
// Inicialização
// ================================================================
window.addEventListener('DOMContentLoaded', () => {
  UI.showScreen('home');
  Sounds.init();
  wireSoundToggle();
  wireTimerToggle();
  console.log('%c🎭 Coup Online', 'color:#f59e0b;font-size:18px;font-weight:bold');
  

  // Tenta retomar sessão anterior (refresh do navegador)
  _tryResumeSession();
});

window.CoupApp = CoupApp;
