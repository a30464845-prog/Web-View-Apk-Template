// IGI 2: Covert Strike in the browser - Copyright (c) 2026 Sagar Joshi. All rights reserved.
// Not licensed for copying, hosting or reuse without written permission. See NOTICE.
// IGI 2: Covert Strike in the browser: copies the player's own game folder into OPFS (once; it never leaves the
// computer), starts the recompiled build (build/recomp.js), replays its frames with WebGPU and feeds it
// input and audio.
//
// URL options: ?mute (no audio) ?fps (frame rate in the console) ?log (host log) ?autoplay
//              ?devgame (download the hosted game folder without asking; testing)
//              ?touch (on-screen controls even without a touch screen) ?touchsens=<x> (extra look factor; the
//              settings sheet on the phone is the normal way)
//              ?exe=<name> (the executable inside the game folder, if not the profile's default)
//              ?pads=N (game controllers to expose, default 1, at most 4)
//              ?queue=1 (frames queued ahead of the display, default 2: 1 cuts 16 ms of input latency online
//              on a machine that simulates a frame well within 16 ms, else it hitches)
//              ?netplay=<url> (the room server for online play, see server/; default: this page's origin)
//              ?join=<room code>
//
// Online play (netplay.js, host/netplay.c): players meet in a room on the server; when the host starts,
// every page boots the game in deterministic lockstep mode with fresh saves, and only pad inputs travel.
// Each player's keyboard and first gamepad merge into one local pad; mouse and raw keys are off.
'use strict';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
// A/B experiments. Each browser draws a fixed bucket 0-99 once; an experiment is on for the buckets below its
// share, so a change can go to a few percent of players first and its reports (crash.php, field "x") be compared
// with everyone else's before it goes further. A browser whose run in an experiment ended badly (no frame, or
// killed within two minutes) leaves that experiment for good (crashCheck). URL switches force either way.
// wide: widescreen display modes (host/d3d8.c RC_WIDE_D3D; IGI 2 draws for a wide display by itself), 100% from
// 2026-11-05 (players asked for full screen): a browser whose run fails in it goes back to 4:3 (crashCheck)
const EXPERIMENTS = { wide: 100, tick: 50 };
const COHORT = (() => {
  let b = 99, off = {};
  try {
    b = parseInt(localStorage.getItem('igi2-bucket'), 10);
    if (!(b >= 0 && b < 100)) { b = Math.floor(Math.random() * 100); localStorage.setItem('igi2-bucket', String(b)); }
    off = JSON.parse(localStorage.getItem('igi2-exp-off') || '{}') || {};
  } catch { b = 99; }
  const on = {};
  for (const [k, pct] of Object.entries(EXPERIMENTS)) on[k] = !off[k] && b < pct;
  // the player's own choice in the settings (controls.js) wins over the bucket: "Full screen (wide)" or "Original 4:3"
  let choice = null;
  try { choice = localStorage.getItem('igi2-wide-choice'); } catch { /* storage blocked */ }
  if (choice === '1') on.wide = true;
  if (choice === '0') on.wide = false;
  if (params.has('widemodes')) on.wide = true;
  if (params.has('nowidemodes')) on.wide = false;
  if (params.get('mem') === 'compact') on.compact = true;
  if (params.get('mem') === 'full') on.compact = false;
  // a chosen setting is tagged apart (+pick), so the bucketed comparison stays between like and like
  return { bucket: b, on, tag: (Object.keys(on).filter((k) => on[k]).join('+') || 'base') + (choice !== null ? '+pick' : '') };
})();
// the settings show the screen the game will actually start with
try { RcControls.get().wide = COHORT.on.wide; } catch { /* controls.js not loaded */ }
window.RC_WIDE_RUNNING = !!COHORT.on.wide;   // the display modes this start runs with (a switch waits for the next start)
// a run that failed in an experiment leaves it (below)
const leaveExperiments = (keys) => {
  try {
    const off = JSON.parse(localStorage.getItem('igi2-exp-off') || '{}') || {};
    for (const k of keys) off[k] = 1;
    localStorage.setItem('igi2-exp-off', JSON.stringify(off));
    // a chosen widescreen is forgotten with it, or it would win again
    if (keys.includes('wide') && localStorage.getItem('igi2-wide-choice') === '1') localStorage.removeItem('igi2-wide-choice');
  } catch { /* storage blocked */ }
};
// one-line telemetry to crash.php (field x = the experiments this browser is in). The per-session events (start,
// play) come from a quarter of the browsers outside experiments and all inside: crash.php is PHP on shared hosting
// and serves ~6 requests/s (load test 2026-10-31), which 2,000 players starting games would approach otherwise.
// Rates per cohort are unaffected (a browser sends all of its events or none).
// (widescreen, on for everyone, samples like the base: only a smaller experiment sends everything)
const SAMPLED = COHORT.bucket % 4 === 0 || COHORT.tag.split('+').some((k) => !['base', 'wide', 'pick', 'tick'].includes(k));
const beacon = (type, extra) => {
  if ((type === 'start' || type === 'play' || type === 'launch' || type === 'noframe') && !SAMPLED && window.RC_RENDERER !== 'gl') return;   // the WebGL players: all of them, to judge the new renderer
  try { navigator.sendBeacon('crash.php', new Blob([JSON.stringify(Object.assign({ v: 21, eng: ENGINE, type, x: COHORT.tag, r: (window.RC_RENDERER || window.RC_GPU_KIND || 'gpu') + (lowEnd() ? '+lite' : ''), ua: navigator.userAgent,
    mem: navigator.deviceMemory || 0, screen: `${screen.width}x${screen.height}@${devicePixelRatio}` }, extra || {}))], { type: 'application/json' })); } catch { /* no beacon */ }
};
const OPFS_DIR = 'rcgame';
// The engine's file name, new for every release: Cloudflare and browsers keep /build/*.wasm for a year as
// immutable, so a fixed name would keep returning players on the old engine (Project I.G.I. shipped the same
// way after that bit it). The deploy script copies build_web/www/recomp.{js,wasm} to this name; the dev server
// maps any recomp-*.js / .wasm back to the local build.
const ENGINE = 'recomp-g2v15';
// the engine's script (the glue): the same engine, with the memory maximum and thread trap patches (build_web.sh)
const GLUE = ENGINE;
const MARKER = '.installed.json';   // { version } once every file is copied
const NETPLAY_BASE = new URL(params.get('netplay') || './', location.href).href.replace(/\/?$/, '/');
const status = (t) => { $('status').textContent = t; };
// the launcher's screens (index.html): loading, home, online, lobby
const show = (view) => { for (const v of document.querySelectorAll('#panel .view')) v.classList.toggle('hidden', v.id !== 'view-' + view); };
const fail = (e) => {
  hideBoot(); status('Error: ' + (e && e.message || e)); $('panel').classList.remove('hidden'); show('loading');
  // the start failed with a script error: report it once (it used to show only on the player's screen)
  if (!fail.sent) { fail.sent = true; beacon('runfail', { msg: String(e && e.message || e).slice(0, 300), page: String(e && e.stack || '').slice(0, 700), n: (compactMemory() ? 'compact' : 'full') + (() => { try { const mb = maxMemMb(); return mb ? ' max' + mb : ''; } catch { return ''; } })() }); }
  // "Out of memory" creating the engine's memory: iPhones and iPads reserve the whole 2 GB maximum up front and
  // some refuse it (36 starts a day ended here, 2026-11-11, mostly iOS 16). Start again with a smaller maximum,
  // by itself, step by step; the compact layout (every WebKit browser) runs the game in about 0.8 GB.
  if (/out of memory/i.test(String(e && e.message || e))) {
    let cur = 0; try { cur = +sessionStorage.getItem('igi2-maxmem') || 0; } catch { /* no storage */ }
    const next = [1536, 1280, 1024, 896].find((mb) => mb < (cur || 2048)) || 0;
    if (next) {
      try { sessionStorage.setItem('igi2-maxmem', String(next)); } catch { /* no storage: no retry */ return; }
      status('Starting again with less memory…');
      const u = new URL(location.href); u.searchParams.set('autoplay', '1');
      setTimeout(() => { window.rcLeave = true; location.replace(u.href); }, 600);
    }
  }
};
// the engine's glue had to fall back to the canvas for an empty or unknown element selector (build_web.sh)
window.rcGlueNote = (what, detail) => { if (!rcGlueNote.sent) { rcGlueNote.sent = true; beacon('gluefix', { msg: what + ' ' + JSON.stringify(detail).slice(0, 80), n: compactMemory() ? 'compact' : 'full' }); } };
const mb = (n) => (n / 1e6).toFixed(0);

// Rotating "intel" tips: a one-time 500 MB download and the first-mission load both take a minute, so the
// wait gets real game tips and a little lore instead of a bare progress bar. Each tip fades to the next.
const TIPS = [
  // how-to tips (teach the basics people ask about, during the wait)
  'Skip a cutscene or briefing: press Esc on a PC, or the MENU button on a phone.',
  'Press Esc (or MENU) any time to pause, then Resume to jump back in.',
  'Phone: tap the right half of the screen to shoot, and drag there to aim.',
  'Phone: hold a FIRE button and drag to aim while you keep shooting.',
  'Zoom in: right-click on a PC, or the eye / SCOPE button on a phone. A sniper raises its scope, anything else the binoculars.',
  'Phone: tap the gear, then Edit layout, to drag any button where you want it and resize it.',
  'Change any key, the mouse or swipe sensitivity, invert-look and brightness in Controls & layout on the home screen.',
  'Switch weapons with 1–9, or F / V for next and previous. On a phone, tap the weapon number.',
  'Use doors, switches and the map computer with E on a PC, or the USE button on a phone. M opens the map.',
  'Turn your phone to fine-aim while scoped, like PUBG: switch gyroscope aiming on in settings.',
  // lore and the game itself
  'Jones is back, and this time the trail leads to a stolen microchip.',
  'Open the map computer to plan a route before the guards see you.',
  'Stay quiet: silenced weapons and the knife keep the alarm off.',
  'The thermal goggles show warm bodies through thin walls.',
  'The Dragunov has a 3x and a 9x scope: right click steps through them.',
  'Scout with the binoculars before you cross open ground.',
  'Crouch or go prone to stay out of sight.',
  'Watch the light meter: shadows hide you, floodlights give you away.',
  'Online: one player hosts a room, friends join it with the room code.',
  'This is the real 2003 game: about 1.4 GB, downloaded to your device once.',
  'Nothing leaves your computer: the whole game runs inside your browser.',
  'The first start is the slow one: after this the game opens straight away.',
];
function startTips(box) {
  if (!box) return () => {};
  const textEl = box.querySelector('.tip-text');
  box.classList.remove('hidden');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let i = Math.floor(Math.random() * TIPS.length);
  const render = () => { textEl.textContent = TIPS[i % TIPS.length]; i++; };
  render();
  const next = () => {
    if (reduce) { render(); return; }
    box.style.opacity = '0';
    setTimeout(() => { render(); box.style.opacity = '1'; }, 350);
  };
  const id = setInterval(next, 4800);
  return () => { clearInterval(id); box.classList.add('hidden'); box.style.opacity = ''; };
}

// Boot overlay (index.html #booting): between the Play click and the first rendered frame the canvas is a
// black void while the game loads a mission into memory. Cover it with a radar, a phase line that escalates
// if it runs long, and tips, then remove it the moment the first frame is presented (run()).
let stopBootTips = null;
function showBoot() {
  const b = $('booting');
  if (!b) return;
  const phase = b.querySelector('.boot-phase');
  phase.textContent = 'Starting the game…';
  b.classList.remove('hidden');
  stopBootTips = startTips(b.querySelector('.tips'));
  // an ad under the loading text (a natural break: the first launch takes from seconds to minutes)
  try { const inner = b.querySelector('.boot-inner'); if (window.RcBreakAd && inner) {
    // phones get the 300x250 too when the screen is tall enough for it under the loading text (portrait), else 320x50
    const phone = RcTouch.wanted() && b.clientHeight < inner.scrollHeight + 300, w = phone ? 320 : 300;
    inner.style.paddingBottom = phone ? '62px' : '262px';
    window.RcBreakAd.show(inner, phone ? 'mobile' : 'box', (inner.clientWidth - w) / 2, inner.scrollHeight - (phone ? 56 : 256)); } } catch { /* no ads */ }
  showBoot.t1 = setTimeout(() => { phase.textContent = 'Loading the game into memory…'; }, 12000);
  showBoot.t2 = setTimeout(() => { phase.textContent = 'The first launch is the slow one, almost there…'; }, 45000);
  showBoot.t3 = setTimeout(() => { phase.textContent = 'Still working, a slow phone can take a couple of minutes…'; }, 90000);
  showBoot.t4 = setTimeout(hideBoot, 300000);   // safety: never trap the player behind the cover
  // A tap or click on the cover must NOT dismiss it (it used to: the canvas behind is still black, so the
  // player saw the loading screen "turn black"). It only answers with a reassuring line.
  b.onpointerdown = () => { phase.textContent = 'Still loading, nothing is stuck, the game is being set up…'; };
}
function hideBoot() {
  const b = $('booting');
  for (const k of ['t1', 't2', 't3', 't4']) clearTimeout(showBoot[k]);
  if (stopBootTips) { stopBootTips(); stopBootTips = null; }
  if (b) { b.classList.add('hidden'); b.onpointerdown = null; const inner = b.querySelector('.boot-inner'); if (inner) inner.style.paddingBottom = ''; }
  try { window.RcBreakAd?.hide(); } catch { /* no ads */ }
}

// Mid-game loading cover: after boot, the game blocks hard (no frames presented) while it loads a selected
// mission or the next level, up to a couple of minutes on a phone, a black screen that looks frozen. The
// frame loop (run()) watches for that stall and shows this, then hides it the moment frames stream again.
let stopLoadTips = null;
function showLoading() {
  const b = $('booting');
  if (!b) return;
  const phase = b.querySelector('.boot-phase');
  phase.textContent = 'Loading mission…';
  b.classList.remove('hidden');
  stopLoadTips = startTips(b.querySelector('.tips'));
  showLoading.t1 = setTimeout(() => { phase.textContent = 'Loading mission… a phone can take a minute or two.'; }, 15000);
  showLoading.t2 = setTimeout(() => { phase.textContent = 'Still loading, hang tight, almost there…'; }, 50000);
  // A load that long is suspicious, but a slow phone loading a big level can take it: the game is only called
  // stuck once it has also opened or read no file for a minute (rc_io_activity, kernel32.c), which no load
  // does. Then, rather than a black screen that never ends, say so and offer the way out.
  let lastIo = -1, lastIoAt = performance.now();
  const t0 = performance.now();
  showLoading.t3 = setInterval(() => {
    const M = window.recomp, io = M && M._rc_io_activity ? M._rc_io_activity() : -1;
    const now = performance.now();
    if (io !== lastIo) { lastIo = io; lastIoAt = now; }
    if (now - t0 < 150000 || now - lastIoAt < 60000) {
      if (now - t0 > 150000) phase.textContent = 'Still loading, a big level on a slow phone. Hang tight…';
      return;
    }
    clearInterval(showLoading.t3);
    phase.innerHTML = 'The game has stopped responding. <button id="stuck-reload" style="font:inherit;padding:6px 16px;' +
      'border-radius:8px;border:0;background:#45cf79;color:#000;font-weight:700;margin-left:8px">Reload the game</button>';
    $('stuck-reload').onclick = () => location.reload();
  }, 10000);
}
function hideLoading() {
  const b = $('booting');
  for (const k of ['t1', 't2']) clearTimeout(showLoading[k]);
  clearInterval(showLoading.t3);
  if (stopLoadTips) { stopLoadTips(); stopLoadTips = null; }
  if (b) b.classList.add('hidden');
}

// The last lines the engine and the page printed, and the page's errors, kept for a start that shows no frame
// (bootlog, run()): older iPhones and iPads (iOS 16-17) pressed Play and the game never appeared, without a word.
const recentLog = [], recentErr = [];
const keepLog = (t) => { recentLog.push(String(t).slice(0, 140)); if (recentLog.length > 14) recentLog.shift(); };
const keepErr = (t) => { if (recentErr.length < 6) recentErr.push(String(t).slice(0, 160)); keepLog(t); };
window.addEventListener('error', (e) => keepErr('ERR ' + e.message + ' @' + String(e.filename || '').split('/').pop() + ':' + e.lineno));
window.addEventListener('unhandledrejection', (e) => keepErr('REJ ' + ((e.reason && (e.reason.message || e.reason)) || '')));
{ const ce = console.error; console.error = (...a) => { keepErr('CE ' + a.map(String).join(' ')); ce.apply(console, a); }; }

// On-screen diagnostics for phones (no devtools): ?debug shows a log overlay capturing errors, warnings,
// unhandled rejections and lost-GPU events, so a remote tester can screenshot exactly what failed (e.g. a
// mission that won't load). Harmless when off.
const DEBUG = params.has('debug');
(function setupDebugLog() {
  if (!DEBUG) return;
  const box = document.createElement('div');
  box.id = 'debuglog';
  box.style.cssText = 'position:fixed;left:0;right:0;bottom:0;max-height:45vh;overflow:auto;z-index:99999;' +
    'background:rgba(0,0,0,.85);color:#9fe6b0;font:11px/1.4 ui-monospace,Menlo,monospace;padding:8px 10px;' +
    'white-space:pre-wrap;word-break:break-word;border-top:2px solid #2ecc71';
  const add = (tag, args) => {
    const line = document.createElement('div');
    line.textContent = tag + ' ' + args.map((a) => (a && a.stack) || (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    if (tag === 'ERR') line.style.color = '#ff8b8b';
    box.appendChild(line); box.scrollTop = box.scrollHeight;
    while (box.childElementCount > 300) box.firstChild.remove();
  };
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(box));
  if (document.body) document.body.appendChild(box);
  const oe = console.error, ow = console.warn, ol = console.log;
  console.error = (...a) => { add('ERR', a); oe.apply(console, a); };
  console.warn = (...a) => { add('WARN', a); ow.apply(console, a); };
  console.log = (...a) => { add('log', a); ol.apply(console, a); };
  window.addEventListener('error', (e) => add('ERR', [e.message, e.filename + ':' + e.lineno]));
  window.addEventListener('unhandledrejection', (e) => add('ERR', ['unhandled rejection:', e.reason]));
  add('log', ['debug log on · ' + navigator.userAgent]);
})();

// Surface WebGPU failures (console.error, so the ?debug overlay shows them): a mission that exceeds a mobile
// GPU's buffer/texture limits, or a lost device (out of memory), otherwise fails silently to a black screen.
if (navigator.gpu && GPUAdapter.prototype.requestDevice) {
  const orig = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (desc) {
    try {
      const dev = await orig.call(this, desc);
      try {
        dev.addEventListener('uncapturederror', (e) => console.error('WebGPU uncaptured error:', e.error?.message || e.error));
        dev.lost.then((info) => console.error('WebGPU device lost:', info.reason, info.message));
      } catch {}
      return dev;
    } catch (e) { console.error('WebGPU requestDevice failed:', e.message); throw e; }
  };
}

// ------------------------------------------------------------------ game files in OPFS

async function gameDir(create) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIR, { create });
}

async function readMarker() {
  try {
    const dir = await gameDir(false);
    const f = await (await dir.getFileHandle(MARKER)).getFile();
    const m = JSON.parse(await f.text());
    // A browser short of storage can evict the game's files but leave the marker (seen in a test profile:
    // "igi2.exe: No such file", and the page waits forever). No executable: treat it as not installed. The
    // host maps names case-insensitively, so look through the folder rather than ask for one spelling.
    if (typeof dir.keys !== 'function') return m;   // no folder listing in this browser: trust the marker
    let exe = false;
    for await (const name of dir.keys()) if (/^igi2\.exe$/i.test(name)) { exe = true; break; }
    if (!exe) { console.warn('the game folder has no executable: installing again'); return null; }
    return m;
  } catch { return null; }
}

async function writeMarker(version) {
  const w = await openWriter(MARKER);
  await w.write(JSON.stringify({ version, at: new Date().toISOString() }));
  await w.close();
}

