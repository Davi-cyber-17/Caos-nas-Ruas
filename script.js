/* =====================================================================
   CAOS NAS RUAS — HTML + CSS + JS puro
   Modo Local (2 jogadores na mesma tela) e Modo Online (salas, via PeerJS).
   O anfitrião (quem cria a sala) roda a simulação e envia o estado;
   o convidado só envia o toque e desenha o que recebe. A simulação usa
   um "mundo" fixo, então celular, tablet e computador jogam juntos,
   cada um desenhando na proporção da própria tela.
   ===================================================================== */
(() => {
'use strict';

/* ---------- Constantes do mundo (iguais para todos os aparelhos) ---------- */
const ROAD_W = 540, ROAD_H = 702;        // área base da estrada
const VIEW_MAX = 1700;                   // largura máxima visível (telas largas veem mais estrada ATRÁS do carro)
const LANES = [126, 276, 426, 576];      // y do centro de cada faixa
const PAIRS = [[0, 1], [3, 2]];          // faixas de cada jogador (0 = azul, 1 = vermelho)
const CAR_X = 360, CAR_W = 104, CAR_H = 54;
const BASE_SPEED = 300, MAX_SPEED = 560, OBS_FACTOR = 0.8;
const WIN_POINTS = 3;
const NAMES = ['Azul', 'Vermelho'];
const COLORS = ['#19d3ff', '#ff3b5c'];
const TEAM = [
  { main: '#19d3ff', body: '#06243a' },
  { main: '#ff3b5c', body: '#3a0b18' }
];
const TYPES = [
  { k: 'bus', w: 220, h: 64, c: '#ff9a3c', n: 3 },
  { k: 'bus', w: 150, h: 58, c: '#ffd23c', n: 2 },
  { k: 'car', w: 98, h: 52, c: '#ffd23c' },
  { k: 'car', w: 98, h: 52, c: '#42f58d' },
  { k: 'car', w: 98, h: 52, c: '#e8f4ff' },
  { k: 'car', w: 98, h: 52, c: '#b57cff' }
];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const Y_MIN = 48 + CAR_H / 2 + 6, Y_MAX = 654 - CAR_H / 2 - 6;   // limites da rua
const MAX_VY = 900;                                              // velocidade lateral máxima dos carros
const PEER_PREFIX = 'caosnasruas-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// STUN + TURN públicos: ajudam a conectar celular (4G/Wi-Fi) com computador em redes diferentes
const PEER_OPTS = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
    ]
  }
};

/* ---------- Elementos ---------- */
const $ = id => document.getElementById(id);
const app = $('app'), stage = $('stage'), cv = $('road'), ctx = cv.getContext('2d'), hud = $('hud');
const screens = { menu: $('scMenu'), online: $('scOnline'), lobby: $('scLobby'), msg: $('scMsg') };

/* ---------- Estado global ---------- */
let state = null;          // estado da partida
let mode = null;           // 'local' | 'host' | 'guest'
let inGame = false;
let peer = null, conn = null, roomCode = '';
let myTy = LANES[2];       // alvo (y) do convidado, para resposta imediata
let particles = [], shake = 0, hudKey = '';
let lastTs = 0, lastSend = 0, lastPingTx = 0, lastRx = 0;
let scale = 1, cssScale = 1, viewW = ROAD_W, oy = 0;
let audio = null, connTimer = null, wakeLock = null;

/* ---------- Telas ---------- */
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('show'));
  if (name) screens[name].classList.add('show');
}
function resetToMenuState() {
  stopNet(); releaseWake();
  inGame = false; mode = null;
  app.dataset.mode = 'menu';
  $('keys').classList.remove('show');
}
function showMsg(title, text) {
  resetToMenuState();
  $('msgTitle').textContent = title;
  $('msgText').textContent = text;
  showScreen('msg');
}
function toMenu() {
  resetToMenuState();
  $('onlineErr').classList.remove('show');
  showScreen('menu');
}
function setupPanels() {
  app.dataset.mode = mode;
  const k = $('keys');
  k.textContent = mode === 'local'
    ? 'AZUL: W / S    ·    VERMELHO: ↑ / ↓'
    : 'W / ↑ = SOBE    ·    S / ↓ = DESCE    ·    OU ARRASTE O MOUSE';
  k.classList.add('show');
}
async function requestWake() {
  try { if (navigator.wakeLock && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* ignora */ }
}
function releaseWake() { try { if (wakeLock) wakeLock.release(); } catch (e) { /* ignora */ } wakeLock = null; }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && inGame) { wakeLock = null; requestWake(); } });

/* ---------- Áudio ---------- */
function beep(f = 440, d = 0.08, type = 'square', v = 0.04) {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = type; o.frequency.value = f; g.gain.value = v;
    o.connect(g); g.connect(audio.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + d);
    o.stop(audio.currentTime + d);
  } catch (e) { /* sem áudio */ }
}

