'use strict';
// Say Hello: room bingo icebreaker. Zero dependencies, in-memory rooms.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATS_FILE = path.join(__dirname, 'stats.json');
const ROOM_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_PLAYERS = 150;
const MAX_SQUARES_PER_PERSON = 2; // forces you to meet more people
const CARD_SIZE = 9;

const QUESTIONS = [
  { id: 'from', type: 'text', label: 'Where are you from?', placeholder: 'e.g. Pune, Kerala, Delhi',
    square: 'Find someone from {v}', starter: 'Ask {n} what you must eat when you visit {v}.' },
  { id: 'trip', type: 'text', label: 'Last place you travelled to?', placeholder: 'e.g. Rishikesh',
    square: "Find someone who's been to {v}", starter: 'Ask {n} the best thing they did in {v}.' },
  { id: 'fact', type: 'text', label: 'A weird skill or fun fact about you', placeholder: "e.g. I can solve a Rubik's cube",
    square: 'Find who says: "{v}"', starter: 'Ask {n} to prove it 😄' },
  { id: 'vibe', type: 'choice', label: 'Mountains or beaches?', options: ['Mountains', 'Beaches'],
    square: 'Find a {v} person', starter: 'Ask {n} about their dream {v} trip.' },
  { id: 'clock', type: 'choice', label: 'Night owl or early bird?', options: ['Night owl', 'Early bird'],
    square: 'Find a fellow {v}', starter: 'Ask {n} what a perfect day looks like for a {v}.' },
  { id: 'fuel', type: 'choice', label: "Can't travel without…", options: ['Chai', 'Coffee', 'Maggi', 'Momos'],
    square: "Find someone who can't travel without {v}", starter: 'Ask {n} where to get the best {v} around here.' },
];
const Q = Object.fromEntries(QUESTIONS.map((q) => [q.id, q]));

// A card only ever holds squares about real people in the room. Below MIN_PLAYERS the card is locked.
// Squares fill the main diagonal first, so a complete line is possible as soon as the room is playable.
const MIN_PLAYERS = 3;
const SLOT_ORDER = [4, 0, 8, 2, 6, 1, 7, 3, 5];

// ---------- stats (persisted so restarts keep the numbers) ----------
let stats = { rooms: 0, players: 0, connections: 0, bingos: 0, since: new Date().toISOString() };
try { stats = { ...stats, ...JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')) }; } catch { /* first run */ }
let statsDirty = false;
const bump = (k) => { stats[k]++; statsDirty = true; };
setInterval(() => {
  if (!statsDirty) return;
  statsDirty = false;
  fs.writeFile(STATS_FILE, JSON.stringify(stats, null, 2), () => {});
}, 5000).unref();

// ---------- helpers ----------
const rooms = new Map();
const norm = (s) => String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
const fill = (tpl, v, n) => tpl.replace(/\{v\}/g, v).replace(/\{n\}/g, n);
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);

function newRoomCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += A[crypto.randomInt(A.length)];
    if (!rooms.has(c)) return c;
  }
}
function newPlayerCode(room) {
  for (;;) {
    const c = String(crypto.randomInt(1000, 10000));
    if (![...room.players.values()].some((p) => p.code === c)) return c;
  }
}
function pushEvent(room, text) {
  room.events.push({ id: ++room.eventSeq, text, at: Date.now() });
  if (room.events.length > 30) room.events.shift();
}

