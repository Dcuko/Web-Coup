/* ================================================================
   peer.js - Conexão multiplayer via PeerJS (WebRTC)
   ================================================================
   - CoupHost: cria sala, aceita conexões, gerencia grace period
     pra reconexão (90s) e lida com mensagens `rejoin`.
   - CoupClient: joinRoom (nova entrada) e rejoinRoom (reconexão
     após refresh/queda). Client manda oldPlayerId pra host casar
     a sessão e preservar cartas/moedas do jogador.
   ================================================================ */

/** Grace period: quanto tempo o host espera antes de remover
 *  definitivamente um jogador que caiu. Se ele voltar antes,
 *  recupera a cadeira com cartas/moedas intactas. */
const GRACE_PERIOD_MS = 90000;

/** Gera um código de sala curto e legível.
 *  Formato: XXXX (4 caracteres — letras maiúsculas + dígitos, sem ambíguos). */
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

/** Nome vindo da rede: sempre string, sem espaços nas pontas, máx. 16 chars. */
function sanitizeName(name) {
  const n = String(name ?? '').trim().slice(0, 16);
  return n || 'Jogador';
}

/** Converte código de sala em peer ID (prefixo pra isolar de outros apps). */
function roomCodeToPeerId(code) {
  return `coup-online-${code.toLowerCase()}`;
}

// ------------------------------------------------------------
// HOST: cria sala, aceita conexões e gerencia reconexões.
// ------------------------------------------------------------
class CoupHost {
  constructor({ onPlayerJoin, onPlayerLeave, onPlayerDisconnect, onPlayerRejoin, onMessage, onReady, onError, canJoin }) {
    this.peer = null;
    this.connections = new Map();    // peerId -> DataConnection
    this.players = [];               // [{ id, name, isHost, disconnected? }]
    this.roomCode = null;
    this._removeTimers = new Map();  // peerId -> timeout handle (grace period)
    this.callbacks = {
      onPlayerJoin, onPlayerLeave,
      onPlayerDisconnect, onPlayerRejoin,
      onMessage, onReady, onError, canJoin
    };
  }

  /** Cria a sala e inicia o peer com um ID previsível baseado no código.
   *  Se o código já estiver em uso no servidor público do PeerJS, sorteia outro
   *  automaticamente (até 5 tentativas). */
  createRoom(hostName, attempt = 1) {
    this.roomCode = generateRoomCode();
    const peerId = roomCodeToPeerId(this.roomCode);

    this.peer = new Peer(peerId, { debug: 1 });
    const myPeer = this.peer;

    this.peer.on('open', id => {
      this.players.push({ id, name: hostName, isHost: true });
      this.callbacks.onReady?.(this.roomCode);
    });

    this.peer.on('connection', conn => this._handleNewConnection(conn));

    // Perdeu o servidor de sinalização (rede oscilou): tenta religar.
    // Conexões já estabelecidas continuam funcionando; isso só afeta novos jogadores.
    this.peer.on('disconnected', () => {
      if (myPeer !== this.peer || myPeer.destroyed) return;
      setTimeout(() => { try { if (myPeer.disconnected && !myPeer.destroyed) myPeer.reconnect(); } catch (_) {} }, 1500);
    });

    this.peer.on('error', err => {
      console.error('[host] peer error:', err);
      if (err.type === 'unavailable-id' && this.players.length === 0 && attempt < 5) {
        try { myPeer.destroy(); } catch (_) {}
        this.createRoom(hostName, attempt + 1);
        return;
      }
      // Erros "de rede" quando ainda não abriu a sala = falha ao criar
      if (this.players.length === 0) {
        this.callbacks.onError?.(err);
      }
    });

    return this.roomCode;
  }

  _handleNewConnection(conn) {
    conn.on('open', () => {
      this.connections.set(conn.peer, conn);
      console.log('[host] nova conexão:', conn.peer);
    });

    conn.on('data', data => {
      if (!data || typeof data !== 'object') return;
      if (data.type === 'join') {
        if (this.players.some(p => p.id === conn.peer)) return; // join duplicado
        const check = this.callbacks.canJoin?.() || { ok: true };
        if (!check.ok) {
          try { conn.send({ type: 'join:rejected', reason: check.reason || 'Não foi possível entrar.' }); } catch (_) {}
          setTimeout(() => { try { conn.close(); } catch (_) {} }, 300);
          return;
        }
        const player = { id: conn.peer, name: sanitizeName(data.name), isHost: false };
        this.players.push(player);
        this.callbacks.onPlayerJoin?.(player);
        this.broadcast({ type: 'lobby:update', players: this._publicPlayers() });
      } else if (data.type === 'rejoin') {
        this._handleRejoin(conn, data);
      } else if (data.type === 'leave') {
        // Saída voluntária: remove na hora (sem esperar o grace period)
        this.removePlayer(conn.peer, false);
      } else {
        this.callbacks.onMessage?.(conn.peer, data);
      }
    });

    conn.on('close', () => this._handleConnectionClose(conn));
  }