// Writing into OPFS. The page's own writer (createWritable) reached Safari only in version 26; older iPhones and
// iPads (iOS 15.2-18) have just the sync access handles of workers. There the bytes go to a small worker that
// opens each file by its path (file handles don't cross threads in every browser) and writes them in order.
// openWriter(path in the game folder) -> { write(Uint8Array | Blob | string), close(), abort() }. A writer that
// fails part way must be aborted: a sync handle keeps its file locked until closed. ?syncwrite forces the worker.
let opfsWorker = null, opfsSeq = 0;
const opfsPending = new Map();
function opfsWriterWorker() {
  const files = new Map();
  let chain = Promise.resolve();   // one operation at a time: overlapping opens hung now and then (Chrome, ~1 in 1000)
  onmessage = (e) => { chain = chain.then(() => run(e.data)); };
  const run = async (m) => {
    try {
      if (m.op === 'open') {
        let dir = await navigator.storage.getDirectory();
        const parts = m.path.split('/');
        for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
        const h = await (await dir.getFileHandle(parts[parts.length - 1], { create: true })).createSyncAccessHandle();
        await h.truncate(0);   // (Safari before 17: truncate, flush and close return promises)
        files.set(m.w, { h, at: 0 });
      } else if (m.op === 'write') {
        const f = files.get(m.w);
        f.at += f.h.write(new Uint8Array(m.data), { at: f.at });
      } else if (m.op === 'close') {
        const f = files.get(m.w);
        files.delete(m.w);
        if (f) { await f.h.flush(); await f.h.close(); }
      }
      postMessage({ id: m.id });
    } catch (err) { postMessage({ id: m.id, error: String((err && err.message) || err) }); }
  };
}
function opfsCall(msg, transfer) {
  if (!opfsWorker) {
    opfsWorker = new Worker(URL.createObjectURL(new Blob(['(' + opfsWriterWorker.toString() + ')()'], { type: 'text/javascript' })));
    opfsWorker.onmessage = (e) => {
      const p = opfsPending.get(e.data.id);
      opfsPending.delete(e.data.id);
      if (p) e.data.error ? p.rej(new Error(e.data.error)) : p.res();
    };
  }
  // a call that never answers (a storage stall) restarts the worker, which drops every lock it held, and fails the
  // calls in flight: the download's own retries then write those files again
  return new Promise((res, rej) => {
    const id = ++opfsSeq;
    const t = setTimeout(() => {
      console.warn('OPFS writer stalled: restarting it');
      opfsWorker?.terminate(); opfsWorker = null;
      const all = [...opfsPending.values()]; opfsPending.clear();
      for (const p of all) p.rej(new Error('storage writer stalled'));
    }, 30000);
    opfsPending.set(id, { res: () => { clearTimeout(t); res(); }, rej: (e) => { clearTimeout(t); rej(e); } });
    opfsWorker.postMessage(Object.assign({ id }, msg), transfer || []);
  });
}
const pageWriter = () => typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype && !params.has('syncwrite');
async function openWriter(relPath) {
  if (pageWriter()) {
    const w = await (await fileHandle(await gameDir(true), relPath, true)).createWritable();
    return { write: (d) => w.write(d), close: () => w.close(), abort: () => w.abort().catch(() => {}) };
  }
  const id = ++opfsSeq;
  await opfsCall({ op: 'open', w: id, path: OPFS_DIR + '/' + relPath });
  const put = (u8) => { const c = u8.slice(); return opfsCall({ op: 'write', w: id, data: c.buffer }, [c.buffer]); };
  return {
    async write(d) {
      if (typeof d === 'string') return put(new TextEncoder().encode(d));
      if (d instanceof Blob) { for (let o = 0; o < d.size; o += 8 << 20) await put(new Uint8Array(await d.slice(o, o + (8 << 20)).arrayBuffer())); return; }
      return put(d instanceof Uint8Array ? d : new Uint8Array(d));
    },
    close: () => opfsCall({ op: 'close', w: id }),
    abort: () => opfsCall({ op: 'close', w: id }).catch(() => {}),
  };
}

async function fileHandle(dir, relPath, create) {
  const parts = relPath.split('/');
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create });
  return dir.getFileHandle(parts[parts.length - 1], { create });
}

// A browser low on space can evict some of the game's files to reclaim it while leaving the rest (and the
// install marker) in place: the folder then looks complete, but a mission whose files were dropped is stuck
// loading for good (the field reports of "can't start mission 2 after mission 1": a later mission's files are
// the ones evicted). List what is actually in the folder and return the manifest entries that are missing, so
// the start can fetch them back. Names are compared case-insensitively (the host maps them that way). A healthy
// install walks the folder once and returns nothing; no files are opened.
async function missingFiles(list) {
  let dir;
  try { dir = await gameDir(false); } catch { return list.slice(); }
  if (typeof dir.values !== 'function') return [];   // no folder listing in this browser: can't check, trust it
  const present = new Set();
  const walk = async (handle, prefix) => {
    for await (const entry of handle.values()) {
      const rel = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.kind === 'directory') await walk(entry, rel);
      else present.add(rel.toLowerCase());
    }
  };
  try { await walk(dir, ''); } catch { return []; }   // a listing that failed midway must not re-download everything
  return list.filter((e) => !present.has(e.path.toLowerCase()));
}

// installer leftovers the game never reads: not worth copying into the browser
// and dot-files (server config such as .htaccess, which the server refuses with 403: listed in the hosted manifest
// once, every fresh install retried it forever at 99 %, 2026-11-01)
const SKIP = /^(directx[^/]*\/|.*\.(mp4|ds_store)$)|(^|\/)\.[^/]*$/i;

// Multiplayer needs the multiplayer maps: fetch the ones this browser doesn't have yet (files already at the
// right size are skipped, so after the first time this is a quick check).
async function ensureMultiplayer() {
  const full = await hostedManifest();
  if (!full) return;   // a picked folder: it has whatever the player's copy has
  const mp = full.filter((e) => MP_FILES.test(e.path));
  if (!mp.length) return;
  show('loading');
  await importFromServer(mp, { marker: false, label: 'Loading the multiplayer maps (once)…' });
}
async function importFromPicker(fileList) {
  // the whole folder, minus its own name: <picked>/a/b.dat -> a/b.dat
  const list = [...fileList].map((f) => ({ f, dest: f.webkitRelativePath.split('/').slice(1).join('/') }))
    .filter((e) => e.dest && !SKIP.test(e.dest));
  if (!list.some((e) => e.dest.toLowerCase() === 'igi2.exe'))
    throw new Error('No igi2.exe in that folder: pick the IGI 2: Covert Strike folder itself.');
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry(OPFS_DIR, { recursive: true }); } catch {}
  await askPersist();
  const dir = await gameDir(true);
  const total = list.reduce((s, e) => s + e.f.size, 0);
  let done = 0;
  $('progress').classList.remove('hidden');
  for (const e of list) {
    status(`Copying ${e.dest} (${mb(done)} / ${mb(total)} MB)`);
    const w = await openWriter(e.dest);
    try { await w.write(e.f); await w.close(); } catch (err) { await w.abort(); throw err; }
    done += e.f.size;
    $('progress').value = done / total;
  }
  const sig = list.map((e) => `${e.dest}:${e.f.size}`).sort().join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sig));
  await writeMarker([...new Uint8Array(digest)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join(''));
  $('progress').classList.add('hidden');
}

// A hosted copy of the game folder: web/serve.py --game DIR serves it at game/, with game/manifest.json
// listing [{ path, size }]. Each file streams straight into OPFS (a phone couldn't hold 500 MB in memory),
// and files already there at the right size are kept, so an interrupted download resumes where it stopped.
// Ask for persistent storage, but never wait on a browser that doesn't answer (the IGI 2 site sat at "Checking
// your browser" for good in one where the request never settled).
const askPersist = () => Promise.race([navigator.storage.persist?.(), new Promise((r) => setTimeout(r, 3000))]).catch(() => {});
// a short fingerprint of a file list (paths and sizes): the install marker's version, compared on later visits
async function listDigest(list) {
  const sig = list.map((e) => `${e.path}:${e.size}`).sort().join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sig));
  return [...new Uint8Array(digest)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
}
// The multiplayer maps (273 MB) are only needed online: the first install leaves them out and the Multiplayer
// start fetches them (ensureMultiplayer), so single-player visitors download 1.36 GB instead of 1.64 GB.
const MP_FILES = /^missions\/multiplayer\//i;
const baseList = (list) => list.filter((e) => !MP_FILES.test(e.path));
async function hostedManifest() {
  try {
    const r = await fetch('game/manifest.json');
    if (!r.ok) return null;
    const list = (await r.json()).filter((e) => !SKIP.test(e.path));
    return list.some((e) => e.path.toLowerCase() === 'igi2.exe') ? list : null;
  } catch { return null; }
}

// The game folder is served through a CDN (Cloudflare) that caches it on an edge near the player, so one
// host is already fast: the files are pulled by a pool of workers over the browser's single multiplexed
// HTTP/2 connection. Each streams straight into OPFS and files already at the right size are skipped, so an
// interrupted download resumes where it stopped.
const DL_CONCURRENCY = 10;
async function importFromServer(list, opts = {}) {
  const stopTips = startTips($('tips'));
  try {
    try { await importFromServerInner(list, opts); }
    catch (err) {
      // A browser short of storage evicts files behind the folder's back: entries still listed can't be opened
      // ("could not be found at the time an operation was processed"), and a download over such a folder
      // fails the same way. Start over from an empty folder once; anything else (network) is reported.
      if (!(err && (err.name === 'NotFoundError' || /could not be found/.test(err.message || '')))) throw err;
      console.warn('the game folder is inconsistent, downloading again from scratch:', err.message);
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(OPFS_DIR, { recursive: true }).catch(() => { /* already gone */ });
      await importFromServerInner(list, opts);
    }
  } finally {
    stopTips();
  }
}
async function importFromServerInner(list, opts = {}) {
  await askPersist();
  // keep the screen on while downloading: a phone that dims and locks freezes the page, and its connections drop
  let wake = null;
  const lockScreen = async () => { try { if (!document.hidden && navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch { /* not allowed: fine */ } };
  const relock = () => { if (!document.hidden && (!wake || wake.released)) lockScreen(); };
  await lockScreen();
  document.addEventListener('visibilitychange', relock);
  try { await importFiles(list, opts); }
  finally { document.removeEventListener('visibilitychange', relock); try { await wake?.release(); } catch { /* gone */ } }
}
async function importFiles(list, opts) {
  const dir = await gameDir(true);
  const total = list.reduce((s, e) => s + e.size, 0);
  let done = 0, shownAt = 0;
  // bytes of the files still arriving, for the display only: the biggest files go first and one of IGI 2's is
  // 56 MB, so counting finished files alone left the screen at "Checking your browser…" and 0 % for a minute
  const inflight = new Map();
  const startT = performance.now();
  let baseDone = null, baseT = 0;   // a steady-state anchor (set after ~1.5s) so the ETA isn't noisy at the start
  $('progress').classList.remove('hidden');
  const etaText = (secs) => {
    secs = Math.round(secs);
    if (secs >= 110) return `about ${Math.round(secs / 60)} minutes left`;
    if (secs >= 50) return 'about a minute left';
    if (secs >= 18) return `about ${Math.round(secs / 10) * 10} seconds left`;
    return 'a few seconds left';
  };
  const shown = (force) => {
    const now = performance.now();
    if (!force && now - shownAt < 120) return;   // several workers report at once; don't thrash the DOM
    shownAt = now;
    let got = done;
    for (const b of inflight.values()) got += b;
    status(`${opts.label || 'Loading necessary files to start the game…'} ${Math.floor((got / total) * 100)}%${reconnecting ? ' (connection lost, reconnecting…)' : ''}`);
    $('progress').value = got / total;
    if (baseDone === null && now - startT > 1500) { baseDone = got; baseT = now; }
    if (baseDone !== null && got < total) {
      const rate = (got - baseDone) / Math.max(0.5, (now - baseT) / 1000);   // bytes/s, steady-state
      // only a time estimate, not the download size (a big MB figure just worries people)
      if (rate > 60000) { $('eta').textContent = etaText((total - got) / rate); $('eta').classList.remove('hidden'); }
    }
  };
  // done is counted per completed file (not per chunk): several workers run at once, so a per-chunk counter
  // couldn't be reset cleanly when a file is retried. 1955 files make the per-file progress fine-grained.
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  let reconnecting = 0;   // files waiting to retry after a network error (shown in the status)
  // offline (a phone between cells, Wi-Fi to mobile data): wait for the network instead of spending the retries
  const waitOnline = (ms) => navigator.onLine !== false ? Promise.resolve() : new Promise((res) => {
    const done = () => { clearTimeout(t); window.removeEventListener('online', done); res(); };
    const t = setTimeout(done, ms);
    window.addEventListener('online', done);
  });

  shown(true);   // the status says "loading" from the first moment, not when the first (big) file is done
  // big files first, so the pool packs well and the slowest file isn't left for last
  const queue = list.slice().sort((a, b) => b.size - a.size);

  const fetchInto = async (e) => {
    // no-store: don't also keep a copy in the browser's HTTP cache (OPFS is the permanent store); the CDN
    // edge cache still serves these, so repeat loads stay fast.
    // A connection the shared host leaves hanging never ends and never errors, and a download then stops at
    // some percentage for good (seen at 42% and 60%): abort a fetch that brings nothing for 30 s and retry it.
    const ac = new AbortController();
    let stallTimer = setTimeout(() => ac.abort(), 30000);
    const alive = () => { clearTimeout(stallTimer); stallTimer = setTimeout(() => ac.abort(), 30000); };
    try {
      const r = await fetch('game/' + e.path.split('/').map(encodeURIComponent).join('/'), { cache: 'no-store', signal: ac.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const w = await openWriter(e.path);
      const reader = r.body.getReader();
      let wrote = 0, closed = false;
      try {
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) break;
          alive();
          await w.write(value);
          wrote += value.length;
          inflight.set(e.path, wrote); shown();
        }
        await w.close(); closed = true;
      } finally { if (!closed) await w.abort(); }
      if (wrote !== e.size) throw new Error(`short read ${wrote}/${e.size}`);
    } finally { clearTimeout(stallTimer); inflight.delete(e.path); }
  };

  const worker = async () => {
    for (;;) {
      const e = queue.shift();
      if (!e) return;
      const fh = await fileHandle(dir, e.path, true);
      if ((await fh.getFile()).size === e.size) { done += e.size; shown(); continue; }
      // Fetch with retries: a dropped or truncated connection (ERR_CONTENT_LENGTH_MISMATCH, a short body) must
      // not leave a wrong-sized file that later breaks a mission, re-fetch until the written size is exact.
      // Phones lose the network for seconds at a time (a cell handover, Wi-Fi to mobile data): six retries over
      // six seconds ended downloads with "Failed to fetch" (2026-11-06, Infinix Hot 30). Now about two minutes
      // of retries, growing apart, with the time offline not counted.
      let ok = false, lastErr;
      for (let attempt = 0; attempt < 12 && !ok; attempt++) {
        try { await fetchInto(e); ok = true; }
        catch (err) {
          lastErr = err;
          if (attempt === 11) break;
          reconnecting++; shown(true);
          try {
            await waitOnline(5 * 60000);
            await sleep(Math.min(15000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5));
          } finally { reconnecting--; }
        }
      }
      if (!ok) throw new Error(`Download failed at ${e.path} (${lastErr?.message}). Reload the page to resume where it stopped.`);
      done += e.size; shown();
    }
  };
  // a pool of workers over the one connection; if any throws it surfaces (and the others settle) so a reload can resume
  const workers = Array.from({ length: Math.min(DL_CONCURRENCY, list.length) }, () => worker());
  await Promise.all(workers);
  shown(true);
  if (opts.marker !== false) await writeMarker(await listDigest(list));
  $('progress').classList.add('hidden');
  $('eta').classList.add('hidden');
}

// ------------------------------------------------------------------ input

// KeyboardEvent.code -> USB HID usage (what host/input.c's key table uses)
const HID = {};
for (let i = 0; i < 26; i++) HID['Key' + String.fromCharCode(65 + i)] = 4 + i;
for (let i = 1; i <= 9; i++) HID['Digit' + i] = 29 + i;
HID.Digit0 = 39;
Object.assign(HID, {
  Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44, Minus: 45, Equal: 46, BracketLeft: 47, BracketRight: 48,
  Backslash: 49, Semicolon: 51, Quote: 52, Backquote: 53, Comma: 54, Period: 55, Slash: 56, CapsLock: 57,
  PrintScreen: 70, ScrollLock: 71, Pause: 72, Insert: 73, Home: 74, PageUp: 75, Delete: 76, End: 77, PageDown: 78,
  ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82, NumLock: 83, NumpadDivide: 84, NumpadMultiply: 85,
  NumpadSubtract: 86, NumpadAdd: 87, NumpadEnter: 88, Numpad0: 98, NumpadDecimal: 99,
  ControlLeft: 224, ShiftLeft: 225, AltLeft: 226, MetaLeft: 227, ControlRight: 228, ShiftRight: 229, AltRight: 230, MetaRight: 231,
});
for (let i = 1; i <= 12; i++) HID['F' + i] = 57 + i;
for (let i = 1; i <= 9; i++) HID['Numpad' + i] = 88 + i;

// Netplay: the keyboard drives this player's pad (the game itself gets no keys or mouse, which would desync).
// Bit 4 is LB, which the game sees as L1: its modifier for lofted shots (the in-game tutorial: "L1 + shot
// button" to hit a six; on the keyboard that's Shift), so Shift holds it as well as Q. The game pauses only
// on the keyboard's Esc, not the pad's Start, so Esc is bit 20: host/netplay.c applies it to the DirectInput
// keyboard on every peer, with the pad inputs (NP_KEY_ESC). Backspace is B, back in menus.
const NET_KEYS = {   // KeyboardEvent.code -> standard-gamepad bit (20: Esc key)
  Enter: 0, Space: 0, KeyS: 0, Escape: 20, Backspace: 1, KeyD: 1, KeyA: 2, KeyW: 3, KeyQ: 4, KeyE: 5,
  ShiftLeft: 4, ShiftRight: 4,
  Digit1: 6, Digit3: 7, Tab: 8, KeyP: 9, ArrowUp: 12, ArrowDown: 13, ArrowLeft: 14, ArrowRight: 15,
};
let netKeyBits = 0;
let netKeyPressed = 0;   // keys pressed since the last poll, so a tap shorter than a frame still counts

// ---- Single-player key remapping ----------------------------------------------------------------
// The game's own control bindings (its config.qvm) stay at their defaults; here we translate the
// player's chosen physical keys onto the game's default key for each action, entirely in the browser
// and saved per browser (localStorage), so keys can be rebound without touching the game. Netplay is
// unaffected: online, the keyboard only drives the pad (above), never raw keys.
// Two layouts ("presets"): the game's ORIGINAL keys (arrows, Right Shift, Right Ctrl, numpad; what the game's
// own Configuration screen shows, and what players of the 2000 game remember) and a MODERN WASD layout. The
// original one is the default for new players, as the game ships; a few extra keys stand in for the numpad
// and Right Ctrl that laptops don't have. Keys not listed here reach the game unchanged in both layouts.
// id, label, { original, modern }: default physical KeyboardEvent.code per preset (null = unbound), the game's
// default key for that action (its code), group
const CONTROLS = [
  // IGI 2 reads WASD and the arrow keys at once (its own config), so the defaults send every key as itself;
  // a rebound key is translated to the game's key for that action.
  ['forward', 'Move forward',    { modern: 'KeyW' },        'KeyW',        'Movement'],
  ['back',    'Move backward',   { modern: 'KeyS' },        'KeyS',        'Movement'],
  ['left',    'Strafe left',     { modern: 'KeyA' },        'KeyA',        'Movement'],
  ['right',   'Strafe right',    { modern: 'KeyD' },        'KeyD',        'Movement'],
  ['turnl',   'Turn left',       { modern: 'KeyX' },        'KeyX',        'Movement'],
  ['turnr',   'Turn right',      { modern: 'KeyC' },        'KeyC',        'Movement'],
  ['jump',    'Jump',            { modern: 'Space' },       'Space',       'Movement'],
  ['crouch',  'Crouch (hold)',   { modern: 'ShiftLeft' },   'ShiftLeft',   'Movement'],
  ['raise',   'Raise stance',    { modern: 'KeyQ' },        'KeyQ',        'Movement'],
  ['lower',   'Lower stance',    { modern: 'KeyZ' },        'KeyZ',        'Movement'],
  ['walkrun', 'Walk / run',      { modern: 'CapsLock' },    'CapsLock',    'Movement'],
  ['use',     'Action / use',    { modern: 'KeyE' },        'KeyE',        'Actions & equipment'],
  ['peek',    'Peek',            { modern: 'Backquote' },   'Backquote',   'Actions & equipment'],
  ['bino',    'Binoculars',      { modern: 'KeyB' },        'KeyB',        'Actions & equipment'],
  ['thermal', 'Thermal goggles', { modern: 'KeyT' },        'KeyT',        'Actions & equipment'],
  ['map',     'Map computer',    { modern: 'KeyM' },        'KeyM',        'Actions & equipment'],
  ['zoomin',  'Zoom in',         { modern: 'KeyH' },        'KeyH',        'Actions & equipment'],
  ['zoomout', 'Zoom out',        { modern: 'KeyN' },        'KeyN',        'Actions & equipment'],
  ['log',     'Map: log',        { modern: 'KeyL' },        'KeyL',        'Actions & equipment'],
  ['objs',    'Map: objectives', { modern: 'KeyO' },        'KeyO',        'Actions & equipment'],
  ['hq',      'Map: IGI HQ',     { modern: 'KeyI' },        'KeyI',        'Actions & equipment'],
  ['reload',  'Reload',          { modern: 'KeyR' },        'KeyR',        'Weapons'],
  ['next',    'Next weapon',     { modern: 'KeyF' },        'KeyF',        'Weapons'],
  ['prev',    'Previous weapon', { modern: 'KeyV' },        'KeyV',        'Weapons'],
  ['drop',    'Drop weapon',     { modern: 'KeyG' },        'KeyG',        'Weapons'],
  ['inv',     'Inventory',       { modern: 'Digit0' },      'Digit0',      'Weapons'],
];
const PRESETS = { modern: 'Default (WASD, as the game ships)' };
const CONTROL_STORE = 'igi2-controls';
const PRESET_STORE = 'igi2-preset';
let preset = 'modern';
// how a KeyboardEvent.code reads on screen
function keyLabel(code) {
  if (!code) return '-';
  const m = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl',
    ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', AltLeft: 'L-Alt', AltRight: 'R-Alt', Space: 'Space',
    Enter: 'Enter', NumpadEnter: 'Num ⏎', Tab: 'Tab', Escape: 'Esc', Backspace: '⌫', CapsLock: 'Caps',
    PageUp: 'PgUp', PageDown: 'PgDn', Home: 'Home', End: 'End', Insert: 'Ins', Delete: 'Del',
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  };
  if (m[code]) return m[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  return code;
}
let userKeys = {};   // id -> physical KeyboardEvent.code
let keyRemap = {};   // physical code -> HID usage to send to the game
function rebuildRemap() {
  keyRemap = {};
  for (const [id, , , target] of CONTROLS) {
    const phys = userKeys[id], u = HID[target];
    if (phys && u !== undefined) keyRemap[phys] = u;
  }
}
function loadControls() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(CONTROL_STORE) || '{}') || {}; } catch { saved = {}; }
  try { if (PRESETS[localStorage.getItem(PRESET_STORE)]) preset = localStorage.getItem(PRESET_STORE); } catch { /* storage blocked */ }
  userKeys = {};
  for (const [id, , def] of CONTROLS) userKeys[id] = typeof saved[id] === 'string' || saved[id] === null ? saved[id] : def[preset];
  rebuildRemap();
}
function saveControls() {
  try { localStorage.setItem(CONTROL_STORE, JSON.stringify(userKeys)); localStorage.setItem(PRESET_STORE, preset); } catch { /* storage blocked */ }
}
function applyPreset(name) {
  preset = PRESETS[name] ? name : 'modern';
  for (const [id, , def] of CONTROLS) userKeys[id] = def[preset];
  saveControls(); rebuildRemap();
}
// Players without a saved choice get the Modern (WASD) layout: earlier players were moved to WASD, new ones got the
// game's own keys (arrows and the numpad, which most laptops lack), so two players saw different "defaults"
// (2026-10-31). A saved choice is never changed.
function migratePreset(installed) {
  let had = false;
  try { had = localStorage.getItem(PRESET_STORE) !== null; } catch { /* storage blocked */ }
  if (had) return;
  let custom = false;
  try { custom = localStorage.getItem(CONTROL_STORE) !== null; } catch { /* storage blocked */ }
  if (custom) { preset = 'modern'; saveControls(); loadControls(); }
  else applyPreset('modern');
  void installed;
  setupControls.render?.();
}
loadControls();