// ---------- bingo card ----------
function factPool(room, me) {
  const pool = [];
  const seen = new Set();
  for (const o of shuffle([...room.players.values()])) {
    if (o.id === me.id) continue;
    for (const q of QUESTIONS) {
      const v = o.answers[q.id];
      if (!v) continue;
      const key = q.id + '|' + norm(v);
      if (seen.has(key)) continue;
      seen.add(key);
      pool.push({ key, q, v, owner: o.id });
    }
  }
  // Specific (text) facts first: they point at one person and spark better conversations.
  return shuffle(pool).sort((a, b) => (a.q.type === 'text' ? 0 : 1) - (b.q.type === 'text' ? 0 : 1));
}
function factSquare(f) {
  const v = f.q.type === 'choice' ? f.v.toLowerCase() : f.v;
  // Text facts point at one person; choice facts can be matched by anyone with that answer.
  return { kind: 'fact', key: f.key, q: f.q.id, norm: norm(f.v), v, owner: f.owner, text: fill(f.q.square, v, ''), done: false };
}
function refillCard(room, p) {
  // Below the minimum, every square stays locked. We never invent squares that aren't about real people here.
  if (room.players.size < MIN_PLAYERS) return;
  const used = new Set(p.card.filter((s) => s.kind === 'fact').map((s) => s.key));
  const perOwner = {};
  for (const s of p.card) if (s.owner) perOwner[s.owner] = (perOwner[s.owner] || 0) + 1;
  const pool = factPool(room, p).filter((f) => !used.has(f.key));
  for (const i of SLOT_ORDER) {
    const s = p.card[i];
    if (s.done || s.kind !== 'empty') continue;
    // Never put more single-person squares on a card than that person is allowed to fill.
    const idx = pool.findIndex((f) => (perOwner[f.owner] || 0) < MAX_SQUARES_PER_PERSON);
    if (idx < 0) break;
    const [f] = pool.splice(idx, 1);
    perOwner[f.owner] = (perOwner[f.owner] || 0) + 1;
    p.card[i] = factSquare(f);
  }
}
function newCard() {
  return Array.from({ length: CARD_SIZE }, () => ({ kind: 'empty', text: 'Waiting for more people to join…', done: false }));
}
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const hasLine = (card) => LINES.some((l) => l.every((i) => card[i].done));

// ---------- views ----------
function publicState(room) {
  const players = [...room.players.values()]
    .map((p) => ({ id: p.id, name: p.name, emoji: p.emoji, score: p.card.filter((s) => s.done).length, met: p.met.size, bingo: p.bingoAt || 0 }))
    .sort((a, b) => (a.bingo && b.bingo ? a.bingo - b.bingo : (b.bingo ? 1 : 0) - (a.bingo ? 1 : 0)) || b.met - a.met || b.score - a.score);
  return { code: room.code, count: players.length, minPlayers: MIN_PLAYERS, players: players.slice(0, 20), events: room.events.slice(-8).reverse() };
}
function meState(p) {
  return {
    id: p.id, name: p.name, emoji: p.emoji, code: p.code,
    score: p.card.filter((s) => s.done).length, met: p.met.size, bingo: !!p.bingoAt,
    card: p.card.map((s) => ({ text: s.text, done: s.done, empty: s.kind === 'empty', byName: s.byName, byEmoji: s.byEmoji, starter: s.starter })),
  };
}

// ---------- actions ----------
function createRoom() {
  const code = newRoomCode();
  rooms.set(code, { code, players: new Map(), events: [], eventSeq: 0, createdAt: Date.now(), lastActive: Date.now() });
  bump('rooms');
  return { code };
}
function joinRoom(room, body) {
  if (room.players.size >= MAX_PLAYERS) throw httpErr(400, 'This room is full. Start a new one!');
  const name = clean(body.name, 20);
  if (!name) throw httpErr(400, 'Tell us your name');
  const emoji = clean(body.emoji, 8) || '🙂';
  const answers = {};
  for (const q of QUESTIONS) {
    const v = clean(body.answers?.[q.id], 40);
    if (!v) throw httpErr(400, `Answer: ${q.label}`);
    if (q.type === 'choice' && !q.options.includes(v)) throw httpErr(400, `Pick an option for: ${q.label}`);
    answers[q.id] = v;
  }
  const p = {
    id: crypto.randomUUID(), secret: crypto.randomBytes(16).toString('hex'),
    name, emoji, answers, code: newPlayerCode(room), card: newCard(), met: new Set(), bingoAt: 0, attempts: [],
  };
  room.players.set(p.id, p);
  for (const o of room.players.values()) refillCard(room, o); // everyone's card gets better as people join
  pushEvent(room, `${emoji} ${name} joined`);
  bump('players');
  return { pid: p.id, secret: p.secret };
}
function claim(room, p, body) {
  // Slow down code guessing: max 8 wrong codes per minute.
  const now = Date.now();
  p.attempts = p.attempts.filter((t) => now - t < 60000);
  if (p.attempts.length >= 8) throw httpErr(429, 'Too many wrong codes. Go talk to them and get the real one 😉');
  const r = tryClaim(room, p, body);
  if (!r.ok) p.attempts.push(now);
  return r;
}
function tryClaim(room, p, body) {
  const slot = Number(body.slot);
  const s = p.card[slot];
  if (!Number.isInteger(slot) || !s) throw httpErr(400, 'Bad square');
  if (s.done) return { ok: false, msg: 'You already unlocked this one.' };
  if (s.kind === 'empty') return { ok: false, msg: `This square unlocks when more people join (${MIN_PLAYERS}+ needed).` };
  const code = String(body.code || '').replace(/\D/g, '');
  const o = [...room.players.values()].find((x) => x.code === code && x.id !== p.id);
  if (code === p.code) return { ok: false, msg: "That's your own code 😄 Go find someone else!" };
  if (!o) return { ok: false, msg: 'Nobody in this room has that code. Double-check it.' };
  if (s.kind === 'fact' && norm(o.answers[s.q]) !== s.norm) {
    return { ok: false, msg: `${o.emoji} ${o.name} isn't the one for this square. But now you've said hi, ask who it might be!` };
  }
  // Cap squares per person so one friend can't fill your whole card. Bingo means meeting 2+ people.
  const already = p.card.filter((x) => x.done && x.by === o.id).length;
  if (already >= MAX_SQUARES_PER_PERSON) {
    return { ok: false, msg: `${o.name} already filled ${MAX_SQUARES_PER_PERSON} of your squares. Find someone new!` };
  }
  const starterTpl = Q[s.q].starter;
  Object.assign(s, { done: true, by: o.id, byName: o.name, byEmoji: o.emoji, starter: fill(starterTpl, s.v || '', o.name) });
  if (!p.met.has(o.id)) { p.met.add(o.id); bump('connections'); }
  let bingo = false;
  if (!p.bingoAt && hasLine(p.card)) {
    p.bingoAt = Date.now(); bingo = true; bump('bingos');
    pushEvent(room, `🎉 ${p.emoji} ${p.name} got BINGO!`);
  } else {
    pushEvent(room, `${p.emoji} ${p.name} met ${o.emoji} ${o.name}`);
  }
  return { ok: true, bingo, other: { name: o.name, emoji: o.emoji }, starter: s.starter, text: s.text };
}

