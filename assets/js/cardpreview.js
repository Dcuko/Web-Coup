/* ================================================================
   cardpreview.js - Zoom da carta com o nome
   ================================================================
   - Desktop: passar o mouse sobre uma carta virada pra cima
   - Mobile: segurar o dedo (long-press) sobre a carta
   Qualquer elemento .card-placeholder.has-image com data-name serve
   (minhas cartas, reveladas dos oponentes, modais de perda/troca).
   ================================================================ */
(function () {
  const HOLD_MS = 350;
  const MOVE_TOLERANCE = 10;   // px — passou disso é scroll, não long-press
  let box, imgEl, nameEl;
  let holdTimer = null, startX = 0, startY = 0;
  let current = null, watchTimer = null;
  let lastTouchAt = 0;         // ignora mouse "fantasma" gerado por toque
  let suppressClickUntil = 0;  // long-press não pode virar clique (ex.: escolher carta)

  function ensureBox() {
    if (box) return;
    box = document.createElement('div');
    box.id = 'card-preview';
    box.setAttribute('aria-hidden', 'true');
    box.innerHTML = '<div class="card-preview-card"><div class="card-preview-img"></div><div class="card-preview-name"></div></div>';
    document.body.appendChild(box);
    imgEl = box.querySelector('.card-preview-img');
    nameEl = box.querySelector('.card-preview-name');
  }

  function cardFrom(target) {
    const el = target && target.closest ? target.closest('.card-placeholder.has-image') : null;
    return el && el.dataset.name ? el : null;
  }

  function show(el) {
    ensureBox();
    imgEl.style.backgroundImage = el.style.backgroundImage;
    nameEl.textContent = el.dataset.name;
    box.classList.add('show');
    current = el;
    // A mesa é redesenhada a cada jogada: se a carta sob o mouse sumiu do DOM, o
    // navegador não dispara mouseout — então vigiamos e fechamos o preview.
    clearInterval(watchTimer);
    watchTimer = setInterval(() => { if (!current || !document.contains(current)) hide(); }, 250);
  }

  function hide() {
    clearTimeout(holdTimer);
    holdTimer = null;
    clearInterval(watchTimer);
    watchTimer = null;
    current = null;
    if (box) box.classList.remove('show');
  }

  // ---- Desktop: hover ----
  document.addEventListener('mouseover', e => {
    if (Date.now() - lastTouchAt < 800) return;
    const el = cardFrom(e.target);
    if (el) show(el);
  });
  document.addEventListener('mouseout', e => {
    if (Date.now() - lastTouchAt < 800) return;
    if (cardFrom(e.target) && !cardFrom(e.relatedTarget)) hide();
    else if (cardFrom(e.target) && cardFrom(e.relatedTarget) !== cardFrom(e.target)) {
      const next = cardFrom(e.relatedTarget);
      if (next) show(next);
    }
  });

  // ---- Mobile: segurar ----
  document.addEventListener('touchstart', e => {
    lastTouchAt = Date.now();
    const el = cardFrom(e.target);
    if (!el || e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      show(el);
      suppressClickUntil = Number.MAX_SAFE_INTEGER; // até soltar o dedo
      if (navigator.vibrate) { try { navigator.vibrate(15); } catch (_) {} }
    }, HOLD_MS);
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!holdTimer && !(box && box.classList.contains('show'))) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - startX) > MOVE_TOLERANCE || Math.abs(t.clientY - startY) > MOVE_TOLERANCE) {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    }
  }, { passive: true });

  function endTouch() {
    lastTouchAt = Date.now();
    const wasShown = box && box.classList.contains('show');
    hide();
    // O toque que terminou um long-press não deve contar como clique na carta
    suppressClickUntil = wasShown ? Date.now() + 500 : 0;
  }
  document.addEventListener('touchend', endTouch);
  document.addEventListener('touchcancel', endTouch);

  document.addEventListener('click', e => {
    if (Date.now() < suppressClickUntil) {
      e.stopPropagation();
      e.preventDefault();
    } else if (Date.now() - lastTouchAt > 800) {
      hide(); // clique de mouse numa carta (ex.: escolher no modal) fecha o zoom
    }
  }, true);

  // Menu de "salvar imagem" do long-press no celular
  document.addEventListener('contextmenu', e => {
    if (cardFrom(e.target)) e.preventDefault();
  });

  // Se o modal/tela mudar enquanto o preview está aberto, fecha
  window.addEventListener('blur', hide);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
})();