// The keyboard panel (index.html #kbd) doubles as the rebind UI: click a key, then press the new one.
function setupControls() {
  const host = $('kbd-binds');
  if (!host) return;
  let capturing = null;   // id being rebound
  const groups = [];
  for (const c of CONTROLS) {
    let g = groups.find((x) => x.name === c[4]);
    if (!g) groups.push(g = { name: c[4], items: [] });
    g.items.push(c);
  }
  const render = () => {
    host.innerHTML = '<p class="kbd-note">The game\'s own keys: WASD to move, Shift crouch, Space jump, R reload, ' +
      'E action, 1-9 weapons. Arrow keys also move. Click a key below and press a new one to change it ' +
      '(Backspace unbinds); it works in the game and in its menus.</p>' +
      groups.map((g) =>
      `<h3>${g.name}</h3>` + g.items.map(([id, label]) =>
        `<div class="row"><span class="label">${label}</span>` +
        `<button class="kbd-rebind${capturing === id ? ' capturing' : ''}" data-id="${id}">` +
        `${capturing === id ? 'press…' : keyLabel(userKeys[id])}</button></div>`).join('')).join('');
    host.querySelectorAll('.kbd-rebind').forEach((b) => {
      b.onclick = () => { capturing = capturing === b.dataset.id ? null : b.dataset.id; render(); };
    });
    host.querySelectorAll('.kbd-preset button').forEach((b) => {
      b.onclick = () => { applyPreset(b.dataset.preset); capturing = null; render(); };
    });
  };
  setupControls.render = render;
  // While rebinding, grab the next key in the capture phase so it reaches neither the page nor the game.
  window.addEventListener('keydown', (e) => {
    if (!capturing) return;
    e.preventDefault(); e.stopPropagation();
    if (e.code === 'Backspace' || e.code === 'Delete') { userKeys[capturing] = null; saveControls(); rebuildRemap(); }   // unbind
    else if (e.code !== 'Escape' && HID[e.code] !== undefined) { userKeys[capturing] = e.code; saveControls(); rebuildRemap(); }
    capturing = null; render();
  }, true);
  // Mouse buttons and sensitivity (controls.js): which action each button does in a mission, and a multiplier
  // on the mouse motion on top of the game's own sensitivity setting.
  const mouseHost = $('kbd-mouse');
  const renderMouse = () => {
    if (!mouseHost) return;
    const C = RcControls, s = C.get();
    const sel = (btn) => `<select data-btn="${btn}">` + C.MOUSE_CHOICES.map((a) =>
      `<option value="${a}"${s.mouse[btn] === a ? ' selected' : ''}>${C.ACTIONS[a].label}</option>`).join('') + '</select>';
    const wsel = '<select data-wheel="1">' + Object.entries(C.WHEEL_CHOICES).map(([k, label]) =>
      `<option value="${k}"${s.wheel === k ? ' selected' : ''}>${label}</option>`).join('') + '</select>';
    mouseHost.innerHTML = '<h3>Mouse</h3>' +
      `<div class="row"><span class="label">Left</span>${sel(0)}</div>` +
      `<div class="row"><span class="label">Right</span>${sel(2)}</div>` +
      `<div class="row"><span class="label">Middle</span>${sel(1)}</div>` +
      `<div class="row"><span class="label">Wheel</span>${wsel}</div>` +
      `<div class="row"><span class="label">Sensitivity</span><output data-for="mouseSens">${s.mouseSens.toFixed(1)}×</output></div>` +
      `<input class="kbd-range" type="range" min="0.2" max="4" step="0.1" value="${s.mouseSens}" data-k="mouseSens" aria-label="Mouse sensitivity">` +
      `<div class="row"><span class="label">Zoomed</span><output data-for="scopeSens">${s.scopeSens.toFixed(1)}×</output></div>` +
      `<input class="kbd-range" type="range" min="0.3" max="3" step="0.1" value="${s.scopeSens}" data-k="scopeSens" aria-label="Zoomed sensitivity">` +
      `<label class="row kbd-check"><span class="label">Invert look up / down</span><input type="checkbox" data-c="invertY"${s.invertY ? ' checked' : ''}></label>` +
      `<label class="row kbd-check"><span class="label">Raw mouse (no OS acceleration)</span><input type="checkbox" data-c="rawMouse"${s.rawMouse ? ' checked' : ''}></label>` +
      '<h3>Screen</h3><div class="seg kbd-preset kbd-wide">' +
      `<button type="button" data-wide="1"${s.wide ? ' class="on"' : ''}>Full screen (wide)</button>` +
      `<button type="button" data-wide="0"${!s.wide ? ' class="on"' : ''}>Original 4:3</button></div>` +
      '<p class="kbd-note">Wide: in fullscreen the game fills a widescreen display with a wider view; menus stay 4:3.' +
      (s.wide !== window.RC_WIDE_RUNNING && document.body.classList.contains('playing') ? ' <b>Applies the next time the game starts: reload the page and press Play.</b>' : '') + '</p>' +
      '<div class="row"><span class="label">Picture quality</span></div><div class="seg kbd-preset kbd-gfx">' +
      [['auto', 'Auto'], ['standard', 'Standard'], ['sharp', 'Sharp'], ['ultra', 'Ultra']].map(([v, t]) => `<button type="button" data-gfx="${v}"${(s.gfx || 'auto') === v ? ' class="on"' : ''}>${t}</button>`).join('') + '</div>' +
      '<p class="kbd-note">Sharp keeps the ground, roads and walls crisp into the distance. Ultra also smooths every edge by drawing the picture larger than the screen: it needs a good graphics card. Applies at once. ' +
      'The game\'s own Options, Video screen works too: Texture filtering, Anisotropic and Antialiasing x2 / x4.</p>' +
      `<div class="row"><span class="label">Brightness</span><output data-for="brightness">${Math.round(s.brightness * 100)}%</output></div>` +
      `<input class="kbd-range" type="range" min="0.6" max="2" step="0.05" value="${s.brightness}" data-k="brightness" aria-label="Brightness">` +
      `<div class="row"><span class="label">Contrast</span><output data-for="contrast">${Math.round(s.contrast * 100)}%</output></div>` +
      `<input class="kbd-range" type="range" min="0.6" max="1.6" step="0.05" value="${s.contrast}" data-k="contrast" aria-label="Contrast">` +
      '<p class="kbd-note">Scenes reading too dark? Raise Brightness, then nudge Contrast until enemies stand out.</p>' +
      '<p class="kbd-note">Right click is the smart scope: the sniper rifles raise their own scope, other weapons bring up the binoculars. ' +
      'Middle click is the game\'s Secondary fire (fire mode, melee). The wheel zooms while zoomed in. Changes apply at once, in the game too.</p>';
    mouseHost.querySelectorAll('select[data-btn]').forEach((e) => { e.onchange = () => RcControls.setMouse(Number(e.dataset.btn), e.value); });
    mouseHost.querySelectorAll('select[data-wheel]').forEach((e) => { e.onchange = () => RcControls.set('wheel', e.value); });
    mouseHost.querySelectorAll('.kbd-wide button').forEach((b) => { b.onclick = () => { RcControls.set('wide', b.dataset.wide === '1'); renderMouse(); }; });
    mouseHost.querySelectorAll('.kbd-gfx button').forEach((b) => { b.onclick = () => { RcControls.set('gfx', b.dataset.gfx); renderMouse(); }; });
    mouseHost.querySelectorAll('input[type=checkbox][data-c]').forEach((e) => { e.onchange = () => { RcControls.set(e.dataset.c, e.checked); if (e.dataset.c === 'rawMouse') document.exitPointerLock?.(); }; });
    mouseHost.querySelectorAll('input[type=range]').forEach((range) => {
      range.oninput = () => { RcControls.set(range.dataset.k, Number(range.value)); const pct = range.dataset.k === 'brightness' || range.dataset.k === 'contrast'; mouseHost.querySelector(`output[data-for="${range.dataset.k}"]`).textContent = pct ? Math.round(Number(range.value) * 100) + '%' : Number(range.value).toFixed(1) + '×'; };
    });
  };
  const reset = $('kbd-reset');
  if (reset) reset.onclick = () => {
    applyPreset(preset); capturing = null; render();
    RcControls.reset(); renderMouse();
  };
  render();
  renderMouse();
}

// Larger subtitles on phones: the engine reads the game's speech back from the glyphs it draws (host/subtitle.c:
// rc_subtitle, and rc_subtitle_box / rc_subtitle_color for where and in which colour). The page draws the same text
// in the same place, over the game's own lines, in the game's colour, only larger: on the black band in cutscenes,
// in a panel like the game's in play. Only with the touch controls (on a PC the game's text is readable); the
// setting "Large subtitles" turns it off.
function subtitles(M, touch) {
  const box = $('subcap');
  if (!box || !M._rc_subtitle || !touch) return;
  let last = '', lastSeen = 0, lastBox = '';
  const dec = new TextDecoder('latin1');
  const canvas = $('canvas'), stage = $('stage');
  setInterval(() => {
    let text = '', b = null, col = 0;
    try {
      if (RcControls.get().subs) {
        const p = M._rc_subtitle(), mem = new Uint8Array(M.wasmMemory.buffer, p, 512);
        const end = mem.indexOf(0);
        text = dec.decode(mem.slice(0, end < 0 ? 512 : end));
        if (text && M._rc_subtitle_box) { b = Array.from(new Float32Array(M.wasmMemory.buffer, M._rc_subtitle_box(), 5)); col = M._rc_subtitle_color() >>> 0; }
      }
    } catch { text = ''; }
    const now = performance.now();
    if (text) lastSeen = now;
    if (!text) { if (last && now - lastSeen > 500) { last = ''; box.classList.add('hidden'); } return; }
    // the game's screen, centred in the canvas at its own shape: 4:3, or wider in a widescreen mode
    const r = canvas.getBoundingClientRect(), S = stage.getBoundingClientRect();
    const asp = (M._rc_screen_aspect && M._rc_screen_aspect() > 1) ? M._rc_screen_aspect() : 4 / 3;
    const h = Math.min(r.height, r.width / asp), w = h * asp;
    const ox = r.left - S.left + (r.width - w) / 2, oy = r.top - S.top + (r.height - h) / 2;
    const geo = b ? b.map((v) => v.toFixed(3)).join() + '|' + Math.round(w) : '';
    if (text === last && geo === lastBox) return;
    last = text; lastBox = geo;
    const rgb = [(col >> 16) & 255, (col >> 8) & 255, col & 255];
    const green = rgb[1] > 120 && rgb[1] > rgb[0] * 1.4;   // in play the game writes in green in a green panel
    box.className = green ? 'panel' : 'band';
    box.style.color = col ? `rgb(${rgb.join()})` : '';
    const fs = Math.max(14, Math.min(22, h * 0.04));        // about twice the game's size on a phone
    box.style.fontSize = `${fs}px`;
    let x0 = ox + w * 0.05, y0 = oy + h * 0.85, width = w * 0.9, room = h * 0.15;
    if (b && b[2] > b[0]) {
      x0 = Math.max(ox, ox + b[0] * w - 4); y0 = Math.max(oy, oy + b[1] * h - 3);
      width = Math.min(w - (x0 - ox) - 2, Math.max((b[2] - b[0]) * w + 8, w * 0.5));
      // the room the game's own block leaves: to the bottom of the picture on the cutscene band, else twice its height
      room = green ? Math.max((b[3] - b[1]) * h * 2.2, h * 0.16) : oy + h - y0;
    }
    box.style.left = `${x0}px`; box.style.top = `${y0}px`; box.style.width = `${width}px`; box.style.transform = 'none';
    box.textContent = text.replace(/\n/g, ' ');
    // as large as fits that room (about twice the game's size when it fits), never below 14 px (then it grows upwards)
    for (let f = fs; f >= 14; f -= 1) { box.style.fontSize = `${f}px`; if (box.scrollHeight <= room + 1) break; }
    if (box.scrollHeight > room + 1 && !green) box.style.top = `${Math.max(oy, oy + h - box.scrollHeight)}px`;   // still too tall: grow upwards
  }, 120);
}

// An ad while the pause menu the PLAYER opened is up (Esc / MENU pressed in play, then the game paused), never in
// cutscenes or loading (the game reads as paused there too). Placed in the free part of the game's 4:3 picture:
// right of the menu box when there is room for 300x250, else under it (728x90 or 320x50). Gone on resume.
// Also when the mission's script failed the level (the game opens the same menu, Resume greyed out). And between
// missions (2026-11-02): after a minute of play, when the game shows a 2D screen (mission complete, the next
// mission's loading) for 2 s, a closable 300x250 card in the middle (RcBreakAd.card), gone when the mission starts;
// at most one card every 3 minutes.
// Where the pause-menu ads go (2026-11-02): every unit that fits fully on the stage without touching what the
// player needs, in this order. The game's Esc menu box is x 132-509, y 113-377 of its 640x480 screen (measured at
// two window sizes); its text and the "Are you sure?" box stay inside x 236-404. Desktop: a 300x250 right of the
// box, 160x600 in the space left of it and right of the 300x250 (or a second 300x250 under the first), a 728x90
// (else 320x50) under the box. Phones: a 300x250 each side of the menu text, under the top row of touch buttons
// (MENU, MAP, settings stay reachable; the stick and fire buttons do nothing while paused), and a 320x50 under the
// box. Returns how many were placed.
function placePauseAds(touch, canvas, stage) {
  const r = canvas.getBoundingClientRect(), S = stage.getBoundingClientRect();
  const h = Math.min(r.height, (r.width * 3) / 4), w = (h * 4) / 3;
  const ox = r.left - S.left + (r.width - w) / 2, oy = r.top - S.top + (r.height - h) / 2;
  const gx = (x) => ox + (x * w) / 640, gy = (y) => oy + (y * h) / 480;
  const M = 6, keep = [], placed = [];
  const hit = (a, b) => a.x < b.x + b.w + M && b.x < a.x + a.w + M && a.y < b.y + b.h + M && b.y < a.y + a.h + M;
  if (touch) {
    keep.push({ x: gx(236), y: gy(108), w: gx(404) - gx(236), h: gy(382) - gy(108) });   // menu text, confirm box
    document.querySelectorAll('#touch [data-id]').forEach((el) => {   // the top row of touch buttons
      const b = el.getBoundingClientRect();
      if (b.width && b.top + b.height / 2 - S.top < S.height * 0.3) keep.push({ x: b.left - S.left, y: b.top - S.top, w: b.width, h: b.height });
    });
  } else keep.push({ x: gx(132), y: gy(113), w: gx(509) - gx(132), h: gy(377) - gy(113) });   // the whole menu box
  const fits = (u) => u.x >= 4 && u.y >= 4 && u.x + u.w <= S.width - 4 && u.y + u.h <= S.height - 4 &&
    !keep.some((k) => hit(u, k)) && !placed.some((p) => hit(u, p));
  const put = (slot, key, x, y) => {
    const z = window.RcBreakAd.sizes[slot], u = { x: Math.round(x), y: Math.round(y), w: z[0], h: z[1], key };
    if (!fits(u)) return null;
    placed.push(u); window.RcBreakAd.show(stage, slot, u.x, u.y, key); return u;
  };
  const below = { y: gy(377), h: oy + h - gy(377) };
  if (touch) {
    const top = Math.max(8, ...keep.slice(1).map((k) => k.y + k.h)) + 8;
    put('box', 'pl', Math.max(4, (gx(236) - M - 300) / 2), top);
    put('box', 'pr', gx(404) + M + (S.width - gx(404) - M - 300) / 2, top);
    put('mobile', 'pb', ox + (w - 320) / 2, below.y + (below.h - 50) / 2);
    // The two side units overlap the menu box's margins, which the Sound and Controls pages use (labels, sliders,
    // OK/Cancel): they go at the player's first tap on the game while paused. Taps on an ad don't count.
    const side = (e) => {
      if (e.target.closest && e.target.closest('.break-ad')) return;
      window.RcBreakAd.hideKey('pl'); window.RcBreakAd.hideKey('pr');
      stage.removeEventListener('pointerdown', side, true);
    };
    if (placed.some((u) => u.key === 'pl' || u.key === 'pr')) stage.addEventListener('pointerdown', side, true);
    placePauseAds.unhook = () => stage.removeEventListener('pointerdown', side, true);
  } else {
    const bx = put('box', 'br', gx(509) + 12, gy(113));
    put('side', 'sl', (gx(132) - 160) / 2, (S.height - 600) / 2);
    const rs = bx ? bx.x + 300 : gx(509);
    if (!put('side', 'sr', rs + (S.width - rs - 160) / 2, (S.height - 600) / 2) && bx) put('box', 'br2', bx.x, bx.y + 262);
    if (!put('lead', 'bl', ox + (w - 728) / 2, below.y + (below.h - 90) / 2)) put('mobile', 'bm', ox + (w - 320) / 2, below.y + (below.h - 50) / 2);
  }
  return placed.length;
}

function pauseAds(touch) {
  if (!window.RcBreakAd) return;
  let escAt = 0, wasPlaying = false, on = false;
  let card = false, playMs = 0, flatMs = 0, lastCard = -1e9, lastT = performance.now();
  const T = new URLSearchParams(location.search).has('adtest') ? 0.1 : 1;   // ?adtest: the waits below at a tenth (testing)
  const markEsc = () => { if (RcControls.inMission() && !RcControls.paused()) { escAt = performance.now(); wasPlaying = true; } };
  window.addEventListener('keydown', (e) => { if (e.code === 'Escape') markEsc(); }, true);
  pauseAds.menuPressed = markEsc;   // the touch MENU button (touch.js through RcControls.act('menu'))
  const canvas = $('canvas'), stage = $('stage');
  setInterval(() => {
    const now = performance.now(), dt = Math.min(1000, now - lastT); lastT = now;
    const paused = RcControls.paused();
    // between missions: the world isn't drawn (zoom 0) and no menu is over a mission
    const world = RcControls.world();
    if (world || paused) { flatMs = 0; if (card) { card = false; window.RcBreakAd.hide(); } }
    if (RcControls.inMission()) playMs += dt;
    if (window.rcExited) return;   // the game quit: its panel is up, no ads over it
    if (!world && !paused && !on) {
      flatMs += dt;
      if (!card && playMs >= 60000 * T && flatMs >= 2000 * T && now - lastCard >= 180000 * T && !document.hidden) {
        const stage2 = $('stage');
        if (window.RcBreakAd.card(stage2)) { card = true; lastCard = now; playMs = 0; }
      }
      return;
    }
    if (card && !window.RcBreakAd.showing()) card = false;   // closed by the player
    if (on && !paused) { on = false; window.RcBreakAd.hide(); if (placePauseAds.unhook) placePauseAds.unhook(); return; }
    const failed = paused && RcControls.levelFailed && RcControls.levelFailed();
    if (!on && paused && (failed || (wasPlaying && performance.now() - escAt < 2000))) {
      wasPlaying = false;
      on = placePauseAds(touch, canvas, stage) > 0;
    }
  }, 300);
}

