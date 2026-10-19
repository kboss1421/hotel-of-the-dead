// Grave Suite online hub: parties, matchmaking, private matches, and the match rooms themselves.
// One small Node.js program, no packages needed. Runs on any host that gives it a PORT (Render, Railway, Fly, your own PC).
//   /hub          lobby connection: who is online, parties, invites, matchmaking, private matches
//   /room/<id>    a match (same protocol as the game's own server, so the game plays exactly the same)
'use strict';
const http = require('http');
const crypto = require('crypto');

const PORT = +process.env.PORT || 8090;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const COOP_TYPES = new Set(['zs', 'zr', 'zre', 'zk', 'zatk', 'zhit', 'pu', 'pug', 'znuke', 'zone', 'zfloor', 'trap', 'zsync', 'zover', 'zwin']);
const MP_MAPS = ['royale', 'frost', 'skyline', 'manor', 'refinery', 'temple', 'nuketown', 'shipyard', 'oldtown', 'farm', 'downtown', 'colosseum'];
const ZM_MAPS = ['hotel', 'nuketown', 'manor', 'refinery', 'temple', 'shipyard', 'oldtown', 'farm', 'downtown', 'frost'];
const BOT_NAMES = ['Viper', 'Ghost', 'Reaper', 'Nomad', 'Havoc', 'Rook', 'Specter', 'Blaze', 'Talon', 'Raven', 'Frost', 'Diesel', 'Jinx', 'Onyx', 'Wolf', 'Cobra', 'Saber', 'Hex', 'Bishop', 'Kodiak'];
const MAX_IN_ROOM = 10, PUBLIC_HUMANS = 8, TEAM_SIZE = 5, SCORE_LIMIT = 100, SND_ROUNDS = 4, SND_MAP = 'colosseum';
const MODES = ['tdm', 'ffa', 'zm', 'snd'];
const rnd = a => a[Math.floor(Math.random() * a.length)];
const code = (n = 6) => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < n; i++) s += A[crypto.randomInt(A.length)]; return s; };
const clean = (s, n) => String(s || '').replace(/[^A-Za-z0-9 _-]/g, '').slice(0, n).trim();

// ---------- minimal WebSocket framing (RFC 6455, text frames only) ----------
function frame(text) {
  const data = Buffer.from(text), n = data.length; let head;
  if (n < 126) head = Buffer.from([0x81, n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, data]);
}
function wsRead(sock, onMsg, onClose) {
  let buf = Buffer.alloc(0), closed = false;
  const done = () => { if (!closed) { closed = true; onClose(); } };
  sock.on('close', done); sock.on('error', done);
  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f, masked = buf[1] & 0x80; let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 65536) { sock.destroy(); return; }
      const need = off + (masked ? 4 : 0) + len; if (buf.length < need) return;
      let data = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) { const mk = buf.subarray(off, off + 4); data = Buffer.from(data); for (let i = 0; i < data.length; i++) data[i] ^= mk[i & 3]; }
      buf = buf.subarray(need);
      if (op === 0x8) { sock.end(); return; }
      if (op === 0x9) { sock.write(Buffer.concat([Buffer.from([0x8a, data.length]), data])); continue; }
      if (op !== 0x1) continue;
      let msg; try { msg = JSON.parse(data.toString('utf8')); } catch (e) { continue; }
      if (msg && typeof msg === 'object') onMsg(msg);
    }
  });
}
const sendTo = (sock, o) => { if (sock && !sock.destroyed) sock.write(frame(JSON.stringify(o))); };

