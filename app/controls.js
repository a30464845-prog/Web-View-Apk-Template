// IGI 2: Covert Strike in the browser - Copyright (c) 2026 Sagar Joshi. All rights reserved.
// Not licensed for copying, hosting or reuse without written permission. See NOTICE.
// Shared controls layer for the keyboard/mouse page (loader.js) and the on-screen touch controls (touch.js):
//  - the game's actions and the default key each one has in its config.qvm (the game's own bindings stay at
//    their defaults; everything here translates onto them in the browser)
//  - mouse button bindings (which action left / right / middle click does, saved per browser)
//  - the scope toggle: the game only has Zoom In / Zoom Out keys that zoom continuously while held (sniper
//    scope, binoculars); one button that snaps to a scope zoom and back is what players expect. The host
//    reports the actual zoom of the view (input_zoom: the projection's y scale, 2.31 at the normal view, up
//    to ~21 fully zoomed), so the toggle holds the key until the view really is there, at any frame rate.
//  - look settings: touch swipe sensitivity, a scope multiplier, PC mouse sensitivity
//  - the gyroscope on phones: turning the phone turns the view, like mobile shooters do
// Everything reaches the game as the keys and mouse it already reads (host/input.c), only in mouse-look mode
// (host input_in_mission: a mission with the game running): the 2D menus, and the Esc menu over a paused
// mission, always get a plain click and an unscaled cursor.
'use strict';