function hookInput(M, net) {
  const canvas = $('canvas');
  if (net) {
    const key = (down) => (e) => {
      const bit = NET_KEYS[e.code];
      if (bit === undefined) return;
      e.preventDefault();
      if (down) { netKeyBits |= 1 << bit; netKeyPressed |= 1 << bit; } else netKeyBits &= ~(1 << bit);
      pollLocalPad(M);   // straight to the game: waiting for the next animation frame would add up to 16 ms
    };
    window.addEventListener('keydown', key(true));
    window.addEventListener('keyup', key(false));
    window.addEventListener('blur', () => { netKeyBits = 0; pollLocalPad(M); });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    return;
  }
  const C = RcControls;
  C.attach(M);
  const key = (down) => (e) => {
    const u = keyRemap[e.code] !== undefined ? keyRemap[e.code] : HID[e.code];
    if (u === undefined) return;
    // the browser's own action is stopped for auto-repeats too: a held Tab (USE in the Modern layout) moved the
    // focus on every repeat, into an ad frame in a window, and the key's release then never came (Activate stuck)
    if (!(e.metaKey && !down)) e.preventDefault();
    if (e.repeat) return;
    if (down) heldKeys.add(u); else heldKeys.delete(u);
    C.keyUsage(u, down);   // a weapon key drops the scope state (controls.js)
    M._input_key_hid(u, down ? 1 : 0);
  };
  // keys still held when the page loses the keyboard (focus to another window or a frame, the tab hidden) are
  // released: their keyup goes elsewhere, and the game would keep them down
  const heldKeys = new Set();
  const releaseKeys = () => { for (const u of heldKeys) M._input_key_hid(u, 0); heldKeys.clear(); };
  window.addEventListener('blur', releaseKeys);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseKeys(); });
  window.addEventListener('keydown', key(true));
  window.addEventListener('keyup', key(false));
  // The game draws its own cursor and reads relative motion. Lock the pointer when the browser allows
  // it (then the system cursor can't leave the game); without a lock, motion over the canvas still works.
  // Each button does the action the player bound to it (controls.js; the Controls panel): in a mission
  // only, the menus always get the plain click. The action a press started is what its release ends, even
  // if the binding or the mission state changed in between.
  const held = {};
  // The pointer lock, with unaccelerated motion when the player wants it (Chrome / Edge: the OS's pointer
  // acceleration is what makes browser aiming feel unlike the game on Windows, which reads DirectInput's raw
  // counts). Browsers without it refuse the option: then a plain lock.
  const lock = () => {
    if (document.pointerLockElement === canvas || !canvas.requestPointerLock) return;
    let p;
    try { p = canvas.requestPointerLock(C.get().rawMouse ? { unadjustedMovement: true } : undefined); } catch { p = null; }
    if (p && p.catch) p.catch(() => { const q = canvas.requestPointerLock(); if (q && q.catch) q.catch(() => {}); });
    else if (!p && C.get().rawMouse) { /* old API: no promise, the option is ignored */ }
  };
  canvas.addEventListener('mousedown', (e) => {
    if (document.pointerLockElement !== canvas) lock();
    if (held[e.button]) C.act(held[e.button], false);
    held[e.button] = C.mouseAction(e.button);
    C.act(held[e.button], true);
  });
  window.addEventListener('mouseup', (e) => { if (held[e.button]) { C.act(held[e.button], false); held[e.button] = null; } });
  // Without the pointer lock the mouse stops at the window's edge, so the view can only turn so far ("the
  // mouse only works 180 degrees"). Esc (the game's menu) always releases the lock, and not every player
  // clicks again afterwards: take it back on the next key press (a user gesture, which the lock needs) while
  // a mission is running, and say so on screen meanwhile.
  const relock = () => {
    if (!C.inMission() || C.paused() || document.pointerLockElement === canvas) return;
    lock();
  };
  window.addEventListener('keydown', (e) => { if (!e.repeat && e.code !== 'Escape') relock(); });
  const locktip = $('locktip');
  if (locktip && !RcTouch.wanted()) setInterval(() => {
    locktip.classList.toggle('hidden', !(C.inMission() && !C.paused() && document.pointerLockElement !== canvas && document.hasFocus()));
  }, 500);
  // Relative motion, scaled by the mouse sensitivity setting in a mission (fractions carry over, so 1 = the
  // raw counts as before). The engine (dinput.c) inverts look-Y only during a mission, so the 2D menus keep
  // their normal cursor direction.
  canvas.addEventListener('mousemove', (e) => {
    if (document.body.classList.contains('ad-open')) return;   // an ad is up: the real mouse pointer is back so its close button can be clicked
    if (!C.inMission()) { M._input_mouse_move(e.movementX, e.movementY); return; }
    const k = C.get().mouseSens * C.lookScale();   // slower while scoped, in step with the zoom
    C.look(e.movementX * k, e.movementY * k);
  });
  // An ad is covering the game: Esc closes it before anything else (the game's menu, or leaving full screen), so a
  // player no longer has to press the Windows key or drop full screen to get rid of it. Capture phase, so it runs
  // ahead of the engine's own Esc; swallowed only while an ad is actually showing.
  window.addEventListener('keydown', (e) => {
    try { if (e.code === 'Escape' && window.RcBreakAd && window.RcBreakAd.showing && window.RcBreakAd.showing()) {
      window.RcBreakAd.hide(); e.preventDefault(); e.stopImmediatePropagation(); } } catch { /* no ads */ }
  }, true);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  // The wheel: the game's own (zoom while scoped or with the binoculars, else it cycles the actions on offer),
  // or the weapons (the player's choice). Notches are counted from the scroll distance so trackpads and
  // high-resolution wheels give one notch per detent, not a burst.
  let wheelAcc = 0;
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const px = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
    wheelAcc += px;
    let n = 0;
    while (Math.abs(wheelAcc) >= 50 && n < 4) { C.wheelNotch(wheelAcc < 0); wheelAcc -= Math.sign(wheelAcc) * 100; n++; }
    if (Math.abs(wheelAcc) < 50 && n) wheelAcc = 0;
  }, { passive: false });
}

// Gamepads (Gamepad API, polled every animation frame). Browsers only expose a pad after a button press
// on it. The game sees each pad as a DirectInput "Logitech Dual Action USB" (host/dinput.c); ?pads=N exposes
// N of them (default 1, at most 4). Like the native feeder (host/window.c), slots are DirectInput pad
// numbers handed out in connection order, not the browser's gamepad.index (which can start above 0, e.g.
// after a reconnect), and a pad keeps its slot until it is unplugged.
// With mapping 'standard' buttons and axes are already in the layout input_gamepad() takes. Other pads
// (older DirectInput-era ones such as the Logitech Precision) report buttons in HID order, as Windows
// DirectInput presents them and as the game's controltypes.csv expects; their axes are indexed by HID
// usage (X Y Z Rx Ry Rz ...), so the right stick is Z/Rz and Chrome puts the hat switch at axes[9].
const PAD_SLOTS = 4;
const padLast = Array.from({ length: PAD_SLOTS }, () => '');
const padSlotIndex = Array(PAD_SLOTS).fill(-1);   // slot -> gamepad.index
const padHats = new Set();   // gamepad.index of pads whose axes[9] is a hat switch
// raw button n -> standard-layout bit that host/dinput.c turns back into DirectInput button n
const STD_FOR_RAW = [2, 0, 1, 3, 4, 5, 6, 7, 9, 8, 10, 11];
// Chrome's hat axis: -1 = up, then clockwise in steps of 2/7; anything outside [-1, 1] is centred
const HAT_DIRS = [1 << 12, (1 << 12) | (1 << 15), 1 << 15, (1 << 13) | (1 << 15), 1 << 13, (1 << 13) | (1 << 14), 1 << 14, (1 << 12) | (1 << 14)];
const axis16 = (v) => Math.round(Math.max(-1, Math.min(1, v || 0)) * 32767);

function readPad(g) {
  let buttons = 0;
  if (g.mapping === 'standard') {
    g.buttons.forEach((b, i) => { if (i < 17 && (b.pressed || b.value > 0.3)) buttons |= 1 << i; });
    return { buttons, ax: [0, 1, 2, 3].map((i) => axis16(g.axes[i])) };
  }
  g.buttons.forEach((b, i) => { if (i < STD_FOR_RAW.length && (b.pressed || b.value > 0.3)) buttons |= 1 << STD_FOR_RAW[i]; });
  // axes[9] is only taken as a hat once it has shown the centred value, so a plain axis resting at 0 isn't
  // read as d-pad down
  const hat = g.axes[9];
  if (hat > 1.1) padHats.add(g.index);
  else if (padHats.has(g.index) && hat >= -1.01) buttons |= HAT_DIRS[Math.round((hat + 1) * 3.5) % 8];
  const ry = g.axes.length > 5 ? g.axes[5] : g.axes[3];
  return { buttons, ax: [axis16(g.axes[0]), axis16(g.axes[1]), axis16(g.axes[2]), axis16(ry)] };
}

// Netplay: one local pad, the first connected gamepad merged with the keyboard (host/netplay.c sends it).
// Called from the key handlers and from a 1 ms timer (not just the animation frame), so a change reaches
// the game thread within a few ms wherever it is in its frame.
let netLast = '';
function pollLocalPad(M) {
  const g = (navigator.getGamepads ? [...navigator.getGamepads()] : []).find((p) => p && p.connected);
  const { buttons, ax } = g ? readPad(g) : { buttons: 0, ax: [0, 0, 0, 0] };
  const b = buttons | netKeyBits | netKeyPressed;
  netKeyPressed = 0;
  const key = `${b}:${ax.join(',')}`;
  if (key === netLast) return;
  netLast = key;
  M._input_gamepad(0, 1, b, ax[0], ax[1], ax[2], ax[3]);
}

function pollGamepads(M) {
  const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter((g) => g && g.connected) : [];
  // free the slots of unplugged pads, then give new pads the lowest free slot
  for (let s = 0; s < PAD_SLOTS; s++)
    if (padSlotIndex[s] >= 0 && !pads.some((g) => g.index === padSlotIndex[s])) { padHats.delete(padSlotIndex[s]); padSlotIndex[s] = -1; }
  for (const g of pads) {
    if (padSlotIndex.includes(g.index)) continue;
    const s = padSlotIndex.indexOf(-1);
    if (s < 0) break;
    padSlotIndex[s] = g.index;
    console.log(`gamepad ${g.index} -> pad ${s}: ${g.id} (${g.mapping || 'non-standard'} mapping, ${g.buttons.length} buttons, ${g.axes.length} axes)`);
  }
  for (let slot = 0; slot < PAD_SLOTS; slot++) {
    const g = pads.find((p) => p.index === padSlotIndex[slot]);
    const { buttons, ax } = g ? readPad(g) : { buttons: 0, ax: [0, 0, 0, 0] };
    const connected = g ? 1 : 0;
    const key = `${connected}:${buttons}:${ax.join(',')}`;
    if (key === padLast[slot]) continue;
    padLast[slot] = key;
    M._input_gamepad(slot, connected, buttons, ax[0], ax[1], ax[2], ax[3]);
  }
}

// ------------------------------------------------------------------ audio

// The context is made by run() while the Play click still counts as a user gesture, so it usually starts
// right away. Otherwise (?autoplay, a browser that wants a gesture on the game itself) it waits for the next
// click or key on the page, and a hint says so.
function newAudioContext() {
  if (params.has('mute') || !window.AudioContext) return null;
  try { return new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' }); } catch { return null; }
}

async function startAudio(M, ctx) {
  if (!ctx) return;
  await ctx.audioWorklet.addModule('audio-worklet.js');
  const node = new AudioWorkletNode(ctx, 'rc-ring', { outputChannelCount: [2] });
  node.port.postMessage({ memory: M.wasmMemory, ring: M._rc_audio_ring() });
  node.connect(ctx.destination);
  const tip = $('soundtip');
  const sync = () => tip.classList.toggle('hidden', ctx.state === 'running' || ctx.state === 'closed');
  const resume = () => { if (ctx.state !== 'running') ctx.resume().then(sync, sync); };
  // capture phase, so no other handler can keep the gesture from reaching here
  for (const ev of ['pointerdown', 'mousedown', 'keydown', 'touchend'])
    window.addEventListener(ev, resume, { capture: true });
  ctx.onstatechange = () => { sync(); if (ctx.state === 'interrupted') resume(); };   // Safari: interrupted
  resume();
  sync();
}

// ------------------------------------------------------------------ run

const isWebKit = () => /AppleWebKit\//.test(navigator.userAgent) && !/Chrome\/|Chromium\/|Edg\//.test(navigator.userAgent);
// The compact layout (runtime.c RC_MEM_COMPACT) is now the default everywhere, not only on WebKit: with the
// full layout the engine's memory is grown to ~1.8 GB at start (reserved for the game's 32-bit address space,
// mostly never touched), and on Windows that whole size counts as committed memory, which is what pushes an
// 8 GB machine with other things open into paging (the field reports' minute-long whole-process freezes).
// Compact keeps it at ~0.5 GB and grows it only as the game allocates. ?mem=full restores the old layout.
// (2026-10-31: back to WebKit only. Compact on every browser went live with recomp15 on the morning of
// 2026-10-30, the morning players started reporting black screens on Android; reverted until proven on phones.)
// Low-end devices (IGI 2): phones and PCs that report 4 GB of memory or less, and every browser that fell back to
// WebGL 2 (no usable WebGPU: older iPhones and Android phones, blocklisted GPUs). The full layout grows the engine
// to ~1.7 GB at start, past what a 3-4 GB phone gives a tab; there the compact layout (~0.8 GB) is the only one
// that can run, and the canvas is drawn at one pixel per CSS pixel (a quarter of the fill at 2x density).
// ?lite / ?nolite force it either way.
function lowEnd() {
  if (params.has('lite')) return true;
  if (params.has('nolite')) return false;
  return window.RC_RENDERER === 'gl' || (navigator.deviceMemory > 0 && navigator.deviceMemory <= 4);
}
// A game thread died on a script error (build_web.sh: the glue prints "thread trap: " and the stack before the
// error leaves the worker). Until now only the message arrived ("Out of bounds memory access" at boot on some
// iPhones, with no way to tell where): report the stack once.
function threadTrap(t) {
  if (threadTrap.sent || !/^thread trap: /.test(t)) return;
  threadTrap.sent = true;
  const text = String(t).slice(13);
  beacon('thrtrap', { msg: text.slice(0, 300), page: text.slice(300, 600), n: (compactMemory() ? 'compact' : 'full') + (maxMemMb() ? ' max' + maxMemMb() : '') });
}
// The engine's script. A failed download used to end the start with "Error: undefined": the promise was rejected
// with the bare error Event, reported as "[object Event]". Now three tries (the later ones with a fresh URL, past
// a bad cached copy), then a message the player can act on.
async function loadEngineScript(src) {
  for (let i = 0; ; i++) {
    const s = document.createElement('script');
    s.src = i ? src + (src.includes('?') ? '&' : '?') + 'retry=' + i : src;
    const ok = await new Promise((done) => { s.onload = () => done(true); s.onerror = () => done(false); document.head.appendChild(s); });
    if (ok && typeof createRecomp === 'function') return;
    s.remove();
    if (i >= 2) throw new Error('The game engine did not download (' + (ok ? 'bad file' : 'network') + '). Check your connection and reload the page.');
    await new Promise((r) => setTimeout(r, 800 * (i + 1)));
  }
}
// The graphics card name the game shows on its video screen: this device's own GPU, as the browser names it
// (a throwaway WebGL context: the unmasked renderer string is the readable one), tidied to a short plain name.
// Empty when the browser hides it or reports a software renderer; the engine then shows a current card.
function gpuLabel() {
  let s = '';
  try {
    const c = document.createElement('canvas'), gl = c.getContext('webgl2') || c.getContext('webgl');
    const e = gl && gl.getExtension('WEBGL_debug_renderer_info');
    if (e) s = String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL) || '');
    try { gl && gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* none */ }
  } catch { /* no WebGL */ }
  if (/^ANGLE \(/.test(s)) { const parts = s.slice(7, -1).split(', '); s = parts[1] || parts[0] || ''; }
  s = s.replace(/ANGLE Metal Renderer:\s*/i, '').replace(/\bANGLE\b/g, '').replace(/\s+on Vulkan.*$/i, '')
    .replace(/\s+(Direct3D|OpenGL|D3D)\w*.*$/i, '').replace(/\(0x[0-9a-f]+\)/ig, '').replace(/\((TM|R|C)\)/ig, '')
    .replace(/,?\s*or similar/i, '').replace(/[()]/g, ' ').replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length < 4 || /swiftshader|basic render|llvmpipe|software|unknown/i.test(s)) return '';
  return s.slice(0, 44);
}
// A smaller maximum for the engine's memory, in MB (0: the build's own 2 GB): ?maxmem=MB for testing, or the step
// the memory retry left in sessionStorage (see fail).
function maxMemMb() {
  const mb = +params.get('maxmem') || +(() => { try { return sessionStorage.getItem('igi2-maxmem'); } catch { return 0; } })();
  return mb >= 256 ? mb : 0;
}
function compactMemory() {
  const want = params.get('mem');
  // and on phones that report 2 GB or less (2026-11-01: 0 of 9 such Android starts showed a frame; 7 timed out
  // still loading the engine): the full layout's 1.8 GB doesn't fit there, so they had nothing to lose
  const small = navigator.deviceMemory > 0 && navigator.deviceMemory <= 2;
  return want === 'compact' || (want !== 'full' && (isWebKit() || COHORT.on.compact || small || lowEnd()));
}

// The browser dropped the WebGPU device: its GPU process died or restarted (Android Chrome does it when a system
// dialog or another app covers the browser), or the page was pushed out of GPU memory. The renderer rebuilds itself
// on a new device (render_wgpu.c rc_gpu_recover) and the game carries on where it was; this shows a short note
// meanwhile. Only if no new device comes (rcRecoverFailed, or nothing within 20 s while the page is visible) the
// old prompt to reload appears.
// the engine's trap line, if any, for the exit report (rcGameExited)
const trapLines = [];
function engineLine(t) {
  // The guest heap could not grow (runtime.c guest_commit: emscripten_resize_heap failed, then abort()).
  // The device's browser would not give the tab the ~400 MB+ the game needs, so the engine dies during boot
  // and the player is left on a black screen with no word. Both IGI 1 and IGI 2 hit this the same way on a
  // memory-starved device (GE8320 / 3-4 GB phones with little free). Turn it into a clear, actionable message.
  if (/cannot grow the wasm memory/.test(t)) showOutOfMemory();
  if (trapLines.length && trapLines.length < 4) trapLines.push(String(t).slice(0, 200));
  else if (!trapLines.length && /^\*\*\* guest trap at /.test(t)) trapLines.push(String(t).slice(0, 200));
}
let oomShown = false;
function showOutOfMemory() {
  if (oomShown) return;
  oomShown = true;
  try { gpuBeacon('oom', { r: window.RC_RENDERER || 'gpu', n: compactMemory() ? 'compact' : 'full' }); } catch { /* no beacon */ }
  if (document.getElementById('oom')) return;
  const d = document.createElement('div');
  d.id = 'oom';
  d.style.cssText = 'position:fixed;inset:0;z-index:55;display:grid;place-items:center;background:rgba(0,0,0,.94);color:#fff;' +
    'font:16px/1.5 ui-sans-serif,system-ui,sans-serif;text-align:center;padding:24px';
  d.innerHTML = '<div style="max-width:440px"><p style="font-size:20px;margin:0 0 8px">The game ran out of memory</p>' +
    '<p style="opacity:.85;margin:0 0 18px">This device could not give the game enough memory to start, so it stopped before the menu reached the screen. ' +
    'Close your other apps and browser tabs and reload \u2014 on a phone, swipe the other apps away from the recent-apps list and restart the browser first, which frees the most memory. ' +
    'Devices with little free memory may not be able to run the game.</p>' +
    '<button id="oom-reload" style="font:inherit;padding:10px 22px;border-radius:8px;border:0;background:#45cf79;color:#000;font-weight:700">Reload the game</button></div>';
  (document.body || document.documentElement).appendChild(d);
  const b = document.getElementById('oom-reload');
  if (b) b.onclick = () => location.reload();
}