/* ---------- Estado / simulação ---------- */
function makeCar(p) {
  const y = LANES[p === 0 ? 1 : 2];
  return { x: CAR_X, y, ty: y, vy: 0, kx: 0, ky: 0, tilt: 0, cr: false, ang: 0, spin: 0, sx: CAR_X, sy: y, cd: 0 };
}
function makeState(scores) {
  return {
    ph: 'count',          // count | play | over | match
    tm: 3.2, sc: scores ? scores.slice() : [0, 0],
    off: 0, sp: BASE_SPEED * 0.7, t: 0, spawn: 0,
    ob: [], cars: [makeCar(0), makeCar(1)],
    w: null, mw: null, id: 1, bump: 0
  };
}
function startMatch() {
  state = makeState();
  myTy = state.cars[1].ty; lastSentTy = null; particles = []; hudKey = '';
  inGame = true; lastRx = performance.now();
  showScreen(null);
  setupPanels();
  requestWake();
  if (mode === 'host') send({ t: 'start' });
}
function nextRound() {
  state = makeState(state.sc);
  particles = []; hudKey = '';
}

function pickType() {
  const r = Math.random();
  if (r < 0.22) return 0;
  if (r < 0.40) return 1;
  return 2 + Math.floor(Math.random() * 4);
}
function addObs(lane, type) {
  const s = state, T = TYPES[type], hw = T.w / 2, x0 = -hw - 12;
  const need = 130 + s.sp * OBS_FACTOR * 0.22;
  const others = new Set();
  for (const o of s.ob) {
    const gap = Math.abs(o.x - x0) - TYPES[o.type].w / 2 - hw;
    if (o.lane === lane) { if (gap < 34) return; }
    else if (gap < need) others.add(o.lane);
  }
  if (others.size >= 2) return;            // sempre sobram faixas livres
  s.ob.push({ id: s.id++, x: x0, lane, type });
}
function spawnWave() {
  const type = pickType(), a = Math.floor(Math.random() * 4);
  addObs(a, type);
  if (Math.random() < 0.45) {
    let b = Math.floor(Math.random() * 3); if (b >= a) b++;
    addObs(b, Math.random() < 0.5 ? type : pickType());
  }
}
function hit(c, o) {
  const T = TYPES[o.type];
  return Math.abs(c.x - o.x) < (CAR_W / 2 - 6 + T.w / 2 - 4) &&
         Math.abs(c.y - LANES[o.lane]) < (CAR_H / 2 - 6 + T.h / 2 - 4);
}
function crashCar(p) {
  const c = state.cars[p];
  c.cr = true;
  c.spin = (Math.random() < 0.5 ? -1 : 1) * (8 + Math.random() * 4);
  c.kx = 160; c.ky = (Math.random() - 0.5) * 120;
  const cols = [TEAM[p].main, '#ffd23c', '#ffffff', TEAM[p].main];
  for (let i = 0; i < 30; i++) {
    const a = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 240;
    particles.push({
      x: c.x, y: c.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: 0.5 + Math.random() * 0.6, s: 3 + Math.random() * 7, col: cols[i % cols.length]
    });
  }
  shake = 12;
  beep(130, 0.35, 'sawtooth', 0.06);
}
function bumpFx() {
  const [a, b] = state.cars, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  for (let i = 0; i < 10; i++) {
    const an = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 160;
    particles.push({ x: mx, y: my, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp, life: 0.3 + Math.random() * 0.3, s: 3 + Math.random() * 4, col: i % 2 ? '#ffffff' : '#ffd23c' });
  }
  shake = Math.max(shake, 5);
  beep(210, 0.07, 'triangle', 0.05);
}
function moveObs(dt) {
  const s = state, v = s.sp * OBS_FACTOR * dt;
  for (const o of s.ob) o.x += v;
  s.ob = s.ob.filter(o => o.x - TYPES[o.type].w / 2 < VIEW_MAX + 60);
}

