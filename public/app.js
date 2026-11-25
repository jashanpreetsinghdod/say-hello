'use strict';
const $ = (s) => document.querySelector(s);
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

const EMOJIS = ['🦊', '🐼', '🐯', '🦁', '🐸', '🐙', '🦄', '🐧', '🐨', '🐵', '🦉', '🐳', '🌵', '🍕', '🎸', '🏔️'];
const params = new URLSearchParams(location.search);
let roomCode = (params.get('r') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
let questions = null;
let pollTimer = null;
let currentPoll = null;
let lastJson = '';
let lastBingo = null;
let pickedEmoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];

const sessKey = (c) => 'sayhello:' + c;
const getSess = () => { try { return JSON.parse(localStorage.getItem(sessKey(roomCode))); } catch { return null; } };
const setSess = (s) => localStorage.setItem(sessKey(roomCode), JSON.stringify(s));
const clearSess = () => localStorage.removeItem(sessKey(roomCode));

async function api(method, url, body) {
  const headers = { 'content-type': 'application/json' };
  const s = roomCode ? getSess() : null;
  if (s) { headers['x-pid'] = s.pid; headers['x-secret'] = s.secret; }
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Something went wrong. Try again.'); e.status = res.status; throw e; }
  return data;
}

function show(name) {
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'view-' + name; });
  document.body.dataset.view = name;
  const tr = $('#topRight');
  if (roomCode && (name === 'game' || name === 'join')) tr.replaceChildren(h('span', { class: 'pill' }, 'ROOM ', h('b', {}, roomCode)));
  else tr.replaceChildren(h('span', { class: 'pill' }, 'SAY ', h('b', {}, 'HELLO'), ' 👋'));
  window.scrollTo(0, 0);
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2800);
}
const joinUrl = (c) => `${location.origin}/?r=${c}`;
const prettyUrl = (c) => joinUrl(c).replace(/^https?:\/\//, '');
const qrUrl = (c, size) => `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=8&data=${encodeURIComponent(joinUrl(c))}`;
const setUrl = (q) => history.replaceState(null, '', q ? '/?' + q : '/');
function goHome(msg) { if (msg) toast(msg); clearTimeout(pollTimer); roomCode = ''; setUrl(''); show('home'); }

// ---------- modal ----------
function openModal(content) {
  $('#modalBody').replaceChildren(content);
  $('#modal').hidden = false;
  const inp = content.querySelector('input');
  if (inp) setTimeout(() => inp.focus(), 50);
}
function closeModal() { $('#modal').hidden = true; }
$('#modalClose').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// ---------- home ----------
$('#btnCreate').addEventListener('click', async (e) => {
  const b = e.currentTarget; b.disabled = true;
  try {
    const { code } = await api('POST', '/api/rooms');
    roomCode = code; setUrl('r=' + code);
    await openJoin(true);
  } catch (err) { toast(err.message); } finally { b.disabled = false; }
});
$('#inpCode').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); });
$('#formCode').addEventListener('submit', async (e) => {
  e.preventDefault();
  const c = $('#inpCode').value;
  if (c.length !== 4) return toast('Room codes have 4 letters');
  roomCode = c; setUrl('r=' + c);
  if (getSess()) startGame(); else openJoin(false);
});

// ---------- join ----------
async function openJoin(isHost) {
  try {
    await api('GET', '/api/rooms/' + roomCode);
    if (!questions) questions = (await api('GET', '/api/questions')).questions;
  } catch (e) { return goHome(e.status === 404 ? 'No room with that code. Start a new one!' : e.message); }
  $('#joinCode').textContent = roomCode;
  $('#joinHostNote').hidden = !isHost;
  renderEmojis(); renderQuestions();
  show('join');
}
function renderEmojis() {
  $('#emojiGrid').replaceChildren(...EMOJIS.map((em) => h('button', {
    type: 'button', class: 'emoji' + (em === pickedEmoji ? ' on' : ''), 'aria-label': 'Emoji ' + em, 'aria-pressed': String(em === pickedEmoji),
    onclick: () => { pickedEmoji = em; renderEmojis(); },
  }, em)));
}
function renderQuestions() {
  const qf = $('#qFields');
  if (qf.childElementCount) return;
  for (const q of questions) {
    if (q.type === 'text') {
      qf.append(h('label', { class: 'field' }, h('span', {}, q.label),
        h('input', { name: q.id, maxlength: 40, placeholder: q.placeholder, required: true, autocomplete: 'off' })));
    } else {
      qf.append(h('fieldset', { class: 'field' }, h('legend', {}, q.label),
        h('div', { class: 'chips' }, q.options.map((o) => h('label', { class: 'chip' },
          h('input', { type: 'radio', name: q.id, value: o, required: true }), h('span', {}, o))))));
    }
  }
}
$('#formJoin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector('button[type=submit]');
  const fd = new FormData(form);
  const answers = {};
  for (const q of questions) answers[q.id] = String(fd.get(q.id) || '').trim();
  btn.disabled = true;
  try {
    const r = await api('POST', `/api/rooms/${roomCode}/join`, { name: String(fd.get('name') || '').trim(), emoji: pickedEmoji, answers });
    setSess({ pid: r.pid, secret: r.secret });
    startGame();
  } catch (err) {
    if (err.status === 404) return goHome('That room has ended. Start a new one!');
    toast(err.message);
  } finally { btn.disabled = false; }
});