let gpuLostAt = 0, gpuFailTimer = 0, gpuReports = 0;   // reports per page: at most 3 of each (a looping GPU flooded crash.php)
const gpuBeacon = (type, extra) => {
  if (++gpuReports > 6) return;
  try {
    navigator.sendBeacon('crash.php', new Blob([JSON.stringify(Object.assign({ v: 21, eng: ENGINE, x: COHORT.tag, type, ua: navigator.userAgent,
      mem: navigator.deviceMemory || 0, mission: RcControls.inMission() ? 1 : 0, bg: document.hidden ? 1 : 0 }, extra))], { type: 'application/json' }));
  } catch { /* no beacon */ }
};
function gpuReloadPrompt(msg) {
  if ($('gpulost')) return;
  $('gpurestore')?.remove();
  const d = document.createElement('div');
  d.id = 'gpulost';
  d.style.cssText = 'position:fixed;inset:0;z-index:50;display:grid;place-items:center;background:rgba(0,0,0,.92);color:#fff;' +
    'font:16px/1.5 ui-sans-serif,system-ui,sans-serif;text-align:center;padding:24px';
  d.innerHTML = '<div><p style="font-size:20px;margin:0 0 8px">The graphics device was lost</p>' +
    '<p style="opacity:.8;margin:0 0 18px">The browser stopped the game\'s renderer' + (msg ? ' (' + String(msg).replace(/[<>&]/g, '') + ')' : '') +
    ' and could not start it again. Your progress since the last save is lost. If this happens again, close the browser completely' +
    ' (on a phone, swipe it away from the recent apps) and open the site again: after repeated graphics crashes the browser turns' +
    ' graphics off for the site until it restarts.</p>' +
    '<button id="gpulost-reload" style="font:inherit;padding:10px 22px;border-radius:8px;border:0;background:#45cf79;color:#000;font-weight:700">Reload the game</button></div>';
  document.body.appendChild(d);
  // WebGPU that keeps dying: come back on WebGL 2 (remembered like the black-picture rescue); a dying GPU process
  // often still draws through WebGL, and the same WebGPU path would only fail again
  $('gpulost-reload').onclick = () => {
    if (window.RC_RENDERER === 'gl') { location.reload(); return; }
    try { localStorage.setItem(GL_STORE, String(Date.now())); } catch { /* storage blocked: the URL still says so */ }
    const u = new URL(location.href); u.searchParams.set('renderer', 'gl'); u.searchParams.set('autoplay', '1');
    location.replace(u.href);
  };
}
window.rcDeviceLost = (msg, n) => {
  if (!gpuLostAt) gpuLostAt = performance.now();   // the 20 s limit runs from the first loss of a series
  gpuBeacon('gpulost', { msg: String(msg || '').slice(0, 200), n: n || 1 });
  if (!$('gpurestore')) {
    const n = document.createElement('div');
    n.id = 'gpurestore';
    n.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:50;padding:12px 20px;border-radius:10px;' +
      'background:rgba(0,0,0,.8);color:#fff;font:600 15px/1.4 ui-sans-serif,system-ui,sans-serif;pointer-events:none';
    n.textContent = 'Restoring graphics…';
    ($('stage') || document.body).appendChild(n);
  }
  clearTimeout(gpuFailTimer);
  const check = () => {   // counts only visible time: in the background Chrome may not give a device until it is back
    if (!gpuLostAt) return;
    if (document.hidden) { gpuFailTimer = setTimeout(check, 1000); return; }
    if (performance.now() - gpuLostAt > 20000) { gpuBeacon('gpufail', {}); gpuReloadPrompt(msg); return; }
    gpuFailTimer = setTimeout(check, 1000);
  };
  gpuFailTimer = setTimeout(check, 1000);
};
// WebGL sessions report once what the renderer saw (render_gl.c gl_diag_frame): GPU, GL errors, back-buffer brightness
window.rcGlRenderer = () => {   // the GPU's real name, where the browser tells it
  try { const gl = $('canvas').getContext('webgl2'); const e = gl && gl.getExtension('WEBGL_debug_renderer_info');
        return e ? String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)) : ''; } catch { return ''; }
};
window.rcGlDiag = (json) => { try { console.warn('[gl] diag', json); gpuBeacon('gldiag', { msg: String(json).slice(0, 300) }); } catch { /* no beacon */ } };
window.rcDeviceRestored = (n) => {
  const ms = gpuLostAt ? Math.round(performance.now() - gpuLostAt) : 0;
  gpuLostAt = 0; clearTimeout(gpuFailTimer);
  $('gpurestore')?.remove();
  gpuBeacon('gpurestored', { dur: ms, n });
};
window.rcRecoverFailed = (final) => {
  // the engine retries on its own (backing off) and gives up after six losses in a row: then the prompt
  if (final) { clearTimeout(gpuFailTimer); gpuBeacon('gpufail', { final: 1 }); gpuReloadPrompt(''); }
};
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && gpuLostAt) gpuLostAt = performance.now();   // count the 20 s from the page's return; the engine retries itself
});

// Render scale: canvas pixels per CSS pixel. Starts at the screen's density (at most 2); adaptive resolution
// (run(): a mission that keeps running under 24 fps) lowers it in steps, never below the game's own 480 lines,
// and this browser starts at the level it settled on for the next 7 days (igi-rscale).
const RSCALE_STORE = 'igi2-rscale2';   // was igi2-rscale: renamed 2026-11-17 to clear marks that never lifted (a 16 GB Mac and PCs at 60 fps drew 640x480 for a week: "even more pixelated than before, I cannot see my cursor")
const fullScale = () => Math.min(window.devicePixelRatio || 1, lowEnd() ? 1 : 2);   // low-end devices: one pixel per CSS pixel
let renderScale = (() => {
  const full = fullScale();
  try { const v = JSON.parse(localStorage.getItem(RSCALE_STORE) || 'null');
    if (v && v.s > 0 && v.s < full && Date.now() - v.at < 7 * 86400000 && !params.has('fullres')) return v.s; } catch { /* none */ }
  return full;
})();
// Picture quality (the "Picture quality" setting, controls.js gfx; ?gfx=standard|sharp|ultra):
//   standard: the game's own texture filtering, one canvas pixel per screen pixel
//   sharp:    16x anisotropic texture filtering (engine rc_set_aniso): ground, roads and walls seen at a low
//             angle stay sharp into the distance. Next to free on a computer's GPU.
//   ultra:    sharp, and the picture is drawn larger than the screen and scaled down by the browser
//             (supersampling): smooth edges, fences and leaves included. 2 to 4 times the pixels.
// auto = sharp on a computer, standard on touch and low-memory devices (their limit is speed, not sharpness).
// The game's own video options work too: "Texture filtering: Anisotropic" is honoured by the engine, and its
// Antialiasing x2 / x4 (engine rc_game_aa) draws 2 / 4 times the pixels the same way.
// (Reported 2026-11-14: "changing the detail does nothing, the installed game is clearer": the engine ignored
// anisotropic filtering, refused antialiasing, and nothing could draw above the screen's own resolution.)
const touchDevice = () => matchMedia('(pointer: coarse)').matches;
function gfxLevel() {
  const q = params.get('gfx');
  const v = ['standard', 'sharp', 'ultra'].includes(q) ? q : ((typeof RcControls !== 'undefined' && RcControls.get && RcControls.get().gfx) || 'auto');
  return v === 'auto' ? (lowEnd() || touchDevice() ? 'standard' : 'sharp') : v;
}
const gfxAniso = () => (gfxLevel() === 'standard' ? 1 : 16);
let gameAa = 0;   // the antialiasing the game's own video option asked its display for (0, 2 or 4 samples)
function superSample() {   // canvas pixels per rendered screen pixel, per axis, on top of the render scale
  const dense = (window.devicePixelRatio || 1) >= 1.75;   // a dense screen already draws 4 pixels per CSS pixel
  const own = gfxLevel() === 'ultra' ? (dense ? 1.5 : 2) : 1;
  const game = gameAa >= 4 ? 2 : gameAa >= 2 ? Math.SQRT2 : 1;
  return Math.max(own, game);
}
function sizeCanvas() {
  const canvas = $('canvas');
  const r = canvas.getBoundingClientRect();
  let k = renderScale * superSample();
  const most = 4096 / Math.max(r.width, r.height, 1);   // no side over 4096 pixels (GPU texture limits, memory)
  if (k > most) k = Math.max(most, Math.min(renderScale, 1));
  // one scale for both axes, raised as far as the 640x480 floor needs: the picture keeps the screen's shape (a
  // floor per axis gave a wide screen a 737x480 or 640x480 picture stretched across it)
  k = Math.max(k, 640 / Math.max(1, r.width), 480 / Math.max(1, r.height));
  canvas.width = Math.round(r.width * k);
  canvas.height = Math.round(r.height * k);
}
// the setting changed, or the game switched its antialiasing: filtering now, the canvas at its new size
window.rcGfxApply = () => {
  const M = window.recomp;
  if (!M) return;
  if (M._rc_set_aniso) M._rc_set_aniso(gfxAniso());
  const canvas = $('canvas'), w = canvas.width, h = canvas.height;
  sizeCanvas();
  if ((canvas.width !== w || canvas.height !== h) && M._rc_set_canvas_size) M._rc_set_canvas_size(canvas.width, canvas.height);
};

// On a phone the stage is fixed to the viewport (index.html: body.coarse #stage). If the page ends up zoomed
// or scrolled (iOS does that around rotation and fullscreen, Android when the browser's zoom setting is on),
// a fixed box is laid out to the layout viewport and overflows the screen: the picture is cropped and the
// touch controls land off-screen. Size and place the stage on the VISUAL viewport instead whenever the two
// differ; with no zoom and no offset this sets exactly the box the stylesheet gives it.
function followVisualViewport(stage) {
  const vv = window.visualViewport;
  if (!vv) return;
  let applied = false;
  const apply = () => {
    const zoomed = Math.abs(vv.scale - 1) > 0.01 || vv.offsetLeft > 0.5 || vv.offsetTop > 0.5 ||
      Math.abs(vv.width - innerWidth) > 1 || Math.abs(vv.height - innerHeight) > 1;
    if (!zoomed && !applied) return;
    applied = zoomed;
    if (!zoomed) { stage.style.cssText = ''; return; }
    stage.style.cssText = `position:fixed;inset:auto;left:${vv.offsetLeft}px;top:${vv.offsetTop}px;width:${vv.width}px;` +
      `height:${vv.height}px;aspect-ratio:auto;border-radius:0;box-shadow:none`;
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  window.addEventListener('orientationchange', () => setTimeout(apply, 300));
  apply();
}

// A netplay session: every peer starts from the same empty saves folder, kept apart from this browser's
// normal saves (one per player slot, so two tabs of one browser can play each other).
const netSaves = (session) => `rcnetplay-${session.you}`;
async function clearNetSaves(session) {
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry(netSaves(session), { recursive: true }); } catch { /* not there yet */ }
}

function showNetStatus(M, session) {
  const el = $('netstatus');
  el.classList.remove('hidden');
  let lastFrame = 0, lastT = performance.now();
  setInterval(() => {
    const frame = M._netplay_status(0), desync = M._netplay_status(2), stalls = M._netplay_status(3);
    const now = performance.now();
    // the game thread always idles until the next frame's inputs arrive; it's only "waiting" when that
    // holds the game below full speed
    const fps = ((frame - lastFrame) * 1000) / Math.max(1, now - lastT);
    lastFrame = frame; lastT = now;
    el.classList.toggle('bad', !!desync);
    // the round trip the inputs ride on, and how many frames the delay failed to cover (a stall is a
    // frame that waited over 10 ms for the others' inputs: the game froze that long)
    const trips = session.client.trips();
    const path = trips.direct ? `direct ${trips.direct} ms` : `relayed ${trips.room} ms`;
    el.textContent = desync ? `Out of sync since frame ${desync}: restart the session`
      : `Online · player ${session.you + 1} of ${session.players} · delay ${session.delay}` +
        ` · ${path}` + (stalls ? ` · ${stalls} stalls` : '') +
        (session.reconnecting ? ' · reconnecting…' : frame > 300 && fps < 50 ? ' · waiting for players' : '') +
        (session.left?.size ? ` · ${session.left.size} left` : '');
  }, 1000);
}

