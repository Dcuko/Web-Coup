/* ================================================================
   game.js - Engine completo do Coup (Fase 3)
   ================================================================
   Gerencia turnos, ações, contestação, bloqueio e vitória.
   Todo o estado fica no HOST. Clients apenas enviam inputs.
   ================================================================ */

/* ---------- Definição das ações ---------- */
const ACTIONS = {
  'income':      { cost: 0, targetRequired: false, character: null,         blockableBy: [],                     challengeable: false },
  'foreign-aid': { cost: 0, targetRequired: false, character: null,         blockableBy: ['duke'],               challengeable: false },
  'coup':        { cost: 7, targetRequired: true,  character: null,         blockableBy: [],                     challengeable: false },
  'tax':         { cost: 0, targetRequired: false, character: 'duke',       blockableBy: [],                     challengeable: true  },
  'assassinate': { cost: 3, targetRequired: true,  character: 'assassin',   blockableBy: ['contessa'],           challengeable: true  },
  'steal':       { cost: 0, targetRequired: true,  character: 'captain',    blockableBy: ['captain','ambassador'], challengeable: true },
  'exchange':    { cost: 0, targetRequired: false, character: 'ambassador', blockableBy: [],                     challengeable: true  }
};

const ACTION_LABEL = {
  'income': 'Renda',
  'foreign-aid': 'Ajuda Externa',
  'coup': 'Golpe',
  'tax': 'Imposto (Duque)',
  'assassinate': 'Assassinar (Assassino)',
  'steal': 'Roubo (Capitão)',
  'exchange': 'Troca (Embaixador)'
};

/* ---------- Game Engine ---------- */
class GameEngine {
  constructor(onStateChange) {
    this.deck = new Deck();
    this.state = this._emptyState();
    this.onStateChange = onStateChange || (() => {});
  }

  _emptyState() {
    return {
      status: 'waiting',    // 'waiting' | 'playing' | 'ended'
      players: [],          // { id, name, coins, cards, revealed, alive }
      turnIndex: 0,
      phase: 'idle',        // idle | await-challenge | await-block | await-block-challenge | await-loss | await-exchange
      pending: null,        // dados da ação/bloqueio em resolução
      log: [],
      winner: null,
      version: 0            // incrementa a cada mudança pra forçar re-render
    };
  }

  /* =================================================================
     CICLO PRINCIPAL
     ================================================================= */

  startGame(playersList) {
    this.deck.reset();
    this.state = this._emptyState();
    this.state.status = 'playing';
    this.state.players = playersList.map(p => ({
      id: p.id,
      name: p.name,
      coins: 2,
      cards: this.deck.draw(2),
      revealed: [false, false],
      alive: true
    }));

    // Primeiro turno aleatório pra ser justo
    this.state.turnIndex = Math.floor(Math.random() * this.state.players.length);
    this.state.phase = 'action';
    this._log(`Partida iniciada! ${this._currentPlayer().name} começa.`);
    this._emit();
  }

  _currentPlayer() {
    return this.state.players[this.state.turnIndex];
  }

  _findPlayer(id) {
    return this.state.players.find(p => p.id === id);
  }

  _alivePlayers() {
    return this.state.players.filter(p => p.alive);
  }

  _log(msg) {
    this.state.log.push({ time: Date.now(), message: msg });
  }

  _emit() {
    this.state.version++;
    this.onStateChange(this.state);
  }

  /* =================================================================
     INPUT: JOGAR AÇÃO
     ================================================================= */

