/* YOHAKU — a dependency-free, local-only audiovisual playground. */
(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const canvas = $('#artboard');
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) {
    $('#stage-hint').textContent = 'このブラウザーではCanvasを利用できません。';
    document.querySelectorAll('button, input').forEach((control) => { control.disabled = true; });
    return;
  }
  const TAU = Math.PI * 2;
  const STORE_KEY = 'yohaku.settings.v1';
  const DEFAULTS = Object.freeze({ mode: 'flow', energy: 55, density: 36, speed: 65, palette: 0, seed: 18624 });
  const PALETTES = [
    { name: '木漏れ日', background: '#eeefe5', grid: '#738568', colors: ['#64825e', '#aca0c0', '#cfa362', '#537865'] },
    { name: '日暮れ', background: '#efedf4', grid: '#8b8199', colors: ['#7375aa', '#cf8a9f', '#9bb8c8', '#8b6f99'] },
    { name: '焼きもの', background: '#f3eae0', grid: '#9a8569', colors: ['#b5684b', '#ce9a5d', '#708777', '#b78d70'] },
  ];
  const MODES = {
    flow: { label: '01 — FLOW FIELD', name: 'ながれを描く', hint: '動かして、ながれをつくる。', description: '流れの実験。ポインターを動かすと線が揺れます。' },
    ripple: { label: '02 — RIPPLE GARDEN', name: '波紋をひろげる', hint: '触れたところに、波紋が咲く。', description: '波紋の実験。クリックした場所から新しい波紋が広がります。' },
    orbit: { label: '03 — ORBIT PLAY', name: '引力であそぶ', hint: 'あなたの指が、引力になる。', description: '引力の実験。ポインターが軌道の中心を引き寄せます。' },
  };
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const bounded = (value, min, max, fallback) => typeof value === 'number' && Number.isFinite(value) ? Math.round(clamp(value, min, max)) : fallback;
  let storageAvailable = true;
  function readSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY));
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return { ...DEFAULTS };
      return {
        mode: Object.hasOwn(MODES, saved.mode) ? saved.mode : DEFAULTS.mode,
        energy: bounded(saved.energy, 10, 100, DEFAULTS.energy),
        density: bounded(saved.density, 12, 60, DEFAULTS.density),
        speed: bounded(saved.speed, 10, 150, DEFAULTS.speed),
        palette: bounded(saved.palette, 0, PALETTES.length - 1, DEFAULTS.palette),
        seed: bounded(saved.seed, 1, 999999, DEFAULTS.seed),
      };
    } catch { storageAvailable = false; return { ...DEFAULTS }; }
  }
  function persist() {
    try {
      const settings = Object.fromEntries(Object.keys(DEFAULTS).map((key) => [key, state[key]]));
      localStorage.setItem(STORE_KEY, JSON.stringify(settings));
      storageAvailable = true;
    } catch { storageAvailable = false; }
    storageNotice();
  }
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const state = { ...readSettings(), playing: !reducedMotion.matches, sound: false, volume: 20 };
  const pointer = { x: 0.5, y: 0.5, targetX: 0.5, targetY: 0.5, active: false, down: false };
  let width = 1, height = 1, dpr = 1, time = 0, frameId = 0, lastFrame = 0;
  let pulses = [], pulseIndex = 0, lastDrag = -Infinity, toastTimeout;

  function notify(message) {
    const toast = $('#toast');
    clearTimeout(toastTimeout);
    toast.textContent = message;
    toast.classList.add('is-visible');
    toastTimeout = setTimeout(() => toast.classList.remove('is-visible'), 2800);
  }
  function storageNotice() {
    $('.local-note').textContent = storageAvailable ? '設定はこのブラウザーだけに保存されます。' : '現在、設定の保存は利用できません。';
  }
  function syncUI() {
    storageNotice();
    document.querySelectorAll('[data-mode]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode)));
    document.querySelectorAll('[data-palette]').forEach((button) => button.setAttribute('aria-pressed', String(Number(button.dataset.palette) === state.palette)));
    ['energy', 'density', 'speed'].forEach((key) => { $(`#${key}`).value = state[key]; });
    $('#energy-value').textContent = `${state.energy}%`;
    $('#density-value').textContent = String(state.density);
    $('#speed-value').textContent = `${(state.speed / 100).toFixed(2)}×`;
    $('#palette-name').textContent = PALETTES[state.palette].name;
    $('#mode-label').textContent = MODES[state.mode].label;
    $('#stage-hint').textContent = MODES[state.mode].hint;
    $('#seed-label').textContent = `SEED ${String(state.seed).padStart(6, '0')}`;
    canvas.setAttribute('aria-label', `${MODES[state.mode].description} クリック、タップ、またはフォーカスして矢印キーとEnterキーで操作できます。`);
    $('#pause-button').setAttribute('aria-pressed', String(!state.playing));
    $('#pause-button').setAttribute('aria-label', state.playing ? '動きを止める' : '動きを再開する');
    $('#pause-icon').textContent = state.playing ? 'Ⅱ' : '▷';
    $('#live-label').innerHTML = `<i></i> ${state.playing ? 'LIVE' : 'PAUSED'}`;
    $('#live-label').classList.toggle('is-paused', !state.playing);
    $('#sound-button').setAttribute('aria-pressed', String(state.sound));
    $('#sound-label').textContent = state.sound ? '音 ON' : '音 OFF';
    $('#sound-waves').setAttribute('d', state.sound ? 'M15 8c3 2 3 6 0 8m3-11c5 4 5 10 0 14' : 'm16 9 6 6m0-6-6 6');
    $('#volume-control').hidden = !state.sound;
  }

  // Audio is constructed only after an explicit click/key command. Never auto-play.
  const audio = {
    context: null, master: null, voices: new Set(),
    async ready() {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) throw new Error('このブラウザーは音の再生に対応していません。');
      if (!this.context) {
        this.context = new AudioContext();
        this.master = this.context.createGain();
        this.master.gain.value = 0;
        this.master.connect(this.context.destination);
      }
      if (this.context.state !== 'running') await this.context.resume();
    },
    setVolume() {
      if (!this.context || !this.master) return;
      const now = this.context.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setTargetAtTime(state.sound ? state.volume / 100 * 0.8 : 0, now, 0.025);
    },
    silence() {
      this.setVolume();
      for (const voice of this.voices) {
        try { voice.stop(this.context.currentTime + 0.06); } catch { /* Already ended. */ }
      }
    },
    async note(x, y) {
      if (!state.sound) return;
      try {
        await this.ready();
        if (!state.sound || this.voices.size >= 8) return;
        this.setVolume();
        const scale = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];
        const pitch = scale[Math.min(scale.length - 1, Math.floor(x * scale.length))];
        const oscillator = this.context.createOscillator();
        const envelope = this.context.createGain();
        const now = this.context.currentTime;
        oscillator.type = state.mode === 'orbit' ? 'sine' : 'triangle';
        oscillator.frequency.setValueAtTime(261.6256 * 2 ** (pitch / 12), now);
        envelope.gain.setValueAtTime(0.0001, now);
        envelope.gain.exponentialRampToValueAtTime(0.07 + (1 - y) * 0.055, now + 0.018);
        envelope.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);
        oscillator.connect(envelope);
        envelope.connect(this.master);
        this.voices.add(oscillator);
        oscillator.onended = () => { this.voices.delete(oscillator); oscillator.disconnect(); envelope.disconnect(); };
        oscillator.start(now);
        oscillator.stop(now + 1.25);
      } catch {
        state.sound = false;
        this.silence();
        syncUI();
        notify('音を再生できませんでした。音 OFFで実験を続けられます。');
      }
    },
  };
  async function toggleSound() {
    const button = $('#sound-button');
    if (button.disabled) return;
    if (state.sound) {
      state.sound = false;
      audio.silence();
      syncUI();
      notify('音をOFFにしました。');
      return;
    }
    button.disabled = true;
    try {
      await audio.ready();
      state.sound = true;
      audio.setVolume();
      syncUI();
      await audio.note(0.45, 0.6);
      if (state.sound) notify('音をONにしました。画面に触れると音が鳴ります。');
    } catch (error) {
      state.sound = false;
      notify(error.message || '音を再生できませんでした。');
    } finally { button.disabled = false; syncUI(); }
  }

  function background(palette) {
    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = palette.grid;
    ctx.globalAlpha = 0.18;
    for (let x = 18; x < width; x += 24) {
      for (let y = 18; y < height; y += 24) ctx.fillRect(x, y, 0.9, 0.9);
    }
    ctx.globalAlpha = 1;
  }
  function flow(palette) {
    const n = state.density;
    const energy = state.energy / 100;
    const phase = (state.seed % 1000) / 1000 * TAU;
    const px = (pointer.x - 0.5) * 1.5, py = (pointer.y - 0.5) * 1.4;
    const samples = Math.min(220, Math.max(100, Math.floor(width / 4)));
    for (let line = 0; line < n; line++) {
      const v = line / (n - 1);
      ctx.beginPath();
      ctx.strokeStyle = palette.colors[Math.min(3, Math.floor(v * 4))];
      ctx.lineWidth = width < 500 ? 1.25 : 1.55;
      ctx.globalAlpha = 0.83;
      for (let j = 0; j <= samples; j++) {
        const u = j / samples;
        const x = (u * 1.16 - 0.08) * width;
        const taper = Math.sin(u * Math.PI) ** 0.7;
        const wave = Math.sin(u * TAU * 1.03 + time * 0.42 + phase + v * 1.8 + px) * 0.65
          + Math.sin(u * TAU * 1.8 - time * 0.26 + v * 2.3) * 0.28;
        let y = height * (0.50 + (v - 0.5) * 0.49)
          + wave * height * (0.13 + energy * 0.14) * taper
          + Math.sin(u * Math.PI) * py * height * 0.12;
        for (const pulse of pulses) {
          const age = time - pulse.born;
          const dx = u - pulse.x;
          y += Math.sin(dx * 20 - age * 4) * Math.exp(-dx * dx * 20) * Math.exp(-age * 0.7) * 15 * (0.4 + energy);
        }
        if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // Two quietly orbiting markers make the moving surface easier to read.
    for (let i = 0; i < 2; i++) {
      const x = width * (0.28 + i * 0.43) + Math.cos(time * 0.3 + i * 3) * 12;
      const y = height * (0.29 + i * 0.42) + Math.sin(time * 0.3 + phase + i) * 15;
      ctx.beginPath(); ctx.arc(x, y, 5, 0, TAU);
      ctx.fillStyle = palette.background; ctx.fill();
      ctx.strokeStyle = palette.colors[i * 2]; ctx.lineWidth = 1.3; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 1.5, 0, TAU); ctx.fillStyle = palette.colors[i * 2]; ctx.fill();
    }
  }
  function bloom(x, y, radius, rings, phase, opacity, palette, colorOffset) {
    const energy = state.energy / 100;
    for (let ring = 1; ring <= rings; ring++) {
      const r = radius * ring / rings;
      ctx.beginPath();
      for (let j = 0; j <= 100; j++) {
        const angle = j / 100 * TAU;
        const wobble = 1 + Math.sin(angle * 3 + phase + time * 0.32 + ring * 0.04) * energy * 0.13
          + Math.cos(angle * 5 - time * 0.22 + phase) * energy * 0.07;
        const cx = x + Math.cos(angle) * r * wobble;
        const cy = y + Math.sin(angle) * r * wobble;
        if (j === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
      }
      ctx.closePath();
      ctx.strokeStyle = palette.colors[(Math.floor(ring / 6) + colorOffset) % 4];
      ctx.lineWidth = 1.15;
      ctx.globalAlpha = opacity * (0.58 + ring / rings * 0.27);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  function ripple(palette) {
    const size = Math.min(width, height);
    const phase = state.seed / 1000;
    const rings = Math.floor(state.density * 0.65);
    const drift = (pointer.x - 0.5) * 15;
    bloom(width * 0.34 + drift, height * 0.46, size * 0.31, rings, phase, 0.9, palette, 0);
    bloom(width * 0.65, height * 0.61 + (pointer.y - 0.5) * 15, size * 0.25, rings, phase + 2, 0.85, palette, 1);
    bloom(width * 0.69 - drift, height * 0.28, size * 0.13, Math.max(8, Math.floor(rings * 0.55)), phase + 4, 0.85, palette, 2);
    for (const pulse of pulses) {
      const age = time - pulse.born;
      const radius = size * (0.045 + (1 - Math.exp(-age * 0.55)) * 0.28);
      bloom(pulse.x * width, pulse.y * height, radius, Math.max(8, Math.floor(rings * 0.7)), pulse.index, Math.exp(-age * 0.4), palette, pulse.index % 4);
    }
  }
  function orbit(palette) {
    const size = Math.min(width, height);
    const phase = state.seed / 10000;
    const x = width * (0.5 + (pointer.x - 0.5) * 0.3);
    const y = height * (0.5 + (pointer.y - 0.5) * 0.3);
    const energy = state.energy / 100;
    const age = pulses.length ? time - pulses[pulses.length - 1].born : 100;
    const burst = Math.sin(age * 4) * Math.exp(-age * 1.4) * size * 0.035;
    for (let i = 0; i < state.density; i++) {
      const fraction = i / state.density;
      const a = size * (0.13 + fraction * 0.31) + burst;
      const b = a * (0.28 + energy * 0.22);
      const tilt = fraction * Math.PI + phase + time * 0.07;
      ctx.save();
      ctx.translate(x, y); ctx.rotate(tilt);
      ctx.beginPath(); ctx.ellipse(0, 0, a, b, 0, 0, TAU);
      ctx.strokeStyle = palette.colors[Math.floor(fraction * 4)];
      ctx.lineWidth = 1.1; ctx.globalAlpha = 0.67; ctx.stroke();
      if (i % 3 === 0) {
        const angle = time * (0.3 + fraction * 0.3) + i * 2.399;
        ctx.beginPath(); ctx.arc(Math.cos(angle) * a, Math.sin(angle) * b, 2 + fraction * 2, 0, TAU);
        ctx.globalAlpha = 1; ctx.fillStyle = palette.colors[i % 4]; ctx.fill();
      }
      ctx.restore();
    }
    ctx.beginPath(); ctx.arc(x, y, 8, 0, TAU); ctx.fillStyle = palette.colors[0]; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, 14, 0, TAU); ctx.strokeStyle = palette.colors[0]; ctx.globalAlpha = 0.35; ctx.stroke(); ctx.globalAlpha = 1;
  }
  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    const palette = PALETTES[state.palette];
    background(palette);
    if (state.mode === 'flow') flow(palette);
    else if (state.mode === 'ripple') ripple(palette);
    else orbit(palette);
    if (pointer.active) {
      ctx.strokeStyle = palette.colors[0]; ctx.lineWidth = 1; ctx.globalAlpha = 0.65;
      const x = pointer.targetX * width, y = pointer.targetY * height;
      ctx.beginPath(); ctx.arc(x, y, pointer.down ? 12 : 7, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - 3, y); ctx.lineTo(x + 3, y); ctx.moveTo(x, y - 3); ctx.lineTo(x, y + 3); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
  function resize() {
    const rect = $('#stage').getBoundingClientRect();
    width = Math.max(1, rect.width); height = Math.max(1, rect.height);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    render();
  }
  function tick(now) {
    frameId = 0;
    if (!state.playing || document.hidden) return;
    const delta = Math.min((now - lastFrame) / 1000, 0.05);
    lastFrame = now;
    time += delta * state.speed / 100;
    pointer.x += (pointer.targetX - pointer.x) * Math.min(1, delta * 7);
    pointer.y += (pointer.targetY - pointer.y) * Math.min(1, delta * 7);
    pulses = pulses.filter((pulse) => time - pulse.born < 12);
    render();
    frameId = requestAnimationFrame(tick);
  }
  function startLoop() {
    if (frameId || !state.playing || document.hidden) return;
    lastFrame = performance.now();
    frameId = requestAnimationFrame(tick);
  }
  function update() { syncUI(); persist(); render(); }
  function chooseMode(mode) {
    if (!Object.hasOwn(MODES, mode)) return;
    state.mode = mode; pulses = []; time = 0;
    update(); notify(`「${MODES[mode].name}」に切り替えました。`);
  }
  function togglePause() {
    state.playing = !state.playing;
    if (!state.playing) { cancelAnimationFrame(frameId); frameId = 0; }
    else startLoop();
    syncUI(); render();
    notify(state.playing ? '動きを再開しました。' : '動きを止めました。このまま保存もできます。');
  }
  function randomize() {
    state.seed = Math.floor(Math.random() * 999999) + 1;
    state.palette = Math.floor(Math.random() * PALETTES.length);
    state.energy = Math.floor(Math.random() * 76) + 25;
    state.density = Math.floor(Math.random() * 37) + 20;
    state.speed = Math.floor(Math.random() * 91) + 30;
    state.mode = ['flow', 'ripple', 'orbit'][Math.floor(Math.random() * 3)];
    pulses = []; time = 0; pointer.x = pointer.targetX = 0.5; pointer.y = pointer.targetY = 0.5;
    update(); notify('偶然から、あたらしい景色が生まれました。');
  }
  function reset() {
    Object.assign(state, DEFAULTS);
    pulses = []; time = 0; pointer.x = pointer.targetX = 0.5; pointer.y = pointer.targetY = 0.5;
    update(); notify('最初の景色にもどしました。');
  }
  function position(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.targetX = clamp((event.clientX - rect.left) / width, 0, 1);
    pointer.targetY = clamp((event.clientY - rect.top) / height, 0, 1);
    pointer.active = true;
    if (!state.playing) { pointer.x = pointer.targetX; pointer.y = pointer.targetY; render(); }
  }
  function addPulse() {
    pulses.push({ x: pointer.targetX, y: pointer.targetY, born: time - 0.15, index: pulseIndex++ });
    if (pulses.length > 8) pulses.shift();
    if (state.sound) void audio.note(pointer.targetX, pointer.targetY);
    render();
  }
  async function saveImage() {
    const button = $('#save-button');
    if (button.disabled) return;
    button.disabled = true;
    const mode = state.mode, seed = state.seed;
    try {
      // Do not include the pointer indicator in the souvenir image.
      const active = pointer.active; pointer.active = false; render();
      const blobPromise = new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNGの生成に失敗しました。')), 'image/png'));
      pointer.active = active; render();
      const blob = await blobPromise;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = `yohaku-${mode}-${String(seed).padStart(6, '0')}.png`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      notify('この景色を、PNGのおみやげに。');
    } catch { notify('画像を保存できませんでした。もう一度お試しください。'); }
    finally { button.disabled = false; }
  }

  document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => chooseMode(button.dataset.mode)));
  document.querySelectorAll('[data-palette]').forEach((button) => button.addEventListener('click', () => { state.palette = Number(button.dataset.palette); update(); }));
  ['energy', 'density', 'speed'].forEach((key) => $(`#${key}`).addEventListener('input', (event) => { state[key] = Number(event.target.value); update(); }));
  $('#volume').addEventListener('input', (event) => {
    state.volume = Number(event.target.value);
    $('#volume-value').textContent = `${state.volume}%`;
    audio.setVolume();
  });
  $('#sound-button').addEventListener('click', toggleSound);
  $('#pause-button').addEventListener('click', togglePause);
  $('#random-button').addEventListener('click', randomize);
  $('#reset-button').addEventListener('click', reset);
  $('#save-button').addEventListener('click', saveImage);
  canvas.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    position(event); pointer.down = true;
    canvas.focus({ preventScroll: true }); canvas.setPointerCapture(event.pointerId);
    lastDrag = performance.now(); addPulse();
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!event.isPrimary) return;
    position(event);
    if (pointer.down && performance.now() - lastDrag > 160) { lastDrag = performance.now(); addPulse(); }
  });
  function releasePointer(event) {
    pointer.down = false;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (event.pointerType !== 'mouse') pointer.active = false;
    render();
  }
  canvas.addEventListener('pointerup', releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);
  canvas.addEventListener('lostpointercapture', () => { pointer.down = false; });
  canvas.addEventListener('pointerleave', () => { if (!pointer.down) { pointer.active = false; render(); } });
  canvas.addEventListener('blur', () => { pointer.active = false; pointer.down = false; render(); });
  document.addEventListener('keydown', (event) => {
    if (event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const key = event.key.toLowerCase();
    if (event.target === canvas && ['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'enter'].includes(key)) {
      event.preventDefault(); pointer.active = true;
      if (key === 'enter') addPulse();
      else {
        pointer.targetX = clamp(pointer.targetX + (key === 'arrowright' ? 0.05 : key === 'arrowleft' ? -0.05 : 0), 0, 1);
        pointer.targetY = clamp(pointer.targetY + (key === 'arrowdown' ? 0.05 : key === 'arrowup' ? -0.05 : 0), 0, 1);
        if (!state.playing) { pointer.x = pointer.targetX; pointer.y = pointer.targetY; }
        render();
      }
      return;
    }
    if (['1', '2', '3'].includes(key)) { event.preventDefault(); chooseMode(['flow', 'ripple', 'orbit'][Number(key) - 1]); }
    else if (key === 'r') { event.preventDefault(); randomize(); }
    else if (key === 's') { event.preventDefault(); void toggleSound(); }
    else if (key === ' ' && !event.target.closest('button, a, summary')) { event.preventDefault(); togglePause(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(frameId); frameId = 0;
      if (audio.context?.state === 'running') void audio.context.suspend().catch(() => {});
    } else startLoop();
  });
  reducedMotion.addEventListener('change', (event) => {
    if (event.matches && state.playing) togglePause();
  });
  window.addEventListener('resize', resize);
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe($('#stage'));
  syncUI(); resize(); startLoop();
})();
