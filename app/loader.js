// IGI 2 Offline Loader – WebView APK ke liye
'use strict';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const ENGINE = 'recomp-g2v15';
const OPFS_DIR = 'game';

// ============================================================
// UI
// ============================================================
const status = (t) => { const el = $('status'); if (el) el.textContent = t; };
const show = (view) => {
  for (const v of document.querySelectorAll('#panel .view'))
    v.classList.toggle('hidden', v.id !== 'view-' + view);
};

// ============================================================
// Canvas / Render
// ============================================================
function sizeCanvas() {
  const canvas = $('canvas');
  const r = canvas.getBoundingClientRect();
  const k = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(r.width * k);
  canvas.height = Math.round(r.height * k);
}

function gpuLabel() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    const e = gl && gl.getExtension('WEBGL_debug_renderer_info');
    if (e) return String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL) || '');
  } catch {}
  return '';
}

// ============================================================
// Engine Load
// ============================================================
async function loadEngineScript(src) {
  for (let i = 0; i < 3; i++) {
    const s = document.createElement('script');
    s.src = i ? src + '?retry=' + i : src;
    const ok = await new Promise((done) => {
      s.onload = () => done(true);
      s.onerror = () => done(false);
      document.head.appendChild(s);
    });
    if (ok && typeof createRecomp === 'function') return;
    s.remove();
    if (i >= 2) throw new Error('Engine load failed: ' + src);
    await new Promise(r => setTimeout(r, 1000));
  }
}