async function run(session) {
  const audio = newAudioContext();   // first, while the click that called run() is still a user gesture
  // Boot report: no frame 8 s after Play sends where the start got to (script / module / frames), the engine's last
  // lines and any errors, once. Set here, not after the engine loads: on iOS 16 the page never got that far.
  const boot = { phase: 'start', at: performance.now(), done: false };
  saveDiag({ phase: 'start', exited: null, fps: null }); setInterval(() => saveDiag({ phase: boot.done ? 'running' : boot.phase }), 15000);
  const bootPhase = (p) => { boot.phase = p; boot.at = performance.now(); keepLog('[boot] ' + p); };
  // also when the page goes away first (players reloaded 4 s after Play on iOS 16)
  const bootReport = (why) => { if (boot.done || boot.sent || session) return; boot.sent = true; saveDiag({ phase: why + ' ' + boot.phase });
    gpuBeacon('bootlog', { r: window.RC_RENDERER || window.RC_GPU_KIND || 'gpu',
      n: why + ' ' + boot.phase + ' ' + Math.round((performance.now() - boot.at) / 1000) + 's',
      msg: recentErr.join(' | ').slice(0, 300), page: recentLog.join(' | ').slice(-300) }); };
  setTimeout(() => { if (recentErr.length || boot.phase !== 'frames') bootReport('8s'); }, 8000);   // most starts take longer than 8 s
  setTimeout(() => bootReport('30s'), 30000);
  addEventListener('pagehide', () => bootReport('left'));
  const touch = !session && RcTouch.wanted();
  if (touch) RcTouch.goFullscreen($('stage'));   // also needs the gesture
  else if (!session) setupFullscreen.enter?.();   // desktop too: the game fills the screen (Esc kept for its menu; Alt+Enter leaves)
  $('panel').classList.add('hidden');
  document.body.classList.add('playing');   // enables the touch re-fullscreen pill (index.html)
  showBoot();   // cover the black canvas until the first frame renders (see frame loop below)
  beacon('launch', { touch: touch ? 1 : 0 });   // Play pressed: against start, the players who never see a frame
  if (touch) {
    // on a phone the game starts fullscreen; if the player later leaves it, #refull gets them back in, and so does
    // the next tap on the game after Back left fullscreen by accident (not after two exits within 15 s: then the
    // player means it, until the next Play)
    $('refull').onclick = () => RcTouch.goFullscreen($('stage'), true);
    const stage = $('stage'), fsActive = () => document.fullscreenElement || document.webkitFullscreenElement;
    let exits = [], rearm = false;
    const onFs = () => {
      if (fsActive()) return;
      exits = exits.filter((t) => performance.now() - t < 15000).concat(performance.now());
      rearm = exits.length < 2;
    };
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs);
    stage.addEventListener('touchend', (e) => {
      if (!rearm || fsActive() || !document.body.classList.contains('playing')) return;
      if (e.target.closest && e.target.closest('#refull, #fshelp, #tsettings, #touch.edit')) return;
      rearm = false;
      RcTouch.goFullscreen(stage);
    }, { passive: true });
  } else { fullscreenTip(); controlsTip(); }
  if (session) await clearNetSaves(session);
  sizeCanvas();
  await loadEngineScript(`build/${GLUE}.js`);
  bootPhase('module');
  const M = await createRecomp({
    arguments: ['/opfs/' + OPFS_DIR],
    // the glue creates the engine's memory as soon as createRecomp is called, before any preRun hook
    ...(maxMemMb() ? { maxMemPages: Math.floor(maxMemMb() * 16) } : {}),
    print: (t) => { keepLog(t); console.log(t); engineLine(t); },
    printErr: (t) => { keepLog(t); console.log(t); engineLine(t); threadTrap(t); },
    preRun: [(m) => {
      if (params.has('mute')) m.ENV.RC_NO_AUDIO = '1';
      m.ENV.RC_ANISO = String(gfxAniso());   // texture filtering (the Picture quality setting; rcGfxApply changes it in play)
      if (params.get('exe')) m.ENV.RC_EXE = params.get('exe');
      if (params.has('log')) m.ENV.RC_LOG = '1';
      if (params.has('pads')) m.ENV.RC_PADS = params.get('pads');
      if (params.has('input')) m.ENV.RC_INPUT = params.get('input');   // testing: scripted input (host/input.c)
      if (params.get('args')) m.ENV.RC_ARGS = params.get('args');   // extra words on the game's command line
      if (lanLaunch) m.ENV.RC_ARGS = lanLaunch.args;                  // multiplayer: host or join (setupOnline)
      if (params.get('watchdog')) m.ENV.RC_WATCHDOG = params.get('watchdog');   // testing: guest stack every N s (host/main.c)
      if (params.has('netlog')) m.ENV.RC_NET_LOG = '1';               // testing: every datagram in the console (host/net.c)
      if (params.has('comlog')) m.ENV.RC_COM_LOG = '1';               // testing: live COM objects and Miles samples (leak checks)
      if (params.has('noyield')) m.ENV.RC_NO_YIELD = '1';                // testing: the game's poll spins unyielded (host/user32.c)
      if (params.has('gpucompat')) m.ENV.RC_GPU_COMPAT = '1';            // testing: a WebGPU compatibility-mode device
      if (params.has('gpuloop')) m.ENV.RC_GPU_LOOP = '1';                // testing: every new device after a loss arrives lost
      if (params.has('glprof')) m.ENV.RC_GL_PROF = '1';                  // testing: time per WebGL command type
      if (params.has('nobc')) m.ENV.RC_NO_BC = '1';                      // testing: no compressed textures (as most phones under WebGL)
      // Widescreen: display modes as wide as the canvas (host/d3d8.c); the game lays out its view and HUD for them
      if (COHORT.on.wide) m.ENV.RC_WIDE_D3D = '1';   // the wide experiment (A/B, see COHORT)
      if (params.has('peeklog')) m.ENV.RC_PEEK_LOG = '1';               // testing: poll interval log in the console
      if (params.has('poke')) m.ENV.RC_POKE = params.get('poke');      // testing: memory pokes (host/input.c)
      if (params.has('queue')) m.ENV.RC_QUEUE = params.get('queue');
      if (params.has('gpuskip')) m.ENV.RC_GPU_SKIP = '1';   // diagnostics: the executor issues no draws
      if (params.has('env')) for (const kv of params.get('env').split(';')) { const i = kv.indexOf('='); if (/^RC_[A-Z_]+$/.test(kv.slice(0, i))) m.ENV[kv.slice(0, i)] = kv.slice(i + 1); }   // testing: engine switches
      if (session) Object.assign(m.ENV, RcNetplay.gameEnv(session), { RC_USERDATA: '/opfs/' + netSaves(session) });
      m.ENV.RC_LOG_FPS = params.has('fps') ? '1' : '';
      if (!params.has('fps')) delete m.ENV.RC_LOG_FPS;
      // WebKit (Safari, and every browser on an iPhone or iPad) keeps a wasm memory resident in full from the
      // moment it is allocated and kills the page past ~2 GB, so there the guest memory is packed and grows
      // only as the game allocates (runtime.c, RC_MEM_COMPACT). ?mem=compact / ?mem=full force it either way.
      if (compactMemory() || maxMemMb()) m.ENV.RC_MEM_COMPACT = '1';
      { const g = params.get('gpulabel') || gpuLabel(); if (g) m.ENV.RC_GPU_LABEL = g; }   // the card name on the game's video screen (host/d3d8.c)
      // The cheap game clock (a helper thread, core.c guest_ms): the game reads the ms clock ~100k times a frame
      // and each read is a call out to JavaScript, a sixth of the game thread's work (2026-11-02). The helper
      // keeps a counter the readers just load. It used to run on the full memory layout only but that was only
      // because Safari crashed at start with it (a WebKit threads bug), not the layout: a 256 KB thread costs
      // nothing. When compact became the layout everywhere, that coupling quietly turned the helper off for almost
      // every phone, re-imposing the clock tax on the CPU-bound ones. Full-layout browsers keep it as before; the
      // compact phones (now most of them) get it through the 'tick' cohort so the field proves the win (and a boot
      // that fails leaves the experiment on its own, loader end). Off WebKit and the smallest phones (<=2 GB) that
      // already struggle to boot. ?tick=0 / ?tick=1 force it off / on.
      const tinyMem = navigator.deviceMemory > 0 && navigator.deviceMemory <= 2;
      const tickOk = params.get('tick') !== '0' && !isWebKit() && !tinyMem;
      if (tickOk && (!compactMemory() || COHORT.on.tick)) m.ENV.RC_TICK_THREAD = '1';
      if (params.get('tick') === '1') m.ENV.RC_TICK_THREAD = '1';
      // and there the frame's vertex/uniform uploads go up in one writeBuffer per batch instead of two per
      // draw (render_wgpu.c): WebKit's WebGPU holds a page-sized IPC copy per call for a while, which added
      // 1-2 GB to the page. ?gpu=coalesce / ?gpu=direct force it either way.
      const gpu = params.get('gpu');
      // 2026-11-02: everywhere, not only WebKit: one upload of each buffer per submit instead of two writeBuffer calls per
      // draw (the page thread's busy share in a mission fell from 9% to 4%; dense mission areas lagged on phones)
      if (gpu !== 'direct') { m.ENV.RC_GPU_COALESCE = '1'; window.RC_COALESCE = 1; }
      if (params.has('nomerge')) m.ENV.RC_NO_MERGE = '1';   // draws with identical state are joined (render_wgpu.c / render_gl.c); this turns it off
    }],
  });
  const canvas = $('canvas');
  if (window.RC_RENDERER === 'gl') {
    if (!M._rc_gl_init(canvas.width, canvas.height)) throw new Error('WebGL 2 could not start on this device.');
  } else M._rc_gpu_init(canvas.width, canvas.height);
  new ResizeObserver(() => { sizeCanvas(); M._rc_set_canvas_size(canvas.width, canvas.height); }).observe(canvas);
  hookInput(M, !!session);
  RcLan.attach(M);   // the virtual LAN (lan.js): offline it is this game alone
  subtitles(M, touch);
  pauseAds(touch);
  if (touch) { RcTouch.attach(M, $('stage'), canvas); followVisualViewport($('stage')); }
  if (session) { session.client.attach(M); showNetStatus(M, session); }
  crashWatch(M, touch);
  startAudio(M, audio).catch((e) => console.warn('audio unavailable:', e));
  const poll = session ? pollLocalPad : pollGamepads;
  // Online, present at most 60 times a second: every Present is a lockstep frame, and the input delay and
  // the time a frame has to simulate are counted in those (netplay.js: autoDelay), so following a 120 Hz
  // display would halve both. Solo play follows the display. A frame is due every 1/60 s, with a little
  // tolerance so a 60 Hz display's own jitter doesn't skip one.
  let due = 0, booted = false, shownFrames = 0, lastPresent = 0, loading = false;
  const launchT = performance.now();
  setTimeout(() => { if (!booted) beacon('noframe', { touch: touch ? 1 : 0, n: shownFrames, t: 120 }); }, 120000);
  bootPhase('frames');
  // Picture check: players reported a black screen after Play with the game running behind it (frames
  // presented, nothing visible). Once the boot cover is off, every 15th presented frame is copied small onto a 2D
  // canvas in the same task as the present (the canvas still holds it then) and its lit pixels counted. A
  // picture that stays black for 20 s on WebGPU switches this browser to WebGL 2 and restarts.
  const pic = { el: null, cx: null, lit: 0, samples: 0, until: 0, done: false, f: 0 };
  const picCheck = () => {
    if (pic.done || ++pic.f % 15) return;
    try {
      if (!pic.el) { pic.el = document.createElement('canvas'); pic.el.width = 16; pic.el.height = 12; pic.cx = pic.el.getContext('2d', { willReadFrequently: true }); }
      pic.cx.clearRect(0, 0, 16, 12);
      pic.cx.drawImage($('canvas'), 0, 0, 16, 12);
      const d = pic.cx.getImageData(0, 0, 16, 12).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 24) lit++;
      pic.samples++; pic.lit = Math.max(pic.lit, lit);
    } catch (e) { pic.done = true; console.warn('picture check unavailable:', e.message); return; }
    if (pic.lit >= 4) { pic.done = true; return; }   // a picture: nothing to do
    if (!pic.until) pic.until = performance.now() + 20000;
    if (performance.now() < pic.until || session) return;
    pic.done = true;
    const r = window.RC_RENDERER || window.RC_GPU_KIND || 'gpu';
    console.warn(`picture check: ${pic.samples} samples over 20 s, all black (${r})`);
    gpuBeacon('blackpic', { r, n: pic.samples, t: Math.round((performance.now() - launchT) / 1000) });
    if (r !== 'gl' && webgl2Ok()) {
      try { localStorage.setItem(GL_STORE, String(Date.now())); } catch { /* storage blocked: the URL still says so */ }
      status('Switching to the compatible graphics mode…');
      const u = new URL(location.href); u.searchParams.set('renderer', 'gl'); u.searchParams.set('autoplay', '1');
      setTimeout(() => location.replace(u.href), 400);
    }
  };
  // Adaptive resolution: in a running mission, presented frames are counted per 2 s; two windows in a row under
  // 24 fps (IGI 2 runs at 60) lower the render scale by a fifth, down to the game's 480 lines. Once per run, a
  // minute into a mission, a 'perf' report: the average frame rate, the scale and the steps taken.
  const perf = { n: 0, t0: 0, low: 0, good: 0, ups: 0, ceil: 0, last: 0, gap: 0, steps: 0, sum: 0, windows: 0, sent: false, firstMission: 0, pump: 0, frames: 0, busy: 0,
    recent: [], capAuto: false, idle: 0, cap: -1 };
  // The "Frame rate" setting (controls.js fps): 'auto' caps a phone at a steady 30 once four 2-second windows in a
  // mission average under 38 fps, and lifts the cap after 30 s with the game thread idle more than half the time
  // (it could go faster). Field phones run 25-35 fps that jumps frame to frame (2026-11-06); an even 30 looks
  // smoother, and the idle time keeps the phone cooler so it throttles less.
  const applyCap = () => {
    const pref = (RcControls.get && RcControls.get().fps) || 'auto';
    const cap = pref === '30' ? 30 : pref === 'max' ? 0 : (perf.capAuto ? 30 : 0);
    if (cap !== perf.cap && M._rc_set_fps_cap) { M._rc_set_fps_cap(cap); perf.cap = cap; console.log(`frame rate: ${cap ? 'steady ' + cap : 'max'} (${pref})`); }
  };
  const perfTick = (presented, now) => {
    // the game's own Antialiasing option (its video screen): the display it asked for decides the canvas size
    if (M._rc_game_aa && now - (perf.aaAt || 0) > 1000) {
      perf.aaAt = now;
      const aa = M._rc_game_aa();
      if (aa !== gameAa) { gameAa = aa; window.rcGfxApply(); console.log(`antialiasing x${aa || 1} (the game's video option): rendering at ${$('canvas').width}x${$('canvas').height}`); }
    }
    if (session || params.has('fullres')) return;
    const playing = RcControls.inMission() && !document.hidden && !loading;
    if (!playing) { perf.t0 = 0; perf.pump = 0; return; }
    perf.frames += presented;
    if (!perf.firstMission) perf.firstMission = now;
    if (!perf.t0) { perf.t0 = now; perf.n = 0; perf.last = now; perf.gap = 0; return; }
    perf.n += presented;
    if (presented) { perf.gap = Math.max(perf.gap, now - perf.last); perf.last = now; }
    if (now - perf.t0 < 2000) return;
    // A window with a frame gap over 400 ms is a stall (a level loading, the GPU restarting, a notification, a
    // garbage collection), not a slow device: it neither lowers nor raises the render scale.
    const stalled = Math.max(perf.gap, now - perf.last) > 400;
    perf.gap = 0;
    const fps = perf.n * 1000 / (now - perf.t0);
    diagState.fps = Math.round(fps);
    const busy = M._rc_game_busy ? M._rc_game_busy() : 0;
    perf.t0 = now; perf.n = 0; perf.sum += fps; perf.windows++; perf.busy += busy;
    if (touch || params.has('autocap')) {   // ?autocap: the phone rule on a desktop (testing)
      perf.recent.push(fps); if (perf.recent.length > 4) perf.recent.shift();
      const avg = perf.recent.reduce((a, b) => a + b, 0) / perf.recent.length;
      if (!perf.capAuto && perf.recent.length === 4 && (avg < 38 || params.has('lowfps'))) { perf.capAuto = true; perf.idle = 0; }
      else if (perf.capAuto && busy < 45 && !params.has('lowfps')) { if (++perf.idle >= 15) { perf.capAuto = false; perf.recent = []; } }
      else perf.idle = 0;
    }
    applyCap();
    // only when the graphics are the limit: with the game thread itself busy 90% of the time (most phones in the
    // field: 95-99%) a smaller picture gains nothing and only blurs it, which players saw as the picture changing
    const lowNow = params.has('lowfps') || (fps < 24 && busy < 90);   // ?lowfps: every window counts as slow (testing; IGI 2 runs at 60)
    perf.low = stalled && !params.has('lowfps') ? perf.low : lowNow ? perf.low + 1 : 0;
    // a full frame rate with time to spare: 60 (or the steady 30 of the frame rate cap) and the game thread not busy
    perf.good = stalled || lowNow || fps < (perf.cap > 0 ? 28 : 50) || busy >= 80 ? 0 : perf.good + 1;
    const canvas = $('canvas');
    // Back up: 20 s at a full frame rate below the device's full resolution raises the render scale a step. The
    // ratchet went one way only: one slow spell (a level loading, a busy computer) kept the picture at 480 lines
    // for a week (field 2026-11-16: PCs and a 16 GB Mac at 60 fps drawing 640x480). Never back up to a level this
    // run already had to leave: every change is a visible hitch.
    const top = Math.min(fullScale(), perf.ceil || Infinity);
    if (perf.good >= 10 && renderScale * 1.01 < top && !params.has('lowfps')) {
      perf.good = 0; perf.ups++;
      renderScale = Math.min(renderScale * 1.25, top);
      sizeCanvas(); M._rc_set_canvas_size(canvas.width, canvas.height);
      try { if (renderScale >= fullScale()) localStorage.removeItem(RSCALE_STORE); else localStorage.setItem(RSCALE_STORE, JSON.stringify({ s: renderScale, at: Date.now() })); } catch { /* storage blocked */ }
      console.warn(`adaptive resolution: ${fps.toFixed(1)} fps, back up to ${canvas.width}x${canvas.height}`);
    }
    if (perf.low >= 3 && canvas.height > 480 && renderScale > 0.5) {   // down: 6 s under 24 fps (was 4 s)
      perf.low = 0; perf.steps++;
      renderScale = Math.max(renderScale * 0.8, 0.5);
      perf.ceil = renderScale;   // the level above failed: the way back up stops here for this run
      sizeCanvas(); M._rc_set_canvas_size(canvas.width, canvas.height);
      try { localStorage.setItem(RSCALE_STORE, JSON.stringify({ s: renderScale, at: Date.now() })); } catch { /* storage blocked */ }
      console.warn(`adaptive resolution: ${fps.toFixed(1)} fps, rendering at ${canvas.width}x${canvas.height} now`);
    }
    if (!perf.sent && now - perf.firstMission > 60000 && perf.windows >= 10) {
      perf.sent = true;
      gpuBeacon('perf', { r: window.RC_RENDERER || window.RC_GPU_KIND || 'gpu', fps: Math.round(perf.sum / perf.windows * 10) / 10,
        n: perf.steps + (perf.ups ? '+' + perf.ups : '') + ' ' + canvas.width + 'x' + canvas.height + ' s' + renderScale.toFixed(2) + ' g' + Math.round(perf.busy / perf.windows) +
           ' d' + (perf.pump / Math.max(1, perf.frames)).toFixed(1) + (window.RC_COALESCE ? ' c' : '') + (perf.cap > 0 ? ' cap' + perf.cap : ''), touch: touch ? 1 : 0 });
    }
  };
  // ?hud: a small on-screen readout for players reporting lag (record the screen with it on): frames shown per
  // second, the longest gap between frames in that second, the render size and the renderer
  const hud = params.has('hud') ? document.createElement('div') : null;
  let hudN = 0, hudT0 = 0, hudLast = 0, hudGap = 0, pumpMs = 0;
  if (hud) {
    hud.style.cssText = 'position:absolute;left:50%;top:calc(52px + env(safe-area-inset-top, 0px));transform:translateX(-50%);z-index:30;' +
      'padding:3px 8px;border-radius:6px;background:rgba(0,0,0,.6);color:#7f7;font:12px/1.3 ui-monospace,monospace;pointer-events:none';
    $('stage').appendChild(hud);
  }
  const hudTick = (presented, t) => {
    if (presented) { if (hudLast) hudGap = Math.max(hudGap, t - hudLast); hudLast = t; hudN += presented; }
    if (!hudT0) hudT0 = t;
    if (t - hudT0 >= 1000) {
      const c = $('canvas');
      hud.textContent = `${(hudN * 1000 / (t - hudT0)).toFixed(0)} fps · worst ${hudGap.toFixed(0)} ms · game ${M._rc_game_busy ? M._rc_game_busy() : '?'}% · draw ${(pumpMs / Math.max(1, hudN)).toFixed(1)} ms · ${c.width}x${c.height} · ${window.RC_RENDERER || window.RC_GPU_KIND || 'gpu'}`;
      pumpMs = 0;
      hudT0 = t; hudN = 0; hudGap = 0;
    }
  };
  const frame = (t) => {
    poll(M);
    if (!session || t >= due - 4) {
      const tp = performance.now();
      const n = M._rc_gpu_pump(1);
      pumpMs += performance.now() - tp; perf.pump += performance.now() - tp;
      perfTick(n, t);
      if (hud) hudTick(n, t);
      if (n) {
        due = Math.max(due + 1000 / 60, t - 4);
        lastPresent = t;
        // Drop the boot cover only once the game is actually STREAMING frames (its menu/mission is up), not
        // on the first frame: while the game loads a cold install it submits nothing for up to ~2 minutes,
        // then a stray clear-frame, then the real render loop. Counting to a couple dozen frames waits for
        // that render loop so the cover never lifts onto a still-black screen.
        if (booted && !pic.done) picCheck();
        if (!booted) { shownFrames += n; if (shownFrames >= 24) { booted = true; boot.done = true; hideBoot(); runFlags.booted = 1;
          try { if (typeof gtag === 'function') gtag('event', 'game_start'); } catch { /* analytics blocked */ } beacon('start', { touch: touch ? 1 : 0, t: Math.round(performance.now() / 1000) }); } }
        else if (loading) { loading = false; hideLoading(); }   // frames resumed: level finished loading
      } else if (booted && !loading && !session && !run.exited && lastPresent && t - lastPresent > 2500) {
        // Booted and running, but no frame for 2.5 s: the game is blocked loading a mission/level. Cover the
        // frozen black screen so it doesn't look crashed (solo only, online must never stall the loop).
        loading = true; showLoading();
      }
    } else M._rc_gpu_pump(0);   // mid-frame readbacks only
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  // The game quit (Quit in its menu) or stopped with an error (host/kernel32.c game_exited): no more frames will
  // come. Without this the page showed "Loading mission" forever, still fullscreen with Esc kept by the keyboard
  // lock (2026-11-02). Leave fullscreen, release Esc and the mouse, and offer the way back.
  window.rcGameExited = (code) => {
    window.rcExited = true; try { window.RcBreakAd && window.RcBreakAd.hide(); } catch { /* no ads */ }
    if (run.exited) return;
    run.exited = true;
    loading = false; booted = true;
    try { hideLoading(); hideBoot(); } catch { /* covers already gone */ }
    try { navigator.keyboard?.unlock?.(); } catch { /* not supported */ }
    try { if (document.pointerLockElement) document.exitPointerLock(); } catch { /* no lock */ }
    try { if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document).catch?.(() => {}); } catch { /* not fullscreen */ }
    const online = lanLaunch, client = online && !online.host;   // an online client's game ends when it loses the host
    // a moment later: the trap's own lines (address, registers, stack) come from the game thread separately
    const inMission = (() => { try { return RcControls.inMission() ? 1 : 0; } catch { return 0; } })();
    setTimeout(() => { gpuReports = Math.min(gpuReports, 5); gpuBeacon('exit', { n: String(code), mission: inMission, online: online ? (client ? 'client' : 'host') : '', msg: trapLines.join(' | ').slice(0, 300) }); }, 1500);   // always sent: one per page
    saveDiag({ exited: code, phase: 'exited' });
    const box = document.createElement('div');
    box.id = 'gameexit';
    box.style.cssText = 'position:absolute;inset:0;z-index:60;display:grid;place-items:center;background:rgba(3,8,5,.88);color:#fff;' +
      'font:15px/1.5 system-ui,-apple-system,sans-serif;text-align:center;padding:20px';
    box.innerHTML = '<div style="max-width:420px"><div style="font-size:20px;font-weight:700;margin-bottom:6px">' +
      (code !== 0 ? 'The game stopped' : client ? 'You were disconnected from the match' : 'The game is closed') + '</div><p style="margin:0 0 16px;opacity:.85">' +
      (code !== 0 ? 'It closed with an error (code ' + code + '). Starting it again usually works.'
        : client ? 'The game lost its connection to the host (the host left, or the connection dropped). You can join the room again.'
        : 'You quit IGI 2: Covert Strike.') + '</p>' +
      (client && online.code && code === 0 ? '<button type="button" data-a="rejoin" style="display:block;width:100%;margin:0 0 10px;padding:12px;border:0;border-radius:10px;background:#2ecc71;color:#04150a;font-weight:700;font-size:16px;cursor:pointer">Join the room again</button>' : '') +
      '<button type="button" data-a="menu" style="display:block;width:100%;margin:0 0 10px;padding:12px;border:0;border-radius:10px;background:#2ecc71;color:#04150a;font-weight:700;font-size:16px;cursor:pointer">Back to the main menu</button>' +
      '<button type="button" data-a="home" style="display:block;width:100%;padding:10px;border:1px solid rgba(255,255,255,.3);border-radius:10px;background:transparent;color:#fff;font-size:15px;cursor:pointer">Home page</button>' +
      (code === 0 ? '<p style="margin:16px 0 0;font-size:14px;opacity:.85">Enjoyed it? <a href="https://buymeacoffee.com/aiwithsagar" target="_blank" rel="noopener" style="color:#45cf79">Support the project</a></p>' : '') +
      '<p style="margin:14px 0 0;font-size:14px;opacity:.85">' + (code === 0 ? 'Something went wrong?' : 'Help us fix it:') + ' <a href="/report.html?what=' + (code === 0 ? 'other' : 'crash') + '" target="_blank" rel="noopener" style="color:#45cf79">Report a problem</a></p></div>';
    box.querySelector('[data-a=menu]').onclick = () => { const u = new URL(location.href); u.searchParams.set('autoplay', '1'); location.replace(u.href); };
    box.querySelector('[data-a=home]').onclick = () => { location.replace(location.pathname); };
    if (box.querySelector('[data-a=rejoin]')) box.querySelector('[data-a=rejoin]').onclick = () => {
      const keep = params.get('lan') ? `&lan=${encodeURIComponent(params.get('lan'))}` : '';
      location.replace(`${location.pathname}?join=${online.code}${keep}`);
    };
    $('stage').appendChild(box);
    (box.querySelector('[data-a=rejoin]') || box.querySelector('[data-a=menu]')).focus();
  };
  // readbacks mid-frame are answered without waiting for vsync; online, the pad is also sampled here
  // (8 ms, not 1: the browser clamps nested 1 ms timers to 4 ms anyway, and the game reads pixels back only for
  // screenshots, so a few ms of readback latency cost nothing while halving the page thread's idle wake-ups)
  setInterval(() => { if (session) poll(M); M._rc_gpu_pump(0); }, 8);
  // Online, a hidden tab still has to present frames (browsers pause requestAnimationFrame there), or the
  // lockstep would freeze every other player with it.
  if (session) setInterval(() => { if (document.hidden) { poll(M); M._rc_gpu_pump(1); } }, 16);
  canvas.focus();
  window.recomp = M;
}

// Players report the game going black mid-mission and the page coming back on the landing screen: that is
// the browser killing the page (out of memory, usually) and reloading it, which no code here can catch as it
// happens. So the running game leaves a heartbeat in sessionStorage (kept across a browser reload, gone when
// the tab closes) and clears it on an orderly unload; a start that finds a fresh heartbeat is the reload after
// such a kill. The player gets a note on the landing screen, and the site a report (crash.php: the device,
// its memory, how long the game ran, whether it was in a mission or in the background) to find the pattern.
const RUN_STORE = 'igi2-run';
function crashWatch(M, touch) {
  const t0 = Date.now();
  // The heartbeat also keeps the state just before a freeze (the field reports show whole-process freezes
  // that no watchdog report precedes): the frame rate over the last beat, the page's memory (wasm, JS, GPU
  // copies: measureUserAgentSpecificMemory, sampled every 30 s), the threads' phases and the longest task.
  let lastFrames = -1, fps = 0, pageMB = 0, longTask = 0;
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.duration > longTask) longTask = e.duration; }).observe({ type: 'longtask', buffered: true }); } catch { /* no longtask support */ }
  const counters = () => {
    try { return M && M._rc_watch_addr ? Array.from(new Int32Array(M.wasmMemory.buffer, M._rc_watch_addr(), 8)) : []; } catch { return []; }
  };
  const beat = () => {
    try {
      const w = counters();
      if (w.length) { if (lastFrames >= 0) fps = Math.round((w[2] - lastFrames) / 5); lastFrames = w[2]; }
      if (!runFlags.play && RcControls.inMission()) { runFlags.play = 1; beacon('play', { touch: touch ? 1 : 0, t: Math.round((Date.now() - t0) / 1000) }); }
      sessionStorage.setItem(RUN_STORE, JSON.stringify({ t: Date.now(), t0, m: RcControls.inMission() ? 1 : 0, touch: touch ? 1 : 0, bg: document.hidden ? 1 : 0,
        x: COHORT.tag, booted: runFlags.booted || 0, play: runFlags.play || 0,
        fps, page: pageMB, lt: Math.round(longTask), pp: w[0], gp: w[1], gf: w[4], gpu: w[7], io: M && M._rc_io_activity ? M._rc_io_activity() : 0 }));
    } catch { /* storage blocked */ }
  };
  const measure = () => {
    try { if (performance.measureUserAgentSpecificMemory) performance.measureUserAgentSpecificMemory().then((r) => { pageMB = r.bytes >> 20; }).catch(() => {}); } catch { /* unsupported */ }
  };
  beat(); measure();
  setInterval(beat, 5000);
  setInterval(measure, 60000);   // the measurement waits for a garbage collection: once a minute is plenty
  window.addEventListener('pagehide', () => {
    try { sessionStorage.removeItem(RUN_STORE); } catch { /* storage blocked */ }
    // an experiment session that ends (a reload, closing the tab) without ever reaching a mission after 20 s may be
    // a black screen the player gave up on: leave the experiments in this browser (conservative by design)
    if (COHORT.tag !== 'base' && !runFlags.play && Date.now() - t0 > 20000) {
      try { const off = JSON.parse(localStorage.getItem('igi2-exp-off') || '{}') || {}; for (const k of COHORT.tag.split('+')) off[k] = 1; localStorage.setItem('igi2-exp-off', JSON.stringify(off)); } catch { /* storage blocked */ }
  bootPhase('script');
      beacon('expoff', { booted: runFlags.booted || 0, played: Math.round((Date.now() - t0) / 1000) });
    }
  });
  hangWatch(M, touch);
}