function stepSim(dt) {
  const s = state;
  s.off += s.sp * dt;
  if (s.ph === 'count') {
    s.sp = BASE_SPEED * 0.7;
    s.tm -= dt;
    if (s.tm <= 0) { s.ph = 'play'; s.t = 0; s.spawn = 0.4; beep(880, 0.25, 'square', 0.05); }
  } else if (s.ph === 'play') {
    s.t += dt;
    s.sp = Math.min(MAX_SPEED, BASE_SPEED + s.t * 6);
    s.spawn -= dt;
    if (s.spawn <= 0) {
      spawnWave();
      s.spawn = Math.max(0.5, 1.3 - s.t * 0.012) * (0.85 + Math.random() * 0.5);
    }
    moveObs(dt);
    const crashed = [false, false];
    for (let p = 0; p < 2; p++) {
      const c = s.cars[p];
      if (!c.cr && s.ob.some(o => hit(c, o))) crashed[p] = true;
    }
    if (crashed[0] || crashed[1]) {
      crashed.forEach((x, p) => { if (x) crashCar(p); });
      s.ph = 'over'; s.tm = 2.4;
      if (crashed[0] && crashed[1]) s.w = -1;
      else {
        s.w = crashed[0] ? 1 : 0;
        s.sc[s.w]++;
        if (s.sc[s.w] >= WIN_POINTS) s.mw = s.w;
      }
    }
  } else if (s.ph === 'over') {
    s.sp = Math.max(0, s.sp - 500 * dt);
    moveObs(dt);
    s.tm -= dt;
    if (s.tm <= 0) {
      if (s.mw !== null) { s.ph = 'match'; s.sp = 0; }
      else nextRound();
    }
  }
}
// Convidado: só extrapola o que recebeu do anfitrião
function extrapolate(dt) {
  const s = state;
  s.off += s.sp * dt;
  if (s.ph === 'play' || s.ph === 'over') {
    const v = s.sp * OBS_FACTOR * dt;
    for (const o of s.ob) o.x += v;
  }
}
function updateCars(dt) {
  const s = state, guest = mode === 'guest';
  s.cars.forEach((c, p) => {
    if (c.cd > 0) c.cd -= dt;
    if (c.cr) {
      c.ang += c.spin * dt;
      c.spin *= Math.pow(0.02, dt);
      c.x += c.kx * dt; c.y += c.ky * dt;
      c.kx *= Math.pow(0.05, dt); c.ky *= Math.pow(0.05, dt);
      c.vy = 0;
      return;
    }
    if (guest) {
      c.x += (c.sx - c.x) * Math.min(1, dt * 22);
      if (p === 1) {            // meu carro: resposta imediata + correção suave do anfitrião
        c.vy = clamp((c.ty - c.y) * 14, -MAX_VY, MAX_VY);
        c.y += c.vy * dt + (c.sy - c.y) * Math.min(1, dt * 6);
      } else {
        const ny = c.y + (c.sy - c.y) * Math.min(1, dt * 22);
        c.vy = (ny - c.y) / (dt || 1); c.y = ny;
      }
    } else {
      c.vy = clamp((c.ty - c.y) * 14, -MAX_VY, MAX_VY);
      c.y += (c.vy + c.ky) * dt;
      c.x += c.kx * dt + (CAR_X - c.x) * Math.min(1, dt * 6);
      const dk = Math.pow(0.03, dt);
      c.kx *= dk; c.ky *= dk;
    }
    c.y = clamp(c.y, Y_MIN, Y_MAX);
    c.tilt = -clamp(c.vy / 600, -1, 1) * 0.5;
  });
  if (!guest && s.ph === 'play') collideCars();
}
// Os carros batem um no outro e se empurram (quem vem na direção do outro empurra mais)
function collideCars() {
  const [a, b] = state.cars;
  if (a.cr || b.cr) return;
  const sw = CAR_W - 8, sh = CAR_H - 4;
  const dx = b.x - a.x, dy = b.y - a.y;
  const ox = sw - Math.abs(dx), oy2 = sh - Math.abs(dy);
  if (ox <= 0 || oy2 <= 0) return;
  if (oy2 < ox) {
    const sg = dy >= 0 ? 1 : -1;
    const pa = Math.max(0, a.vy * sg), pb = Math.max(0, -b.vy * sg);
    const share = pa + pb > 1 ? pa / (pa + pb) : 0.5;     // parte do deslocamento que o B recebe
    a.y -= sg * oy2 * (1 - share); b.y += sg * oy2 * share;
    const imp = 140 + (pa + pb) * 0.35;
    a.ky -= sg * imp * (1 - share); b.ky += sg * imp * share;
  } else {
    const sx = dx >= 0 ? 1 : -1;
    a.x -= sx * ox / 2; b.x += sx * ox / 2;
    a.kx -= sx * 120; b.kx += sx * 120;
  }
  a.y = clamp(a.y, Y_MIN, Y_MAX); b.y = clamp(b.y, Y_MIN, Y_MAX);
  if (a.cd <= 0) { a.cd = b.cd = 0.2; state.bump++; bumpFx(); }
}
function updateParts(dt) {
  shake *= Math.pow(0.01, dt);
  particles.forEach(p => { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.96; p.vy *= 0.96; p.life -= dt; });
  particles = particles.filter(p => p.life > 0);
}

/* ---------- Entrada: arraste na tela (ou teclado) para mover o carro pela rua toda ---------- */
const myPlayer = () => (mode === 'host' ? 0 : 1);
const pointers = new Map();
const keysDown = new Set();
let lastSentTy = null, lastInTx = 0;

