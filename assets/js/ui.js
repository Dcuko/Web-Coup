/* ================================================================
   ui.js - Renderização e utilitários de interface (Fase 3)
   ================================================================ */

const UI = {
  screens: ['home', 'create', 'join', 'lobby', 'game'],
  _prevState: null,     // último state renderizado (p/ detectar deltas)
  _prevMyId: null,

  /** Matiz (0-359) estável a partir do nome — cada jogador ganha sua cor. */
  _hue(str) {
    let h = 0;
    for (const ch of String(str)) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  },

  _avatar(name) {
    const initial = escapeHTML((String(name).trim()[0] || '?').toUpperCase());
    return `<span class="avatar" style="--hue:${UI._hue(name)}">${initial}</span>`;
  },

  showScreen(name) {
    UI.screens.forEach(s => {
      const el = document.getElementById(`screen-${s}`);
      if (!el) return;
      el.classList.toggle('hidden', s !== name);
    });
    window.scrollTo(0, 0);
  },

  toast(message, duration = 2500) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(UI._toastTimer);
    UI._toastTimer = setTimeout(() => el.classList.add('hidden'), duration);
  },

  // ---------- Lobby ----------
  renderLobby(roomCode, players, isHost) {
    document.getElementById('lobby-room-code').textContent = roomCode;

    const ul = document.getElementById('lobby-players');
    ul.innerHTML = '';
    players.forEach(p => {
      const li = document.createElement('li');
      li.className = 'lobby-player-item';
      if (p.disconnected) li.classList.add('opacity-50');
      const badges = [];
      if (p.isHost) badges.push('<span class="host-badge">HOST</span>');
      if (p.disconnected) badges.push('<span class="reconnect-badge" title="Reconectando...">🔌</span>');
      const kickBtn = (isHost && !p.isHost)
        ? `<button class="kick-btn" data-action="kick-player" data-peer-id="${escapeHTML(p.id)}" data-player-name="${escapeHTML(p.name)}" title="Remover ${escapeHTML(p.name)}">×</button>`
        : '';
      li.innerHTML = `
        ${UI._avatar(p.name)}
        <span class="lp-name">${escapeHTML(p.name)}</span>
        <span class="lobby-player-right">${badges.join(' ')}${kickBtn}</span>
      `;
      ul.appendChild(li);
    });

    document.getElementById('lobby-host-controls').classList.toggle('hidden', !isHost);
    document.getElementById('lobby-guest-waiting').classList.toggle('hidden', isHost);

    const startBtn = document.querySelector('[data-action="start-game"]');
    if (startBtn) startBtn.disabled = players.filter(p => !p.disconnected).length < 2;
  },

  // ---------- Tela de jogo ----------
  renderGame(state, myPlayerId, roomCode) {
    document.getElementById('game-room-code').textContent = roomCode || '—';

    const me = state.players.find(p => p.id === myPlayerId);
    const opponents = state.players.filter(p => p.id !== myPlayerId);
    const current = state.players.find(p => p.id === state.currentPlayerId);
    document.getElementById('game-current-turn').textContent = current ? current.name : '—';

    // Detectar deltas e tocar sons/animações ANTES de re-renderizar
    UI._detectDeltas(state, myPlayerId);

    if (me) {
      document.getElementById('game-my-name').textContent = me.name + (!me.alive ? ' (ELIMINADO)' : '');
      document.getElementById('game-my-coins').textContent = me.coins;
      UI._renderMyCards(me);
    }

    UI._renderOpponents(opponents, state.currentPlayerId);
    UI._renderLog(state.log);

    // Banner de fase + botões
    UI._renderPhaseBanner(state, myPlayerId);
    UI._renderActionButtons(state, myPlayerId, me);
    UI._renderResponseButtons(state, myPlayerId);

    // Modais
    UI._handleLossModal(state, myPlayerId);
    UI._handleExchangeModal(state, myPlayerId);
    UI._handleEndModal(state);

    // Timer por jogada (visual-only, se configurado)
    UI._handleTurnTimer(state, myPlayerId);

    // Timer visual de auto-pass (10s) em fases de contestação/bloqueio
    UI._handleAutoPassBar(state);

    // Guarda pra próxima comparação
    UI._prevState = UI._cloneState(state);
    UI._prevMyId = myPlayerId;
  },

  _autoPassBar: { handle: null, key: null, startedAt: 0 },

  _handleAutoPassBar(state) {
    const bar = document.getElementById('auto-pass-bar');
    if (!bar) return;
    const fill = document.getElementById('auto-pass-fill');
    const label = document.getElementById('auto-pass-label');
    const AUTO_PHASES = ['await-challenge', 'await-block', 'await-block-challenge'];
    const active = AUTO_PHASES.includes(state.phase) && state.status === 'playing';
    const pending = state.pending || {};
    const key = active ? `${state.phase}|${pending.actorId || ''}|${pending.type || ''}|${pending.blockerId || ''}` : null;

    if (!active) {
      if (UI._autoPassBar.handle) { clearInterval(UI._autoPassBar.handle); UI._autoPassBar.handle = null; }
      bar.classList.add('hidden');
      return;
    }
    bar.classList.remove('hidden');

    if (UI._autoPassBar.key !== key) {
      UI._autoPassBar.key = key;
      UI._autoPassBar.startedAt = Date.now();
      if (UI._autoPassBar.handle) clearInterval(UI._autoPassBar.handle);
      UI._autoPassBar.handle = setInterval(() => {
        const elapsed = Date.now() - UI._autoPassBar.startedAt;
        const total = (window.CoupApp && CoupApp.AUTO_PASS_MS) || 10000;
        const remaining = Math.max(0, total - elapsed);
        const pct = (remaining / total) * 100;
        if (fill) fill.style.width = pct + '%';
        if (label) label.textContent = Math.ceil(remaining / 1000) + 's';
        if (remaining <= 0) { clearInterval(UI._autoPassBar.handle); UI._autoPassBar.handle = null; }
      }, 150);
      const total = (window.CoupApp && CoupApp.AUTO_PASS_MS) || 20000;
      if (fill) fill.style.width = '100%';
      if (label) label.textContent = Math.round(total / 1000) + 's';
    }
  },

  _cloneState(state) {
    return {
      phase: state.phase,
      status: state.status,
      currentPlayerId: state.currentPlayerId,
      winner: state.winner,
      pendingType: state.pending ? state.pending.type : null,
      pendingActor: state.pending ? state.pending.actorId : null,
      players: state.players.map(p => ({
        id: p.id, coins: p.coins, alive: p.alive,
        revealed: [...(p.revealed || [])]
      })),
      logLen: (state.log || []).length
    };
  },

  _detectDeltas(newState, myId) {
    const prev = UI._prevState;
    if (!prev) return; // primeiro render — sem comparação

    // Moedas minhas subiram?
    const prevMe = prev.players.find(p => p.id === myId);
    const me = newState.players.find(p => p.id === myId);
    if (prevMe && me && me.coins > prevMe.coins) {
      Sounds.coin();
      const el = document.getElementById('game-my-coins');
      el.classList.remove('coin-pulse'); void el.offsetWidth; el.classList.add('coin-pulse');
    }

    // Alguém revelou (perdeu) uma carta?
    newState.players.forEach(p => {
      const old = prev.players.find(o => o.id === p.id);
      if (!old) return;
      (p.revealed || []).forEach((rev, i) => {
        if (rev && !old.revealed[i]) {
          // Carta acabou de ser revelada
          Sounds.flip();
          setTimeout(() => Sounds.eliminate(), 120);
          UI._shakePlayer(p.id === myId, i);
        }
      });
      // Eliminação (todas as cartas reveladas)
      if (old.alive && !p.alive) {
        setTimeout(() => Sounds.eliminate(), 180);
      }
    });

    // Mudança de turno
    if (prev.currentPlayerId && newState.currentPlayerId && prev.currentPlayerId !== newState.currentPlayerId) {
      Sounds.tick();
    }

    // Alguém precisa responder (await-challenge ou await-block) agora
    const pendingTypeChanged = prev.pendingType !== (newState.pending ? newState.pending.type : null);
    const phaseChanged = prev.phase !== newState.phase;
    if (phaseChanged && (newState.phase === 'await-challenge' || newState.phase === 'await-block' || newState.phase === 'await-block-challenge')) {
      // Só alerta se eu preciso responder
      const eligible = newState.eligibleResponders || [];
      if (eligible.includes(myId)) Sounds.alert();
    }

    // Log novo — detectar entradas novas e classificar
    const newLog = newState.log || [];
    const delta = newLog.length - prev.logLen;
    if (delta > 0) {
      const fresh = newLog.slice(-delta);
      fresh.forEach(entry => {
        const msg = (entry.message || '').toLowerCase();
        if (msg.includes('contestou') || msg.includes('contestação')) Sounds.challenge();
        else if (msg.includes('bloque')) Sounds.block();
      });
    }

    // Vitória
    if (!prev.winner && newState.winner) {
      setTimeout(() => Sounds.victory(), 300);
    }
  },

  _shakePlayer(isMe, cardIndex) {
    if (isMe) {
      const el = document.getElementById(`game-my-card-${cardIndex + 1}`);
      if (el) { el.classList.remove('shake','flip'); void el.offsetWidth; el.classList.add('flip','shake'); }
    } else {
      // Shake no card do oponente: faz em todos, fica simples
      document.querySelectorAll('#game-opponents .opponent-card').forEach(el => {
        el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
      });
    }
  },

  // ---------- Timer visual por jogada ----------
  _turnTimer: { handle: null, startedAt: 0, duration: 0, warned: false },

  _handleTurnTimer(state, myId) {
    const bar = document.getElementById('turn-timer');
    const fill = document.getElementById('turn-timer-fill');
    const cfg = window.CoupApp && CoupApp.timerSeconds ? CoupApp.timerSeconds : 0;

    const shouldRun = cfg > 0 && state.phase === 'action' && state.status === 'playing';

    // Resetar se virou outro turno ou fase
    const key = `${state.currentPlayerId}|${state.phase}`;
    if (UI._turnTimer.key !== key) {
      UI._turnTimer.key = key;
      UI._turnTimer.startedAt = Date.now();
      UI._turnTimer.duration = cfg * 1000;
      UI._turnTimer.warned = false;
      bar.classList.remove('warning');
      if (UI._turnTimer.handle) clearInterval(UI._turnTimer.handle);
      UI._turnTimer.handle = null;
    }

    if (!shouldRun) {
      bar.classList.add('hidden');
      if (UI._turnTimer.handle) { clearInterval(UI._turnTimer.handle); UI._turnTimer.handle = null; }
      return;
    }

    bar.classList.remove('hidden');
    if (!UI._turnTimer.handle) {
      UI._turnTimer.handle = setInterval(() => {
        const elapsed = Date.now() - UI._turnTimer.startedAt;
        const remaining = Math.max(0, UI._turnTimer.duration - elapsed);
        const pct = (remaining / UI._turnTimer.duration) * 100;
        fill.style.width = pct + '%';
        if (remaining < 5000 && !UI._turnTimer.warned) {
          UI._turnTimer.warned = true;
          bar.classList.add('warning');
        }
        if (remaining <= 0) {
          clearInterval(UI._turnTimer.handle);
          UI._turnTimer.handle = null;
        }
      }, 150);
    }
  },

  _renderMyCards(me) {
    const slots = [
      document.getElementById('game-my-card-1'),
      document.getElementById('game-my-card-2')
    ];
    slots.forEach((slot, i) => {
      const cardId = me.cards[i];
      slot.className = 'card-placeholder';
      slot.style.backgroundImage = '';
      slot.innerHTML = '';
      slot.style.filter = '';
      if (!cardId) {
        slot.textContent = '—';
        slot.style.opacity = '0.3';
        return;
      }
      slot.style.opacity = me.revealed[i] ? '0.55' : '1';
      const ch = CHARACTERS[cardId.toUpperCase()];
      slot.classList.add('revealed', 'has-image', ch.cssClass);
      slot.style.backgroundImage = `url('${cardImage(ch.id)}')`;
      slot.dataset.name = ch.name; slot.setAttribute('aria-label', ch.name);
      if (me.revealed[i]) slot.style.filter = 'grayscale(1)';
    });
  },

  _renderOpponents(opponents, currentId) {
    const ul = document.getElementById('game-opponents');
    ul.innerHTML = '';
    if (opponents.length === 0) {
      ul.innerHTML = '<li class="seat-note">Sem oponentes.</li>';
      return;
    }
    opponents.forEach(opp => {
      const li = document.createElement('li');
      li.className = 'opponent-card';
      if (opp.id === currentId) li.classList.add('current-turn');
      if (!opp.alive) li.classList.add('eliminated');
      if (opp.disconnected) li.classList.add('disconnected');

      const cardsHTML = opp.cards.map((c, i) => {
        if (opp.revealed[i] && c) {
          const ch = CHARACTERS[c.toUpperCase()];
          return `<div class="card-placeholder card-opponent revealed has-image ${ch.cssClass}" style="background-image:url('${cardImage(ch.id)}');filter:grayscale(1);opacity:.55" data-name="${escapeHTML(ch.name)}" aria-label="${escapeHTML(ch.name)}"></div>`;
        }
        return `<div class="card-placeholder card-opponent"></div>`;
      }).join('');

      const statusBadge = !opp.alive ? ' ☠️' : (opp.disconnected ? ' 🔌' : '');
      li.innerHTML = `
        <div class="seat-head">
          ${UI._avatar(opp.name)}
          <span class="seat-name">${escapeHTML(opp.name)}${statusBadge}</span>
          <span class="coin-chip" title="Moedas"><i class="coin"></i>${opp.coins}</span>
        </div>
        <div class="seat-cards">${cardsHTML}</div>
        ${opp.disconnected ? '<p class="seat-note">Reconectando…</p>' : ''}
      `;
      ul.appendChild(li);
    });
  },

  _renderLog(logEntries) {
    const box = document.getElementById('game-log');
    const prevLen = UI._prevState ? UI._prevState.logLen : 0;
    box.innerHTML = '';
    if (!logEntries || logEntries.length === 0) {
      box.innerHTML = '<p class="muted-line">Sem eventos.</p>';
      return;
    }
    const slice = logEntries.slice(-60);
    const newStart = slice.length - Math.max(0, logEntries.length - prevLen);
    slice.forEach((entry, idx) => {
      const p = document.createElement('p');
      p.textContent = entry.message;
      // classificar por palavras-chave pra colorir
      const msg = (entry.message || '').toLowerCase();
      const isDanger = msg.includes('venceu') || msg.includes('eliminad') ||
                       msg.includes('revelou') || msg.includes('perdeu influência') ||
                       msg.includes('perdeu a') || msg.includes('assassin');
      if (isDanger) {
        p.classList.add('log-danger');
      } else if (msg.includes('bloque')) {
        p.classList.add('log-block');
      } else if (msg.includes('contestou') || msg.includes('declarou') || msg.includes('contestação')) {
        p.classList.add('log-important');
      }
      if (idx >= newStart) p.classList.add('log-new');
      box.appendChild(p);
    });
    box.scrollTop = box.scrollHeight;
  },

  _renderPhaseBanner(state, myId) {
    const banner = document.getElementById('game-phase-banner');
    const pending = state.pending;

    if (state.phase === 'action') {
      const current = state.players.find(p => p.id === state.currentPlayerId);
      if (current && current.id === myId) {
        banner.textContent = 'Sua vez — escolha uma ação';
      } else {
        banner.textContent = `Vez de ${current ? current.name : '...'}`;
      }
      banner.classList.remove('hidden');
      return;
    }

    if (state.phase === 'await-challenge' && pending) {
      const actor = state.players.find(p => p.id === pending.actorId);
      const target = pending.targetId ? state.players.find(p => p.id === pending.targetId) : null;
      banner.textContent = `${actor.name} declarou ${ACTION_LABEL[pending.type]}${target ? ` em ${target.name}` : ''}. Aguardando respostas...`;
      banner.classList.remove('hidden');
      return;
    }

    if (state.phase === 'await-block' && pending) {
      const actor = state.players.find(p => p.id === pending.actorId);
      banner.textContent = `${actor.name} vai fazer ${ACTION_LABEL[pending.type]}. Alguém quer bloquear?`;
      banner.classList.remove('hidden');
      return;
    }

    if (state.phase === 'await-block-challenge' && pending) {
      const blocker = state.players.find(p => p.id === pending.blockerId);
      banner.textContent = `${blocker.name} declarou bloqueio com ${UI._charName(pending.blockCharacter)}. Contestar?`;
      banner.classList.remove('hidden');
      return;
    }

    if (state.phase === 'await-loss' && pending) {
      const p = state.players.find(pl => pl.id === pending.lossPlayerId);
      banner.textContent = `Aguardando ${p ? p.name : '...'} escolher carta pra perder.`;
      banner.classList.remove('hidden');
      return;
    }

    if (state.phase === 'await-exchange' && pending) {
      const p = state.players.find(pl => pl.id === pending.exchangePlayerId);
      banner.textContent = `Aguardando ${p ? p.name : '...'} trocar cartas.`;
      banner.classList.remove('hidden');
      return;
    }

    if (state.phase === 'ended') {
      banner.classList.add('hidden');
      return;
    }

    banner.classList.add('hidden');
  },

  _renderActionButtons(state, myId, me) {
    const panel = document.getElementById('game-actions');
    const isMyTurn = me && me.alive && state.currentPlayerId === myId && state.phase === 'action';
    panel.classList.toggle('hidden', !isMyTurn);

    if (!isMyTurn) return;

    const forceCoup = me.coins >= 10;
    panel.querySelectorAll('button[data-game-action]').forEach(btn => {
      const act = btn.dataset.gameAction;
      let disabled = false;
      if (forceCoup && act !== 'coup') disabled = true;
      if (me.coins < (ACTIONS[act]?.cost || 0)) disabled = true;
      btn.disabled = disabled;
      btn.classList.toggle('opacity-40', disabled);
    });
  },

  _renderResponseButtons(state, myId) {
    const panel = document.getElementById('game-response');
    panel.innerHTML = '';
    panel.classList.add('hidden');

    if (!state.pending) return;
    const eligible = state.eligibleResponders || [];
    if (!eligible.includes(myId)) return;
    const alreadyResponded = state.pending.responses && state.pending.responses[myId];
    if (alreadyResponded) {
      panel.classList.remove('hidden');
      panel.innerHTML = '<p class="text-sm text-gray-400 italic py-2">Aguardando os outros jogadores...</p>';
      return;
    }

    // Em await-challenge: pode Contestar ou Passar
    if (state.phase === 'await-challenge') {
      panel.appendChild(UI._makeBtn('Contestar', 'btn-response btn-response-challenge', () => CoupApp.sendResponse('challenge')));
      panel.appendChild(UI._makeBtn('Passar', 'btn-response btn-response-pass', () => CoupApp.sendResponse('pass')));
      panel.classList.remove('hidden');
      panel.classList.add('flex');
      return;
    }

    // Em await-block: pode Bloquear (se tiver carta válida) ou Passar
    if (state.phase === 'await-block') {
      const def = ACTIONS[state.pending.type];
      def.blockableBy.forEach(chId => {
        const ch = CHARACTERS[chId.toUpperCase()];
        panel.appendChild(UI._makeBtn(`Bloquear com ${ch.name}`, 'btn-response btn-response-block', () => CoupApp.sendResponse('block', chId)));
      });
      panel.appendChild(UI._makeBtn('Passar', 'btn-response btn-response-pass', () => CoupApp.sendResponse('pass')));
      panel.classList.remove('hidden');
      panel.classList.add('flex');
      return;
    }

    // Em await-block-challenge: pode Contestar o bloqueio ou Passar
    if (state.phase === 'await-block-challenge') {
      panel.appendChild(UI._makeBtn('Contestar bloqueio', 'btn-response btn-response-challenge', () => CoupApp.sendResponse('challenge')));
      panel.appendChild(UI._makeBtn('Passar', 'btn-response btn-response-pass', () => CoupApp.sendResponse('pass')));
      panel.classList.remove('hidden');
      panel.classList.add('flex');
      return;
    }
  },

  _makeBtn(label, cls, onClick) {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.onclick = onClick;
    return b;
  },

  // ---------- Modal de alvo ----------
  showTargetPicker(title, players, onPick) {
    const modal = document.getElementById('modal-target');
    document.getElementById('modal-target-title').textContent = title;
    const list = document.getElementById('modal-target-list');
    list.innerHTML = '';
    players.forEach(p => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'target-btn';
      btn.innerHTML = `
        <span class="t-who">${UI._avatar(p.name)}${escapeHTML(p.name)}</span>
        <span class="coin-chip"><i class="coin"></i>${p.coins}</span>
      `;
      btn.onclick = () => {
        modal.classList.add('hidden');
        onPick(p.id);
      };
      li.appendChild(btn);
      list.appendChild(li);
    });
    modal.classList.remove('hidden');
  },

  hideTargetPicker() {
    document.getElementById('modal-target').classList.add('hidden');
  },

  // ---------- Modal de perder carta ----------
  _handleLossModal(state, myId) {
    const modal = document.getElementById('modal-lose');
    if (state.phase === 'await-loss' && state.pending && state.pending.lossPlayerId === myId) {
      const me = state.players.find(p => p.id === myId);
      // Já escolhi e o host ainda não respondeu: não reabre o modal com estado velho
      const lossKey = `${state.pending.lossMessage}|${me.revealed.join()}`;
      if (UI._lossDone === lossKey) { modal.classList.add('hidden'); return; }
      document.getElementById('modal-lose-reason').textContent = state.pending.lossMessage || '';
      const holder = document.getElementById('modal-lose-cards');
      holder.innerHTML = '';
      me.cards.forEach((c, i) => {
        if (me.revealed[i] || !c) return;
        const ch = CHARACTERS[c.toUpperCase()];
        const div = document.createElement('div');
        div.className = `card-placeholder card-select revealed has-image ${ch.cssClass}`;
        div.style.backgroundImage = `url('${cardImage(ch.id)}')`;
        div.dataset.name = ch.name; div.setAttribute('aria-label', ch.name);
        const label = document.createElement('span');
        label.className = 'card-name-label';
        label.textContent = ch.name;
        div.appendChild(label);
        div.onclick = () => {
          UI._lossDone = lossKey;
          modal.classList.add('hidden');
          CoupApp.sendLoseCard(i);
        };
        holder.appendChild(div);
      });
      modal.classList.remove('hidden');
    } else {
      UI._lossDone = null;
      modal.classList.add('hidden');
    }
  },

  // ---------- Modal de exchange ----------
  _handleExchangeModal(state, myId) {
    const modal = document.getElementById('modal-exchange');
    if (state.phase === 'await-exchange' && state.pending && state.pending.exchangePlayerId === myId) {
      const me = state.players.find(p => p.id === myId);
      const aliveCount = me.revealed.filter(r => !r).length;
      // Não reconstrói o modal (perderia a seleção) se nada mudou, nem reabre depois de confirmar
      const exKey = (state.pending.exchangePool || []).join(',') + '|' + aliveCount;
      if (UI._exchangeDone === exKey) { modal.classList.add('hidden'); return; }
      if (UI._exchangeKey === exKey && !modal.classList.contains('hidden')) return;
      UI._exchangeKey = exKey;
      document.getElementById('modal-exchange-hint').textContent =
        `Escolha ${aliveCount} carta(s) pra ficar. As outras voltam pro baralho.`;

      const pool = state.pending.exchangePool || [];
      const holder = document.getElementById('modal-exchange-cards');
      holder.innerHTML = '';
      const selected = new Set();

      pool.forEach((cardId, i) => {
        const ch = CHARACTERS[cardId.toUpperCase()];
        const div = document.createElement('div');
        div.className = `card-placeholder card-select revealed has-image ${ch.cssClass}`;
        div.style.backgroundImage = `url('${cardImage(ch.id)}')`;
        div.dataset.name = ch.name; div.setAttribute('aria-label', ch.name);
        const label = document.createElement('span');
        label.className = 'card-name-label';
        label.textContent = ch.name;
        div.appendChild(label);
        div.dataset.index = i;
        div.onclick = () => {
          if (selected.has(i)) {
            selected.delete(i);
            div.classList.remove('selected');
          } else {
            if (selected.size >= aliveCount) {
              // Desseleciona a primeira (comportamento LIFO)
              const first = Array.from(selected)[0];
              selected.delete(first);
              holder.querySelector(`[data-index="${first}"]`)?.classList.remove('selected');
            }
            selected.add(i);
            div.classList.add('selected');
          }
          document.getElementById('modal-exchange-confirm').disabled = selected.size !== aliveCount;
        };
        holder.appendChild(div);
      });

      const confirmBtn = document.getElementById('modal-exchange-confirm');
      confirmBtn.disabled = true;
      confirmBtn.onclick = () => {
        if (selected.size !== aliveCount) return;
        UI._exchangeDone = exKey;
        modal.classList.add('hidden');
        CoupApp.sendExchange(Array.from(selected));
      };

      modal.classList.remove('hidden');
    } else {
      UI._exchangeKey = null;
      UI._exchangeDone = null;
      modal.classList.add('hidden');
    }
  },

  // ---------- Modal de fim ----------
  _handleEndModal(state) {
    const modal = document.getElementById('modal-end');
    if (state.status === 'ended' && state.winner) {
      const w = state.players.find(p => p.id === state.winner);
      document.getElementById('modal-end-winner').textContent = w ? w.name : '?';
      modal.classList.remove('hidden');
    } else {
      modal.classList.add('hidden');
    }
  },

  _charName(id) {
    const c = CHARACTERS[id?.toUpperCase()];
    return c ? c.name : id;
  }
};

function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, s => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[s]);
}

window.UI = UI;