// Watchdog worker. Players report two freezes the heartbeat above can't explain: the page thread stops
// answering (Chrome's "Page unresponsive" dialog; the heartbeat stops with it, so the reload after it shows
// a gap of a minute or more), and the picture stops while the page still answers. A worker keeps its own
// clock: the page thread posts a beat every second (and on visibility changes), and the worker reads the
// host's watchdog counters straight from the shared wasm memory (host/win32.h RcWatch: what the page thread
// and the game thread were doing). After 15 s without a beat in the foreground it reports a hang, and after
// 20 s with no frame presented and no file read in a running mission a stall, to crash.php, with those
// counters; the end of either is reported too, so a hang that recovers is told from one that lasts.
function hangWorker() {
  let mem = null, addr = 0, info = {}, t0 = Date.now(), last = 0, st = null, lastBg = 0;
  let hangAt = 0, hangSent = false, stallAt = 0, stallSent = false, lastFrames = -1, lastIo = -1, lastMoveT = 0, fpsBefore = 0;
  const counters = () => {
    if (!mem || !addr) return {};
    const a = new Int32Array(mem.buffer, addr, 8);
    return { pp: a[0], gp: a[1], frames: a[2], queued: a[3], gf: a[4], beat: a[5], rb: a[6], gpu: a[7] };
  };
  const hist = [];   // (time, frames presented) over the last 10 s, for the frame rate before a freeze
  const fps = () => {
    const w = counters();
    if (w.frames === undefined) return 0;
    const now = Date.now();
    hist.push([now, w.frames]);
    while (hist.length > 1 && now - hist[0][0] > 10000) hist.shift();
    const a = hist[0];
    return now - a[0] >= 1000 ? Math.round((w.frames - a[1]) * 1000 / (now - a[0])) : 0;
  };
  const report = (type, dur) => {
    const body = Object.assign({ type, dur, played: Math.round((Date.now() - t0) / 1000), wasm: mem ? mem.buffer.byteLength >> 20 : 0, fps: fpsBefore },
      info, st ? { mission: st.m, paused: st.p, bg: st.bg, io: st.io, lt: st.lt } : {}, counters());
    try { fetch('crash.php', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {}); } catch { /* offline */ }
    postMessage({ warn: 'watchdog: ' + JSON.stringify(body), ga: type });
  };
  onmessage = (e) => {
    const d = e.data;
    if (d.init) { mem = d.memory; addr = d.addr; info = d.info; t0 = Date.now(); return; }
    last = Date.now(); st = d;
  };
  let lastTick = 0;
  setInterval(() => {
    if (!last) return;
    const now = Date.now(), quiet = now - last, bg = st && st.bg;
    // this worker itself didn't run for a while: the whole process was paused (the device slept, the browser
    // froze the tab or the system paged it out), which is not a hang of the page thread; reported apart,
    // and the page thread's silence over that time is not counted as a hang
    const jump = lastTick ? now - lastTick : 0;
    lastTick = now;
    if (jump > 8000) { report('pause', Math.round(jump / 1000)); last = now; return; }
    const f = fps();
    if (quiet < 3000 && !bg) fpsBefore = f;   // the frame rate while the page still answered
    if (bg !== lastBg) { lastBg = bg; lastMoveT = now; }   // frames stop in a hidden tab: not a stall
    if (!bg && quiet > 10000) {
      if (!hangAt) hangAt = last;
      if (!hangSent && quiet > 15000) { hangSent = true; report('hang', Math.round(quiet / 1000)); }
    } else if (hangAt) {
      if (hangSent) report('hangend', Math.round((now - hangAt) / 1000));
      hangAt = 0; hangSent = false;
    }
    const w = counters();
    if (w.frames === undefined || !st || bg || quiet > 3000) return;
    if (w.frames !== lastFrames || st.io !== lastIo) {
      lastFrames = w.frames; lastIo = st.io; lastMoveT = now;
      if (stallAt) { if (stallSent) report('stallend', Math.round((now - stallAt) / 1000)); stallAt = 0; stallSent = false; }
    } else if (st.m && !st.p && lastMoveT && now - lastMoveT > 20000) {
      if (!stallAt) stallAt = lastMoveT;
      if (!stallSent) { stallSent = true; report('stall', Math.round((now - lastMoveT) / 1000)); }
    }
  }, 1000);
}
function hangWatch(M, touch) {
  if (!M || !M.wasmMemory || !M._rc_watch_addr || typeof Worker !== 'function') return;
  let w;
  try { w = new Worker(URL.createObjectURL(new Blob(['(' + hangWorker.toString() + ')()'], { type: 'text/javascript' }))); }
  catch (e) { console.warn('watchdog worker unavailable:', e); return; }
  w.onmessage = (e) => {
    if (!e.data) return;
    if (e.data.warn) console.warn(e.data.warn);
    try { if (e.data.ga && typeof gtag === 'function') gtag('event', 'freeze_' + e.data.ga); } catch { /* analytics blocked */ }
  };
  w.postMessage({ init: 1, memory: M.wasmMemory, addr: M._rc_watch_addr(), info: {
    v: 21, x: COHORT.tag, ua: navigator.userAgent, mem: navigator.deviceMemory || 0, cores: navigator.hardwareConcurrency || 0,
    touch: touch ? 1 : 0, screen: `${screen.width}x${screen.height}@${devicePixelRatio}` } });
  // the longest task the page thread ran (ms): a hang that ends shows as one long task; a stutter as many
  let lt = 0;
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.duration > lt) lt = e.duration; }).observe({ type: 'longtask', buffered: true }); } catch { /* no longtask support */ }
  const beat = () => {
    try { w.postMessage({ t: Date.now(), m: RcControls.inMission() ? 1 : 0, p: RcControls.paused() ? 1 : 0, bg: document.hidden ? 1 : 0, io: M._rc_io_activity ? M._rc_io_activity() : 0, lt: Math.round(lt) }); }
    catch { /* the game is gone */ }
  };
  beat();
  setInterval(beat, 1000);
  document.addEventListener('visibilitychange', beat);
}
// What the report page (report.html) attaches to a player's problem report: the facts this page knows about the
// device and the last run, kept in localStorage (same site) and refreshed while the game runs, so a report sent
// from another tab, or after a crash, still carries them.
const DIAG_STORE = 'igi-diag';
const diagState = {};
function saveDiag(extra) {
  try {
    Object.assign(diagState, extra || {});
    const c = $('canvas');
    let gpu = window.RC_GPU_NAME || '';
    if (!gpu && window.RC_RENDERER === 'gl') { try { gpu = window.rcGlRenderer() || ''; } catch { /* none */ } }
    localStorage.setItem(DIAG_STORE, JSON.stringify(Object.assign({
      t: Date.now(), loader: (document.querySelector('script[src^="loader.js"]') || {}).src?.split('v=')[1] || '',
      engine: (document.querySelector('script[src*="recomp.js"]') || {}).src?.split('v=')[1] || '',
      renderer: window.RC_RENDERER || window.RC_GPU_KIND || '', gpu: String(gpu).slice(0, 120), x: COHORT.tag,
      canvas: c ? c.width + 'x' + c.height : '', scale: typeof renderScale === 'number' ? +renderScale.toFixed(2) : '',
      mem: navigator.deviceMemory || 0, cores: navigator.hardwareConcurrency || 0,
      screen: `${screen.width}x${screen.height}@${devicePixelRatio}`, touch: matchMedia('(pointer: coarse)').matches ? 1 : 0,
      errors: recentErr.slice(0, 4), log: recentLog.slice(-8),
    }, diagState)));
  } catch { /* storage blocked */ }
}

// A browser whose WebGPU picture stayed black (picture check in run()) uses WebGL 2 for 14 days.
const GL_STORE = 'igi2-gl-black';
const glRemembered = () => { try { const t = +localStorage.getItem(GL_STORE); return t > 0 && Date.now() - t < 14 * 86400000; } catch { return false; } };
const webgl2Ok = () => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; } };
const runFlags = {};   // this run: booted (24 frames shown), play (the player reached a mission)
function crashCheck() {
  let r = null;
  try { r = JSON.parse(sessionStorage.getItem(RUN_STORE) || 'null'); sessionStorage.removeItem(RUN_STORE); } catch { r = null; }
  if (!r || typeof r.t !== 'number' || Date.now() - r.t > 120000) return;   // not the reload right after a running game
  const info = {
    v: 21, type: 'reload', ua: navigator.userAgent, mem: navigator.deviceMemory || 0, cores: navigator.hardwareConcurrency || 0,
    played: Math.round((r.t - r.t0) / 1000), gap: Math.round((Date.now() - r.t) / 1000), mission: r.m, touch: r.touch, bg: r.bg,
    nav: performance.getEntriesByType('navigation')[0]?.type || '', screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
    fps: r.fps, page: r.page, lt: r.lt, pp: r.pp, gp: r.gp, gf: r.gf, io: r.io, gpu: r.gpu,   // the state at the last beat before the end
    x: r.x || '', booted: r.booted || 0, play: r.play || 0,
  };
  // a run in an experiment that never showed the game, or was killed within two minutes: leave the experiments
  if (r.x && !/^base/.test(r.x) && (!r.booted || (r.fps === 0 && info.played < 120) || info.played < 120)) {
    leaveExperiments(r.x.split('+'));
    info.expoff = 1;
  }
  console.warn('the previous run ended without unloading (the browser killed the page?)', info);
  try { navigator.sendBeacon('crash.php', new Blob([JSON.stringify(info)], { type: 'application/json' })); } catch { /* no beacon */ }
  if (!r.bg) $('crashnote')?.classList.remove('hidden');   // a kill in the background is the OS reclaiming a hidden tab, not a crash
}

// Follow gate (index.html #iggate): the first Play shows a prompt to follow the site's Instagram; Play is
// enabled once the Follow link has been tapped (or "already following"), and the choice is remembered in
// this browser. A follow can't be checked from a website, so this is a prompt, not a lock. Test runs
// (?autoplay) skip it.
const FOLLOW_STORE = 'igi2-ig-follow';
function followGate(next) {
  let done = false;
  try { done = localStorage.getItem(FOLLOW_STORE) === '1' || params.has('autoplay'); } catch { done = params.has('autoplay'); }
  const gate = $('iggate');
  if (done || !gate) { next(); return; }
  const play = $('ig-play');
  const unlock = () => { try { localStorage.setItem(FOLLOW_STORE, '1'); } catch { /* storage blocked */ } gate.classList.add('hidden'); next(); };
  $('ig-follow').onclick = () => { setTimeout(() => { play.disabled = false; play.focus(); }, 1500); };   // link opens in a new tab
  $('ig-already').onclick = (e) => { e.preventDefault(); unlock(); };
  play.onclick = unlock;
  gate.classList.remove('hidden');
}

// Early access (server/access/worker.js): this browser needs a code from the Instagram post before the game's file
// list and engine are served. A random device id stays in this browser; a code holds 2 of them. The server's pass
// is an HttpOnly cookie (the engine download carries it). No access service at this address (a local dev server:
// 404) = no gate. A network failure lets a browser that was let in within the pass's 3 days carry on.
const DEVICE_STORE = 'igi2-device-id', ACCESS_STORE = 'igi2-access-at';
function deviceId() {
  let d = null;
  try { d = localStorage.getItem(DEVICE_STORE); } catch { /* storage blocked */ }
  if (!d || !/^[0-9a-f]{32}$/.test(d)) {
    const a = new Uint8Array(16); crypto.getRandomValues(a);
    d = Array.from(a, (x) => x.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(DEVICE_STORE, d); } catch { /* storage blocked: a new device next time */ }
  }
  return d;
}
const accessPost = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body), credentials: 'same-origin', cache: 'no-store' });
function accessGranted() {
  try { localStorage.setItem(ACCESS_STORE, String(Date.now())); localStorage.setItem(FOLLOW_STORE, '1'); } catch { /* storage blocked */ }   // Vyral checked the follow
}
// 2026-11-16: the invite codes are switched off for now (the code database hit its daily limit and nobody could
// get in): everyone plays, new players get the follow prompt (followGate). Set to true, and OPEN to false in
// server/access/worker.js, to bring the codes back.
const INVITE_CODES = false;
async function accessGate() {
  if (!INVITE_CODES) return true;
  const dev = deviceId();
  const urlCode = params.get('code');
  if (urlCode) {   // the claim page's Play link: redeem, then take the code out of the address bar
    const u = new URL(location.href); u.searchParams.delete('code'); history.replaceState(null, '', u.href);
  }
  try {
    const r = await accessPost('/api/access/check', { device: dev });
    // only the access service answers in JSON: anything else (a local dev server's 404/405/501) = no gate here
    if (!/json/.test(r.headers.get('Content-Type') || '')) return true;
    if (r.ok && (await r.json()).ok) { accessGranted(); return true; }
  } catch {
    let at = 0; try { at = +localStorage.getItem(ACCESS_STORE) || 0; } catch { /* storage blocked */ }
    if (Date.now() - at < 3 * 86400000) return true;   // offline for a moment, let in recently: the cookie still opens the engine
  }
  return new Promise((resolve) => {
    hideBoot(); $('panel').classList.remove('hidden'); show('access');
    const msg = (t, err) => { $('acc-msg').textContent = t; $('acc-msg').classList.toggle('err', !!err); };
    const input = $('acc-code'), go = $('acc-go'), rep = $('acc-replace');
    input.oninput = () => {   // XXXX-XXXX as they type
      const v = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      input.value = v.length > 4 ? v.slice(0, 4) + '-' + v.slice(4) : v;
    };
    const redeem = async (replace) => {
      const code = input.value.trim();
      if (code.replace(/[^A-Za-z0-9]/g, '').length !== 8) { msg('Your code has 8 letters and numbers, like K7Q2-M9XP.', true); input.focus(); return; }
      go.disabled = true; rep.disabled = true; msg('Checking…');
      try {
        const r = await accessPost('/api/access/redeem', { code, device: dev, replace: !!replace });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.ok) { msg(''); accessGranted(); resolve(true); return; }
        msg(j.message || 'That didn\'t work. Try again in a minute.', true);
        rep.classList.toggle('hidden', !(j.error === 'full' && j.canReplace));
      } catch { msg('No connection. Check your internet and try again.', true); }
      go.disabled = false; rep.disabled = false;
    };
    $('acc-form').onsubmit = (e) => { e.preventDefault(); redeem(false); };
    rep.onclick = () => redeem(true);
    // how to get a code: the (i) button opens the steps as a sheet on short screens (inline card on tall ones)
    const guide = $('acc-guide'), info = $('acc-info');
    const close = () => { if (!guide.classList.contains('open')) return; guide.classList.remove('open'); info.after(guide); info.focus(); };
    info.onclick = () => { document.body.appendChild(guide); guide.classList.add('open'); guide.querySelector('.acc-reel').focus(); };
    guide.onclick = (e) => { if (e.target === guide || e.target.closest('[data-close]')) close(); };
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    // a phone's keyboard would cover the steps: focus the box only where there is a real keyboard
    if (urlCode) { input.value = urlCode; input.oninput(); redeem(false); } else if (!matchMedia('(pointer: coarse)').matches) input.focus();
  });
}

async function boot() {
  // Friendly, device-specific message when the browser can't run the game (cross-origin isolation, WebGL 2 and
  // OPFS: iOS 16 and later; WebGPU itself only from iOS 26, older ones use WebGL 2). Avoids developer jargon.
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const needHint = isIOS
    ? 'On iPhone or iPad this needs iOS 16 or later, opened in Safari. Please update iOS and try again.'
    : 'Please use an up-to-date Chrome or Edge (Android or desktop), or Safari 16+ on Apple devices.';
  // Links tapped inside Instagram, Facebook, WhatsApp or other apps open in the app's own browser view, which
  // lacks the features the game needs: say so and offer the way out (Android: open Chrome by intent; else copy).
  const inApp = /Instagram|FBAN|FBAV|FB_IAB|Line\/|Snapchat|; wv\)|WhatsApp|Twitter|TikTok|Telegram/i.test(navigator.userAgent);
  if (!crossOriginIsolated && inApp) {
    const android = /Android/i.test(navigator.userAgent);
    status('You opened this inside an app’s built-in browser, which can’t run the game. Open it in Chrome instead.');
    const btn = $('download');
    btn.textContent = android ? 'Open in Chrome' : 'Copy the link';
    btn.classList.remove('hidden');
    btn.onclick = () => {
      if (android) window.rcLeave = true, location.href = 'intent://' + location.host + location.pathname + '#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=' + encodeURIComponent(location.href) + ';end';
      else { navigator.clipboard?.writeText(location.href).then(() => status('Link copied. Paste it in Safari or Chrome.')).catch(() => status('Copy this address and open it in Safari or Chrome: ' + location.href)); }
    };
    return;
  }
  if (!crossOriginIsolated) { status('This browser can’t run the game yet, it’s missing a feature the game needs (cross-origin isolation). ' + needHint); return; }
  // Count the visitors the game can't start for, and on what (crash.php type nowebgpu / nogpu): the size of
  // the audience a second renderer (WebGL) would reach. Device model is in the user agent on Android.
  const cannot = (type) => { try { navigator.sendBeacon('crash.php', new Blob([JSON.stringify({ v: 21, x: COHORT.tag, type, ua: navigator.userAgent, mem: navigator.deviceMemory || 0,
    cores: navigator.hardwareConcurrency || 0, screen: `${screen.width}x${screen.height}@${devicePixelRatio}` })], { type: 'application/json' })); } catch { /* no beacon */ } };
  // Renderer: WebGPU when the browser has a usable adapter, else WebGL 2 (render_gl.c), which reaches older iPhones
  // and the Android phones and PCs whose GPU Chrome keeps off WebGPU. ?renderer=gl forces WebGL 2 (testing).
  const webgl2 = webgl2Ok;
  if (params.get('renderer') === 'gl' && webgl2()) { window.RC_RENDERER = 'gl'; }
  else if (glRemembered() && !params.has('renderer') && webgl2()) { window.RC_RENDERER = 'gl'; }   // this browser showed black on WebGPU
  else if (!navigator.gpu) {
    cannot('nowebgpu');
    if (webgl2()) window.RC_RENDERER = 'gl';
    else { status('This browser doesn’t support WebGPU or WebGL 2, which the game needs for graphics. ' + needHint); return; }
  }
  // navigator.gpu can exist with no usable adapter (GPU or driver blocklisted, hardware acceleration off,
  // Remote Desktop / VM): say so instead of starting a game that can only show a black screen
  // (featureLevel 'compatibility': WebGPU on OpenGL ES 3.1, Chrome 146+, for phones without full WebGPU; the engine
  // asks in the same order, host/render_wgpu.c request_web_adapter)
  // window.RC_GPU_KIND: which request gave the adapter, reported as r (gpu, gpuc = compatibility mode, gpusw = software)
  const asked = async (opts, kind) => { const a = await navigator.gpu.requestAdapter(opts).catch(() => null); if (a) window.RC_GPU_KIND = kind; return a; };
  const adapter = window.RC_RENDERER === 'gl' ? { gl: 1 } : params.has('noadapter') ? null :   // ?noadapter: testing the fallback
    await asked({ powerPreference: 'high-performance' }, 'gpu') ||
    await asked(undefined, 'gpu') ||
    await asked({ featureLevel: 'compatibility' }, 'gpuc') ||
    await asked({ forceFallbackAdapter: true }, 'gpusw');
  if (!adapter && webgl2()) { cannot('nogpu'); window.RC_RENDERER = 'gl'; }
  else if (!adapter) {
    cannot('nogpu');
    const firefox = /Firefox\//.test(navigator.userAgent);
    // Chrome switches graphics off for a site after the graphics process crashed while it was open, until the
    // browser restarts: the commonest reason on machines that played before. Say that first.
    status('The browser didn’t give the game a graphics adapter. If the game worked before in this browser, close the browser ' +
      'completely (every tab, and on a phone swipe it away from recent apps) and open the site again: Chrome turns graphics off ' +
      'for a site after a graphics crash, until it restarts. ' +
      (firefox ? 'Firefox only enables WebGPU for some GPUs and drivers; Chrome or Edge usually work. '
        : 'Otherwise check that hardware acceleration is on in the browser settings and the graphics driver is up to date. ') +
      'Remote Desktop and virtual machines often have no GPU for the browser.');
    return;
  }
  try { if (adapter && !adapter.gl && adapter.info) window.RC_GPU_NAME = [adapter.info.vendor, adapter.info.architecture, adapter.info.description].filter(Boolean).join(' '); } catch { /* no info */ }
  if (adapter && !adapter.gl && (adapter.isFallbackAdapter || adapter.info?.isFallbackAdapter))
    console.warn('WebGPU: only a software (fallback) adapter is available; the game will be slow');
  if (!navigator.storage?.getDirectory) { status('This browser has no Origin Private File System.'); return; }
  await accessGate();
  show('loading');
  let onlineReady = false;
  const goOnline = () => {
    if (!onlineReady) { setupOnline(); onlineReady = true; }
    show('online');
    ($('np-code').value ? $('np-join') : $('np-name')).focus();
  };
  const ready = () => {
    show('home');
    crashCheck();
    if (params.get('join')) goOnline();   // an invite link goes straight to joining
    if (params.has('autoplay')) $('play').click();
  };
  migratePreset(!!(await readMarker()));   // the keyboard layout for players from before the layouts existed
  $('play').onclick = () => followGate(() => run().catch(fail));
  $('go-online').onclick = () => followGate(goOnline);
  for (const b of document.querySelectorAll('[data-go]')) b.onclick = () => show(b.dataset.go);
  $('folder').onchange = async (e) => {
    $('pick').classList.add('hidden');
    try { await importFromPicker(e.target.files); ready(); }
    catch (err) { status(err.message); $('pick').classList.remove('hidden'); }
  };
  const showPicker = (msg) => {
    status(msg);
    $('pick').classList.remove('hidden');
    $('help').classList.remove('hidden');
  };

  // A hosted game folder (game/manifest.json) is downloaded; without one the player picks their own copy.
  // Phones and tablets can't pick folders, so there it's the only way in.
  const full = await hostedManifest();
  const hosted = full && baseList(full);   // the single-player install (the multiplayer maps come on demand)
  if (hosted) $('reset').textContent = 'Reload the game again';
  const offerDownload = (msg) => {
    status(msg);
    $('download').textContent = 'Download the game (one time)';
    $('download').classList.remove('hidden');
  };
  // The browser's private storage refused: Safari's private windows and some locked-down profiles have none
  // ("The operation failed for an unknown transient reason", QuotaExceededError), and the game can't be kept.
  const storageProblem = (err) => {
    const m = String(err && err.message || ''), n = err && err.name || '';
    if (!/transient|quota|storage|NotAllowed|Security|UnknownError/i.test(m + ' ' + n)) return '';
    return 'This browser window can\'t store the game (a private window, or the browser\'s storage is full or blocked). ' +
           'Open the site in a normal window with some free space and try again.';
  };
  $('download').onclick = async () => {
    $('download').classList.add('hidden');
    $('pick').classList.add('hidden');
    try { await importFromServer(hosted); ready(); }
    catch (err) { offerDownload(storageProblem(err) || err.message); }
  };
  $('reset').onclick = (e) => {
    e.preventDefault();
    show('loading');
    if (hosted) offerDownload('Reload the game again.'); else showPicker('Choose your IGI 2: Covert Strike folder.');
  };
  const marker = await readMarker();
  if (!marker) {
    // Hosted page (always, on phone or desktop): start the one-time download straight away, no click to
    // waste. On failure the click handler re-shows the button to retry. Without a hosted folder (desktop
    // dev), the player picks their own copy.
    if (hosted) { $('download').click(); return; }
    showPicker('Choose your IGI 2: Covert Strike folder to start.');
    return;
  }
  // Re-fetch when the hosted folder changed since this browser copied it (a file added or replaced), OR when
  // the browser evicted some of this copy's files (the folder looks complete, the marker is kept, but a later
  // mission's files are gone: "can't start mission 2"). importFiles skips every file already present at the right
  // size, so a current, complete install downloads nothing and starts at once; only changed or missing files are
  // fetched. Importing the whole list (not just the missing ones) keeps the from-scratch fallback correct.
  if (hosted && (marker.version !== await listDigest(hosted) || (await missingFiles(hosted)).length)) {
    try { await importFromServer(hosted); } catch (err) { offerDownload(storageProblem(err) || err.message); return; }
  }
  // (Project I.G.I. fetched its stock config.qvm again on every start; IGI 2's config.qvm also holds the
  // player's mission progress, GOActiveMission, so it stays as the game left it.)
  ready();
}

