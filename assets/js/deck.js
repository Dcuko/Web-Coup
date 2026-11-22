/* ================================================================
   deck.js - Baralho do Coup
   ================================================================
   Responsável por:
   - Definir os 5 personagens do jogo
   - Criar o baralho inicial (3 cartas de cada = 15 cartas)
   - Embaralhar, comprar e devolver cartas
   ================================================================ */

const CHARACTERS = {
  DUKE:       { id: 'duke',       name: 'Duque',      cssClass: 'card-duke',       file: 'duque', action: 'tax',          blocks: ['foreign-aid'] },
  ASSASSIN:   { id: 'assassin',   name: 'Assassino',  cssClass: 'card-assassin',   file: 'assassino', action: 'assassinate',  blocks: [] },
  CAPTAIN:    { id: 'captain',    name: 'Capitão',    cssClass: 'card-captain',    file: 'capitao', action: 'steal',        blocks: ['steal'] },
  AMBASSADOR: { id: 'ambassador', name: 'Embaixador', cssClass: 'card-ambassador', file: 'embaixador', action: 'exchange',     blocks: ['steal'] },
  CONTESSA:   { id: 'contessa',   name: 'Condessa',   cssClass: 'card-contessa',   file: 'condessa', action: null,           blocks: ['assassinate'] }
};

/* ---------- Temas de carta ----------
   Cada tema é uma pasta em assets/cards/<id>/ com os 5 arquivos .webp
   (duque, assassino, capitao, embaixador, condessa). O padrão é o 'padrao'.
   Pra criar um tema novo: crie a pasta, coloque os 5 arquivos e registre aqui. */
const CARD_THEMES = {
  padrao:  { name: 'Padrão' },
  animais: { name: 'Animais' }
};
const DEFAULT_CARD_THEME = 'padrao';

const CardTheme = {
  get() {
    try {
      const t = localStorage.getItem('coup:cardTheme');
      if (t && CARD_THEMES[t]) return t;
    } catch (_) {}
    return DEFAULT_CARD_THEME;
  },
  set(id) {
    if (!CARD_THEMES[id]) return;
    try { localStorage.setItem('coup:cardTheme', id); } catch (_) {}
    CardTheme.applyToPage();
  },
  /** Atualiza imagens estáticas do HTML (modal de regras) que têm data-card. */
  applyToPage() {
    document.querySelectorAll('img[data-card]').forEach(img => {
      img.src = cardImage(img.dataset.card);
    });
  }
};

/** Caminho da imagem de um personagem ('duke', 'assassin'...) no tema atual. */
function cardImage(characterId) {
  const ch = CHARACTERS[String(characterId).toUpperCase()];
  return `assets/cards/${CardTheme.get()}/${ch.file}.webp`;
}

class Deck {
  constructor() {
    this.cards = [];
    this.reset();
  }

  /** Cria um baralho fresco com 3 cópias de cada personagem (15 cartas total). */
  reset() {
    this.cards = [];
    Object.values(CHARACTERS).forEach(character => {
      for (let i = 0; i < 3; i++) {
        this.cards.push(character.id);
      }
    });
    this.shuffle();
  }

  /** Embaralha o baralho (Fisher-Yates). */
  shuffle() {
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    }
  }

  /** Compra N cartas do topo. */
  draw(count = 1) {
    return this.cards.splice(0, count);
  }

  /** Devolve uma ou mais cartas ao baralho e embaralha. */
  returnCards(cards) {
    this.cards.push(...cards);
    this.shuffle();
  }

  /** Quantas cartas restam. */
  get size() {
    return this.cards.length;
  }
}

// Expor no escopo global (sem módulos ES pra evitar setup de build)
window.CHARACTERS = CHARACTERS;
window.Deck = Deck;
window.CARD_THEMES = CARD_THEMES;
window.CardTheme = CardTheme;
window.cardImage = cardImage;
window.addEventListener('DOMContentLoaded', () => CardTheme.applyToPage());