function setTarget(p, y) {
  const s = state;
  if (!s || !inGame) return;
  y = clamp(y, Y_MIN, Y_MAX);
  if (mode === 'guest') { if (p !== 1) return; myTy = y; s.cars[1].ty = y; }
  else { if (mode === 'host' && p !== 0) return; s.cars[p].ty = y; }
}
function worldY(e) {
  const r = stage.getBoundingClientRect();
  return (e.clientY - r.top) / cssScale - oy;
}
// Local: lado esquerdo da tela = Azul, lado direito = Vermelho. Online: a tela toda move o seu carro.
function ownerOf(e) {
  if (mode === 'local') {
    const r = stage.getBoundingClientRect();
    return (e.clientX - r.left) < r.width / 2 ? 0 : 1;
  }
  return myPlayer();
}
stage.addEventListener('pointerdown', e => {
  if (!inGame || !state || e.target.closest('button')) return;
  e.preventDefault();
  try { stage.setPointerCapture(e.pointerId); } catch (err) { /* ignora */ }
  const p = ownerOf(e);
  pointers.set(e.pointerId, p);
  setTarget(p, worldY(e));
});
stage.addEventListener('pointermove', e => {
  const p = pointers.get(e.pointerId);
  if (p === undefined || !inGame || !state) return;
  setTarget(p, worldY(e));
});
const endPointer = e => pointers.delete(e.pointerId);
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);

const MOVE_KEYS = ['w', 's', 'i', 'k', 'arrowup', 'arrowdown'];
addEventListener('keydown', e => {
  if (!inGame) return;
  if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (!MOVE_KEYS.includes(k)) return;
  e.preventDefault();
  keysDown.add(k);
});
addEventListener('keyup', e => keysDown.delete(e.key.toLowerCase()));
addEventListener('blur', () => { keysDown.clear(); pointers.clear(); });
function applyKeys(dt) {
  if (!inGame || !state || !keysDown.size) return;
  const step = 620 * dt;
  const move = (p, up, down) => {
    if (up === down) return;
    setTarget(p, state.cars[p].ty + (down ? step : -step));
  };
  const has = (...ks) => ks.some(k => keysDown.has(k));
  if (mode === 'local') {
    move(0, has('w'), has('s'));
    move(1, has('arrowup', 'i'), has('arrowdown', 'k'));
  } else {
    move(myPlayer(), has('w', 'arrowup', 'i'), has('s', 'arrowdown', 'k'));
  }
}
addEventListener('pointerdown', () => { if (audio && audio.state === 'suspended') audio.resume(); }, { passive: true });

/* ---------- Rede (PeerJS) ---------- */
function send(m) { try { if (conn && conn.open) conn.send(m); } catch (e) { /* ignora */ } }
function stopNet() {
  clearTimeout(connTimer);
  const c = conn, p = peer;
  conn = null; peer = null; roomCode = '';
  try { if (c) c.close(); } catch (e) { /* ignora */ }
  try { if (p) p.destroy(); } catch (e) { /* ignora */ }
}
function genCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}
function setLobby(code, status, guestIn) {
  $('lobbyCode').textContent = code || '----';
  $('lobbyStatus').textContent = status;
  $('slotRed').textContent = guestIn ? 'Vermelho: conectado' : 'Vermelho: aguardando…';
  $('slotRed').parentElement.classList.toggle('wait', !guestIn);
}
function hasPeerJS() {
  if (typeof Peer === 'undefined') {
    showMsg('Sem conexão', 'Não foi possível carregar o módulo online (PeerJS). Verifique sua internet e recarregue a página.');
    return false;
  }
  return true;
}

function createRoom(attempt = 0) {
  if (!hasPeerJS()) return;
  stopNet();
  mode = 'host';
  roomCode = genCode();
  $('slotBlue').textContent = 'Azul: você';
  setLobby('----', 'Criando sala…', false);
  showScreen('lobby');
  const p = new Peer(PEER_PREFIX + roomCode, PEER_OPTS);
  peer = p;
  p.on('open', () => {
    setLobby(roomCode, 'Sala criada! Passe o código (ou o link) para o outro jogador, em qualquer aparelho.', false);
  });
  p.on('connection', c => {
    if (conn && conn.open) { c.on('open', () => { c.send({ t: 'full' }); setTimeout(() => c.close(), 300); }); return; }
    conn = c;
    c.on('open', () => {
      lastRx = performance.now();
      setLobby(roomCode, 'Jogador 2 entrou! Começando…', true);
      setTimeout(() => { if (conn === c && c.open && !inGame) startMatch(); }, 900);
    });
    c.on('data', m => {
      lastRx = performance.now();
      if (m && m.t === 'in' && state && typeof m.y === 'number' && !state.cars[1].cr) state.cars[1].ty = clamp(m.y, Y_MIN, Y_MAX);
    });
    c.on('close', () => {
      if (conn !== c) return;
      conn = null;
      if (inGame) showMsg('Oponente saiu', 'A conexão com o outro jogador foi encerrada.');
      else setLobby(roomCode, 'O jogador saiu. Aguardando outro jogador…', false);
    });
    c.on('error', () => {});
  });
  p.on('error', e => {
    if (e.type === 'unavailable-id' && attempt < 5) { createRoom(attempt + 1); return; }
    if (peer !== p) return;
    showMsg('Erro de conexão', 'Não foi possível criar a sala. Verifique sua internet e tente de novo.');
  });
  p.on('disconnected', () => { try { if (peer === p && !p.destroyed) p.reconnect(); } catch (e) { /* ignora */ } });
}