// ---------- match rooms (same rules as the game's own server) ----------
const rooms = new Map();
function createRoom({ map, mode, bots, priv, owner }) {
  if (mode === 'snd' && map === 'hotel') map = SND_MAP;
  if (map === 'hotel') mode = 'zm';
  const id = code(8);
  const room = { id, map, mode, priv: !!priv, owner, allowed: new Set(), tickets: new Map(), minutes: 10, scores: { blue: 0, red: 0 }, time: 600, running: true, created: Date.now(), emptySince: Date.now() };
  const botTarget = mode === 'zm' ? 0 : Math.max(0, Math.min(MAX_IN_ROOM, bots | 0));
  const players = new Map(), botsMap = new Map(); let nextId = 1, nextBot = 1001, hostId = null;
  const limit = () => mode === 'snd' ? SND_ROUNDS : SCORE_LIMIT;
  const info = () => ({ map, mode, limit: limit(), time: room.time, scores: room.scores, running: room.running });
  const pinfo = p => Object.assign({ id: p.id, name: p.name, team: p.team, skin: p.skin, banner: p.banner || '', kills: p.kills, deaths: p.deaths, score: p.score }, p.bot ? { bot: true } : {});
  const everyone = () => [...players.values(), ...botsMap.values()];
  const send = (p, o) => sendTo(p.sock, o);
  const broadcast = (o, ex) => { const f = frame(JSON.stringify(o)); for (const p of players.values()) if (p !== ex && !p.sock.destroyed) p.sock.write(f); };
  const stats = () => { const s = {}; for (const p of everyone()) s[p.id] = [p.kills, p.deaths, p.score]; return s; };
  const pickTeam = pref => { if (mode === 'zm') return 'blue'; if (mode === 'ffa') return null;
    // a party keeps its team, except S&D without bots, which needs someone on both sides
    const n = t => everyone().filter(p => p.team === t).length; if (pref && n(pref) < TEAM_SIZE && !(mode === 'snd' && !botTarget)) return pref; return n('blue') <= n('red') ? 'blue' : 'red'; };
  const rosterMsg = () => ({ t: 'roster', host: hostId, bots: [...botsMap.values()].map(pinfo) });
  function rebalance() {
    let changed = false; const hid = players.size ? Math.min(...players.keys()) : null; if (hid !== hostId) { hostId = hid; changed = true; }
    const want = players.size ? Math.max(0, botTarget - players.size) : 0;
    while (botsMap.size < want) { const used = new Set([...botsMap.values()].map(b => b.name.replace(' [BOT]', ''))); const name = BOT_NAMES.find(n => !used.has(n)) || ('Bot' + nextBot);
      const b = { id: nextBot, name: name + ' [BOT]', team: pickTeam() || ('p' + nextBot), skin: 'default', kills: 0, deaths: 0, score: 0, bot: true, x: 0, z: 0 }; botsMap.set(b.id, b); nextBot++; changed = true; }
    while (botsMap.size > want) { let pool = [...botsMap.values()];
      if (mode === 'tdm' || mode === 'snd') { const n = t => everyone().filter(p => p.team === t).length; const big = n('blue') >= n('red') ? 'blue' : 'red'; if (pool.some(b => b.team === big)) pool = pool.filter(b => b.team === big); }
      const gone = pool[pool.length - 1]; botsMap.delete(gone.id); sndOut(gone.id, gone.x, gone.z); changed = true; }
    if (changed) broadcast(rosterMsg());
  }
  const restart = () => { room.scores = { blue: 0, red: 0 }; room.time = room.minutes * 60; room.running = true; room.snd = sndNew(); for (const q of everyone()) q.kills = q.deaths = q.score = 0; broadcast({ t: 'restart', room: info() }); sndRound(); };
  function endMatch() { room.running = false; broadcast({ t: 'end', scores: room.scores, standings: everyone().map(pinfo).sort((a, b) => b.score - a.score || b.kills - a.kills) }); setTimeout(restart, 12000); }
  function checkEnd() { if (!room.running || mode === 'zm' || mode === 'snd') return; const lim = limit();
    if (mode === 'tdm' ? (room.scores.blue >= lim || room.scores.red >= lim) : everyone().some(p => p.kills >= lim)) endMatch(); }
  const actingAs = (p, m) => (m.as != null && p.id === hostId && botsMap.has(m.as)) ? botsMap.get(m.as) : p;
  const num = (v, lo, hi) => { const x = Number(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : lo; };
  // ---------- Search and Destroy: the server runs the rounds (same rules as the game's own server) ----------
  // one life per round; clients report bomb pickups, plants and defuses, the server checks them and decides every round
  const SND_ROUND = 150, SND_FUSE = 40;
  const sndNew = () => ({ round: 0, wins: { blue: 0, red: 0 }, att: Math.random() < .5 ? 'blue' : 'red', phase: 'wait', t: SND_ROUND, fuse: 0, bomb: { c: null, x: 0, z: 0, pl: false, site: null, by: null }, alive: new Set(), gen: 0 });
  const sndOther = t => t === 'blue' ? 'red' : 'blue';
  const sndCounts = aliveOnly => { const n = { blue: 0, red: 0 }; for (const e of everyone()) if (e.team in n && (!aliveOnly || room.snd.alive.has(e.id))) n[e.team]++; return n; };
  const sndMsg = (ev, kw) => { const s = room.snd, b = s.bomb; return Object.assign({ t: 'snd', ev, round: s.round, att: s.att, wins: s.wins, phase: s.phase, tl: s.t, fuse: s.fuse, c: b.c, bx: +b.x.toFixed(2), bz: +b.z.toFixed(2), pl: b.pl, site: b.site, ids: [...s.alive].sort((a, c) => a - c), al: sndCounts(true), target: limit(), half: Math.max(1, limit() - 1) }, kw || {}); };
  function sndRound() {
    const s = room.snd; if (mode !== 'snd' || !room.running) return;
    const n = sndCounts(false);
    if (!players.size || !n.blue || !n.red) { if (s.phase !== 'wait') { s.phase = 'wait'; s.alive = new Set(); broadcast(sndMsg('wait')); } return; }
    s.round++; const swap = s.round > 1 && (s.round - 1) % Math.max(1, limit() - 1) === 0; if (swap) s.att = sndOther(s.att);
    s.phase = 'live'; s.t = SND_ROUND; s.fuse = 0; s.alive = new Set(everyone().filter(e => e.team === 'blue' || e.team === 'red').map(e => e.id));
    const atts = everyone().filter(e => e.team === s.att);
    s.bomb = { c: atts[Math.floor(Math.random() * atts.length)].id, x: 0, z: 0, pl: false, site: null, by: null };
    broadcast(sndMsg('round', { swap }));
  }
  function sndEnd(win, reason, kw) {
    const s = room.snd; if (s.phase !== 'live') return;
    s.phase = 'over'; s.wins[win]++; room.scores.blue = s.wins.blue; room.scores.red = s.wins.red; s.bomb.c = null;
    broadcast(sndMsg('end', Object.assign({ win, reason }, kw || {})));
    const gen = ++s.gen;
    if (s.wins[win] >= limit()) setTimeout(() => { if (room.snd === s && s.gen === gen && room.running) endMatch(); }, 3000);
    else setTimeout(() => { if (room.snd === s && s.gen === gen) sndRound(); }, 5000);
  }
  function sndCheck() {
    const s = room.snd; if (s.phase !== 'live') return; const al = sndCounts(true), att = s.att, dfn = sndOther(att);
    if (!al[dfn]) sndEnd(att, 'elim'); else if (!al[att] && !s.bomb.pl) sndEnd(dfn, 'elim');
  }
  // someone is out of the round (died, left, or a bot was removed); a carrier drops the bomb where they were
  function sndOut(id, x, z) {
    const s = room.snd; if (mode !== 'snd' || s.phase !== 'live' || !s.alive.has(id)) return; s.alive.delete(id);
    const b = s.bomb; if (b.c === id) { b.c = null; if (Number.isFinite(x) && Number.isFinite(z)) { b.x = x; b.z = z; } broadcast(sndMsg('drop')); }
    sndCheck();
  }
  function sndTick() {
    const s = room.snd; if (!room.running) return; if (s.phase === 'wait') { sndRound(); return; } if (s.phase !== 'live') return;
    if (s.bomb.pl) { if (--s.fuse <= 0) { sndEnd(s.att, 'boom', { boom: 1 }); return; } } else if (--s.t <= 0) { sndEnd(sndOther(s.att), 'time'); return; }
    broadcast(sndMsg('tick'));
  }
  // bpick / bprog / bplant / bdefuse from a player, or from the host for one of its bots
  function sndAction(p, m) {
    const s = room.snd; if (mode !== 'snd' || s.phase !== 'live') return; const who = actingAs(p, m); if (!s.alive.has(who.id)) return;
    const b = s.bomb, att = who.team === s.att;
    if (m.t === 'bpick') { if (att && !b.pl && b.c == null) { b.c = who.id; broadcast(sndMsg('pick', { by: who.id })); } }
    else if (m.t === 'bprog') { if (m.k === 'plant' || m.k === 'defuse') broadcast({ t: 'sndp', k: m.k, by: who.id, p: +num(m.p, 0, 1).toFixed(2) }, p); }
    else if (m.t === 'bplant') {
      const x = Number(m.x), z = Number(m.z);
      if (att && !b.pl && b.c === who.id && (m.site === 'A' || m.site === 'B') && Number.isFinite(x) && Number.isFinite(z)) {
        Object.assign(b, { pl: true, site: m.site, x, z, by: who.id, c: null }); s.fuse = SND_FUSE; who.score += 300; broadcast(sndMsg('plant', { by: who.id }));
      }
    } else if (m.t === 'bdefuse') { if (!att && b.pl) { who.score += 300; sndEnd(who.team, 'defuse', { by: who.id }); } }
  }
  const sndPos = (e, s) => { const x = Number(s && s.x), z = Number(s && s.z); if (e && Number.isFinite(x) && Number.isFinite(z)) { e.x = x; e.z = z; } };
  room.snd = sndNew();
  function handle(p, m) {
    const t = m.t;
    if (t === 'state') { if (mode === 'snd') sndPos(p, m.s); broadcast({ t: 'state', id: p.id, s: m.s }, p); }
    else if (t === 'bstate') {
      if (p.id === hostId && Array.isArray(m.l)) {
        if (mode === 'snd') for (const a of m.l.slice(0, 32)) if (Array.isArray(a)) sndPos(botsMap.get(a[0]), { x: a[1], z: a[3] });
        broadcast({ t: 'bstate', l: m.l.slice(0, 32) }, p);
      }
    }
    else if (t === 'bpick' || t === 'bprog' || t === 'bplant' || t === 'bdefuse') sndAction(p, m);
    else if (COOP_TYPES.has(t)) {
      if (mode !== 'zm') return; const out = Object.assign({}, m, { from: p.id });
      if (t === 'zhit' || t === 'znuke') { const h = players.get(hostId); if (h && h !== p) send(h, out); }
      else if (m.to != null) { const tp = players.get(m.to); if (tp) send(tp, out); } else broadcast(out, p);
      if (t === 'zover' && p.id === hostId && room.running) { room.running = false; setTimeout(restart, 10000); }
    } else if (t === 'hit') {
      const src = actingAs(p, m);
      if (botsMap.has(m.to) && room.running) { const h = players.get(hostId); if (h && h !== p) send(h, { t: 'bhit', to: m.to, from: src.id, dmg: num(m.dmg, 0, 300), head: !!m.head, w: String(m.w || '').slice(0, 24), stun: num(m.stun, 0, 1) }); return; }
      const target = players.get(m.to);
      if (target && target !== src && room.running) send(target, { t: 'hit', from: src.id, dmg: num(m.dmg, 0, 300), head: !!m.head, w: String(m.w || '').slice(0, 24), stun: num(m.stun, 0, 1) });
    } else if (t === 'died') {
      if (!room.running) return; const v = actingAs(p, m); v.deaths++; const killer = players.get(m.by) || botsMap.get(m.by); const head = !!m.head;
      if (killer && killer !== v) { killer.kills++; killer.score += 100 + (head ? 25 : 0); if (mode === 'tdm' && killer.team in room.scores) room.scores[killer.team]++; }
      broadcast({ t: 'kill', killer: killer ? killer.id : null, victim: v.id, w: String(m.w || '').slice(0, 24), head, scores: room.scores, stats: stats() });
      if (mode === 'snd') { sndPos(v, m); sndOut(v.id, v.x, v.z); }
      checkEnd();
    } else if (t === 'shot' || t === 'fx') {
      // voice handshakes go to one player only
      if (m.k === 'rtc' && m.to != null) { const tp = players.get(m.to); if (tp) send(tp, Object.assign({}, m, { from: p.id })); return; }
      const out = Object.assign({}, m, { from: actingAs(p, m).id }); delete out.as; broadcast(out, p);
    }
  }
  room.humans = () => players.size;
  room.join = (sock, ticket) => {
    let p = null;
    wsRead(sock, msg => {
      if (!p) {
        if (msg.t !== 'hello') return;
        const tk = room.tickets.get(ticket);
        if (room.priv && !tk) { sendTo(sock, { t: 'full', why: 'private' }); sock.end(); return; }
        if (players.size >= MAX_IN_ROOM) { sendTo(sock, { t: 'full' }); sock.end(); return; }
        p = { id: nextId++, name: clean(msg.name, 14) || 'Player', sock, kills: 0, deaths: 0, score: 0, x: 0, z: 0, skin: String(msg.skin || 'default').replace(/[^a-z]/g, '').slice(0, 12) || 'default', banner: String(msg.banner || '').replace(/[^a-z0-9]/g, '').slice(0, 16) };
        p.team = pickTeam(tk && tk.team) || ('p' + p.id);
        const others = [...players.values()].map(pinfo); players.set(p.id, p); room.emptySince = 0;
        send(p, { t: 'welcome', id: p.id, team: p.team, room: info(), players: others }); if (mode === 'snd') send(p, sndMsg('state')); broadcast({ t: 'join', p: pinfo(p) }, p); send(p, rosterMsg()); rebalance(); hubRoomChanged(room); return;
      }
      handle(p, msg);
    }, () => { if (p && players.delete(p.id)) { broadcast({ t: 'leave', id: p.id }); sndOut(p.id, p.x, p.z); rebalance(); if (!players.size) room.emptySince = Date.now(); hubRoomChanged(room); } p = null; });
  };
  room.tick = () => { if (mode === 'snd') { if (players.size) sndTick(); return; } if (!room.running || !players.size || mode === 'zm') return; room.time--; if (room.time <= 0) endMatch(); else if (room.time % 5 === 0) broadcast({ t: 'time', time: room.time, scores: room.scores }); };
  rooms.set(id, room); return room;
}
setInterval(() => { const t = Date.now(); for (const r of rooms.values()) { r.tick(); if (r.emptySince && t - r.emptySince > 90000) rooms.delete(r.id); } }, 1000);
function ticketFor(room, user, team) { const tk = code(10); room.tickets.set(tk, { uid: user.uid, team, at: Date.now() }); return tk; }

// ---------- the lobby: presence, parties, invites, matchmaking ----------
const users = new Map();     // uid -> {uid, name, skin, sock, friend, party, queue, lastSeen, status}
const byFriend = new Map();  // friend code -> uid
const parties = new Map();   // party code -> {code, leader, members:[uid], room}
const queue = [];            // {party or solo leader uid, uids:[...], mode, since}
const friendOf = uid => { let f = crypto.createHash('sha1').update('hotd' + uid).digest('hex').slice(0, 6).toUpperCase(); return f; };
const online = u => u && u.sock && !u.sock.destroyed;
function push(uid, o) { const u = users.get(uid); if (online(u)) sendTo(u.sock, o); }
function partyView(p) { return p && { code: p.code, leader: p.leader, members: p.members.map(id => { const u = users.get(id) || {}; return { uid: id, name: u.name || '?', friend: u.friend, online: online(u), status: u.status || 'menu' }; }), queued: queue.some(q => q.uids.includes(p.leader)) }; }
function pushParty(p) { if (!p) return; const v = partyView(p); for (const id of p.members) push(id, { t: 'party', party: v }); }
function onlineList() { return [...users.values()].filter(online).slice(0, 60).map(u => ({ name: u.name, friend: u.friend, status: u.status || 'menu', inParty: !!u.party })); }
let presenceT = null;
function presence() { if (presenceT) return; presenceT = setTimeout(() => { presenceT = null; const l = onlineList(); const msg = { t: 'online', n: l.length, list: l, rooms: [...rooms.values()].filter(r => !r.priv).length };
  for (const u of users.values()) if (online(u)) sendTo(u.sock, msg); }, 300); }
function leaveParty(u) {
  const p = parties.get(u.party); u.party = null; if (!p) return;
  p.members = p.members.filter(id => id !== u.uid); unqueue(p.leader);
  if (!p.members.length) { parties.delete(p.code); return; }
  if (p.leader === u.uid) { p.leader = p.members[0]; push(p.leader, { t: 'toast', text: 'You are the party leader now' }); }
  pushParty(p);
}
function unqueue(uid) { const i = queue.findIndex(q => q.uids.includes(uid)); if (i >= 0) { const q = queue.splice(i, 1)[0]; for (const id of q.uids) push(id, { t: 'mm', state: 'idle' }); } }
// send a group into a room: each gets a ticket; teams stay together in TDM
function sendIn(room, uids, why) {
  const team = room.mode === 'tdm' || room.mode === 'snd' ? (() => { let b = 0, r = 0; for (const t of room.tickets.values()) t.team === 'red' ? r++ : b++; return b <= r ? 'blue' : 'red'; })() : null;
  for (const id of uids) { const u = users.get(id); if (!u) continue; const tk = ticketFor(room, u, team); u.status = 'in a match'; push(id, { t: 'match', room: room.id, ticket: tk, map: room.map, mode: room.mode, priv: room.priv, why }); }
  for (const id of uids) { const u = users.get(id); if (u && u.party) { const p = parties.get(u.party); if (p && p.leader === id) p.room = room.id; } }
  presence();
}
function hubRoomChanged(room) { presence(); }
// matchmaking: every 2 s, fill public rooms that have space, otherwise open new ones (bots fill empty slots)
setInterval(() => {
  const now = Date.now();
  for (let i = 0; i < queue.length; i++) {
    const q = queue[i]; const waited = now - q.since;
    let room = [...rooms.values()].find(r => !r.priv && r.mode === q.mode && r.running && r.humans() + q.uids.length <= PUBLIC_HUMANS && now - r.created < 9 * 60000);
    if (!room) {
      // wait a little for others to queue so people land together
      const same = queue.filter(o => o.mode === q.mode); const total = same.reduce((a, o) => a + o.uids.length, 0);
      if (waited < 8000 && total < 2) continue;
      room = createRoom({ map: q.mode === 'snd' ? SND_MAP : rnd(q.mode === 'zm' ? ZM_MAPS : MP_MAPS), mode: q.mode, bots: q.mode === 'zm' ? 0 : MAX_IN_ROOM });
      for (const o of same) { if (room.humans() + o.uids.length > PUBLIC_HUMANS) continue; sendIn(room, o.uids, 'matchmaking'); o.done = true; }
    } else { sendIn(room, q.uids, 'matchmaking'); q.done = true; }
  }
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].done) queue.splice(i, 1);
}, 2000);
function hubSession(sock) {
  let u = null;
  wsRead(sock, m => {
    if (!u) {
      if (m.t !== 'hello') return;
      const uid = String(m.uid || '').replace(/[^a-z0-9]/gi, '').slice(0, 24) || code(12);
      u = users.get(uid) || { uid, party: null };
      if (online(u) && u.sock !== sock) { sendTo(u.sock, { t: 'toast', text: 'Signed in somewhere else' }); u.sock.destroy(); }
      Object.assign(u, { sock, name: clean(m.name, 14) || 'Player', skin: String(m.skin || 'default').replace(/[^a-z]/g, '').slice(0, 12), friend: friendOf(uid), lastSeen: Date.now(), status: m.inGame ? 'in a match' : 'menu' });
      users.set(uid, u); byFriend.set(u.friend, uid);
      sendTo(sock, { t: 'hi', uid, friend: u.friend });
      if (u.party && parties.has(u.party)) pushParty(parties.get(u.party)); else u.party = null;
      presence(); return;
    }
    u.lastSeen = Date.now();
    const p = u.party && parties.get(u.party), lead = p && p.leader === u.uid;
    switch (m.t) {
      case 'name': u.name = clean(m.name, 14) || u.name; if (p) pushParty(p); presence(); break;
      case 'status': u.status = m.inGame ? 'in a match' : 'menu'; if (p) pushParty(p); presence(); break;
      case 'party.create': if (!p) { const pc = code(5); parties.set(pc, { code: pc, leader: u.uid, members: [u.uid], room: null }); u.party = pc; pushParty(parties.get(pc)); presence(); } break;
      case 'party.join': {
        const target = parties.get(String(m.code || '').toUpperCase().replace(/^P-/, '')); if (!target) { sendTo(sock, { t: 'toast', text: 'No party with that code' }); break; }
        if (target.members.length >= 8) { sendTo(sock, { t: 'toast', text: 'That party is full' }); break; }
        if (p && p !== target) leaveParty(u); if (!target.members.includes(u.uid)) target.members.push(u.uid); u.party = target.code; pushParty(target); presence();
        // the party is already playing: follow the leader in
        const lr = target.room && rooms.get(target.room); if (lr && lr.humans() < MAX_IN_ROOM) { if (lr.priv) lr.allowed.add(u.uid); sendIn(lr, [u.uid], 'joined your party'); }
        break; }
      case 'party.leave': if (p) { leaveParty(u); sendTo(sock, { t: 'party', party: null }); presence(); } break;
      case 'party.kick': if (lead && m.uid !== u.uid) { const v = users.get(m.uid); if (v && v.party === p.code) { leaveParty(v); push(v.uid, { t: 'party', party: null }); push(v.uid, { t: 'toast', text: 'You were removed from the party' }); } } break;
      case 'party.promote': if (lead && p.members.includes(m.uid)) { p.leader = m.uid; pushParty(p); } break;
      case 'invite': {
        // invite someone (by friend code) to your party; makes a party if you have none
        const to = byFriend.get(String(m.friend || '').toUpperCase()); const tu = users.get(to);
        if (!online(tu)) { sendTo(sock, { t: 'toast', text: 'That player is not online' }); break; }
        let party = p; if (!party) { const pc = code(5); party = { code: pc, leader: u.uid, members: [u.uid], room: null }; parties.set(pc, party); u.party = pc; pushParty(party); }
        const room = party.room && rooms.get(party.room); if (room && room.priv) room.allowed.add(to);
        push(to, { t: 'invite', from: u.name, party: party.code }); sendTo(sock, { t: 'toast', text: 'Invite sent to ' + tu.name }); break; }
      case 'mm.queue': {
        const mode = MODES.includes(m.mode) ? m.mode : 'tdm';
        if (p && !lead) { sendTo(sock, { t: 'toast', text: 'Only the party leader can start matchmaking' }); break; }
        const uids = p ? p.members.filter(id => online(users.get(id))) : [u.uid]; unqueue(u.uid);
        queue.push({ uids, mode, since: Date.now() }); for (const id of uids) push(id, { t: 'mm', state: 'searching', mode }); break; }
      case 'mm.cancel': if (!p || lead) unqueue(u.uid); break;
      case 'private.create': {
        if (p && !lead) { sendTo(sock, { t: 'toast', text: 'Only the party leader can start a private match' }); break; }
        const mode = MODES.includes(m.mode) ? m.mode : 'tdm'; const map = (mode === 'zm' ? ZM_MAPS : MP_MAPS).includes(m.map) ? m.map : mode === 'snd' ? SND_MAP : 'nuketown';
        const room = createRoom({ map, mode, bots: m.bots | 0, priv: true, owner: u.uid }); const uids = p ? p.members.filter(id => online(users.get(id))) : [u.uid];
        for (const id of uids) room.allowed.add(id); sendIn(room, uids, 'private match'); break; }
      case 'private.invite': {
        // let one more friend into your private match
        const room = rooms.get(String(m.room || '')); const to = byFriend.get(String(m.friend || '').toUpperCase());
        if (!room || !room.priv || !room.allowed.has(u.uid)) break; if (!online(users.get(to))) { sendTo(sock, { t: 'toast', text: 'That player is not online' }); break; }
        room.allowed.add(to); push(to, { t: 'invite', from: u.name, room: room.id, map: room.map, mode: room.mode }); sendTo(sock, { t: 'toast', text: 'Invite sent' }); break; }
      case 'private.join': {
        const room = rooms.get(String(m.room || '')); if (!room) { sendTo(sock, { t: 'toast', text: 'That match has ended' }); break; }
        if (room.priv && !room.allowed.has(u.uid)) { sendTo(sock, { t: 'toast', text: 'That match is invite only' }); break; }
        sendIn(room, [u.uid], 'invite'); break; }
      case 'ping': sendTo(sock, { t: 'pong' }); break;
    }
  }, () => { if (u && u.sock === sock) { u.sock = null; u.lastSeen = Date.now(); unqueue(u.uid); presence(); if (u.party) pushParty(parties.get(u.party)); } });
}
// people who closed the game for good drop out of their party after 2 minutes
setInterval(() => { const t = Date.now(); for (const u of users.values()) if (!online(u) && t - u.lastSeen > 120000) { if (u.party) leaveParty(u); users.delete(u.uid); } }, 30000);

// ---------- HTTP + upgrade routing ----------
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (url === '/stats') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ online: onlineList().length, rooms: rooms.size, parties: parties.size, queue: queue.length })); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><title>Grave Suite hub</title><body style="font-family:sans-serif;background:#0b0910;color:#eee;padding:30px"><h1>Grave Suite online hub</h1><p>This is the matchmaking server. Open the game to play.</p></body>');
});
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key']; if (!key) { sock.destroy(); return; }
  const u = new URL(req.url || '/', 'http://x'); const parts = u.pathname.split('/').filter(Boolean);
  let target = null;
  if (parts[0] === 'hub') target = () => hubSession(sock);
  else if (parts[0] === 'room' && rooms.has(parts[1])) { const room = rooms.get(parts[1]); target = () => room.join(sock, u.searchParams.get('t')); }
  if (!target) { sock.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true); sock.setKeepAlive(true, 20000); target();
});
server.listen(PORT, () => console.log('Grave Suite hub listening on port ' + PORT));