// ---------- game ----------
function startGame() {
  show('game');
  lastJson = ''; lastBingo = null;
  $('#qr').src = qrUrl(roomCode, 400);
  $('#joinLink').textContent = prettyUrl(roomCode);
  $('#btnScreen').href = `/?r=${roomCode}&screen=1`;
  currentPoll = pollGame; pollGame();
}
async function pollGame() {
  clearTimeout(pollTimer);
  try {
    const st = await api('GET', '/api/rooms/' + roomCode);
    if (!st.me) { clearSess(); return openJoin(false); }
    renderGame(st);
  } catch (e) {
    if (e.status === 404) { clearSess(); return goHome('This room has ended. Start a new one!'); }
  }
  pollTimer = setTimeout(pollGame, document.hidden ? 10000 : 2500);
}
function renderGame(st) {
  const json = JSON.stringify(st);
  if (json === lastJson) return;
  lastJson = json;
  const me = st.me;
  $('#meEmoji').textContent = me.emoji;
  $('#meName').textContent = me.name;
  $('#meCode').textContent = me.code;
  $('#gRoom').textContent = st.code;
  $('#gCount').textContent = st.count;
  $('#grid').replaceChildren(...me.card.map((s, i) => h('button', {
    type: 'button', class: 'sq' + (s.done ? ' done' : '') + (s.empty ? ' empty' : ''), onclick: () => openSquare(i, s),
  }, s.empty
    ? [h('span', { class: 'sq-emoji' }, '🔒')]
    : s.done
    ? [h('span', { class: 'sq-emoji' }, s.byEmoji), h('span', { class: 'sq-text' }, s.text), h('span', { class: 'sq-by' }, s.byName)]
    : h('span', { class: 'sq-text' }, s.text))));
  const live = me.card.filter((s) => !s.empty).length;
  const need = st.minPlayers - st.count;
  const lobby = $('#lobby');
  lobby.hidden = need <= 0;
  if (need > 0) {
    lobby.replaceChildren(h('b', {}, `Waiting for ${need} more ${need === 1 ? 'person' : 'people'}`),
      h('span', {}, `Your card is built from real people in the room, so it unlocks at ${st.minPlayers} players. Show the QR below!`));
  }
  $('#progText').textContent = need > 0 ? '' : `${me.score}/${live} squares · met ${me.met} ${me.met === 1 ? 'person' : 'people'}${me.bingo ? ' · BINGO 🎉' : ''}`;
  renderBoard($('#board'), st.players, me.id);
  renderFeed($('#feed'), st.events);
  if (me.bingo && lastBingo === false) celebrate();
  lastBingo = me.bingo;
}
function renderBoard(el, players, myId) {
  if (!players.length) return el.replaceChildren(h('li', { class: 'empty' }, 'No one yet. Be the first!'));
  el.replaceChildren(...players.slice(0, 10).map((p, i) => h('li', { class: p.id === myId ? 'me' : '' },
    h('span', { class: 'rank' }, i + 1), h('span', { class: 'em' }, p.emoji), h('span', { class: 'nm' }, p.name),
    h('span', { class: 'sc' }, p.bingo ? 'BINGO' : `${p.met} met`))));
}
function renderFeed(el, events) {
  if (!events.length) return el.replaceChildren(h('li', { class: 'empty' }, 'Quiet… go say hi 👋'));
  el.replaceChildren(...events.map((ev) => h('li', {}, ev.text)));
}
function openSquare(i, s) {
  if (s.empty) return toast('Locked until more people join. Share the QR!');
  if (s.done) return openModal(resultView({ other: { name: s.byName, emoji: s.byEmoji }, starter: s.starter, text: s.text }));
  const input = h('input', { class: 'code-input', inputmode: 'numeric', pattern: '[0-9]*', maxlength: 4, placeholder: '0000', autocomplete: 'off', 'aria-label': 'Their 4-digit code' });
  const err = h('p', { class: 'err', hidden: true });
  const btn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Unlock square');
  const showErr = (m) => { err.textContent = m; err.hidden = false; };
  const form = h('form', {
    class: 'claim',
    onsubmit: async (e) => {
      e.preventDefault();
      const code = input.value.replace(/\D/g, '');
      if (code.length !== 4) return showErr('Codes have 4 digits.');
      btn.disabled = true;
      try {
        const r = await api('POST', `/api/rooms/${roomCode}/claim`, { slot: i, code });
        if (!r.ok) return showErr(r.msg);
        if (r.bingo) lastBingo = true;
        openModal(resultView(r));
        if (r.bingo) celebrate();
        pollGame();
      } catch (ex) { showErr(ex.message); } finally { btn.disabled = false; }
    },
  },
  h('p', { class: 'script sm' }, 'find'),
  h('h3', { class: 'sq-title' }, s.text),
  h('p', { class: 'muted' }, 'Walk around and ask people. When you find them, ask for the 4-digit code on their screen.'),
  input, err, btn);
  openModal(form);
}
function resultView(r) {
  return h('div', { class: 'result' },
    h('div', { class: 'res-emoji' }, r.other.emoji),
    h('h3', {}, `You met ${r.other.name}!`),
    h('p', { class: 'muted' }, r.text),
    h('div', { class: 'starter' }, h('small', {}, '💬 Keep it going'), h('p', {}, r.starter)),
    h('button', { class: 'btn btn-outline', type: 'button', onclick: closeModal }, 'Back to my card'));
}
function celebrate() {
  const wrap = h('div', { class: 'confetti', 'aria-hidden': 'true' });
  const bits = ['🎉', '👋', '✨', '🎊', '💖', '🏔️'];
  for (let i = 0; i < 40; i++) {
    wrap.append(h('span', { style: `left:${Math.random() * 100}%;animation-delay:${Math.random() * 0.8}s;font-size:${18 + Math.random() * 22}px` }, bits[i % bits.length]));
  }
  wrap.append(h('div', { class: 'bingo-banner' }, 'BINGO!'));
  document.body.append(wrap);
  if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
  setTimeout(() => wrap.remove(), 3500);
}
$('#btnShare').addEventListener('click', async () => {
  const url = joinUrl(roomCode);
  const text = `Join room ${roomCode} and say hello 👋 No app, no sign-up.`;
  if (navigator.share) { try { await navigator.share({ title: 'Say Hello', text, url }); } catch { /* cancelled */ } return; }
  try { await navigator.clipboard.writeText(url); toast('Link copied!'); } catch { prompt('Copy this link', url); }
});

