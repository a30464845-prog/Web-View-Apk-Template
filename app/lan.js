// IGI 2: Covert Strike in the browser - Copyright (c) 2026 Sagar Joshi. All rights reserved.
// Not licensed for copying, hosting or reuse without written permission. See NOTICE.
// Online rooms for IGI 2: a virtual LAN between browsers.
//
// The game's multiplayer is plain UDP (host/net.c turns WinSock into a virtual LAN on 10.77.0.0/24). This
// module joins a room on the room server (server/lan/worker.js; server/lan/local.mjs for local testing), gets
// this player's address there (the first player, the host, is 10.77.0.1), and moves datagrams between the
// engine and the other players: directly over a WebRTC data channel to each of them when the browsers can
// reach each other (unordered, no retransmits: UDP's own behaviour), through the room server when they can't
// (or until the channel is up). The room also carries the lobby: who is in, and the host's announcement of the
// server it runs (map, port), which starts the other players' games.
'use strict';

const RcLan = (() => {
  const NODIRECT = typeof location !== 'undefined' && new URLSearchParams(location.search).has('nodirect');   // testing: every datagram through the room server
  const TURNONLY = typeof location !== 'undefined' && new URLSearchParams(location.search).has('turnonly');   // testing: links only through TURN
  const DCDROP = typeof location !== 'undefined' ? Number(new URLSearchParams(location.search).get('dcdrop')) || 0 : 0;   // testing: direct sends vanish N s after the channel opens (a silent link)
  // STUN only by default; the room's hello adds Cloudflare TURN (server/lan/worker.js iceServers), so a pair that
  // can't link directly goes through the nearest TURN server (~45 ms) rather than through the room (~266 ms)
  let ICE = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];
  let ws = null, me = 0, M = null, pump = 0;
  const peers = new Map();   // n -> { name, pc, dc, open, heard (last direct datagram), relayUntil }
  // A direct channel can go silent without closing (Wi-Fi or mobile handover, ICE consent lost): the game's client
  // then quits on "no server response". A peer whose direct channel has carried nothing for SILENT_MS gets its
  // datagrams through the room server for RELAY_MS, then direct again on trial; anything arriving on the channel
  // switches straight back. One path at a time, never both: late duplicates through the room confused the game's
  // own protocol (every match dropped the client within a minute, 2026-11-01).
  const SILENT_MS = 2000, RELAY_MS = 8000;
  const handlers = {};
  const stats = { sent: 0, recv: 0, direct: 0, relayed: 0 };
  const emit = (ev, ...a) => { try { handlers[ev]?.(...a); } catch (e) { console.warn('lan handler', e); } };
  const on = (ev, f) => { handlers[ev] = f; };
  const addr = (n) => [10, 77, 0, n];
  const naddr = (n) => (10 | 77 << 8 | 0 << 16 | n << 24) >>> 0;   // WinSock byte order (host/net.c)

  // ---- the room. Two transports with the same messages: a WebSocket to the room server (server/lan/worker.js,
  // which also relays datagrams), or HTTP polling of room.php (lobby and WebRTC set-up only: datagrams then go
  // over the direct channels alone).
  let poll = null;   // { url, code, n, token, timer } with room.php
  function onMessage(m, settle) {
    if (m.t === 'hello') {
      me = m.you;
      if (Array.isArray(m.ice) && m.ice.length) ICE = m.ice;
      clearInterval(measureTimer); measureTimer = setInterval(() => { measure().then(() => emit('lobby')); }, 3000);
      for (const p of m.peers) addPeer(p.n, p.name, true);   // the newcomer calls everyone already in
      settle({ you: me, host: me === 1, peers: m.peers, state: m.state });
      emit('lobby');
      if (m.state) emit('state', m.state);
      configure();
    } else if (m.t === 'join') { addPeer(m.n, m.name, false); emit('lobby'); }
    else if (m.t === 'leave') { dropPeer(m.n); emit('lobby'); }
    else if (m.t === 'sig') signal(m.from, m.data);
    else if (m.t === 'state') emit('state', m.state);
  }
  const post = (url, body) => fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, cache: 'no-store' }).then((r) => r.json());
  function connect(base, code, name, version) {
    close();
    if (!/^wss?:/.test(base)) return connectPoll(base, code, name, version);
    const url = `${base.replace(/\/$/, '')}/lan/${encodeURIComponent(code)}?name=${encodeURIComponent(name)}&v=${encodeURIComponent(version || '')}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      const fail = (msg) => { if (!settled) { settled = true; reject(new Error(msg)); } else emit('error', msg); };
      const t = setTimeout(() => fail('The room server did not answer.'), 10000);
      ws.onerror = () => fail('Could not reach the room server.');
      ws.onclose = () => { clearTimeout(t); if (settled) emit('closed'); else fail('The room server closed the connection.'); };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') { fromRelay(new Uint8Array(ev.data)); return; }
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === 'full') fail('That room is full (16 players).');
        else if (m.t === 'version') fail('That room runs a different version of the game page. Reload the page and try again.');
        else onMessage(m, (r) => { clearTimeout(t); settled = true; resolve(r); });
      };
    });
  }
  async function connectPoll(url, code, name, version) {
    let r;
    try { r = await post(url, { op: 'join', code, name, v: version || '' }); } catch { throw new Error('Could not reach the room server.'); }
    if (r.error === 'full') throw new Error('That room is full (16 players).');
    if (r.error === 'version') throw new Error('That room runs a different version of the game page. Reload the page and try again.');
    if (!r.you) throw new Error('The room server refused to join.');
    poll = { url, code, n: r.you, token: r.token, timer: 0, busy: false, fails: 0 };
    let result;
    onMessage({ t: 'hello', you: r.you, peers: r.peers, state: r.state }, (x) => { result = x; });
    const tick = async () => {
      const P = poll;
      if (!P || P.busy) return;
      P.busy = true;
      try {
        const q = await post(P.url, { op: 'poll', code: P.code, n: P.n, token: P.token });
        if (poll !== P) return;
        if (q.error === 'gone') { close(); emit('closed'); return; }
        P.fails = 0;
        for (const m of q.events || []) onMessage(m, () => {});
      } catch { if (++P.fails === 10) emit('error', 'The room server stopped answering.'); }
      finally {
        P.busy = false;
        // fast while channels are being set up, slower once everyone is linked
        if (poll === P) { const linking = [...peers.values()].some((p) => !p.open); P.timer = setTimeout(tick, linking ? 700 : 2500); }
      }
    };
    poll.timer = setTimeout(tick, 300);
    return result;
  }
  function close() {
    if (ws) { try { ws.onclose = null; ws.close(); } catch { /* closed */ } }
    ws = null;
    if (poll) { clearTimeout(poll.timer); const P = poll; poll = null; post(P.url, { op: 'leave', code: P.code, n: P.n, token: P.token }).catch(() => {}); }
    for (const n of [...peers.keys()]) dropPeer(n);
    clearInterval(measureTimer);
    me = 0;
  }
  const sendJson = (m) => {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(m)); return; }
    if (poll) post(poll.url, { op: m.t, code: poll.code, n: poll.n, token: poll.token, to: m.to, data: m.data, state: m.state }).catch(() => {});
  };
  const announce = (state) => sendJson({ t: 'state', state });   // host only (the server ignores the others)

  // ---- direct channels (WebRTC), set up through the room
  function addPeer(n, name, caller) {
    if (peers.has(n)) return;
    const p = { name, pc: null, dc: null, open: false, heard: 0, relayUntil: 0 };
    peers.set(n, p);
    if (typeof RTCPeerConnection !== 'function' || NODIRECT) return;
    const pc = p.pc = new RTCPeerConnection({ iceServers: ICE, iceTransportPolicy: TURNONLY ? 'relay' : 'all' });
    pc.onicecandidate = (e) => { if (e.candidate) sendJson({ t: 'sig', to: n, data: { cand: e.candidate } }); };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'failed' || st === 'closed' || st === 'disconnected') { p.open = false; emit('lobby'); }
      else if (st === 'connected' && p.dc && p.dc.readyState === 'open' && !p.open) { p.open = true; emit('lobby'); }
      if (st === 'failed' && typeof pc.restartIce === 'function') try { pc.restartIce(); } catch { /* old browser */ }
    };
    const wire = (dc) => {
      p.dc = dc; dc.binaryType = 'arraybuffer';
      dc.onopen = () => { p.open = true; p.heard = p.openedAt = performance.now(); emit('lobby'); };
      dc.onclose = () => { p.open = false; emit('lobby'); };
      dc.onmessage = (e) => { p.heard = performance.now(); p.relayUntil = 0; fromDirect(n, new Uint8Array(e.data)); };
    };
    if (caller) {
      wire(pc.createDataChannel('udp', { ordered: false, maxRetransmits: 0 }));
      pc.createOffer().then((o) => pc.setLocalDescription(o)).then(() => sendJson({ t: 'sig', to: n, data: { sdp: pc.localDescription } })).catch(() => {});
    } else pc.ondatachannel = (e) => wire(e.channel);
  }
  async function signal(from, data) {
    const p = peers.get(from);
    if (!p || !p.pc) return;
    try {
      if (data.sdp) {
        await p.pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') { await p.pc.setLocalDescription(await p.pc.createAnswer()); sendJson({ t: 'sig', to: from, data: { sdp: p.pc.localDescription } }); }
      } else if (data.cand) await p.pc.addIceCandidate(data.cand);
    } catch (e) { console.warn('lan signal', e.message); }
  }
  // how each direct link runs: 'direct' (straight between the two browsers) or 'turn' (through Cloudflare's TURN), and
  // its round trip from WebRTC's own measurement; shown in the lobby and reported once per match (loader.js mpnet)
  async function measure() {
    for (const p of peers.values()) {
      if (!p.pc || !p.open) { p.link = null; continue; }
      try {
        const st = await p.pc.getStats(); let pair = null, local = null;
        st.forEach((x) => { if (x.type === 'transport' && x.selectedCandidatePairId) pair = st.get(x.selectedCandidatePairId); });
        if (!pair) st.forEach((x) => { if (x.type === 'candidate-pair' && x.nominated && x.state === 'succeeded') pair = x; });
        if (pair) local = st.get(pair.localCandidateId);
        p.link = pair ? { kind: local && local.candidateType === 'relay' ? 'turn' : 'direct',
          rtt: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null } : null;
      } catch { p.link = null; }
    }
  }
  let measureTimer = 0;
  function dropPeer(n) {
    const p = peers.get(n);
    if (!p) return;
    try { p.dc?.close(); p.pc?.close(); } catch { /* closed */ }
    peers.delete(n);
  }

  // ---- datagrams. Engine outbox record: [dst addr 4][src port 2][dst port 2][data] (host/net.c net_pop).
  // Direct channel message: [src port 2][dst port 2][broadcast 1][data] (the sender is the channel's peer).
  // Room relay: as worker.js says.
  const heap = () => new Uint8Array(M.wasmMemory.buffer);
  function drain() {
    if (!M) return;
    const buf = M._net_buf();
    for (let i = 0; i < 256; i++) {
      const len = M._net_pop();
      if (!len) break;
      const rec = heap().slice(buf, buf + len);
      stats.sent++;
      const bcast = rec[0] === 255 && rec[1] === 255 && rec[2] === 255 && rec[3] === 255;
      const direct = new Uint8Array(len - 3);
      const dsend = (p) => { if (!(DCDROP && performance.now() - p.openedAt > DCDROP * 1000)) p.dc.send(direct); };
      direct.set(rec.subarray(4, 8), 0); direct[4] = bcast ? 1 : 0; direct.set(rec.subarray(8), 5);
      const now = performance.now();
      const trusted = (p) => {
        if (!p.open) return false;
        if (!ws || ws.readyState !== 1) return true;   // no room server to fall back on (room.php): direct is all there is
        if (now < p.relayUntil) return false;
        if (now - p.heard > SILENT_MS) { p.relayUntil = now + RELAY_MS; p.heard = now + RELAY_MS; stats.fallbacks = (stats.fallbacks || 0) + 1; return false; }   // then a SILENT_MS trial
        return true;
      };
      if (bcast) {
        let all = true;
        for (const p of peers.values()) if (trusted(p)) { try { dsend(p); stats.direct++; } catch { all = false; } } else all = false;
        if (!all && ws && ws.readyState === 1) { ws.send(rec); stats.relayed++; }   // the room skips nobody: duplicates are harmless for UDP
      } else if (rec[0] === 10 && rec[1] === 77 && rec[2] === 0) {
        const p = peers.get(rec[3]);
        let sent = false;
        if (p && trusted(p)) { try { dsend(p); stats.direct++; sent = true; } catch { /* fall back */ } }
        if (!sent && ws && ws.readyState === 1) { ws.send(rec); stats.relayed++; }
      }
    }
  }
  function deliver(from, sport, dport, data, bcast) {
    if (!M || !data.length || data.length > 65536) return;
    heap().set(data, M._net_buf());
    M._net_push(from, sport, dport, data.length, bcast ? 1 : 0);
    stats.recv++;
  }
  function fromRelay(d) {
    if (d.length < 9) return;
    deliver((d[0] | d[1] << 8 | d[2] << 16 | d[3] << 24) >>> 0, d[4] | d[5] << 8, d[6] | d[7] << 8, d.subarray(9), d[8]);
  }
  function fromDirect(n, d) {
    if (d.length < 5) return;
    deliver(naddr(n), d[0] | d[1] << 8, d[2] | d[3] << 8, d.subarray(5), d[4]);
  }

  // the engine is running: give it this player's address and start moving its datagrams
  function configure() {
    if (!M || !me || !M._net_config) return;
    M._net_config(naddr(me), naddr(255));
  }
  function linkSummary() {   // e.g. "direct 34|turn 47|room" for the report
    return [...peers.values()].map((p) => (p.open && p.link ? p.link.kind + (p.link.rtt != null ? ' ' + p.link.rtt : '') : ws ? 'room' : 'none')).join('|');
  }
  function attach(module) {
    M = module;
    configure();
    clearInterval(pump);
    pump = setInterval(drain, 4);
  }

  return {
    connect, close, on, announce, attach, stats,
    me: () => me, address: (n) => addr(n || me).join('.'),
    players: () => [{ n: me, name: 'you', open: true, self: true }, ...[...peers].map(([n, p]) => ({ n, name: p.name, open: p.open, link: p.link || null }))].sort((a, b) => a.n - b.n),
    linkSummary,
    connected: () => (!!ws && ws.readyState === 1) || !!poll,
    relay: () => !!ws,
  };
})();
if (typeof module !== 'undefined') module.exports = RcLan;
