/* ================================================================
   sounds.js - Áudio procedural via Web Audio API (Fase 4)
   ================================================================
   - Sem arquivos de áudio: tudo gerado em tempo real
   - Sons: coin, flip, click, challenge, block, eliminate, victory,
           turnTick, alert
   - Desligado por padrão até o primeiro gesto do usuário (política
     de autoplay dos navegadores modernos)
   ================================================================ */

const Sounds = {
  enabled: true,
  _ctx: null,
  _unlocked: false,
  _muted: false,

  init() {
    // Carrega preferência salva
    try {
      const pref = localStorage.getItem('coup:muted');
      if (pref === '1') Sounds._muted = true;
    } catch (e) { /* localStorage pode estar indisponível */ }

    // Destrava o AudioContext no primeiro gesto do usuário
    const unlock = () => {
      if (Sounds._unlocked) return;
      try {
        Sounds._ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (Sounds._ctx.state === 'suspended') Sounds._ctx.resume();
        Sounds._unlocked = true;
      } catch (e) {
        console.warn('[sounds] Web Audio indisponível', e);
        Sounds.enabled = false;
      }
      document.removeEventListener('click', unlock);
      document.removeEventListener('touchstart', unlock);
      document.removeEventListener('keydown', unlock);
    };
    document.addEventListener('click', unlock, { once: false });
    document.addEventListener('touchstart', unlock, { once: false });
    document.addEventListener('keydown', unlock, { once: false });
  },

  toggleMute() {
    Sounds._muted = !Sounds._muted;
    try { localStorage.setItem('coup:muted', Sounds._muted ? '1' : '0'); } catch (e) {}
    return Sounds._muted;
  },

  isMuted() { return Sounds._muted; },

  // ------------- primitivas -------------

  _beep({ freq = 440, dur = 0.15, type = 'sine', gain = 0.15, attack = 0.005, release = 0.08, freqEnd = null, delay = 0 } = {}) {
    if (!Sounds.enabled || Sounds._muted || !Sounds._ctx) return;
    const ctx = Sounds._ctx;
    if (ctx.state === 'suspended') ctx.resume();
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freqEnd !== null) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 20), t0 + dur);
    }
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + attack);
    g.gain.linearRampToValueAtTime(0, t0 + dur + release);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + release + 0.02);
  },

  _noise({ dur = 0.1, gain = 0.08, delay = 0, filter = 800 } = {}) {
    if (!Sounds.enabled || Sounds._muted || !Sounds._ctx) return;
    const ctx = Sounds._ctx;
    if (ctx.state === 'suspended') ctx.resume();
    const t0 = ctx.currentTime + delay;
    const bufferSize = Math.floor(ctx.sampleRate * dur);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = filter;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    src.connect(bp).connect(g).connect(ctx.destination);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  },

  // ------------- sons expostos -------------

  click()     { Sounds._beep({ freq: 620, dur: 0.04, type: 'square', gain: 0.08 }); },

  coin() {
    // Dois beeps rápidos agudos, tipo moeda caindo
    Sounds._beep({ freq: 880, dur: 0.05, type: 'triangle', gain: 0.12 });
    Sounds._beep({ freq: 1320, dur: 0.07, type: 'triangle', gain: 0.1, delay: 0.06 });
  },

  flip() {
    Sounds._noise({ dur: 0.08, gain: 0.06, filter: 1500 });
    Sounds._beep({ freq: 520, dur: 0.05, type: 'sine', gain: 0.05, delay: 0.04 });
  },

  challenge() {
    // Som tenso, descendente
    Sounds._beep({ freq: 520, freqEnd: 260, dur: 0.18, type: 'sawtooth', gain: 0.12 });
  },

  block() {
    // Som defensivo, ascendente
    Sounds._beep({ freq: 320, freqEnd: 560, dur: 0.15, type: 'triangle', gain: 0.12 });
  },

  eliminate() {
    // Queda dramática
    Sounds._beep({ freq: 400, freqEnd: 90, dur: 0.45, type: 'sawtooth', gain: 0.18 });
    Sounds._noise({ dur: 0.3, gain: 0.06, filter: 400, delay: 0.05 });
  },

  victory() {
    // Pequena fanfarra
    const notes = [523, 659, 784, 1047]; // C E G C
    notes.forEach((f, i) => {
      Sounds._beep({ freq: f, dur: 0.18, type: 'triangle', gain: 0.14, delay: i * 0.12 });
    });
  },

  alert() {
    // Alguém precisa responder algo
    Sounds._beep({ freq: 880, dur: 0.08, type: 'sine', gain: 0.1 });
    Sounds._beep({ freq: 880, dur: 0.08, type: 'sine', gain: 0.1, delay: 0.14 });
  },

  tick() {
    Sounds._beep({ freq: 1200, dur: 0.02, type: 'square', gain: 0.05 });
  }
};

window.Sounds = Sounds;