  playAction(playerId, actionType, targetId = null) {
    if (this.state.status !== 'playing') return { error: 'Jogo não está em andamento' };
    if (this.state.phase !== 'action') return { error: 'Não é hora de escolher ação' };
    const player = this._findPlayer(playerId);
    if (!player || !player.alive) return { error: 'Jogador inválido' };
    if (player.id !== this._currentPlayer().id) return { error: 'Não é seu turno' };

    const actionDef = ACTIONS[actionType];
    if (!actionDef) return { error: 'Ação inválida' };

    // Regra: com 10+ moedas, golpe é OBRIGATÓRIO
    if (player.coins >= 10 && actionType !== 'coup') {
      return { error: 'Com 10+ moedas, você DEVE dar um Golpe' };
    }
    if (player.coins < actionDef.cost) return { error: 'Moedas insuficientes' };

    // Valida alvo
    let target = null;
    if (actionDef.targetRequired) {
      target = this._findPlayer(targetId);
      if (!target || !target.alive || target.id === player.id) {
        return { error: 'Alvo inválido' };
      }
    }

    // Paga o custo IMEDIATAMENTE (válido mesmo se contestar/bloquear)
    player.coins -= actionDef.cost;

    this._log(`${player.name} declarou: ${ACTION_LABEL[actionType]}${target ? ` em ${target.name}` : ''}.`);

    // Ações que executam direto (sem contestação nem bloqueio)
    if (actionType === 'income') {
      player.coins += 1;
      this._log(`${player.name} ganhou 1 moeda (Renda).`);
      this._nextTurn();
      this._emit();
      return { ok: true };
    }

    if (actionType === 'coup') {
      // Alvo escolhe qual influência perder
      this.state.pending = { kind: 'action', type: 'coup', actorId: player.id, targetId: target.id };
      this._requestLoss(target.id, `${player.name} te golpeou — escolha uma carta pra perder.`);
      this._emit();
      return { ok: true };
    }

    // Ações contestáveis ou bloqueáveis: entra em "await-challenge" ou "await-block"
    this.state.pending = {
      kind: 'action',
      type: actionType,
      actorId: player.id,
      targetId: target ? target.id : null,
      responses: {},     // id -> 'pass' | 'challenge' | 'block'
      resolved: false
    };

    if (actionDef.challengeable) {
      this.state.phase = 'await-challenge';
    } else if (actionDef.blockableBy.length > 0) {
      this.state.phase = 'await-block';
    } else {
      // não deveria cair aqui, mas...
      this._executeAction();
      return { ok: true };
    }

    this._emit();
    return { ok: true };
  }

  /* =================================================================
     INPUT: PASSAR (não contesta / não bloqueia)
     ================================================================= */

  pass(playerId) {
    const phase = this.state.phase;
    const pending = this.state.pending;
    if (!pending) return { error: 'Nada pra passar' };

    // Quem pode responder
    const eligible = this._eligibleResponders();
    if (!eligible.includes(playerId)) return { error: 'Você não pode responder agora' };
    if (pending.responses[playerId]) return { error: 'Você já respondeu' };

    pending.responses[playerId] = 'pass';
    this._log(`${this._findPlayer(playerId).name} passou.`);

    // Quando todos passam, avança
    const allPassed = eligible.every(id => pending.responses[id] === 'pass');
    if (allPassed) {
      this._advanceAfterResponses();
    }
    this._emit();
    return { ok: true };
  }

  /* =================================================================
     INPUT: CONTESTAR
     ================================================================= */

  challenge(playerId) {
    const pending = this.state.pending;
    if (!pending) return { error: 'Nada pra contestar' };
    const eligible = this._eligibleResponders();
    if (!eligible.includes(playerId)) return { error: 'Você não pode contestar agora' };

    // Descobre quem fez a alegação e qual personagem foi alegado
    let claimerId, claimedCharacter, isBlockChallenge;
    if (this.state.phase === 'await-challenge') {
      claimerId = pending.actorId;
      claimedCharacter = ACTIONS[pending.type].character;
      isBlockChallenge = false;
    } else if (this.state.phase === 'await-block-challenge') {
      claimerId = pending.blockerId;
      claimedCharacter = pending.blockCharacter;
      isBlockChallenge = true;
    } else {
      return { error: 'Fase errada pra contestar' };
    }

    const claimer = this._findPlayer(claimerId);
    const challenger = this._findPlayer(playerId);

    this._log(`${challenger.name} contestou ${claimer.name}!`);

    // Verifica se o claimer REALMENTE tem a carta
    const hasCharacter = claimer.cards.some((c, i) => c === claimedCharacter && !claimer.revealed[i]);

    if (hasCharacter) {
      // Claimer tinha: contestador perde influência, claimer troca a carta
      this._log(`${claimer.name} tinha ${this._charName(claimedCharacter)} mesmo. ${challenger.name} perde uma influência.`);

      // Claimer revela e troca pela carta nova (antes de o contestador perder, conforme regra)
      const idx = claimer.cards.findIndex((c, i) => c === claimedCharacter && !claimer.revealed[i]);
      this.deck.returnCards([claimer.cards[idx]]);
      claimer.cards[idx] = this.deck.draw(1)[0];

      // Marca que o desafio foi resolvido favoravelmente ao claimer
      this.state.pending.challengeResolved = true;
      this.state.pending.challengeWinner = claimerId;

      this._requestLoss(challenger.id, 'Você contestou errado — escolha uma carta pra perder.',
        () => this._afterChallengeResolved(isBlockChallenge, true));
    } else {
      // Claimer blefou: perde influência e a ação (ou bloqueio) é cancelada
      this._log(`${claimer.name} estava blefando! Perde uma influência.`);
      this.state.pending.challengeResolved = true;
      this.state.pending.challengeWinner = challenger.id;

      this._requestLoss(claimer.id, 'Você foi pego no blefe — escolha uma carta pra perder.',
        () => this._afterChallengeResolved(isBlockChallenge, false));
    }

    this._emit();
    return { ok: true };
  }