function joinRoom() {
  const err = $('onlineErr');
  const code = $('inCode').value.trim().toUpperCase();
  err.classList.remove('show');
  if (code.length !== 4) { err.textContent = 'Digite o código de 4 letras ou números da sala.'; err.classList.add('show'); return; }
  if (!hasPeerJS()) return;
  stopNet();
  mode = 'guest';
  roomCode = code;
  $('slotBlue').textContent = 'Azul: anfitrião';
  $('slotRed').textContent = 'Vermelho: você';
  $('slotRed').parentElement.classList.remove('wait');
  setLobby(code, 'Entrando na sala…', true);
  $('slotRed').textContent = 'Vermelho: você';
  showScreen('lobby');
  const p = new Peer(undefined, PEER_OPTS);
  peer = p;
  const fail = text => {
    if (peer !== p) return;
    stopNet(); mode = null;
    err.textContent = text; err.classList.add('show');
    showScreen('online');
  };
  p.on('open', () => {
    const c = p.connect(PEER_PREFIX + code, { reliable: true });
    conn = c;
    connTimer = setTimeout(() => { if (!c.open) fail('Tempo esgotado. Confira o código da sala ou a sua conexão.'); }, 12000);
    c.on('open', () => {
      clearTimeout(connTimer);
      lastRx = performance.now();
      setLobby(code, 'Conectado! Aguardando o início da partida…', true);
      $('slotRed').textContent = 'Vermelho: você';
    });
    c.on('data', m => {
      if (!m) return;
      lastRx = performance.now();
      if (m.t === 'full') fail('Essa sala já está cheia.');
      else if (m.t === 'start') {
        state = makeState(); myTy = state.cars[1].ty; lastSentTy = null; particles = []; hudKey = '';
        inGame = true; showScreen(null); setupPanels(); requestWake();
      } else if (m.t === 's' && inGame) applySnap(m);
    });
    c.on('close', () => {
      if (conn !== c) return;
      if (inGame) showMsg('Oponente saiu', 'O anfitrião encerrou a sala.');
      else fail('A conexão com a sala foi encerrada.');
    });
    c.on('error', () => {});
  });
  p.on('error', e => {
    if (e.type === 'peer-unavailable') fail('Sala não encontrada. Confira o código.');
    else fail('Erro de conexão com o servidor de salas. Tente de novo.');
  });
}

function snapshot() {
  const s = state;
  return {
    t: 's', ph: s.ph, tm: +s.tm.toFixed(2), sc: s.sc, off: Math.round(s.off), sp: Math.round(s.sp),
    ob: s.ob.map(o => [o.id, Math.round(o.x), o.lane, o.type]),
    cx: [Math.round(s.cars[0].x), Math.round(s.cars[0].y), Math.round(s.cars[1].x), Math.round(s.cars[1].y)],
    cr: [s.cars[0].cr, s.cars[1].cr], bm: s.bump,
    w: s.w, mw: s.mw
  };
}
function applySnap(m) {
  const s = state;
  if (m.ph === 'count' && s.ph !== 'count') {
    s.cars = [makeCar(0), makeCar(1)]; particles = []; myTy = s.cars[1].ty; lastSentTy = null; hudKey = '';
  }
  s.ph = m.ph; s.tm = m.tm; s.sc = m.sc; s.off = m.off; s.sp = m.sp; s.w = m.w; s.mw = m.mw;
  s.ob = m.ob.map(a => ({ id: a[0], x: a[1], lane: a[2], type: a[3] }));
  for (let p = 0; p < 2; p++) {
    const c = s.cars[p];
    c.sx = m.cx[p * 2]; c.sy = m.cx[p * 2 + 1];
    if (m.cr[p] && !c.cr) crashCar(p);
  }
  if (m.bm !== s.bump) { s.bump = m.bm; bumpFx(); }
}