const RcControls = (() => {
  const STORE = 'igi2-settings';
  const HOLD_MS = 70;   // the game samples input once a frame: hold taps at least this long (the host also keeps a press until sampled)

  // What the game does and the key it reads for it: HID usages of IGI 2's default bindings (its config.qvm,
  // checked on its Controls screen). The game reads both its primary (WASD) and secondary (arrows) layouts.
  const ACTIONS = {
    fire:       { label: 'Fire',                   mouse: 0 },
    secondary:  { label: 'Secondary fire',         mouse: 1 },        // the game's right button: scope on the sniper rifles, fire mode or melee on the rest
    scope:      { label: 'Scope / zoom (smart)',   scope: true },     // the weapon's scope when it has one, else nothing (binoculars are their own button)
    zoomin:     { label: 'Zoom in',                key: 11 },         // H (and the wheel)
    zoomout:    { label: 'Zoom out',               key: 17 },         // N
    nextweapon: { label: 'Next weapon',            key: 9 },          // F
    prevweapon: { label: 'Previous weapon',        key: 25 },         // V
    reload:     { label: 'Reload',                 key: 21 },         // R
    use:        { label: 'Action / use',           key: 8 },          // E
    crouch:     { label: 'Crouch',                 key: 225 },        // Left Shift (held)
    jump:       { label: 'Jump',                   key: 44 },         // Space
    peek:       { label: 'Peek',                   key: 53 },         // `
    bino:       { label: 'Binoculars',             key: 5 },          // B
    thermal:    { label: 'Thermal goggles',        key: 23 },         // T
    walk:       { label: 'Walk / run',             key: 57 },         // Caps Lock
    raise:      { label: 'Raise stance',           key: 20 },         // Q
    lower:      { label: 'Lower stance',           key: 29 },         // Z
    drop:       { label: 'Drop weapon',            key: 10 },         // G
    inventory:  { label: 'Inventory',              key: 39 },         // 0
    map:        { label: 'Map computer',           key: 16 },         // M
    menu:       { label: 'Menu',                   key: 41 },         // Esc
    none:       { label: 'Nothing' },
  };
  // the actions a mouse button can take, in menu order
  const MOUSE_CHOICES = ['fire', 'scope', 'secondary', 'bino', 'thermal', 'zoomin', 'zoomout', 'nextweapon', 'prevweapon', 'reload', 'crouch', 'jump', 'use', 'peek', 'walk', 'none'];
  // what the wheel does: the game's own wheel (zoom with a scope or the binoculars up, else cycle the actions on offer), or weapons
  const WHEEL_CHOICES = { game: 'Zoom / cycle action (game)', weapons: 'Next / previous weapon', none: 'Nothing' };

  const DEFAULTS = {
    mouse: { 0: 'fire', 1: 'secondary', 2: 'scope' },   // left, middle, right (MouseEvent.button)
    wheel: 'game',
    mouseSens: 1,       // PC: multiplier on mouse motion (1 = the game's own response, as on Windows)
    invertY: false,     // mouse and touch look: push forward to look down (flight-sim style)
    rawMouse: true,     // ask the browser for unaccelerated motion (pointer lock unadjustedMovement), like DirectInput on Windows
    look: 1,            // touch: swipe sensitivity
    scopeSens: 1,       // touch, mouse and gyro while zoomed (the game already slows the view by the zoom)
    scopeZoom: 3,       // the binoculars' zoom the smart scope snaps to (x the normal view)
    gyro: 'scope',      // 'off' | 'on' | 'scope'
    gyroSens: 1,
    gyroInvY: false,
    gyroInvX: false,
    wide: true,         // widescreen display modes (the loader starts the game with them, COHORT); false = 4:3
    fps: 'auto',        // 'auto' (a phone that can't hold 60 in a mission plays at a steady 30) | '30' | 'max'
    brightness: 1.15,   // screen brightness, applied as a CSS filter on the canvas (1 = untouched; lifted a little by default because many scenes read dark)
    contrast: 1,        // screen contrast, same CSS filter; raising both can make a dark scene readable
    gfx: 'auto',        // picture quality (loader.js gfxLevel): 'auto' (sharp on a computer, standard on phones and low-memory devices) | 'standard' | 'sharp' (16x anisotropic texture filtering) | 'ultra' (sharp + the picture drawn larger and scaled down: smooth edges)
    subs: false,
    tapFire: true,      // touch: a short tap on the open screen fires a shot in play (touch.js); off = only the FIRE buttons
  };
  let S = load();
  function load() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch { saved = {}; }
    const s = { ...DEFAULTS, mouse: { ...DEFAULTS.mouse } };
    for (const k of ['mouseSens', 'look', 'scopeSens', 'scopeZoom', 'gyroSens']) if (typeof saved[k] === 'number' && saved[k] > 0) s[k] = saved[k];
    if (typeof saved.brightness === 'number' && saved.brightness >= 0.5 && saved.brightness <= 2) s.brightness = saved.brightness;
    if (typeof saved.contrast === 'number' && saved.contrast >= 0.5 && saved.contrast <= 2) s.contrast = saved.contrast;
    if (['off', 'on', 'scope'].includes(saved.gyro)) s.gyro = saved.gyro;
    if (WHEEL_CHOICES[saved.wheel]) s.wheel = saved.wheel;
    if (['auto', '30', 'max'].includes(saved.fps)) s.fps = saved.fps;
    if (['auto', 'standard', 'sharp', 'ultra'].includes(saved.gfx)) s.gfx = saved.gfx;
    for (const k of ['gyroInvY', 'gyroInvX', 'invertY', 'rawMouse', 'wide', 'tapFire']) if (typeof saved[k] === 'boolean') s[k] = saved[k];
    if (saved.mouse) for (const b of [0, 1, 2]) if (ACTIONS[saved.mouse[b]]) s.mouse[b] = saved.mouse[b];
    return s;
  }
  function save() { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch { /* storage blocked */ } }
  // Brightness: a CSS filter on the game canvas (the browser compositor applies it, no GPU cost, works on both
  // the WebGPU and WebGL renderers). Several players said scenes read too dark; this lifts them without a rebuild.
  function brightnessApply() {
    let c = null; try { c = document.getElementById('canvas'); } catch { /* no DOM */ }
    if (!c) return;
    const parts = [];
    if (S.brightness && Math.abs(S.brightness - 1) > 0.001) parts.push(`brightness(${S.brightness})`);
    if (S.contrast && Math.abs(S.contrast - 1) > 0.001) parts.push(`contrast(${S.contrast})`);
    c.style.filter = parts.join(' ');
  }
  const get = () => S;
  function set(k, v) {
    S[k] = v; save(); if (k === 'gyro') gyroApply(); if (k === 'brightness' || k === 'contrast') brightnessApply();
    if (k === 'gfx') { try { window.rcGfxApply && window.rcGfxApply(); } catch { /* the loader applies it at the next start */ } }
    // the player's own choice of screen: the loader starts the game in widescreen display modes by it (COHORT)
    if (k === 'wide') { try { localStorage.setItem('igi2-wide-choice', v ? '1' : '0'); } catch { /* storage blocked */ } }
  }
  function setMouse(button, action) { S.mouse[button] = ACTIONS[action] ? action : 'none'; save(); }
  function reset() { S = { ...DEFAULTS, mouse: { ...DEFAULTS.mouse } }; save(); gyroApply(); brightnessApply(); try { window.rcGfxApply && window.rcGfxApply(); } catch { /* next start */ } }

  // ---- sending input: a key or mouse button held at least HOLD_MS so a quick tap still lasts a game frame
  let M = null;
  // A weapon HUD icon is drawn only in live play (render_rec.c g_weapon_sig: 0 in the menus, the map,
  // cutscenes and the fail menu). The game's clock-based in-mission/paused flags can misread live play as
  // paused when the clock global reads stale: in mission 2 (2026-11-07, confirmed across iPhone + PC reports)
  // the controls went dead, taps acted as a menu cursor, pause-ads appeared and a false "Mission over" showed.
  // So a drawn weapon is ground truth for "in a live mission, not paused"; a real death/fail draws no weapon,
  // so the genuine fail overlay still appears.
  let lastWeaponMs = 0, scopeLatch = false;
  const weaponDrawn = () => { const w = !!(M && M._input_weapon_sig && M._input_weapon_sig()); if (w) lastWeaponMs = performance.now(); return w; };
  // The game's clock global can read stale (2026-11-07 mission-2 root cause), so its own in-mission flag goes
  // false during live play and weaponDrawn() -- the HUD weapon icon -- is the only thing holding inMission()
  // true. But raising a scope HIDES that icon, and the detector can also miss it for a stray frame; then
  // inMission() dropped to false and the controls fell back to the menu cursor (absolute click-to-aim), the
  // "click anywhere and the crosshair jumps there" players reported. livePlay() covers both:
  // "Live play" even when the HUD weapon icon isn't detected this instant. A 3D world is being drawn
  // (render_rec.c sets g_zoom > 0 only on a world draw; it is 0 in the fully-2D menus, map and pause screen)
  // AND the weapon HUD was seen very recently. This covers BOTH a raised scope (which hides the HUD) and a
  // momentary miss of the bottom-right weapon icon during ordinary play -- either of which otherwise dropped
  // inMission() to false and handed the controls to the menu cursor (absolute click-to-aim). The main-menu
  // flythrough draws a world too but never a weapon, so it can't trigger this; a scope can be held longer than
  // the weapon window, so while the view stays zoomed the latch is kept alive.
  const worldDrawn = () => zoomRaw() > 0;
  const livePlay = () => {
    if (scoped()) { if (performance.now() - lastWeaponMs < 1500) scopeLatch = true; }
    else scopeLatch = false;
    if (scopeLatch) return true;
    // Once this level has actually begun (playedThisLevel latches the FIRST time the engine's own in-mission
    // flag fires, at mission start), any frame that draws a 3D world is live play -- no weapon icon needed. This
    // is the weapon-independent path: the HUD weapon-icon detector fails at some resolutions/aspects, so for
    // those players livePlay never armed and the menu's absolute cursor leaked into play -- on a phone that fed
    // the game absolute cursor positions and the view span round and round on a tap (iQOO Z5, 2026-11-10). It
    // can't arm in the main menu (playedThisLevel is false there) or a briefing (still tap-skippable, so the
    // engine flag is false then too), and for players whose weapon icon IS detected inMission() was already true,
    // so this changes nothing for them.
    if (playedThisLevel && worldDrawn()) return true;
    return worldDrawn() && performance.now() - lastWeaponMs < 2500;
  };
  const inMission = () => { const w = weaponDrawn(); return !!(M && M._input_in_mission && M._input_in_mission()) || w || livePlay(); };
  const paused = () => !!(M && M._input_paused && M._input_paused()) && !weaponDrawn() && !livePlay();
  // A failed level or a dead Jones: the game opens its pause menu with Resume greyed out, so Esc (or MENU) no
  // longer resumes. Without the game's own flag (Project I.G.I. has one, host/input.c) that is how it shows: a
  // menu press while paused that leaves the game paused. Cleared once the game runs again.
  // The heuristic may only fire once the player has actually been in active play this mission. A mission's
  // intro/briefing already reads as "paused" (profile.h), so skipping it with MENU before play ever starts
  // would otherwise look like a failed level (mission 2's intro, 2026-11-07). playedThisLevel tracks that;
  // it resets in the 2D menu / loading between missions (not the paused fail-menu), so each run is judged fresh.
  let stuckPause = false, stuckTimer = 0, playedThisLevel = false;
  function menuPressed() {
    if (!paused() || !playedThisLevel) return;
    clearTimeout(stuckTimer);
    stuckTimer = setTimeout(() => { if (paused() && playedThisLevel) stuckPause = true; }, 1500);
  }
  setInterval(() => {
    if (!M) return;
    if (inMission()) playedThisLevel = true;
    else if (!paused()) playedThisLevel = false;   // between missions: forget the old run before the next intro
    if (stuckPause && !paused()) stuckPause = false;
  }, 500);
  const levelFailed = () => !!(M && M._input_level_failed && M._input_level_failed()) || stuckPause;
  const downAt = new Map();
  function press(what, down) {
    if (!M) return;
    const k = what.key !== undefined ? 'k' + what.key : 'm' + what.mouse;
    const send = (v) => (what.key !== undefined ? M._input_key_hid(what.key, v) : M._input_mouse_button(what.mouse, v));
    if (down) { downAt.set(k, performance.now()); send(1); return; }
    const held = performance.now() - (downAt.get(k) ?? 0);
    downAt.delete(k);
    if (held >= HOLD_MS) send(0); else setTimeout(() => { if (!downAt.has(k)) send(0); }, HOLD_MS - held);
  }
  const tap = (what) => { press(what, true); press(what, false); };
  // one notch of the game's mouse wheel (+1 up = zoom in / previous action, -1 down)
  const wheel = (dir) => { if (M && M._input_mouse_wheel) M._input_mouse_wheel(dir > 0 ? 120 : -120); };

  // ---- the scope. zoom() is the view's zoom as the host saw it last frame (1 = normal view). scoped() is
  // true once the view is zoomed at all (a rifle's scope or the binoculars, however it got there).
  const BASE_M11 = 2.3094;   // the projection's y scale at the normal view
  const zoomRaw = () => (M && M._input_zoom ? M._input_zoom() : 0);
  const zoom = () => { const z = zoomRaw(); return z > 0 ? z / BASE_M11 : 1; };
  const scoped = () => zoom() > 1.12;
  // The HUD's current-weapon icon (host render_rec.c): the same signature for the same weapon everywhere
  const weaponSig = () => (M && M._input_weapon_sig ? M._input_weapon_sig() >>> 0 : 0);
  const BINO_SIG = 0x229cd194;   // the binoculars' own icon
  // Which weapons have a scope, learned the first time the scope is asked for with each (the game's Secondary
  // Fire raises it, e.g. the Dragunov's 3x / 9x). Seeded with mission 1's kit so those never fire a stray
  // Secondary (the MP5's fire mode, the pistol whip, the knife's stab).
  // (igi2-scopes until 2026-11-06: a slow phone could learn "no scope" for a sniper rifle, kept for good)
  const SCOPE_STORE = 'igi2-scopes2';
  const scopes = (() => { try { return JSON.parse(localStorage.getItem(SCOPE_STORE) || '{}') || {}; } catch { return {}; } })();
  for (const [sig, v] of [[0xfddaf414, 0], [0xb93b1666, 0], [0xb6314913, 0]]) if (scopes[sig] === undefined) scopes[sig] = v;
  const learn = (sig, v) => { scopes[sig] = v; try { localStorage.setItem(SCOPE_STORE, JSON.stringify(scopes)); } catch { /* storage blocked */ } };
  // "no scope" is only kept after two probes in a row saw no zoom: a rifle raising its scope on a slow phone
  // (a few frames of animation at 15-25 fps) must not be taken for a weapon without one
  const misses = {};
  const listeners = new Set();
  let lastScoped = false, lastShown = 0;
  const notify = () => { for (const f of listeners) f(scoped(), zoom()); };
  function onScope(f) { listeners.add(f); }
  let zoomKey = 0;          // +1 / -1 while a zoom key is held (by the toggle or the player), 0 otherwise
  let drive = null;
  function zoomKeyDown(dir) {
    if (zoomKey === dir) return;
    if (zoomKey) press(zoomKey > 0 ? ACTIONS.zoomin : ACTIONS.zoomout, false);
    zoomKey = dir;
    press(dir > 0 ? ACTIONS.zoomin : ACTIONS.zoomout, true);
  }
  function zoomKeyUp(dir) {
    if (zoomKey !== dir) return;
    zoomKey = 0;
    press(dir > 0 ? ACTIONS.zoomin : ACTIONS.zoomout, false);
  }
  function driveStop(reached) {
    if (!drive) return;
    const d = drive;
    clearInterval(d.timer);
    zoomKeyUp(d.dir);
    drive = null;
    notify();
    if (d.done && reached !== undefined) d.done(reached, d.moved);
  }
  // Drive the zoom keys towards a zoom factor (1 = normal view); give up when the view stands still for
  // `patience` ms (no zoom on this view) or after 4 s.
  function zoomTo(target, done, patience = 700) {
    driveStop();
    const z = zoom(), dir = target > z ? 1 : -1;
    if (Math.abs(target - z) < 0.04 * target) { if (done) done(true, false); return; }
    const now = performance.now();
    drive = { dir, target, last: z, lastT: now, t0: now, timer: 0, done, moved: false };
    zoomKeyDown(dir);
    drive.timer = setInterval(() => {
      const t = performance.now(), cur = zoom();
      const reached = dir > 0 ? cur >= target * 0.97 : cur <= Math.max(1.02, target * 1.03);
      if (Math.abs(cur - drive.last) > 0.005 * cur) { drive.last = cur; drive.lastT = t; drive.moved = true; }
      if (reached) driveStop(true);
      else if (t - drive.lastT > patience || t - drive.t0 > 4000) driveStop(false);
    }, 16);
  }
  // The smart scope. IGI 2's sniper rifles raise their scope with Secondary Fire (press again for the next power
  // or to lower it); every other weapon uses Secondary Fire for something else, so with those the toggle does
  // nothing (the binoculars have their own button). Which weapon has a scope is learned per HUD icon: the first
  // time, Secondary Fire is tried and the zoom watched; if no zoom follows, the weapon is marked scope-less.
  let viaBino = false, viaScope = false, wait = 0, lastToggle = 0, zoomPress = 0, zoomFrom = 1;
  const later = (ms, f) => { wait = setTimeout(() => { wait = 0; f(); }, ms); };
  function binoUp() {
    viaBino = true;
    tap(ACTIONS.bino);
    // the binoculars take a few frames to come up (longer on a slow phone), then zoom through them
    later(300, () => { if (scoped()) zoomTo(S.scopeZoom, null, 900); else later(250, () => zoomTo(S.scopeZoom, null, 900)); });
  }
  function scopeDown() {
    // the binoculars (ours or the player's): their key puts them away
    if (viaBino || weaponSig() === BINO_SIG) { viaBino = false; driveStop(); tap(ACTIONS.bino); return; }
    // a rifle's scope: Secondary Fire steps through its powers and then lowers it
    viaScope = false;
    let n = 0;
    const step = () => { tap(ACTIONS.secondary); if (++n < 3) later(220, () => { if (scoped()) step(); }); };
    step();
  }
  function scopeToggle() {
    if (!inMission()) return;
    const now = performance.now();
    if (wait && now - lastToggle < 1500) return;   // a second tap while the first is still bringing the scope up (or probing)
    if (wait) { clearTimeout(wait); wait = 0; }
    lastToggle = now;
    if (drive) { driveStop(); return; }   // a tap while it's still zooming: stop where it is
    if (scoped()) { scopeDown(); return; }
    viaBino = viaScope = false;
    const sig = weaponSig();
    if (!sig) return;                          // no weapon on screen (swimming, a cutscene)
    if (scopes[sig] === 0) return;             // known to have no scope: RMB stays inert, like the original (the binoculars are their own button)
    const z0 = zoom();
    tap(ACTIONS.secondary);
    if (scopes[sig] === 1) { viaScope = true; return; }
    const t0 = performance.now();
    const probe = () => {
      if (Math.abs(zoom() - z0) > 0.05) { viaScope = true; misses[sig] = 0; learn(sig, 1); notify(); return; }   // the scope came up
      if (performance.now() - t0 < 1400) { later(40, probe); return; }   // a slow phone draws a frame in 70+ ms
      // no zoom: this weapon has no scope. Match the original - do nothing (a PC player reported RMB opening
      // the binoculars mid-combat on weapons without a scope; in the original it does nothing there). The
      // binoculars stay on their own button. After a second miss, remember it so RMB stays inert on this weapon.
      if ((misses[sig] = (misses[sig] || 0) + 1) >= 2) learn(sig, 0);
      notify();
    };
    later(40, probe);
  }
  function weaponChanged() { driveStop(); viaScope = false; }
  setInterval(() => {
    if (!M) return;
    const s = scoped(), z = zoom();
    if (!s) { viaBino = viaBino && weaponSig() === BINO_SIG; }
    if (s !== lastScoped || (s && Math.abs(z - lastShown) > 0.15)) { lastScoped = s; lastShown = z; notify(); }
  }, 120);

  // ---- an action pressed / released (a mouse button or a touch button)
  function act(name, down) {
    const a = ACTIONS[name];
    if (!a) return;
    if (a.scope) { if (down) scopeToggle(); return; }
    if (name === 'menu' && down) { menuPressed(); try { window.pauseAds?.menuPressed?.(); } catch { /* no ads */ } }
    // Zoom in / out from a button: with nothing zoomed, + raises the scope; a tap steps 1.5x, a hold zooms on.
    if (name === 'zoomin' || name === 'zoomout') {
      const dir = name === 'zoomin' ? 1 : -1;
      if (down) {
        if (!scoped()) { zoomPress = 0; if (dir > 0) scopeToggle(); return; }
        driveStop(); zoomPress = performance.now(); zoomFrom = zoom(); zoomKeyDown(dir);
      } else if (zoomPress) {
        const held = performance.now() - zoomPress; zoomPress = 0;
        if (held < 220 && Math.abs(zoom() - zoomFrom) < 0.25 * zoomFrom) zoomTo(dir > 0 ? zoomFrom * 1.5 : Math.max(1.05, zoomFrom / 1.5), null, 500);
        else zoomKeyUp(dir);
      }
      return;
    }
    if (down && (name === 'nextweapon' || name === 'prevweapon' || name === 'drop')) weaponChanged();
    if (down && name === 'bino') viaBino = false;
    press(a, down);
  }
  // which action a physical mouse button does right now: in mouse-look mode the player's binding, in the
  // menus, the map and the Esc menu the plain button, so clicks always click
  function mouseAction(button) {
    if (!inMission()) return button === 0 ? 'fire' : button === 2 ? 'secondary' : 'none';
    return S.mouse[button] || 'none';
  }
  // the wheel, one notch: the game's own wheel (menus and the map always get it), or the weapons
  function wheelNotch(up) {
    if (!inMission() || S.wheel === 'game') { wheel(up ? 1 : -1); return; }
    if (S.wheel === 'weapons') { weaponChanged(); tap(up ? ACTIONS.prevweapon : ACTIONS.nextweapon); }
  }
  // keys that change the weapon (F, V, G, the quick keys 1-9) end a scope toggle in progress
  function keyUsage(usage, down) {
    if (down && usage === 41) menuPressed();   // Esc
    if (down && (usage === 9 || usage === 25 || usage === 10 || (usage >= 30 && usage <= 38))) weaponChanged();
  }

  // ---- look motion: fractions carry over so slow motion still moves
  let fx = 0, fy = 0;
  function look(dx, dy) {
    if (!M) return;
    if (S.invertY) dy = -dy;
    fx += dx; fy += dy;
    const ix = Math.trunc(fx), iy = Math.trunc(fy);
    if (ix || iy) { M._input_mouse_move(ix, iy); fx -= ix; fy -= iy; }
  }
  // While scoped the view turns slower, in step with the zoom (at 4x a swipe turns about a third as far),
  // times the player's own scope multiplier; mobile shooters do the same.
  const lookScale = () => (zoom() > 1.12 ? S.scopeSens : 1);

  // ---- gyroscope (devicemotion): the rotation rate about the vertical axis turns the view, about the screen's
  // horizontal axis tilts it. Gravity (low-passed accelerationIncludingGravity) gives both axes in the device's
  // frame whatever way the phone is held, so the mapping holds in either landscape and when the phone is
  // tilted back. iOS reports the acceleration with the opposite sign to the spec, and needs permission.
  const webkit = /AppleWebKit\//.test(navigator.userAgent) && !/Chrome\/|Chromium\/|Edg\//.test(navigator.userAgent);
  const DEG = 4.7;   // mouse counts per degree of phone rotation at sensitivity 1
  let g = null, wf = null, gyroOn = false, gyroLast = 0, gyroStatus = 'idle';   // idle | on | denied | none
  const gyroState = () => gyroStatus;
  function onMotion(e) {
    const r = e.rotationRate, a = e.accelerationIncludingGravity;
    if (!r || r.alpha == null || !a || a.x == null) { if (gyroStatus === 'on') gyroStatus = 'none'; return; }
    gyroStatus = 'on';
    const now = performance.now();
    // Each event is one sensor sample: integrate over the sensor's own interval (ms; a few WebKits report
    // seconds), not the time it took to arrive. Browsers deliver these in bursts under load, which with
    // arrival times made the view stutter. Without an interval, the arrival time, capped.
    let dt = typeof e.interval === 'number' && e.interval > 0 ? (e.interval < 1 ? e.interval : e.interval / 1000) : 0;
    if (!dt) dt = gyroLast ? (now - gyroLast) / 1000 : 0;
    dt = Math.min(dt, 0.05);
    const first = !gyroLast;
    gyroLast = now;
    const s = webkit ? -1 : 1;
    const ax = a.x * s, ay = a.y * s, az = a.z * s;
    g = g ? [g[0] + (ax - g[0]) * 0.15, g[1] + (ay - g[1]) * 0.15, g[2] + (az - g[2]) * 0.15] : [ax, ay, az];
    const n = Math.hypot(g[0], g[1], g[2]);
    // a light two-sample smoothing of the rates takes the sensor noise out without a felt lag
    const raw = [r.alpha, r.beta, r.gamma];
    wf = wf && !first ? [wf[0] + (raw[0] - wf[0]) * 0.5, wf[1] + (raw[1] - wf[1]) * 0.5, wf[2] + (raw[2] - wf[2]) * 0.5] : raw;
    if (!dt || first || n < 1) return;
    if (!gyroActive() || !inMission()) return;
    const up = [g[0] / n, g[1] / n, g[2] / n];                 // world up in device axes (x right, y top, z out of screen)
    const right = [up[1], -up[0], 0];                          // up × z: horizontal, in the screen plane, pointing right
    const rn = Math.hypot(right[0], right[1]);
    if (rn < 0.3) return;                                      // phone lying flat: no horizontal reference
    right[0] /= rn; right[1] /= rn;
    // deg/s about device x, y, z. The spec names alpha the rate about z, but Chromium AND WebKit both fill
    // alpha/beta/gamma straight from the gyroscope's x/y/z (device_motion_event_pump.cc, WebCoreMotionManager.mm).
    const w = wf;
    // right-hand rule about each axis: turning left (counter-clockwise seen from above) is a positive yaw,
    // and tilting the phone so its camera (the back) points up is a positive pitch (+y rolls into +z, so -z,
    // the camera, rolls into +y). Players reported the first version looked down when they tilted up: the
    // pitch sign was the wrong way round. Mouse counts: +x looks right, +y looks down.
    const yaw = w[0] * up[0] + w[1] * up[1] + w[2] * up[2];
    const pitch = w[0] * right[0] + w[1] * right[1];
    if (gyroDbg) gyroDbg(raw, up, yaw, pitch, dt);
    if (Math.abs(yaw) < 0.3 && Math.abs(pitch) < 0.3) return;  // hand tremor: a small dead zone
    if (Math.abs(yaw) > 720 || Math.abs(pitch) > 720) return;   // a sensor glitch, not a hand
    const k = DEG * S.gyroSens * lookScale() * dt;
    look(-yaw * k * (S.gyroInvX ? -1 : 1), -pitch * k * (S.gyroInvY ? -1 : 1));
  }
  const gyroActive = () => S.gyro === 'on' || (S.gyro === 'scope' && scoped());
  // ?gyrotest: a readout of what the sensor says and what reaches the game, for a screen recording when the
  // gyroscope misbehaves on a phone we don't have (rates in deg/s in the device frame, the up vector, the
  // yaw / pitch rates, the event interval, the events per second and the counts sent per second).
  let gyroDbg = null;
  if (new URLSearchParams(location.search).has('gyrotest')) {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:50%;top:40%;transform:translateX(-50%);z-index:9999;pointer-events:none;' +
      'background:rgba(0,0,0,.7);color:#9fe6b0;font:12px/1.4 ui-monospace,Menlo,monospace;padding:6px 10px;border-radius:8px;white-space:pre';
    document.body.appendChild(box);
    let shown = 0, events = 0, sentX = 0, sentY = 0, t0 = performance.now();
    const look0 = look;
    gyroDbg = (raw, up, yaw, pitch, dt) => {
      events++;
      const now = performance.now();
      if (now - shown < 100) return;
      shown = now;
      const secs = (now - t0) / 1000;
      box.textContent = `gyro raw ${raw.map((v) => v.toFixed(1).padStart(7)).join(' ')} deg/s\n` +
        `up   ${up.map((v) => v.toFixed(2).padStart(6)).join(' ')}   dt ${(dt * 1000).toFixed(1)} ms\n` +
        `yaw ${yaw.toFixed(1).padStart(7)}  pitch ${pitch.toFixed(1).padStart(7)} deg/s\n` +
        `${(events / secs).toFixed(0)} ev/s   sent ${(sentX / secs).toFixed(0)} ${(sentY / secs).toFixed(0)} counts/s   mode ${S.gyro} sens ${S.gyroSens}`;
      if (secs > 5) { t0 = now; events = 0; sentX = sentY = 0; }
    };
    look = (dx, dy) => { sentX += Math.abs(dx); sentY += Math.abs(dy); look0(dx, dy); };
  }
  // Starts listening (once): on iOS this must be called from a user gesture (a click). One request at a time.
  let gyroPending = null;
  function gyroEnable() {
    if (gyroOn) return Promise.resolve(gyroStatus);
    if (gyroPending) return gyroPending;
    gyroPending = (async () => {
      if (!window.DeviceMotionEvent) { gyroStatus = 'none'; return gyroStatus; }
      try {
        if (typeof DeviceMotionEvent.requestPermission === 'function') {
          const p = await DeviceMotionEvent.requestPermission();
          if (p !== 'granted') { gyroStatus = 'denied'; return gyroStatus; }
        }
      } catch { gyroStatus = 'denied'; return gyroStatus; }
      window.addEventListener('devicemotion', onMotion);
      gyroOn = true; gyroLast = 0; wf = null; gyroStatus = 'on';
      // no event within 1.5 s: the device has no motion sensors (or the browser blocks them)
      setTimeout(() => { if (gyroStatus === 'on' && !gyroLast) gyroStatus = 'none'; }, 1500);
      return gyroStatus;
    })().finally(() => { gyroPending = null; });
    return gyroPending;
  }
  // The saved setting wants the gyroscope: where the browser asks permission (iOS) that needs a gesture, so
  // it waits for the first tap on the page; elsewhere it starts right away.
  function gyroApply() {
    if (S.gyro === 'off' || gyroOn || gyroPending) return;
    if (typeof window.DeviceMotionEvent?.requestPermission !== 'function') { gyroEnable(); return; }
    const once = () => { window.removeEventListener('click', once, true); window.removeEventListener('touchend', once, true); gyroEnable(); };
    window.addEventListener('click', once, true);
    window.addEventListener('touchend', once, true);
  }

  function attach(module) { M = module; gyroApply(); try { brightnessApply(); } catch { /* re-applied elsewhere */ } }

  return { ACTIONS, MOUSE_CHOICES, WHEEL_CHOICES, DEFAULTS, wheelNotch, weaponSig, get, set, setMouse, reset, attach, brightnessApply, press, tap, act, mouseAction, keyUsage,
    look, lookScale, scoped, zoom, zoomTo, onScope, weaponChanged, inMission, paused, levelFailed, gyroEnable, gyroState,
    world: () => zoomRaw() > 0 };   // the game drew a 3D world last frame (0 zoom: one of its 2D screens)
})();