  /* =================================================================
     INPUT: BLOQUEAR
     ================================================================= */

  block(playerId, character) {
    const pending = this.state.pending;
    if (!pending) return { error: 'Nada pra bloquear' };
    // Só dá pra bloquear na janela de bloqueio (a de contestação precisa fechar antes)
    if (this.state.phase !== 'await-block') return { error: 'Fase errada pra bloquear' };
    // Só quem está elegível (vivo e com direito de bloquear) pode bloquear
    if (!this._eligibleResponders().includes(playerId)) return { error: 'Você não pode bloquear agora' };

    const actionDef = ACTIONS[pending.type];
    if (!actionDef.blockableBy.includes(character)) {
      return { error: 'Essa ação não pode ser bloqueada por essa carta' };
    }

    // Quem pode bloquear:
    // - Ajuda Externa: qualquer jogador
    // - Assassinate/Steal: só o alvo
    if (pending.type === 'assassinate' || pending.type === 'steal') {
      if (playerId !== pending.targetId) return { error: 'Só o alvo pode bloquear' };
    }
    if (playerId === pending.actorId) return { error: 'Você não pode se bloquear' };

    const blocker = this._findPlayer(playerId);
    this._log(`${blocker.name} bloqueou com ${this._charName(character)}.`);

    // Pending vira bloqueio
    this.state.pending = {
      ...pending,
      kind: 'block',
      blockerId: playerId,
      blockCharacter: character,
      responses: {}  // resposta ao bloqueio (pass/challenge)
    };
    this.state.phase = 'await-block-challenge';
    this._emit();
    return { ok: true };
  }

  /* =================================================================
     INPUT: PERDER CARTA (escolher qual revelar)
     ================================================================= */

  loseCard(playerId, cardIndex) {
    if (this.state.phase !== 'await-loss') return { error: 'Não é hora de perder carta' };
    const pending = this.state.pending;
    if (!pending || pending.lossPlayerId !== playerId) return { error: 'Não é você quem escolhe' };

    const player = this._findPlayer(playerId);
    if (!Number.isInteger(cardIndex) || !player.cards[cardIndex] || player.revealed[cardIndex]) {
      return { error: 'Carta inválida' };
    }

    player.revealed[cardIndex] = true;
    this._log(`${player.name} revelou ${this._charName(player.cards[cardIndex])}.`);

    if (player.revealed.every(r => r)) {
      player.alive = false;
      this._log(`${player.name} foi eliminado!`);
    }

    // Checa vitória antes de tudo
    if (this._checkWinner()) { this._emit(); return { ok: true }; }

    // Callback registrado antes (resoluções de challenge)
    const cb = pending.afterLoss;
    if (cb) {
      // Remove só os campos de loss, mantém pending viva pra callback trabalhar
      delete pending.lossPlayerId;
      delete pending.lossMessage;
      delete pending.afterLoss;
      cb();
    } else {
      // Fim da sequência (coup, assassinato): limpa e passa turno
      this.state.pending = null;
      this.state.phase = 'idle';
      this._nextTurn();
    }

    this._emit();
    return { ok: true };
  }

  /* =================================================================
     INPUT: EMBAIXADOR — escolher quais cartas ficar
     ================================================================= */