/* ---------- Desenho (visual neon) ---------- */
function rr(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
function glow(color, blur) { ctx.shadowColor = color; ctx.shadowBlur = blur * scale; }
function noGlow() { ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; }

function drawWheels(w, h, n, startF, spanF, wf) {
  ctx.fillStyle = '#02040a';
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + w * (startF + (n > 1 ? i * spanF / (n - 1) : 0));
    rr(x, -h / 2 - 5, w * wf, 12, 4); ctx.fill();
    rr(x, h / 2 - 7, w * wf, 12, 4); ctx.fill();
  }
}
function drawPlayerCar(p, c, showTrail) {
  const w = CAR_W, h = CAR_H, T = TEAM[p];
  // rastro de velocidade (atrás do carro = lado direito)
  if (showTrail) {
    const g = ctx.createLinearGradient(w / 2, 0, w / 2 + 90, 0);
    g.addColorStop(0, T.main + 'aa'); g.addColorStop(1, T.main + '00');
    ctx.fillStyle = g;
    ctx.fillRect(w / 2 - 4, -h * 0.3, 90, 4);
    ctx.fillRect(w / 2 - 4, h * 0.3 - 4, 90, 4);
    // feixe dos faróis
    const f = ctx.createLinearGradient(-w / 2, 0, -w / 2 - 120, 0);
    f.addColorStop(0, 'rgba(255,255,255,.32)'); f.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = f;
    ctx.beginPath(); ctx.moveTo(-w / 2 + 4, -h * 0.28); ctx.lineTo(-w / 2 - 120, -h * 0.95);
    ctx.lineTo(-w / 2 - 120, h * 0.95); ctx.lineTo(-w / 2 + 4, h * 0.28); ctx.closePath(); ctx.fill();
  }
  drawWheels(w, h, 2, 0.14, 0.52, 0.21);
  glow(T.main, 16);
  ctx.fillStyle = T.body; ctx.lineWidth = 3.5; ctx.strokeStyle = T.main; ctx.lineJoin = 'round';
  rr(-w / 2, -h / 2 + 2, w, h - 4, h * 0.45); ctx.fill(); ctx.stroke();
  noGlow();
  // faixa de neon
  ctx.save(); rr(-w / 2, -h / 2 + 2, w, h - 4, h * 0.45); ctx.clip();
  ctx.fillStyle = T.main; ctx.globalAlpha = 0.9; ctx.fillRect(-w / 2, -h * 0.1, w, h * 0.2);
  ctx.restore();
  // cabine
  ctx.fillStyle = '#03060f'; ctx.strokeStyle = T.main; ctx.lineWidth = 3;
  rr(-w * 0.17, -h * 0.3, w * 0.34, h * 0.6, 8); ctx.fill(); ctx.stroke();
  // luzes
  ctx.fillStyle = '#fff'; ctx.fillRect(-w / 2 + 1, -h * 0.3, 4, 7); ctx.fillRect(-w / 2 + 1, h * 0.3 - 7, 4, 7);
  ctx.fillStyle = '#ff3b5c'; ctx.fillRect(w / 2 - 5, -h * 0.3, 4, 7); ctx.fillRect(w / 2 - 5, h * 0.3 - 7, 4, 7);
}
function drawObstacle(T) {
  const w = T.w, h = T.h;
  if (T.k === 'bus') drawWheels(w, h, T.n + 1, 0.1, 0.72, 0.11); else drawWheels(w, h, 2, 0.14, 0.52, 0.21);
  glow(T.c, 12);
  ctx.fillStyle = '#0c1630'; ctx.lineWidth = 3; ctx.strokeStyle = T.c; ctx.lineJoin = 'round';
  if (T.k === 'bus') rr(-w / 2, -h / 2, w, h, [18, 3, 3, 18]); else rr(-w / 2, -h / 2 + 2, w, h - 4, h * 0.4);
  ctx.fill(); ctx.stroke();
  noGlow();
  ctx.fillStyle = T.c;
  if (T.k === 'bus') {
    ctx.globalAlpha = 0.85;
    rr(-w / 2 + 30, -h / 2 + 5, 12, h - 10, 3); ctx.fill();   // para-brisa
    for (let i = 0; i < T.n; i++) rr(-w / 2 + w * (0.36 + i * (0.3 / (T.n - 1 || 1))), -h * 0.26, w * 0.075, h * 0.52, 5), ctx.fill();
    ctx.globalAlpha = 1;
  } else {
    ctx.globalAlpha = 0.35; rr(-w * 0.17, -h * 0.3, w * 0.34, h * 0.6, 8); ctx.fill(); ctx.globalAlpha = 1;
  }
  ctx.fillStyle = '#ff3b5c'; ctx.fillRect(w / 2 - 5, -h * 0.34, 4, 7); ctx.fillRect(w / 2 - 5, h * 0.34 - 7, 4, 7);
  ctx.fillStyle = '#fff6c8'; ctx.fillRect(-w / 2 + 1, -h * 0.34, 4, 7); ctx.fillRect(-w / 2 + 1, h * 0.34 - 7, 4, 7);
}
function drawMarker(x, y) {
  glow('#19d3ff', 10);
  ctx.strokeStyle = '#19d3ff'; ctx.lineWidth = 3; ctx.fillStyle = 'rgba(8,18,44,.9)';
  ctx.beginPath(); ctx.arc(x, y, 24, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  noGlow();
  ctx.strokeStyle = '#9ad8ff'; ctx.lineWidth = 4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x - 9, y - 9); ctx.lineTo(x + 9, y + 9); ctx.moveTo(x + 9, y - 9); ctx.lineTo(x - 9, y + 9); ctx.stroke();
}