  /** Quando a conexão cai: marca como desconectado e agenda remoção
   *  definitiva em GRACE_PERIOD_MS. Se voltar antes, o timer é cancelado. */
  _handleConnectionClose(conn) {
    this.connections.delete(conn.peer);
    const leaving = this.players.find(p => p.id === conn.peer);
    if (!leaving) return;

    leaving.disconnected = true;
    leaving.disconnectedAt = Date.now();

    this.callbacks.onPlayerDisconnect?.(leaving);
    this.broadcast({ type: 'lobby:update', players: this._publicPlayers() });

    const targetId = leaving.id;
    const timer = setTimeout(() => {
      this._removeTimers.delete(targetId);
      // Se já reconectou (id mudou ou flag limpa), não remove
      const still = this.players.find(p => p.id === targetId);
      if (!still || !still.disconnected) return;
      this.players = this.players.filter(p => p.id !== targetId);
      this.callbacks.onPlayerLeave?.(leaving);
      this.broadcast({ type: 'lobby:update', players: this._publicPlayers() });
    }, GRACE_PERIOD_MS);
    this._removeTimers.set(targetId, timer);
  }

  /** Reassocia uma nova conexão a um jogador existente.
   *  Casa pelo oldPlayerId; fallback pelo nome + flag desconectado. */
  _handleRejoin(conn, data) {
    let existing = this.players.find(p => p.id === data.oldPlayerId);
    if (!existing) {
      existing = this.players.find(p => p.name === data.name && p.disconnected);
    }
    if (!existing) {
      try { conn.send({ type: 'rejoin:failed', reason: 'Sessão expirada. Entre na sala de novo.' }); } catch (_) {}
      return;
    }

    const oldId = existing.id;
    const newId = conn.peer;

    // Cancela o timer de remoção
    const timer = this._removeTimers.get(oldId);
    if (timer) { clearTimeout(timer); this._removeTimers.delete(oldId); }

    // Atualiza mapas e flags
    this.connections.delete(oldId);
    this.connections.set(newId, conn);
    existing.id = newId;
    existing.disconnected = false;
    delete existing.disconnectedAt;

    this.callbacks.onPlayerRejoin?.(oldId, newId, existing);

    // ACK específico pro reconectado (ele precisa saber o novo peer id)
    try {
      conn.send({
        type: 'rejoin:ack',
        playerId: newId,
        roomCode: this.roomCode,
        players: this._publicPlayers()
      });
    } catch (_) {}

    // Broadcast atualizado pra todos
    this.broadcast({ type: 'lobby:update', players: this._publicPlayers() });
  }

  /** Representação pública dos jogadores (sem referências internas). */
  _publicPlayers() {
    return this.players.map(p => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      disconnected: !!p.disconnected
    }));
  }

  /** Envia mensagem pra todos os clients conectados. */
  broadcast(data) {
    this.connections.forEach(conn => {
      if (conn.open) conn.send(data);
    });
  }

  /** Envia mensagem pra um peer específico. */
  sendTo(peerId, data) {
    const conn = this.connections.get(peerId);
    if (conn && conn.open) conn.send(data);
  }

  /** Remove um jogador definitivamente (kick pelo host ou saída voluntária).
   *  Cancela qualquer grace timer, fecha a conexão e dispara onPlayerLeave. */
  removePlayer(peerId, notify = true) {
    const player = this.players.find(p => p.id === peerId);
    if (!player || player.isHost) return false;

    const timer = this._removeTimers.get(peerId);
    if (timer) { clearTimeout(timer); this._removeTimers.delete(peerId); }

    const conn = this.connections.get(peerId);
    if (conn && conn.open) {
      if (notify) {
        try { conn.send({ type: 'kicked', reason: 'Você foi removido pelo host.' }); } catch (_) {}
      }
      setTimeout(() => { try { conn.close(); } catch (_) {} }, 150);
    }

    this.connections.delete(peerId);
    this.players = this.players.filter(p => p.id !== peerId);
    this.callbacks.onPlayerLeave?.(player);
    this.broadcast({ type: 'lobby:update', players: this._publicPlayers() });
    return true;
  }

  kickPlayer(peerId) { return this.removePlayer(peerId, true); }

  destroy() {
    this._removeTimers.forEach(t => clearTimeout(t));
    this._removeTimers.clear();
    this.connections.forEach(c => c.close());
    if (this.peer) this.peer.destroy();
    this.peer = null;
    this.connections.clear();
    this.players = [];
  }
}