  exchangeSelect(playerId, keepIndexes) {
    if (this.state.phase !== 'await-exchange') return { error: 'Não é hora de trocar' };
    const pending = this.state.pending;
    if (!pending || pending.exchangePlayerId !== playerId) return { error: 'Não é você quem troca' };
    if (!Array.isArray(keepIndexes)) return { error: 'Seleção inválida' };

    const player = this._findPlayer(playerId);
    const pool = pending.exchangePool; // 4 cartas (2 do jogador vivas + 2 do baralho)
    const aliveIdxs = player.cards
      .map((c, i) => player.revealed[i] ? null : i)
      .filter(i => i !== null);

    // Precisa manter exatamente a quantidade de cartas vivas
    if (keepIndexes.length !== aliveIdxs.length) return { error: 'Quantidade errada' };
    if (keepIndexes.some(i => !Number.isInteger(i) || i < 0 || i >= pool.length)) return { error: 'Índice inválido' };
    if (new Set(keepIndexes).size !== keepIndexes.length) return { error: 'Índices repetidos' };

    const kept = keepIndexes.map(i => pool[i]);
    const returned = pool.filter((_, i) => !keepIndexes.includes(i));

    // Atualiza cartas do jogador
    let k = 0;
    for (let i = 0; i < player.cards.length; i++) {
      if (!player.revealed[i]) {
        player.cards[i] = kept[k++];
      }
    }
    this.deck.returnCards(returned);

    this._log(`${player.name} fez a troca de cartas.`);
    this.state.pending = null;
    this.state.phase = 'idle';
    this._nextTurn();
    this._emit();
    return { ok: true };
  }

  /* =================================================================
     JOGADOR SAIU / CAIU DE VEZ: elimina e destrava o fluxo
     ================================================================= */

  forfeitPlayer(playerId) {
    if (this.state.status !== 'playing') return;
    const p = this._findPlayer(playerId);
    if (!p || !p.alive) return;

    const pending = this.state.pending;
    // Se estava no meio de uma troca, devolve ao baralho só as cartas sacadas
    if (pending && pending.kind === 'exchange' && pending.exchangePlayerId === playerId) {
      const aliveCount = p.revealed.filter(r => !r).length;
      this.deck.returnCards(pending.exchangePool.slice(aliveCount));
    }

    p.revealed = p.revealed.map(() => true);
    p.alive = false;
    this._log(`${p.name} saiu da partida e foi eliminado.`);

    if (this._checkWinner()) { this._emit(); return; }

    const wasCurrent = this._currentPlayer().id === playerId;
    const involved = pending && [pending.actorId, pending.targetId, pending.blockerId,
      pending.lossPlayerId, pending.exchangePlayerId].includes(playerId);

    if (wasCurrent || involved) {
      // O fluxo dependia dele: cancela e passa a vez
      this.state.pending = null;
      this.state.phase = 'idle';
      this._nextTurn();
    } else if (pending && pending.responses && this.state.phase.startsWith('await-') ) {
      // Era só um possível respondente: se os demais já passaram, avança
      const eligible = this._eligibleResponders();
      if (eligible.every(id => pending.responses[id] === 'pass')) this._advanceAfterResponses();
    }
    this._emit();
  }

  /* =================================================================
     RESOLUÇÕES INTERNAS
     ================================================================= */

  _eligibleResponders() {
    const pending = this.state.pending;
    if (!pending) return [];

    if (this.state.phase === 'await-challenge') {
      // Todos menos o ator
      return this._alivePlayers().filter(p => p.id !== pending.actorId).map(p => p.id);
    }
    if (this.state.phase === 'await-block') {
      // Pra ajuda externa: todos menos o ator. Pra assassinate/steal: só o alvo.
      if (pending.type === 'foreign-aid') {
        return this._alivePlayers().filter(p => p.id !== pending.actorId).map(p => p.id);
      }
      if (pending.type === 'assassinate' || pending.type === 'steal') {
        const t = this._findPlayer(pending.targetId);
        return t && t.alive ? [pending.targetId] : [];
      }
      return [];
    }
    if (this.state.phase === 'await-block-challenge') {
      // Todos menos o bloqueador (inclui o ator original)
      return this._alivePlayers().filter(p => p.id !== pending.blockerId).map(p => p.id);
    }
    return [];
  }