function render() {
  const s = state;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  const sx = shake > 0.5 ? (Math.random() - 0.5) * shake : 0, sy = shake > 0.5 ? (Math.random() - 0.5) * shake : 0;
  ctx.setTransform(scale, 0, 0, scale, sx * scale, (oy + sy) * scale);
  const X0 = -30, X1 = viewW + 30;

  // asfalto
  const g = ctx.createLinearGradient(0, 48, 0, 654);
  g.addColorStop(0, '#0a1430'); g.addColorStop(0.5, '#0b1124'); g.addColorStop(1, '#0a1430');
  ctx.fillStyle = g; ctx.fillRect(X0, 48, X1 - X0, 606);
  // barreiras laterais
  ctx.fillStyle = '#0e1a3a'; ctx.fillRect(X0, 18, X1 - X0, 30); ctx.fillRect(X0, 654, X1 - X0, 30);
  ctx.fillStyle = '#1b2f63';
  for (let x = (s.off % 60) - 60; x < X1; x += 60) { ctx.fillRect(x, 28, 34, 10); ctx.fillRect(x, 664, 34, 10); }
  // bordas neon (azul em cima, vermelha embaixo)
  glow('#19d3ff', 14); ctx.fillStyle = '#19d3ff'; ctx.fillRect(X0, 46, X1 - X0, 4);
  glow('#ff3b5c', 14); ctx.fillStyle = '#ff3b5c'; ctx.fillRect(X0, 652, X1 - X0, 4);
  noGlow();

  // linhas de velocidade
  ctx.strokeStyle = 'rgba(160,220,255,.14)'; ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < 26; i++) {
    const y = 62 + ((i * 137) % 580), len = 30 + (i % 5) * 16;
    const x = (((i * 97) + s.off * (1.3 + (i % 3) * 0.2)) % (viewW + 240)) - 120;
    ctx.moveTo(x, y); ctx.lineTo(x - len, y);
  }
  ctx.stroke();

  // divisórias de faixa (a rua é livre: sem barreira central)
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(190,225,255,.5)';
  ctx.setLineDash([26, 30]); ctx.lineDashOffset = -s.off;
  glow('#9ad8ff', 6);
  ctx.beginPath();
  for (const yy of [201, 351, 501]) { ctx.moveTo(X0, yy); ctx.lineTo(X1, yy); }
  ctx.stroke();
  noGlow(); ctx.setLineDash([]);

  // obstáculos
  for (const o of s.ob) {
    ctx.save(); ctx.translate(o.x, LANES[o.lane]);
    drawObstacle(TYPES[o.type]);
    ctx.restore();
  }
  // carros dos jogadores (viram para a esquerda)
  s.cars.forEach((c, p) => {
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.cr ? c.ang : c.tilt);
    drawPlayerCar(p, c, !c.cr && s.ph !== 'match');
    ctx.restore();
  });
  // partículas
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 2));
    ctx.fillStyle = p.col; ctx.fillRect(p.x - p.s / 2, p.y - p.s / 2, p.s, p.s);
  }
  ctx.globalAlpha = 1;
}

/* ---------- Tamanho adaptável (qualquer tela) ---------- */
function resize() {
  const r = stage.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = Math.max(1, r.width), ch = Math.max(1, r.height);
  cv.width = Math.round(cw * dpr);
  cv.height = Math.round(ch * dpr);
  // a estrada inteira (faixas) sempre cabe; telas largas mostram mais asfalto atrás do carro
  const sc = Math.max(Math.min(cw / ROAD_W, ch / ROAD_H), cw / VIEW_MAX);
  scale = sc * dpr;
  cssScale = sc;
  viewW = cw / sc;
  oy = (ch / sc - ROAD_H) / 2;
}
addEventListener('resize', resize);
addEventListener('orientationchange', () => setTimeout(resize, 150));
if (window.ResizeObserver) new ResizeObserver(resize).observe(stage);