// ---------- big screen ----------
function startScreen() {
  show('screen');
  $('#sQr').src = qrUrl(roomCode, 600);
  $('#sCode').textContent = roomCode;
  $('#sLink').textContent = prettyUrl(roomCode);
  currentPoll = pollScreen; pollScreen();
}
async function pollScreen() {
  clearTimeout(pollTimer);
  try {
    const st = await api('GET', '/api/rooms/' + roomCode);
    $('#sCount').textContent = st.count;
    renderBoard($('#sBoard'), st.players, null);
    renderFeed($('#sFeed'), st.events);
  } catch (e) { if (e.status === 404) return goHome('This room has ended.'); }
  pollTimer = setTimeout(pollScreen, 3000);
}

// ---------- stats ----------
async function showStats() {
  show('stats');
  try {
    const s = await api('GET', '/api/stats');
    const items = [['People played', s.players], ['Hellos said', s.connections], ['Rooms', s.rooms], ['Bingos', s.bingos], ['Playing now', s.livePlayers]];
    $('#statsGrid').replaceChildren(...items.map(([k, v]) => h('div', { class: 'stat' }, h('b', {}, v), h('small', {}, k))));
    $('#statsSince').textContent = 'Counting since ' + new Date(s.since).toLocaleString();
  } catch (e) { toast(e.message); }
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && currentPoll) currentPoll(); });

// ---------- boot ----------
(function boot() {
  if (location.pathname === '/stats') return showStats();
  if (!roomCode) return show('home');
  if (params.get('screen')) return startScreen();
  if (getSess()) return startGame();
  openJoin(false);
})();