  _advanceAfterResponses() {
    const pending = this.state.pending;
    if (!pending) return;

    if (this.state.phase === 'await-challenge') {
      // Ninguém contestou. Se a ação é bloqueável, abre janela de bloqueio.
      const def = ACTIONS[pending.type];
      if (def.blockableBy.length > 0) {
        pending.responses = {};
        this.state.phase = 'await-block';
        this._log(`Ninguém contestou. Aguardando bloqueio...`);
        return;
      }
      // Senão, executa
      this._executeAction();
      return;
    }

    if (this.state.phase === 'await-block') {
      // Ninguém bloqueou. Executa.
      this._executeAction();
      return;
    }

    if (this.state.phase === 'await-block-challenge') {
      // Ninguém contestou o bloqueio. O bloqueio vigora — ação cancelada.
      this._log(`Ninguém contestou o bloqueio. ${ACTION_LABEL[pending.type]} foi bloqueada.`);
      this.state.pending = null;
      this.state.phase = 'idle';
      this._nextTurn();
      return;
    }
  }

  /** Se a ação tem alvo e ele já foi eliminado (ex.: perdeu a última carta
   *  numa contestação), a ação perde o sentido: cancela e passa o turno.
   *  Sem isso o jogo travava esperando resposta/carta de um jogador morto. */
  _cancelIfTargetGone() {
    const pending = this.state.pending;
    if (!pending || !pending.targetId) return false;
    const target = this._findPlayer(pending.targetId);
    if (target && target.alive) return false;
    this._log(`Alvo eliminado. ${ACTION_LABEL[pending.type]} cancelada.`);
    this.state.pending = null;
    this.state.phase = 'idle';
    this._nextTurn();
    return true;
  }

  _afterChallengeResolved(isBlockChallenge, claimerWon) {
    const pending = this.state.pending;
    if (!pending) return;

    if (!isBlockChallenge) {
      // Contestação foi da AÇÃO original
      if (claimerWon) {
        if (this._cancelIfTargetGone()) return;
        // Claimer (ator) tinha a carta. Agora ainda precisa passar por bloqueio se aplicável.
        const def = ACTIONS[pending.type];
        if (def.blockableBy.length > 0) {
          pending.responses = {};
          pending.challengeResolved = false; // reseta pra próxima fase
          this.state.phase = 'await-block';
          this._log(`Aguardando bloqueio...`);
        } else {
          this._executeAction();
        }
      } else {
        // Ator blefou. Ação cancelada e, pela regra oficial, o custo é devolvido
        // (só quando a ação cai por contestação; se for bloqueada, o custo fica pago).
        const refund = ACTIONS[pending.type].cost;
        if (refund > 0) {
          const actor = this._findPlayer(pending.actorId);
          actor.coins += refund;
          this._log(`${actor.name} recebeu de volta as ${refund} moedas.`);
        }
        this._log(`Ação cancelada.`);
        this.state.pending = null;
        this.state.phase = 'idle';
        this._nextTurn();
      }
    } else {
      // Contestação foi do BLOQUEIO
      if (claimerWon) {
        // Bloqueador tinha a carta. Ação é bloqueada.
        this._log(`Bloqueio confirmado. ${ACTION_LABEL[pending.type]} cancelada.`);
        this.state.pending = null;
        this.state.phase = 'idle';
        this._nextTurn();
      } else {
        // Bloqueador blefou. Ação procede.
        this._log(`Bloqueio inválido. ${ACTION_LABEL[pending.type]} prossegue!`);
        // Reconstrói pending pra executar a ação original
        this.state.pending = {
          kind: 'action',
          type: pending.type,
          actorId: pending.actorId,
          targetId: pending.targetId
        };
        this._executeAction();
      }
    }
    // (sem _emit aqui: quem chamou — loseCard/challenge — já emite em seguida)
  }

  _executeAction() {
    const pending = this.state.pending;
    if (!pending) return;
    if (this._cancelIfTargetGone()) return;
    const actor = this._findPlayer(pending.actorId);
    const target = pending.targetId ? this._findPlayer(pending.targetId) : null;

    switch (pending.type) {
      case 'foreign-aid':
        actor.coins += 2;
        this._log(`${actor.name} ganhou 2 moedas (Ajuda Externa).`);
        this.state.pending = null;
        this.state.phase = 'idle';
        this._nextTurn();
        break;

      case 'tax':
        actor.coins += 3;
        this._log(`${actor.name} ganhou 3 moedas (Imposto).`);
        this.state.pending = null;
        this.state.phase = 'idle';
        this._nextTurn();
        break;

      case 'assassinate':
        // Custo já foi pago em playAction
        this.state.pending = { ...pending, type: 'assassinate' };
        this._requestLoss(target.id, `${actor.name} te assassinou — escolha uma carta pra perder.`);
        break;

      case 'steal':
        const stolen = Math.min(2, target.coins);
        target.coins -= stolen;
        actor.coins += stolen;
        this._log(`${actor.name} roubou ${stolen} moeda(s) de ${target.name}.`);
        this.state.pending = null;
        this.state.phase = 'idle';
        this._nextTurn();
        break;

      case 'exchange':
        const drawn = this.deck.draw(2);
        // Monta pool com cartas vivas do jogador + 2 novas
        const pool = [];
        actor.cards.forEach((c, i) => { if (!actor.revealed[i]) pool.push(c); });
        pool.push(...drawn);
        this.state.pending = {
          kind: 'exchange',
          exchangePlayerId: actor.id,
          exchangePool: pool
        };
        this.state.phase = 'await-exchange';
        this._log(`${actor.name} está trocando cartas...`);
        break;
    }
  }