// ------------------------------------------------------------
// CLIENT: entra numa sala (joinRoom) ou reconecta (rejoinRoom).
// ------------------------------------------------------------
class CoupClient {
  constructor({ onConnected, onMessage, onDisconnect }) {
    this.peer = null;
    this.conn = null;
    this.roomCode = null;
    this.callbacks = { onConnected, onMessage, onDisconnect };
  }

  joinRoom(roomCode, playerName) {
    this._openConnection(roomCode, () => ({ type: 'join', name: playerName }));
  }

  /** Reabre conexão e manda `rejoin` pro host com o id anterior,
   *  pra recuperar o slot (cartas + moedas) se o grace period ainda valer. */
  rejoinRoom(roomCode, playerName, oldPlayerId) {
    this._openConnection(roomCode, () => ({ type: 'rejoin', oldPlayerId, name: playerName }));
  }

  _openConnection(roomCode, buildGreeting) {
    this.roomCode = roomCode.toUpperCase().trim();
    const hostPeerId = roomCodeToPeerId(this.roomCode);
    let opened = false;
    let failed = false;
    const fail = (msg) => {
      if (failed) return;
      failed = true;
      clearTimeout(this._connectTimer);
      UI.toast(msg);
      this.callbacks.onDisconnect?.();
    };

    this.peer = new Peer(undefined, { debug: 1 });

    // Se o host não responder em 15s (sala inexistente, rede bloqueada...), desiste
    this._connectTimer = setTimeout(() => {
      if (!opened && !this._destroyed) fail('Não foi possível conectar à sala. Confira o código e a internet.');
    }, 15000);

    this.peer.on('open', myId => {
      this.conn = this.peer.connect(hostPeerId, { reliable: true });

      this.conn.on('open', () => {
        opened = true;
        clearTimeout(this._connectTimer);
        this.conn.send(buildGreeting());
        this.callbacks.onConnected?.(myId);
      });

      this.conn.on('data', data => {
        this.callbacks.onMessage?.(data);
      });

      this.conn.on('close', () => {
        clearTimeout(this._connectTimer);
        if (failed || this._destroyed) return; // saída voluntária não gera "Desconectado"
        failed = true;
        this.callbacks.onDisconnect?.();
      });

      this.conn.on('error', err => {
        console.error('[client] conn error:', err);
        UI.toast('Erro ao conectar na sala.');
      });
    });

    this.peer.on('error', err => {
      console.error('[client] peer error:', err);
      if (this._destroyed) return;
      if (err.type === 'peer-unavailable') {
        fail('Sala não encontrada. Verifique o código.');
      } else if (!opened) {
        // network / server-error / socket-error / webrtc... antes de conectar
        fail('Falha de conexão com o servidor. Tente de novo em instantes.');
      }
    });
  }

  /** Envia mensagem ao host. */
  send(data) {
    if (this.conn && this.conn.open) {
      this.conn.send(data);
    }
  }

  /** Sai da sala avisando o host (pra ele não esperar 90s de grace period). */
  destroy() {
    this._destroyed = true;
    clearTimeout(this._connectTimer);
    const conn = this.conn, peer = this.peer;
    this.peer = null;
    this.conn = null;
    if (conn && conn.open) { try { conn.send({ type: 'leave' }); } catch (_) {} }
    // Pequeno atraso pra mensagem de saída ser entregue antes de fechar
    setTimeout(() => {
      try { if (conn) conn.close(); } catch (_) {}
      try { if (peer) peer.destroy(); } catch (_) {}
    }, 150);
  }
}

window.CoupHost = CoupHost;
window.CoupClient = CoupClient;
window.generateRoomCode = generateRoomCode;
window.sanitizeName = sanitizeName;
window.GRACE_PERIOD_MS = GRACE_PERIOD_MS;
