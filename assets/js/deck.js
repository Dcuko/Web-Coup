/* ================================================================
   deck.js - Baralho do Coup
   ================================================================
   Responsável por:
   - Definir os 5 personagens do jogo
   - Criar o baralho inicial (3 cartas de cada = 15 cartas)
   - Embaralhar, comprar e devolver cartas
   ================================================================ */

const CHARACTERS = {
  DUKE:       { id: 'duke',       name: 'Duque',      cssClass: 'card-duke',       image: 'assets/cards/duque.webp',      action: 'tax',          blocks: ['foreign-aid'] },
  ASSASSIN:   { id: 'assassin',   name: 'Assassino',  cssClass: 'card-assassin',   image: 'assets/cards/assassino.webp',  action: 'assassinate',  blocks: [] },
  CAPTAIN:    { id: 'captain',    name: 'Capitão',    cssClass: 'card-captain',    image: 'assets/cards/capitao.webp',    action: 'steal',        blocks: ['steal'] },
  AMBASSADOR: { id: 'ambassador', name: 'Embaixador', cssClass: 'card-ambassador', image: 'assets/cards/embaixador.webp', action: 'exchange',     blocks: ['steal'] },
  CONTESSA:   { id: 'contessa',   name: 'Condessa',   cssClass: 'card-contessa',   image: 'assets/cards/condessa.webp',   action: null,           blocks: ['assassinate'] }
};

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