  _requestLoss(playerId, message, afterLoss = null) {
    const player = this._findPlayer(playerId);
    if (!player) return;

    // Jogador já eliminado (sem carta pra perder): segue o fluxo normal
    if (!player.alive) {
      if (afterLoss) afterLoss();
      else { this.state.pending = null; this.state.phase = 'idle'; this._nextTurn(); }
      return;
    }

    // Se só tem 1 carta viva, auto-revela
    const aliveIdxs = player.cards
      .map((_, i) => player.revealed[i] ? null : i)
      .filter(i => i !== null);

    if (aliveIdxs.length === 1) {
      player.revealed[aliveIdxs[0]] = true;
      this._log(`${player.name} revelou ${this._charName(player.cards[aliveIdxs[0]])} (única restante).`);
      if (player.revealed.every(r => r)) {
        player.alive = false;
        this._log(`${player.name} foi eliminado!`);
      }
      if (this._checkWinner()) return;
      if (afterLoss) {
        afterLoss();
      } else {
        this.state.pending = null;
        this.state.phase = 'idle';
        this._nextTurn();
      }
      return;
    }

    // Mais de uma carta viva: jogador precisa escolher qual perder
    this.state.pending = {
      ...(this.state.pending || {}),
      lossPlayerId: playerId,
      lossMessage: message,
      afterLoss: afterLoss
    };
    this.state.phase = 'await-loss';
  }

  _nextTurn() {
    if (this._checkWinner()) return;

    const alive = this._alivePlayers();
    if (alive.length <= 1) return;

    // Avança pro próximo vivo
    let next = this.state.turnIndex;
    for (let i = 0; i < this.state.players.length; i++) {
      next = (next + 1) % this.state.players.length;
      if (this.state.players[next].alive) break;
    }
    this.state.turnIndex = next;
    this.state.phase = 'action';
    this.state.pending = null;
    this._log(`— Vez de ${this._currentPlayer().name} —`);
  }

  _checkWinner() {
    const alive = this._alivePlayers();
    if (alive.length === 1 && this.state.status === 'playing') {
      this.state.status = 'ended';
      this.state.winner = alive[0].id;
      this.state.phase = 'ended';
      this._log(`🏆 ${alive[0].name} venceu a partida!`);
      return true;
    }
    return false;
  }

  _charName(id) {
    const c = CHARACTERS[id?.toUpperCase()];
    return c ? c.name : id;
  }

  /* =================================================================
     ESTADO SANITIZADO POR JOGADOR
     ================================================================= */

  getStateFor(playerId) {
    const s = JSON.parse(JSON.stringify(this.state));
    // Oculta cartas dos outros (exceto reveladas)
    s.players = s.players.map(p => {
      if (p.id === playerId) return p;
      return {
        ...p,
        cards: p.cards.map((c, i) => p.revealed[i] ? c : null)
      };
    });
    // Adiciona campo derivado: quem sou eu
    s.you = playerId;
    // Exchange pool só mostra pro dono
    if (s.pending && s.pending.kind === 'exchange' && s.pending.exchangePlayerId !== playerId) {
      s.pending = { ...s.pending, exchangePool: null };
    }
    // Responders elegíveis pro UI saber se mostra botões
    s.eligibleResponders = this._eligibleResponders();
    s.currentPlayerId = this._currentPlayer()?.id || null;
    return s;
  }
}

window.ACTIONS = ACTIONS;
window.ACTION_LABEL = ACTION_LABEL;
window.GameEngine = GameEngine;