// ---------- http ----------
function httpErr(status, msg) { const e = new Error(msg); e.status = status; return e; }
function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 10000) { reject(httpErr(413, 'Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { reject(httpErr(400, 'Bad JSON')); } });
    req.on('error', reject);
  });
}
function auth(room, req) {
  const p = room.players.get(String(req.headers['x-pid'] || ''));
  if (!p) return null;
  const a = Buffer.from(String(req.headers['x-secret'] || '')), b = Buffer.from(p.secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? p : null;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  if (!path.extname(file)) file = path.join(PUBLIC_DIR, 'index.html'); // SPA routes like /stats
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(file);
    res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300' });
    res.end(buf);
  });
}

async function handleApi(req, res, parts) {
  // parts: ['api', ...]
  const [, a, code, action] = parts;
  if (a === 'questions' && req.method === 'GET') return send(res, 200, { questions: QUESTIONS.map(({ id, type, label, placeholder, options }) => ({ id, type, label, placeholder, options })) });
  if (a === 'stats' && req.method === 'GET') return send(res, 200, { ...stats, liveRooms: rooms.size, livePlayers: [...rooms.values()].reduce((n, r) => n + r.players.size, 0) });
  if (a !== 'rooms') throw httpErr(404, 'Not found');
  if (!code && req.method === 'POST') return send(res, 201, createRoom());

  const room = rooms.get(String(code || '').toUpperCase());
  if (!room) throw httpErr(404, 'Room not found');
  room.lastActive = Date.now();

  if (!action && req.method === 'GET') {
    const p = auth(room, req);
    return send(res, 200, { ...publicState(room), me: p ? meState(p) : null });
  }
  if (action === 'join' && req.method === 'POST') return send(res, 201, joinRoom(room, await readBody(req)));
  if (action === 'claim' && req.method === 'POST') {
    const p = auth(room, req);
    if (!p) throw httpErr(401, 'Please join the room first');
    return send(res, 200, claim(room, p, await readBody(req)));
  }
  throw httpErr(404, 'Not found');
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  const parts = pathname.split('/').filter(Boolean);
  try {
    if (parts[0] === 'api') return await handleApi(req, res, parts);
    if (pathname === '/healthz') return send(res, 200, { ok: true });
    serveStatic(req, res, pathname);
  } catch (e) {
    if (!e.status) console.error(e);
    send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [c, r] of rooms) if (now - r.lastActive > ROOM_TTL_MS) rooms.delete(c);
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => console.log(`Say Hello running on http://localhost:${PORT}`));