// config.qvm holds the game's own key bindings. The game rewrites it when a mission ends, and a tap or two in
// its Controls menu rebinds keys by accident (a phone's tap is a mouse click to it), which then came back on
// every visit and fought the page's own key layout. On every start the shipped copy is fetched again (3.7 KB)
// over the one in storage, so the game always starts with its default bindings; keys are changed in the
// page's panel. A failed fetch keeps whatever is there, so an offline start still works.
// It also carries the mission unlock (GOActiveMission = 14, so "Finding the bomb" is listed). CONFIG_REV is in
// the URL because Cloudflare keeps /game/ files as immutable: bump it whenever the shipped config.qvm changes.
const CONFIG_REV = 2;
// The stock config also resets the game's own mouse settings, so a player's in-game sensitivity or invert
// was lost at every start (reported as "sensitivity changed but not applied", 2026-10-31). Carry those two over
// from the player's saved copy. Records in the compiled config (the LOOP script) read
//   0d <name#> 18 01 00 00 00 <u32 string offset> 14 <type> 00 00 00 <value>
// with name #5 = GOInMouSens (type 6: 05 + float) and #4 = GOInMouInv (type 2: one byte, 0f false / 10 true), one
// record per player profile, matched in order. Anything unexpected keeps the stock values.
function keepPlayerMouse(saved, fresh) {
  const find = (b, name, type) => {
    const at = [];
    for (let i = 0; i + 17 < b.length; i++)
      if (b[i] === 0x0d && b[i + 1] === name && b[i + 2] === 0x18 && b[i + 3] === 1 && b[i + 4] === 0 && b[i + 5] === 0 && b[i + 6] === 0 &&
          b[i + 11] === 0x14 && b[i + 12] === type && b[i + 13] === 0 && b[i + 14] === 0 && b[i + 15] === 0) at.push(i + 16);
    return at;
  };
  const out = fresh.slice();
  const sensS = find(saved, 5, 6), sensF = find(out, 5, 6);
  if (sensS.length && sensS.length === sensF.length)
    sensS.forEach((o, k) => {
      if (saved[o] !== 0x05) return;
      const v = new DataView(saved.buffer, saved.byteOffset + o + 1, 4).getFloat32(0, true);
      if (v > 0.02 && v < 3 && out[sensF[k]] === 0x05) out.set(saved.subarray(o, o + 5), sensF[k]);
    });
  const invS = find(saved, 4, 2), invF = find(out, 4, 2);
  if (invS.length && invS.length === invF.length)
    invS.forEach((o, k) => { if (saved[o] === 0x0f || saved[o] === 0x10) out[invF[k]] = saved[o]; });
  return out;
}
async function refreshConfig(list) {
  const e = list.find((f) => f.path.toLowerCase() === 'config.qvm');   // the root one (LANGUAGE/* has its own)
  if (!e) return;
  try {
    const r = await fetch('game/' + e.path.split('/').map(encodeURIComponent).join('/') + '?rev=' + CONFIG_REV, { cache: 'no-cache' });
    if (!r.ok) return;
    const buf = await r.arrayBuffer();
    if (buf.byteLength !== e.size) return;
    const fh = await fileHandle(await gameDir(true), e.path, true);
    let fresh = new Uint8Array(buf);
    try { fresh = keepPlayerMouse(new Uint8Array(await (await fh.getFile()).arrayBuffer()), fresh); } catch { /* no saved copy yet */ }
    const w = await openWriter(fh, OPFS_DIR + '/' + e.path);
    try { await w.write(fresh); await w.close(); } catch (err) { await w.abort(); throw err; }
  } catch (err) { console.warn('config.qvm refresh skipped:', err.message); }
}

// ------------------------------------------------------------------ fullscreen

// The stage (game + overlays) goes fullscreen; the canvas grows with it and the game letterboxes its 4:3
// picture inside. Alt+Enter (Option+Enter on a Mac) toggles it, as in PC games of the time; it is caught
// before the game's own key handling so Enter doesn't also reach a menu.
function setupFullscreen() {
  const stage = $('stage');
  const active = () => document.fullscreenElement || document.webkitFullscreenElement;
  // body.fs drives the touch re-fullscreen pill (index.html): shown only when playing and NOT fullscreen.
  // Registered unconditionally (even where the desktop button is unavailable) so the pill is always right.
  // opened from the Home Screen (iPhone, an installed app): already without browser bars, so no pill either
  // (not display-mode: fullscreen: Chrome reports it for element fullscreen too, and the pill then stayed hidden
  // on phones after Back left fullscreen)
  const standalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const syncFsClass = () => document.body.classList.toggle('fs', !!active() || standalone());
  document.addEventListener('fullscreenchange', syncFsClass);
  document.addEventListener('webkitfullscreenchange', syncFsClass);
  addEventListener('resize', syncFsClass);
  syncFsClass();
  // In fullscreen the page asks to keep Esc (Keyboard Lock, Chrome and Edge): a tap of Esc then opens the game's
  // menu as players expect, and holding Esc still leaves fullscreen (the browser's rule). Without the lock the
  // first Esc leaves fullscreen.
  const enter = () => {
    const p = (stage.requestFullscreen || stage.webkitRequestFullscreen).call(stage);
    const lock = () => { try { navigator.keyboard?.lock?.(['Escape'])?.catch?.(() => {}); } catch { /* not supported */ } };
    if (p && p.then) p.then(lock).catch(() => {}); else lock();
  };
  const toggle = () => {
    if (active()) { try { navigator.keyboard?.unlock?.(); } catch { /* not supported */ } (document.exitFullscreen || document.webkitExitFullscreen).call(document); }
    else enter();
    $('canvas').focus();
  };
  setupFullscreen.enter = () => { if (!active() && (stage.requestFullscreen || stage.webkitRequestFullscreen)) enter(); };
  if (!stage.requestFullscreen && !stage.webkitRequestFullscreen) { $('fs').classList.add('hidden'); return; }
  $('fs').onclick = toggle;
  const swallow = (e) => {
    if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
    if (!e.altKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'keydown' && !e.repeat) toggle();
  };
  window.addEventListener('keydown', swallow, true);
  window.addEventListener('keyup', swallow, true);
  const sync = () => {
    $('fs-icon').setAttribute('d', active() ? 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5' : 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5');
    $('fs').title = active() ? 'Exit fullscreen (Alt+Enter or Esc)' : 'Fullscreen (Alt+Enter)';
  };
  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);
  // the button shows while the mouse moves over the stage and fades after a few still seconds
  let idle;
  const wake = () => { stage.classList.add('awake'); clearTimeout(idle); idle = setTimeout(() => stage.classList.remove('awake'), 2500); };
  stage.addEventListener('mousemove', wake);
  stage.addEventListener('mouseleave', () => stage.classList.remove('awake'));
  wake();
}

// once the game starts: a short hint, so players learn the shortcut
function fullscreenTip() {
  const tip = $('fstip');
  if (document.fullscreenElement || document.webkitFullscreenElement || $('fs').classList.contains('hidden')) return;
  tip.classList.remove('hidden');
  tip.style.opacity = '1';
  setTimeout(() => { tip.style.opacity = '0'; }, 5000);
  setTimeout(() => tip.classList.add('hidden'), 5500);
}

// and, a moment later, the controls that differ from what players of other shooters expect
function controlsTip() {
  const tip = $('ctltip');
  if (!tip) return;
  const C = RcControls.get(), right = RcControls.ACTIONS[C.mouse[2]]?.label || 'nothing';
  const k = (id) => `<kbd>${keyLabel(userKeys[id])}</kbd>`;
  tip.innerHTML = preset === 'original'
    ? `Original keys: arrows move · ${k('walkrun')} walk/run · ${k('crouch')} crouch · ${k('jump')} jump · ${k('zoomin')}/${k('zoomout')} zoom · right click: <b>${right}</b>: WASD and more in the Controls panel`
    : `Right click: <b>${right}</b> · scroll: weapon · ${k('walkrun')} walk/run · ${k('crouch')} crouch · ${k('jump')} jump, change them in the Controls panel`;
  setTimeout(() => { tip.classList.remove('hidden'); tip.style.opacity = '1'; }, 6000);
  setTimeout(() => { tip.style.opacity = '0'; }, 16000);
  setTimeout(() => tip.classList.add('hidden'), 16500);
}

// ------------------------------------------------------------------ online lobby

async function buildVersion() {
  // peers must run the same build and game files, or their simulations diverge
  const marker = await readMarker();
  const wasm = await fetch(`build/${ENGINE}.wasm`, { method: 'HEAD' }).catch(() => null);
  // the ETag comes back weak (W/"...") when the response is compressed: compare only its value
  const etag = (wasm?.headers.get('ETag') || '').replace(/^W\//, '').replace(/"/g, '');
  return `${marker?.version || 'local'}:${etag || wasm?.headers.get('Content-Length') || '?'}`;
}

// Multiplayer (index.html #view-online / #view-lobby, web/lan.js): a room on the room server is a virtual LAN.
// The host's Start launches its game as a listen server on the chosen map (IGI 2's own command line:
// "player<name> server port26001 level<NN>", MP-README.txt) and tells the room; everyone else's Join launches
// "ip10.77.0.1 port26001 player<name>". Players who come later join the running match the same way.
// Room server: ?lan=<url>; on a local address the local test server (server/lan/local.mjs, port 8790).
// On the site: the room server Worker (server/lan/worker.js on Cloudflare, live 2026-10-31), which also relays
// datagrams for players whose networks refuse a direct link. ?lan=room.php selects the PHP polling rooms instead
// (lobby and WebRTC set-up only, no relay). Everyone in a room must use the same server.
const LAN_SERVER = params.get('lan') ||
  (/^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname) ? `ws://${location.hostname}:8790` : 'wss://igi2-lan.sagarinfosec.site');
const MAPS = { '01': 'Redstone', '02': 'Forest Raid', '03': 'Sandstorm', '04': 'Timberland', '05': 'Chinese Temple', '06': 'Jungle' };
let lanLaunch = null;   // { args } while a multiplayer start is pending (run() reads it)
function setupOnline() {
  const NAME_STORE = 'igi2-name';
  const cleanName = (v) => (v || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 15);
  const nameEl = $('np-name'), codeEl = $('np-code'), msg = (t) => { $('np-msg').textContent = t || ''; };
  try { nameEl.value = localStorage.getItem(NAME_STORE) || ''; } catch { /* storage blocked */ }
  if (params.get('join')) codeEl.value = params.get('join').toUpperCase();
  const myName = () => {
    const n = cleanName(nameEl.value) || 'Player' + Math.floor(Math.random() * 900 + 100);
    nameEl.value = n;
    try { localStorage.setItem(NAME_STORE, n); } catch { /* storage blocked */ }
    return n;
  };
  let room = null, map = '05', served = null;
  const lobbyMsg = (t) => { $('np-lobbymsg').textContent = t || ''; };
  const renderLobby = () => {
    const list = $('np-players');
    list.innerHTML = '';
    for (const p of RcLan.players()) {
      const li = document.createElement('li');
      const ms = p.link && p.link.rtt != null ? ` ${p.link.rtt} ms` : '';
      const tag = p.self ? 'you' : p.open ? (p.link && p.link.kind === 'turn' ? `via Cloudflare${ms}` : `direct${ms}`) : RcLan.relay() ? 'via the room server' : 'connecting…';
      li.textContent = `${p.self ? nameEl.value : p.name}${p.n === 1 ? ' (host)' : ''}`;
      const small = document.createElement('span'); small.className = 'small'; small.textContent = ` · ${tag}`;
      li.appendChild(small);
      list.appendChild(li);
    }
  };
  RcLan.on('lobby', renderLobby);
  // The guest's button follows the host's announcement. A room whose match already runs sends that with its
  // hello, before enter() has the room: enter() calls this again, or the button stayed "Waiting for the host"
  // for everyone who came after the host started (found 2026-11-14).
  const syncGo = () => {
    if (!room || room.host) return;
    const go = $('np-go');
    go.disabled = !served;
    go.textContent = served ? `Join the match (${MAPS[served.map] || 'map ' + served.map})` : 'Waiting for the host…';
  };
  RcLan.on('state', (st) => { served = st && st.serving ? st : null; syncGo(); });
  RcLan.on('closed', () => { lobbyMsg('Lost the connection to the room. Leave and join again.'); });
  const enter = async (code, host) => {
    msg('Connecting…');
    served = null;
    try {
      const version = await buildVersion();
      room = await RcLan.connect(LAN_SERVER, code, myName(), version);
    } catch (err) { msg(err.message); room = null; return; }
    if (host && !room.host) { msg('Someone already hosts that room code. Try again.'); RcLan.close(); room = null; return; }
    msg('');
    room.code = code;
    $('np-room').textContent = code;
    $('np-hostctl').classList.toggle('hidden', !room.host);
    $('np-guestctl').classList.toggle('hidden', room.host);
    $('np-mapname').textContent = MAPS[map];
    syncGo();
    if (room.host) RcLan.announce({ serving: false, map });
    lobbyMsg('');
    renderLobby();
    show('lobby');
  };
  $('np-host').onclick = () => {
    map = $('np-map').value;
    const code = Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
    enter(code, true);
  };
  $('np-join').onclick = () => {
    const code = codeEl.value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(code)) { msg('A room code is 4 to 8 letters and digits.'); return; }
    enter(code, false);
  };
  codeEl.onkeydown = (e) => { if (e.key === 'Enter') $('np-join').click(); };
  $('np-copy').onclick = async () => {
    const invite = new URL(location.href);
    invite.search = `?join=${room.code}` + (params.get('lan') ? `&lan=${encodeURIComponent(params.get('lan'))}` : '');
    try { await navigator.clipboard.writeText(invite.href); lobbyMsg('Invite link copied.'); } catch { lobbyMsg('Invite link: ' + invite.href); }
  };
  $('np-leave').onclick = () => { RcLan.close(); room = null; show('online'); };
  const launch = async (args) => {
    lanLaunch = { args, code: room && room.code, host: / server /.test(` ${args} `) };
    // how the links ran in this match (direct / TURN / room server, round trips): a report 90 s in, field data on lag
    setTimeout(() => { try { gpuBeacon('mpnet', { msg: RcLan.linkSummary().slice(0, 200), online: lanLaunch.host ? 'host' : 'client', n: String(RcLan.players().length) }); } catch { /* left */ } }, 90000);
    try { await ensureMultiplayer(); } catch (err) { show('lobby'); lobbyMsg(err.message); return; }
    run().catch(fail);
  };
  $('np-start').onclick = () => {
    RcLan.announce({ serving: true, map, port: 26001 });
    launch(`player${nameEl.value} server port26001 level${map}`);
  };
  $('np-go').onclick = () => {
    if (!served) return;
    launch(`ip10.77.0.1 port${served.port || 26001} player${nameEl.value}`);
  };
}

function setupKbdHelp() {
  const off = () => { try { return localStorage.getItem('rc-kbd') === 'hide'; } catch { return false; } };
  const save = (v) => { try { localStorage.setItem('rc-kbd', v); } catch { /* storage blocked */ } };
  const apply = () => document.body.classList.toggle('kbd-off', off());
  $('kbd-close').onclick = () => { save('hide'); apply(); };
  $('kbd-show').onclick = () => { save('show'); apply(); };
  apply();
}

// The device choice on the landing screen (index.html #device): touch controls + gyroscope, or keyboard and
// mouse. Preselected from the browser (a coarse pointer on a touch screen), remembered in this browser, and
// applied right away: the page's phone layout (body.coarse) and the hints follow it, and run() asks
// RcTouch.wanted() when the game starts.
function setupDevice() {
  const box = $('device');
  if (!box) return;
  const sync = () => {
    const touch = RcTouch.wanted();
    document.body.classList.toggle('coarse', touch);
    // iPhone Safari has no fullscreen for a page, and its toolbars slide in over the page when a swipe starts
    // at the screen's edge (looking down starts one at the top): the viewport shrinks, and a stage fixed to
    // it would resize the game's picture every time. There the stage keeps the largest viewport's size
    // instead (index.html body.nofs #stage); the toolbar overlaps the bottom until it hides again.
    document.body.classList.toggle('nofs', touch && !document.fullscreenEnabled && !document.webkitFullscreenEnabled);
    // the on-screen controls exist from here on (hidden until the game runs), so their settings and layout can
    // be set up on the landing screen and while the game loads
    if (touch) {
      RcTouch.setup($('stage'), $('canvas'));
      $('home-controls').onclick = () => RcTouch.openSettings();
      $('boot-controls').onclick = () => RcTouch.openSettings();
    }
    for (const b of box.querySelectorAll('button')) {
      const on = (b.dataset.device === 'touch') === touch;
      b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  };
  for (const b of box.querySelectorAll('button')) b.onclick = () => {
    try { localStorage.setItem('igi2-device', b.dataset.device); } catch { /* storage blocked */ }
    sync();
  };
  sync();
}
setupDevice();
setupFullscreen();
setupKbdHelp();
setupControls();
boot();

// ?diag: a tiny on-screen readout of the mission/pause flags, for diagnosing mission-2 control issues in the
// field without the console. Shows the raw engine flags and the page-side (RcControls) values side by side, so
// a single screenshot in a mission says whether the game is read as in-mission/paused and whether the HUD
// weapon icon is detected. Pointer-events none; only active with ?diag; costs nothing otherwise.
(function () {
  try {
    if (!new URLSearchParams(location.search).has('diag')) return;
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:6px;top:6px;z-index:2147483647;pointer-events:none;' +
      'font:12px/1.35 ui-monospace,Menlo,monospace;color:#0f0;background:rgba(0,0,0,.72);' +
      'padding:6px 8px;border-radius:6px;white-space:pre;max-width:60vw';
    document.body.appendChild(box);
    const hx = (n) => '0x' + (n >>> 0).toString(16).padStart(8, '0');
    const ver = (document.querySelector('script[src*="loader.js"]') || {}).src || '';
    const build = (ver.match(/v=([A-Za-z0-9]+)/) || [])[1] || '?';
    setInterval(() => {
      const M = window.recomp, C = window.RcControls, cv = document.getElementById('canvas');
      const call = (f) => { try { return M && M[f] ? M[f]() : '-'; } catch { return 'err'; } };
      const cc = (f) => { try { return C && C[f] ? C[f]() : '-'; } catch { return 'err'; } };
      const z = (() => { try { return (M && M._input_zoom ? M._input_zoom() : 0).toFixed(2); } catch { return 'err'; } })();
      box.textContent =
        'build ' + build + '   lock ' + (document.pointerLockElement === cv ? 'ON' : 'off') + '   zoom ' + z + '\n' +
        'eng inMission ' + call('_input_in_mission') + '   paused ' + call('_input_paused') + '\n' +
        'eng weaponSig ' + hx(call('_input_weapon_sig')) + '   levelFailed ' + call('_input_level_failed') + '\n' +
        'C.inMission  ' + cc('inMission') + '   C.paused ' + cc('paused') + '   C.levelFailed ' + cc('levelFailed');
    }, 200);
  } catch { /* diag is best-effort */ }
})();