// ============================================================
// Audio
// ============================================================
function newAudioContext() {
  if (params.has('mute') || !window.AudioContext) return null;
  try { return new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' }); } catch { return null; }
}

async function startAudio(M, ctx) {
  if (!ctx) return;
  try {
    await ctx.audioWorklet.addModule('audio-worklet.js');
    const node = new AudioWorkletNode(ctx, 'rc-ring', { outputChannelCount: [2] });
    node.port.postMessage({ memory: M.wasmMemory, ring: M._rc_audio_ring() });
    node.connect(ctx.destination);
    ctx.resume();
  } catch (e) { console.warn('audio:', e.message); }
}

// ============================================================
// Input – Keyboard
// ============================================================
const HID = {};
for (let i = 0; i < 26; i++) HID['Key' + String.fromCharCode(65 + i)] = 4 + i;
for (let i = 1; i <= 9; i++) HID['Digit' + i] = 29 + i;
HID.Digit0 = 39;
Object.assign(HID, {
  Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44, Minus: 45, Equal: 46,
  BracketLeft: 47, BracketRight: 48, Backslash: 49, Semicolon: 51, Quote: 52,
  Backquote: 53, Comma: 54, Period: 55, Slash: 56, CapsLock: 57,
  PrintScreen: 70, ScrollLock: 71, Pause: 72, Insert: 73, Home: 74, PageUp: 75,
  Delete: 76, End: 77, PageDown: 78, ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82,
  NumLock: 83, NumpadDivide: 84, NumpadMultiply: 85, NumpadSubtract: 86, NumpadAdd: 87, NumpadEnter: 88,
  Numpad0: 98, NumpadDecimal: 99,
  ControlLeft: 224, ShiftLeft: 225, AltLeft: 226, MetaLeft: 227,
  ControlRight: 228, ShiftRight: 229, AltRight: 230, MetaRight: 231,
});
for (let i = 1; i <= 12; i++) HID['F' + i] = 57 + i;
for (let i = 1; i <= 9; i++) HID['Numpad' + i] = 88 + i;

function hookInput(M) {
  const canvas = $('canvas');
  const heldKeys = new Set();
  const releaseKeys = () => { for (const u of heldKeys) M._input_key_hid(u, 0); heldKeys.clear(); };

  window.addEventListener('keydown', (e) => {
    const u = HID[e.code];
    if (u === undefined) return;
    e.preventDefault();
    if (e.repeat) return;
    heldKeys.add(u);
    M._input_key_hid(u, 1);
  });
  window.addEventListener('keyup', (e) => {
    const u = HID[e.code];
    if (u === undefined) return;
    heldKeys.delete(u);
    M._input_key_hid(u, 0);
  });
  window.addEventListener('blur', releaseKeys);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseKeys(); });

  // Mouse
  canvas.addEventListener('mousedown', (e) => {
    if (document.pointerLockElement !== canvas) {
      try { canvas.requestPointerLock(); } catch {}
    }
    M._input_mouse_button(e.button, 1);
  });
  window.addEventListener('mouseup', (e) => M._input_mouse_button(e.button, 0));
  canvas.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement === canvas) {
      M._input_mouse_move(e.movementX, e.movementY);
    } else {
      M._input_mouse_move(e.movementX, e.movementY);
    }
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    M._input_mouse_wheel(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ============================================================
// Gamepad
// ============================================================
const PAD_SLOTS = 4;
const padLast = Array.from({ length: PAD_SLOTS }, () => '');
const axis16 = (v) => Math.round(Math.max(-1, Math.min(1, v || 0)) * 32767);

function pollGamepads(M) {
  const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(g => g && g.connected) : [];
  for (let slot = 0; slot < PAD_SLOTS; slot++) {
    const g = pads[slot];
    const buttons = g ? g.buttons.filter((b, i) => i < 17 && (b.pressed || b.value > 0.3)).reduce((a, b, i) => a | (1 << i), 0) : 0;
    const ax = g ? [axis16(g.axes[0]), axis16(g.axes[1]), axis16(g.axes[2]), axis16(g.axes[3])] : [0, 0, 0, 0];
    const key = `${g ? 1 : 0}:${buttons}:${ax.join(',')}`;
    if (key === padLast[slot]) continue;
    padLast[slot] = key;
    M._input_gamepad(slot, g ? 1 : 0, buttons, ax[0], ax[1], ax[2], ax[3]);
  }
}

// ============================================================
// Run Game
// ============================================================
async function run() {
  const audio = newAudioContext();
  const touch = matchMedia('(pointer: coarse)').matches;

  $('panel').classList.add('hidden');
  document.body.classList.add('playing');
  showBoot();
  sizeCanvas();

  status('Loading engine…');
  await loadEngineScript(`build/${ENGINE}.js`);
  status('Starting game…');

  const M = await createRecomp({
    arguments: [`/${OPFS_DIR}`],
    print: (t) => console.log(t),
    printErr: (t) => console.error(t),
    preRun: [(m) => {
      if (params.has('mute')) m.ENV.RC_NO_AUDIO = '1';
      const g = gpuLabel();
      if (g) m.ENV.RC_GPU_LABEL = g;
      m.ENV.RC_MEM_COMPACT = '1';
    }],
  });

  const canvas = $('canvas');
  if (window.RC_RENDERER === 'gl') {
    if (!M._rc_gl_init(canvas.width, canvas.height)) throw new Error('WebGL 2 failed');
  } else {
    M._rc_gpu_init(canvas.width, canvas.height);
  }

  new ResizeObserver(() => { sizeCanvas(); M._rc_set_canvas_size(canvas.width, canvas.height); }).observe(canvas);
  hookInput(M);
  if (typeof RcTouch !== 'undefined' && touch) RcTouch.attach(M, $('stage'), canvas);
  if (typeof RcLan !== 'undefined') RcLan.attach(M);
  startAudio(M, audio).catch(e => console.warn('audio:', e));

  // Frame loop
  let booted = false, shownFrames = 0, lastPresent = 0, loading = false;
  const frame = (t) => {
    pollGamepads(M);
    const n = M._rc_gpu_pump(1);
    if (n) {
      lastPresent = t;
      if (!booted) {
        shownFrames += n;
        if (shownFrames >= 24) { booted = true; hideBoot(); }
      } else if (loading) { loading = false; hideLoading(); }
    } else if (booted && !loading && lastPresent && t - lastPresent > 2500) {
      loading = true; showLoading();
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  setInterval(() => M._rc_gpu_pump(0), 8);

  canvas.focus();
  window.recomp = M;
}

// ============================================================
// Boot / Loading Overlays
// ============================================================
let bootTimers = [];
function showBoot() {
  const b = $('booting');
  if (!b) return;
  b.classList.remove('hidden');
  bootTimers = [
    setTimeout(() => { const p = b.querySelector('.boot-phase'); if (p) p.textContent = 'Loading game into memory…'; }, 12000),
    setTimeout(() => { const p = b.querySelector('.boot-phase'); if (p) p.textContent = 'Still loading, hang tight…'; }, 45000),
    setTimeout(hideBoot, 300000),
  ];
}
function hideBoot() {
  const b = $('booting');
  bootTimers.forEach(clearTimeout);
  if (b) b.classList.add('hidden');
}
function showLoading() {
  const b = $('booting');
  if (!b) return;
  b.classList.remove('hidden');
  const p = b.querySelector('.boot-phase');
  if (p) p.textContent = 'Loading mission…';
}
function hideLoading() {
  const b = $('booting');
  if (b) b.classList.add('hidden');
}

// ============================================================
// Fullscreen
// ============================================================
function setupFullscreen() {
  const stage = $('stage');
  const active = () => document.fullscreenElement || document.webkitFullscreenElement;
  const enter = () => {
    const p = (stage.requestFullscreen || stage.webkitRequestFullscreen).call(stage);
    if (p && p.catch) p.catch(() => {});
  };
  const toggle = () => {
    if (active()) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document).catch?.(() => {});
    } else enter();
    $('canvas').focus();
  };
  const fsBtn = $('fs');
  if (fsBtn) fsBtn.onclick = toggle;
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Enter' && e.altKey) { e.preventDefault(); toggle(); }
  }, true);
}