/* ---------- HUD (placar e mensagens) ---------- */
function who(p) {
  if (mode === 'local') return NAMES[p];
  return p === myPlayer() ? 'Você' : 'Oponente';
}
function updateHud() {
  const s = state;
  $('scoreBlue').textContent = s.sc[0];
  $('scoreRed').textContent = s.sc[1];
  const n = Math.min(3, Math.max(1, Math.ceil(s.tm)));
  const go = s.ph === 'play' && s.t < 0.7;
  const key = [s.ph, s.ph === 'count' ? n : '', go, s.w, s.mw, mode].join('|');
  if (key === hudKey) return;
  hudKey = key;
  let html = '';
  if (s.ph === 'count') {
    const hint = mode === 'local'
      ? 'Arraste na tela para mover o carro: lado esquerdo é do Azul, lado direito é do Vermelho. Dá para empurrar o outro carro!'
      : 'Toque ou arraste na tela para mover seu carro pela rua toda. Dá para empurrar o outro carro!';
    html = `<div class="big">${n}</div><div class="msg hint">${hint}</div>`;
    beep(520, 0.1, 'square', 0.04);
  }
  else if (go) html = '<div class="big">VAI!</div>';
  else if (s.ph === 'over') {
    html = s.w === -1
      ? '<div class="txt">Empate!</div><div class="msg">Os dois bateram</div>'
      : `<div class="txt" style="color:${COLORS[s.w]}">${who(s.w)} marcou!</div><div class="msg">O outro bateu</div>`;
  } else if (s.ph === 'match') {
    html = `<div class="txt" style="color:${COLORS[s.mw]}">${who(s.mw)} venceu!</div>`;
    html += mode === 'guest'
      ? '<div class="msg">Aguardando o anfitrião…</div>'
      : '<button class="mbtn hot" id="hudAgain" style="max-width:300px">Jogar novamente</button>';
    html += '<button class="mbtn" id="hudMenu" style="max-width:300px">Menu</button>';
  }
  hud.innerHTML = html;
  const again = $('hudAgain'), menu = $('hudMenu');
  if (again) again.onclick = () => startMatch();
  if (menu) menu.onclick = toMenu;
}

/* ---------- Loop principal ---------- */
function loop(ts) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (ts - lastTs) / 1000 || 0);
  lastTs = ts;
  if (!inGame || !state) return;
  applyKeys(dt);
  if (mode === 'guest') extrapolate(dt); else stepSim(dt);
  updateCars(dt);
  updateParts(dt);
  if (mode === 'host') {
    if (ts - lastSend > 33) { lastSend = ts; send(snapshot()); }
    if (conn && ts - lastRx > 8000) showMsg('Oponente saiu', 'A conexão com o outro jogador foi perdida.');
  } else if (mode === 'guest') {
    if (ts - lastPingTx > 2000) { lastPingTx = ts; send({ t: 'p' }); }
    if (myTy !== lastSentTy && ts - lastInTx > 33) { lastInTx = ts; lastSentTy = myTy; send({ t: 'in', y: Math.round(myTy) }); }
    if (ts - lastRx > 8000) showMsg('Conexão perdida', 'A conexão com a sala foi perdida.');
  }
  if (!inGame) return;
  render();
  updateHud();
}

/* ---------- Botões de menu ---------- */
$('btnLocal').onclick = () => { stopNet(); mode = 'local'; startMatch(); };
$('btnOnline').onclick = () => { $('onlineErr').classList.remove('show'); showScreen('online'); };
$('btnOnBack').onclick = toMenu;
$('btnCreate').onclick = () => createRoom();
$('btnJoin').onclick = joinRoom;
$('inCode').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
$('inCode').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
$('btnLobbyBack').onclick = toMenu;
$('btnMsgBack').onclick = toMenu;
$('btnExit').onclick = toMenu;
$('btnCopy').onclick = () => {
  if (!roomCode) return;
  const link = location.href.split('#')[0] + '#' + roomCode;
  const done = () => { $('btnCopy').textContent = 'Link copiado!'; setTimeout(() => { $('btnCopy').textContent = 'Copiar link da sala'; }, 1600); };
  if (navigator.share && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
    navigator.share({ title: 'Caos nas Ruas', text: 'Entre na minha sala: ' + roomCode, url: link }).catch(() => {});
  } else if (navigator.clipboard) navigator.clipboard.writeText(link).then(done).catch(() => {});
  else done();
};
document.addEventListener('contextmenu', e => e.preventDefault());

/* ---------- Início ---------- */
resize();
requestAnimationFrame(loop);
showScreen('menu');
// Link de sala (…/index.html#ABCD) abre direto a tela de entrada
if (/^#[A-Za-z0-9]{4}$/.test(location.hash)) {
  $('inCode').value = location.hash.slice(1).toUpperCase();
  showScreen('online');
}
})();