// ============================================================
// Game Folder Check
// ============================================================
async function checkGameFiles() {
  try {
    const r = await fetch('game/igi2.exe', { method: 'HEAD' });
    return r.ok;
  } catch {
    return false;
  }
}

// ============================================================
// Boot
// ============================================================
async function boot() {
  // Check renderer
  if (params.get('renderer') === 'gl' && webgl2Ok()) {
    window.RC_RENDERER = 'gl';
  } else if (!navigator.gpu) {
    if (webgl2Ok()) window.RC_RENDERER = 'gl';
    else { status('WebGPU or WebGL 2 not supported.'); return; }
  } else {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null)
      || await navigator.gpu.requestAdapter().catch(() => null)
      || await navigator.gpu.requestAdapter({ featureLevel: 'compatibility' }).catch(() => null)
      || await navigator.gpu.requestAdapter({ forceFallbackAdapter: true }).catch(() => null);
    if (!adapter && webgl2Ok()) window.RC_RENDERER = 'gl';
    else if (!adapter) { status('No graphics adapter found.'); return; }
  }

  // Check game files
  const hasFiles = await checkGameFiles();
  if (!hasFiles) {
    show('loading');
    status('Game files not found. Place IGI 2 files in the game/ folder.');
    $('pick').classList.remove('hidden');
    $('help').classList.remove('hidden');
    return;
  }

  // Ready – show home
  show('home');
  status('');
}

function webgl2Ok() {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
}

// ============================================================
// Init
// ============================================================
setupFullscreen();

// Play button
$('play').onclick = () => run().catch((e) => {
  hideBoot();
  status('Error: ' + (e.message || e));
  show('loading');
});

// Select folder (for WebView: just reload after files are placed)
$('pick').onclick = async () => {
  $('pick').classList.add('hidden');
  status('Checking game files…');
  await new Promise(r => setTimeout(r, 500));
  const ok = await checkGameFiles();
  if (ok) {
    show('home');
    status('');
  } else {
    status('Game files still not found. Place IGI 2 folder as "game/" in the app assets and reload.');
    $('pick').classList.remove('hidden');
    $('help').classList.remove('hidden');
  }
};

// Reset button
$('reset').onclick = () => location.reload();

// Go online (disabled in offline mode)
$('go-online').onclick = () => status('Multiplayer not available in offline mode.');

// Device toggle
document.querySelectorAll('#device button').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('#device button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    const touch = b.dataset.device === 'touch';
    document.body.classList.toggle('coarse', touch);
  };
});

boot();   