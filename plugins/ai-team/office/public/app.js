// AI Team Office — renderer. Reads only reducer state (reduce/tick/compliance); never invents activity.
import { initState, reduceAll, tick, compliance, bashTokens, MODELS } from './reducer.js';

const $ = id => document.getElementById(id);
const scene = $('scene'), spritesEl = $('sprites');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: per-viewer convenience only */ } },
};
const esc = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const safeJSON = s => { try { return JSON.parse(s); } catch { return null; } };

const ACT_KO = { idle: '대기', thinking: '생각 중', reading: '자료 조사', running: '실행 중', writing: '작성 중', delegating: '위임 중',
  reviewing: '검수 중', external: '외부 연락', blocked: '승인 대기', leaving: '퇴장', arriving: '도착', working: '작업 중' };
const EFFORT = { low: 1, medium: 2, high: 3, xhigh: 4, max: 4 };
const OBS_KO = { observed: '관측', inferred: '추정', stale: '오래됨' };
const VERDICT_KO = { ok: '통과', rework: '재작업', fail: '실패' };
const TOOL_ACT = { Read: 'reading', Grep: 'reading', Glob: 'reading', LSP: 'reading', WebFetch: 'reading', WebSearch: 'reading', ToolSearch: 'reading',
  Bash: 'running', Edit: 'writing', Write: 'writing', NotebookEdit: 'writing', Agent: 'delegating' };
const toolKo = t => ACT_KO[TOOL_ACT[t]] || t || '';
const toolNoun = t => toolKo(t).replace(/ 중$/, '');   // '실행 실패', '승인 요청 작성' (no dangling '중')
const hash = id => [...String(id)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);

let state = initState();
let queue = [];
const ui = { floor: null, sid: null, pinned: false, sound: store.get('office.sound') === '1', theme: store.get('office.theme') || 'auto', mode: '실시간' };
let panelDirty = true, sceneDirty = true, lastPanelAt = 0, lastTickerSeq = 0, lastTickerAt = 0, lastBlocked = 0;

// ---------------- theme & sound toggles ----------------
function applyTheme() {
  const root = document.documentElement;
  if (ui.theme === 'auto') delete root.dataset.theme; else root.dataset.theme = ui.theme;
  $('theme').textContent = { auto: '◐', light: '☀', dark: '☾' }[ui.theme];
  $('theme').title = `테마: ${{ auto: '자동', light: '라이트', dark: '다크' }[ui.theme]}`;
}
$('theme').onclick = () => { ui.theme = { auto: 'light', light: 'dark', dark: 'auto' }[ui.theme]; store.set('office.theme', ui.theme); applyTheme(); };
function applySound() { $('sound').textContent = ui.sound ? '🔔' : '🔕'; $('sound').setAttribute('aria-pressed', String(ui.sound)); }
$('sound').onclick = () => { ui.sound = !ui.sound; store.set('office.sound', ui.sound ? '1' : '0'); applySound(); if (ui.sound) chime(); };
let audio = null;
function chime() {
  try {
    audio ||= new AudioContext();
    const t = audio.currentTime;
    [660, 880].forEach((f, i) => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t + i * 0.16); g.gain.exponentialRampToValueAtTime(0.12, t + i * 0.16 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.16 + 0.35);
      o.connect(g).connect(audio.destination); o.start(t + i * 0.16); o.stop(t + i * 0.16 + 0.4);
    });
  } catch { /* audio unavailable */ }
}
applyTheme(); applySound();

// ---------------- data: SSE -> queue -> reducer ----------------
function setConn(st, text) { const el = $('conn'); el.dataset.state = st; el.textContent = text; }
let es = null, dayEnd = 0;
function resetView() { state = initState(); queue = []; clearSprites(); lastTickerSeq = 0; $('ticker').textContent = ''; panelDirty = sceneDirty = true; }
function connect() {
  es = new EventSource('/events' + location.search);
  es.onopen = () => { resetView(); setConn('live', ui.mode); kick(); };
  es.addEventListener('batch', m => { const arr = safeJSON(m.data); if (Array.isArray(arr)) { queue.push(...arr); kick(); } });
  es.addEventListener('ready', m => {
    const info = safeJSON(m.data) || {};
    ui.mode = /[?&]sim=1/.test(location.search) ? '시뮬레이터' : info.mode === 'replay' ? '리플레이' : '실시간';
    if (info.redact) ui.mode += ' · 가림';
    setConn('live', ui.mode);
    scheduleMidnight(info.dayStart);
  });
  es.onmessage = m => { const e = safeJSON(m.data); if (e) { queue.push(e); kick(); } };
  es.onerror = () => setConn('err', '재연결 중…');
}
// "오늘" is a server-defined day. When the server says when it began, start a fresh day at the next local midnight
// by reconnecting (the server replays the new day's lines). No dayStart → keep the old behaviour.
function scheduleMidnight(dayStart) {
  const ds = typeof dayStart === 'number' ? dayStart : typeof dayStart === 'string' ? Date.parse(dayStart) : NaN;   // local-midnight epoch ms (or ISO)
  dayEnd = Number.isFinite(ds) ? ds + 86400000 : 0;
}
// Checked by the 1s timer (survives sleep/wake, unlike one long setTimeout).
function maybeNewDay(now) {
  if (!dayEnd || now < dayEnd) return;
  dayEnd = 0; es?.close(); resetView(); setConn('wait', '새 날 시작…'); connect(); kick();
}
// Drain the queue once per frame: one clone per batch keeps 20+ events/s cheap. If the batch throws, redo it
// event by event and skip only the bad one — a single malformed line must never wipe the day's history.
function drain() {
  if (!queue.length) return;
  const batch = queue.splice(0);
  try { state = reduceAll(state, batch); } catch {
    let bad = 0;
    for (const e of batch) { try { state = reduceAll(state, [e]); } catch { bad++; } }
    console.warn(`office: skipped ${bad} event(s) the reducer could not apply`);
  }
  try { state = tick(state, Date.now()); } catch { /* keep last good state */ }
  panelDirty = sceneDirty = true;
}
setInterval(() => { maybeNewDay(Date.now()); try { state = tick(state, Date.now()); } catch { /* keep last good state */ } panelDirty = sceneDirty = true; kick(); }, 1000);

// ---------------- selection: floors (proj) and rooms (sid) ----------------
const blockedIn = r => Object.values(r.chars).some(c => c.blocked);
function select() {
  const floors = Object.values(state.floors).sort((a, b) => b.lastTs - a.lastTs);
  if (!ui.pinned || !state.floors[ui.floor]) { ui.pinned = ui.pinned && !!state.floors[ui.floor]; ui.floor = floors[0]?.proj ?? null; }
  const f = state.floors[ui.floor];
  const rooms = f ? Object.values(f.rooms).sort((a, b) => b.lastTs - a.lastTs) : [];
  if (!f || !f.rooms[ui.sid] || !ui.pinned) ui.sid = rooms[0]?.sid ?? null;
  return { floors, rooms, room: f?.rooms[ui.sid] || null };
}
let tabSig = '';
function renderTabs({ floors, rooms }) {
  const sig = JSON.stringify([ui.pinned, ui.floor, ui.sid, floors.map(f => [f.proj, Object.values(f.rooms).some(blockedIn)]),
    rooms.map(r => [r.sid, blockedIn(r), r.ended])]);
  if (sig === tabSig) return;
  tabSig = sig;
  $('floors').innerHTML = `<button type="button" data-auto aria-pressed="${!ui.pinned}" title="가장 최근 활동 층/방을 따라감">자동</button>` +
    floors.map(f => `<button type="button" data-floor="${esc(f.proj)}" aria-pressed="${ui.pinned && f.proj === ui.floor}">${esc(f.proj)}${
      Object.values(f.rooms).some(blockedIn) ? '<i class="dot-red"></i>' : ''}</button>`).join('');
  $('roomtabs').innerHTML = rooms.map(r => `<button type="button" data-sid="${esc(r.sid)}" class="${r.ended ? 'ended' : ''}" title="세션 ${esc(r.sid)}"
    aria-pressed="${r.sid === ui.sid}">${esc(r.sid.slice(0, 4))}${blockedIn(r) ? '<i class="dot-red"></i>' : ''}</button>`).join('');
}
$('floors').onclick = ev => {
  const b = ev.target.closest('button'); if (!b) return;
  if (b.hasAttribute('data-auto')) ui.pinned = false;
  else { ui.pinned = true; ui.floor = b.dataset.floor; ui.sid = null; }
  panelDirty = sceneDirty = true; kick();
};
$('roomtabs').onclick = ev => {
  const b = ev.target.closest('button'); if (!b) return;
  ui.pinned = true; ui.sid = b.dataset.sid; panelDirty = sceneDirty = true; kick();
};
$('needs').onclick = () => {
  for (const f of Object.values(state.floors)) for (const r of Object.values(f.rooms)) if (blockedIn(r)) {
    ui.pinned = true; ui.floor = f.proj; ui.sid = r.sid; panelDirty = sceneDirty = true; kick(); return;
  }
};

// ---------------- scene geometry ----------------
let geo = { rooms: {}, desks: [], main: null, w: 0, h: 0 }, charW = 46, charH = 60;
function measure() {
  const rooms = {};
  for (const el of scene.querySelectorAll('.room')) rooms[el.dataset.room] = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight, el };
  const fl = rooms.floor;
  // desks are centered with translateX(-50%), which offsetLeft ignores: their visual center is offsetLeft itself.
  const seat = d => ({ x: fl.x + d.offsetLeft, y: fl.y + d.offsetTop + d.offsetHeight + charH * 0.75 });
  const desks = [...scene.querySelectorAll('.desk.sub')].sort((a, b) => a.dataset.desk - b.dataset.desk);
  geo = { rooms, desks: desks.map(seat), deskEls: desks, main: seat(scene.querySelector('.desk.main')), w: scene.clientWidth, h: scene.clientHeight };
  const narrow = matchMedia('(max-width: 640px)').matches;
  charW = narrow ? 36 : 54; charH = narrow ? 47 : 70;
}
// Spot `slot` of `n` people in a room: two in front, from the 3rd on a staggered second row (y -= charH*0.55).
function anchor(room, c, slot = 0, n = 1) {
  if (room === 'desk') {
    if (!c.aid) return geo.main;
    if (c.desk != null && geo.desks[c.desk]) return geo.desks[c.desk];
    const f = geo.rooms.floor;                     // no free desk: stand in the aisles beside the main desk
    const row = Math.floor(slot / 2), side = slot % 2 ? 1 : -1;  // back rows step outward so tags don't stack
    return { x: f.x + f.w * (side > 0 ? 0.62 : 0.38) + side * (row % 3) * charW * 0.75, y: f.y + f.h * 0.92 - (row % 3) * charH * 0.55 };
  }
  const r = geo.rooms[room] || geo.rooms.floor;
  const back = slot >= 2, i = back ? slot - 2 : slot, cnt = back ? Math.max(1, n - 2) : Math.min(Math.max(n, 1), 2);
  const step = Math.min(charW * 1.6, (r.w - charW) / Math.max(cnt - 1 + (back ? 0.5 : 0), 1));
  const x = r.x + r.w / 2 + (i - (cnt - 1) / 2 + (back ? 0.5 : 0)) * step;
  const y = r.y + r.h * 0.9 - (back ? charH * 0.55 : 0);
  return { x: Math.max(r.x + charW / 2, Math.min(r.x + r.w - charW / 2, x)), y };
}
const hashSlot = id => hash(id) % 2;

// ---------------- characters ----------------
const SVG = `<svg viewBox="0 0 40 52" aria-hidden="true"><g class="flip">
  <ellipse class="shadow" cx="20" cy="49" rx="11" ry="2.6"/>
  <rect class="leg l" x="14" y="38" width="5" height="10" rx="2.5"/><rect class="leg r" x="21" y="38" width="5" height="10" rx="2.5"/>
  <g class="torso">
    <rect class="arm l" x="7.5" y="24" width="5" height="12" rx="2.5"/>
    <rect class="shirt" x="10" y="22" width="20" height="18" rx="7"/>
    <path class="tie" d="M20 23.5 l-2.2 3 2.2 8.5 2.2-8.5z"/>
    <g class="arm-r"><rect class="arm" x="27.5" y="24" width="5" height="12" rx="2.5"/></g>
    <circle class="head" cx="20" cy="14" r="9"/>
    <g class="hat h-crown"><path class="hair" d="M11 13.5 a9 9 0 0 1 18 0 q-4.5-3-9-2.4 q-4.5-.6-9 2.4z"/>
      <path class="crown" d="M13.2 8.6 l-.6-5.4 3.6 2.8 3.8-4.6 3.8 4.6 3.6-2.8 -.6 5.4z"/><circle class="gem" cx="20" cy="6.6" r="1.3"/></g>
    <g class="hat h-cap"><path class="c-dome" d="M11.2 12.5 a8.8 8.8 0 0 1 17.6 0 z"/><rect class="c-brim" x="18" y="10.6" width="15" height="2.8" rx="1.4"/>
      <circle class="c-btn" cx="20" cy="3.9" r="1.2"/></g>
    <g class="hat h-phones"><path class="hair" d="M11 13.5 a9 9 0 0 1 18 0 q-4.5-3-9-2.4 q-4.5-.6-9 2.4z"/>
      <path class="band" d="M10.6 14 a9.4 9.4 0 0 1 18.8 0"/><rect class="cup" x="8.2" y="12.2" width="4.4" height="7.4" rx="2.2"/>
      <rect class="cup" x="27.4" y="12.2" width="4.4" height="7.4" rx="2.2"/></g>
    <g class="hat h-beanie"><path class="bn-dome" d="M11 12.6 a9 9.6 0 0 1 18 0 z"/><rect class="bn-rib" x="10.2" y="10.6" width="19.6" height="3.6" rx="1.8"/>
      <circle class="pom" cx="20" cy="2.6" r="2.5"/></g>
    <g class="eyes"><circle class="eye" cx="16.6" cy="16.2" r="1.2"/><circle class="eye" cx="23.4" cy="16.2" r="1.2"/></g>
    <ellipse class="cheek" cx="14.4" cy="18.6" rx="1.7" ry="1.1"/><ellipse class="cheek" cx="25.6" cy="18.6" rx="1.7" ry="1.1"/>
    <path class="mouth" d="M18 19.6 q2 1.5 4 0"/>
    <g class="prop book"><rect x="12" y="27" width="16" height="10" rx="1.5" fill="#f2e8d5" stroke="#b08850" stroke-width="1"/><path d="M20 27v10" stroke="#b08850" stroke-width="1"/></g>
    <g class="prop laptop"><rect x="11" y="29" width="18" height="10" rx="1.5" fill="#cfd5df" stroke="#7d8696" stroke-width="1"/><circle cx="20" cy="34" r="1.3" fill="#9aa3b2"/></g>
    <g class="prop mug"><rect x="29" y="29" width="6" height="7" rx="1.5" fill="#fff" stroke="#9a8f86" stroke-width="1"/><path d="M35 31 q2.5 1.5 0 3" fill="none" stroke="#9a8f86" stroke-width="1"/></g>
  </g></g></svg>`;

const sprites = new Map();
let spriteSid = null;
function clearSprites() { sprites.clear(); spritesEl.textContent = ''; spriteSid = null; }

function makeSprite(c, room) {
  const el = document.createElement('div');
  el.className = 'char';
  el.innerHTML = `<div class="above"><div class="badges"><span class="badge b-block">승인 대기</span><span class="badge b-stuck">1분+</span>
    <span class="badge b-zz">💤</span><span class="badge b-bolt">⚡</span></div><div class="bubble"></div></div>
    ${SVG}<div class="stamp"></div><div class="mis" title="의도한 모델과 실제 모델이 달라요">✗</div>
    <div class="tag"><i class="obs"></i><span class="nm"></span><i class="pips"></i></div>`;
  const h = hash(c.id);                              // desync decorative breathe/blink per sprite
  el.style.setProperty('--bd', `-${(h % 3200) / 1000}s`); el.style.setProperty('--kd', `-${(h % 5000) / 1000}s`);
  spritesEl.append(el);
  const sp = { key: c.id, el, c, path: [], seen: 0, dwell: 0, gone: false, fading: false, walking: false, left: false, slot: 0, n: 1,
    bubble: el.querySelector('.bubble'), pips: el.querySelector('.pips'), stamp: el.querySelector('.stamp'),
    obs: el.querySelector('.obs'), nm: el.querySelector('.nm'), x: 0, y: 0, seg: null, sig: '', mis: false, talk: true };
  // A fresh subagent visibly arrives by elevator; anyone else (history, room switch) starts where they are.
  const fresh = c.aid && c.visits[0]?.room === 'elevator' && state.now - c.enteredAt < 15000 && !reducedMotion.matches;
  const start = fresh ? anchor('elevator', c, hashSlot(c.id)) : anchor(c.room, c, 0);
  sp.x = start.x; sp.y = start.y; sp.snap = !fresh;
  sp.seen = fresh ? c.visits[0].seq : (c.visits.at(-1)?.seq ?? 0);
  sprites.set(c.id, sp);
  return sp;
}

function head(c) {
  const t = typeof c.target === 'string' ? c.target : c.target != null ? JSON.stringify(c.target) : '';
  if (!t) return c.tool || '';
  if (c.tool === 'Bash') return bashTokens(t).toks.slice(0, 2).join(' ') || t;
  if (/^https?:\/\//.test(t)) { try { return new URL(t).host; } catch { return t; } }
  if (t.includes('/')) return t.split('/').filter(Boolean).pop() || t;
  return t;
}
function bubbleText(c) {
  if (c.blocked) return c.target ? `승인? ${head(c)}` : '승인 기다리는 중';
  if (c.label) return c.label;                      // e.g. '위임 대기' while main waits on a long Agent call
  if (c.act === 'thinking') return '…';
  if (['idle', 'leaving', 'arriving'].includes(c.act)) return '';
  return head(c);
}
function applyClass(sp) {
  const c = sp.c;
  sp.el.className = ['char', `m-${c.model}`, `act-${c.act}`, c.aid ? 'sub' : 'main', c.blocked && 'blocked', c.stuck && 'stuck',
    c.dozing && 'dozing', c.flash && 'flash', c.obs === 'stale' && 'stale', c.verdict && `v-${c.verdict}`, sp.mis && 'mismatch',
    sp.walking && 'walking', sp.left && 'face-left', sp.fading && 'gone'].filter(Boolean).join(' ');
}
const pipsHTML = effort => (EFFORT[effort] ? [1, 2, 3, 4].map(i => `<i class="${i <= EFFORT[effort] ? 'on' : ''}"></i>`).join('') : '');

function syncScene(room) {
  if ((room?.sid ?? null) !== spriteSid) { clearSprites(); spriteSid = room?.sid ?? null; }
  $('empty').hidden = Object.keys(state.floors).length > 0;
  const chars = room ? Object.values(room.chars).sort((a, b) => (a.id < b.id ? -1 : 1)) : [];
  const used = {}, count = {}, newest = {};
  const keyOf = c => (c.room === 'desk' && (!c.aid || c.desk != null) ? `desk:${c.id}` : c.room);
  for (const c of chars) { const k = keyOf(c); count[k] = (count[k] || 0) + 1; if (!newest[k] || c.lastTs >= newest[k].lastTs) newest[k] = c; }
  const mism = new Set(compliance(state).rows.filter(r => r.match === 'no' && r.child).map(r => r.child));
  for (const c of chars) {
    const sp = sprites.get(c.id) || makeSprite(c, room);
    sp.c = c; sp.gone = false;
    const k = keyOf(c);
    sp.slot = used[k] = (used[k] ?? -1) + 1; sp.n = count[k];
    for (const v of c.visits) if (v.seq > sp.seen) { sp.path.push(v.room); sp.seen = v.seq; }
    if (sp.path.length > 5) sp.path.splice(0, sp.path.length - 4);   // event storm: skip stale waypoints, keep up
    sp.talk = newest[k] === c || c.blocked;                         // one bubble per room: the newest speaker
    sp.mis = mism.has(c.id);
    const sig = [c.model, c.act, c.blocked, c.stuck, c.dozing, c.flash, c.obs, c.verdict, c.target, c.effort, c.atype, c.desk, c.label, sp.talk, sp.mis].join('|');
    if (sig !== sp.sig) {
      sp.sig = sig;
      sp.bubble.textContent = sp.talk ? bubbleText(c) : '';
      sp.pips.innerHTML = pipsHTML(c.effort);
      sp.pips.title = c.effort ? `effort ${c.effort}` : '';
      sp.stamp.textContent = c.verdict ? VERDICT_KO[c.verdict] || c.verdict : '';
      sp.obs.className = `obs ${c.obs}`;
      sp.nm.textContent = !c.aid ? 'Fable' : c.desk == null ? c.atype : `${c.atype}·${c.aid.slice(0, 4)}`;
      sp.el.title = `${c.aid ? `${c.atype}·${c.aid.slice(0, 4)}` : 'Fable'} · ${c.model} · ${ACT_KO[c.act] || c.act} · ${OBS_KO[c.obs]}${sp.mis ? ' · 모델 불일치' : ''}`;
      applyClass(sp);
    }
  }
  for (const sp of sprites.values()) if (!room?.chars[sp.key] && !sp.gone) {
    sp.gone = true;                                      // removed by tick after the leave animation
    if ((sp.path.at(-1) ?? sp.c.room) !== 'elevator') sp.path.push('elevator');
  }
  // Room decorations follow state only.
  const busy = {};
  for (const c of chars) if (c.room !== 'desk') busy[c.room] = (busy[c.room] || 0) + 1;
  for (const [name, r] of Object.entries(geo.rooms)) {
    if (name === 'floor') continue;
    r.el.classList.toggle('busy', !!busy[name] && name !== 'elevator');
    const h = r.el.querySelector('h3');
    const label = h.dataset.label ||= h.textContent;
    h.innerHTML = esc(label) + (busy[name] && name !== 'elevator' ? ` <span class="count">${busy[name]}</span>` : '');
  }
  const liftOpen = chars.some(c => c.act === 'arriving' || c.act === 'leaving' || c.act === 'delegating') ||
    [...sprites.values()].some(sp => sp.gone && !sp.fading);
  geo.rooms.elevator?.el.classList.toggle('open', liftOpen);
  geo.deskEls?.forEach((d, i) => d.classList.toggle('taken', !!room?.desks[i]));
}

// Movement: walk each sprite through its waypoint queue with a short dwell so brief visits stay visible.
// Each leg is its own eased tween (easeInOutCubic, 350–900ms by distance) — starts soft, lands soft.
const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
function move(now) {
  const speed = Math.max(160, geo.w * 0.4) / 1000;   // px per ms
  let active = false;
  for (const sp of sprites.values()) {
    if (sp.fading) continue;
    if (sp.dwell > now) { active = true; continue; }
    const target = sp.path.length ? sp.path[0] : (sp.gone ? null : sp.c.room);
    if (target == null) {
      sp.fading = true; applyClass(sp);
      setTimeout(() => { sp.el.remove(); if (sprites.get(sp.key) === sp) sprites.delete(sp.key); }, reducedMotion.matches ? 0 : 650);
      continue;
    }
    const p = target === sp.c.room ? anchor(target, sp.c, sp.slot, sp.n) : anchor(target, sp.c, hashSlot(sp.c.id), 2);
    const wasWalking = sp.walking, wasLeft = sp.left;
    if (sp.snap) { sp.snap = false; sp.x = p.x; sp.y = p.y; }
    if (!sp.seg || Math.abs(sp.seg.tx - p.x) > 1 || Math.abs(sp.seg.ty - p.y) > 1) {
      const dist = Math.hypot(p.x - sp.x, p.y - sp.y);
      sp.seg = { t0: now, fx: sp.x, fy: sp.y, tx: p.x, ty: p.y, dur: dist < 1 ? 0 : Math.min(900, Math.max(350, dist / speed)) };
      if (Math.abs(p.x - sp.x) > 1) sp.left = p.x < sp.x;
    }
    const s = sp.seg, t = reducedMotion.matches || !s.dur ? 1 : Math.min(1, (now - s.t0) / s.dur);
    const e = ease(t);
    sp.x = s.fx + (s.tx - s.fx) * e; sp.y = s.fy + (s.ty - s.fy) * e;
    if (t >= 1) {
      sp.walking = false;
      if (sp.path.length) { sp.path.shift(); sp.seg = null; sp.dwell = reducedMotion.matches ? 0 : now + (sp.path.length || sp.gone ? 650 : 0); active = true; }
    } else { sp.walking = true; active = true; }
    if (wasWalking !== sp.walking || wasLeft !== sp.left) applyClass(sp);
    sp.el.style.transform = `translate3d(${(sp.x - charW / 2).toFixed(1)}px, ${(sp.y - charH).toFixed(1)}px, 0)`;
    sp.el.style.zIndex = sp.c.aid ? String(Math.round(sp.y)) : '9999';
  }
  return active;
}

// ---------------- panel ----------------
const fmtDur = ms => {
  if (ms == null || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return ms < 10000 ? `${(ms / 1000).toFixed(1)}초` : `${s}초`;
  if (s < 3600) return `${Math.floor(s / 60)}분 ${s % 60}초`;
  return `${Math.floor(s / 3600)}시간 ${Math.floor(s / 60) % 60}분`;
};
const pct = x => (x == null ? '—' : `${Math.round(x * 100)}%`);
const clock = ms => new Date(ms).toLocaleTimeString('en-GB', { hour12: false });
const mkey = m => (MODELS.includes(m) ? m : 'unknown');
const mstyle = m => `--m:var(--${mkey(m)});--mi:var(--${mkey(m)}-ink)`;
const pipsSpan = (effort, m) => `<i class="pips" title="effort ${esc(effort || '?')}" style="${mstyle(m)}">${pipsHTML(effort)}</i>`;
// Write only when the markup actually changed: keeps hover/selection stable and lets CSS transitions run.
const setHTML = (el, html) => { if (el._h !== html) { el._h = html; el.innerHTML = html; } };
const setW = (id, frac) => { const w = `${(Math.max(0, frac) * 100).toFixed(2)}%`; const el = $(id); if (el.style.width !== w) el.style.width = w; };
const level = r => (r == null ? 'none' : r >= 0.9 ? 'ok' : r >= 0.7 ? 'warn' : 'bad');

function renderMeter(k) {
  const m = $('meter');
  if (!m.dataset.built) {
    m.dataset.built = '1';
    m.innerHTML = `<div class="head"><h2>모델 분배 준수</h2><span class="muted" style="font-size:12px">오늘 · 전체 세션</span></div>
      <div class="big" id="m-big"><span class="n"></span><small>의도 모델 = 실제 모델</small></div>
      <div class="say" id="m-say"></div><div class="chips" id="m-chips"></div>
      <div class="row" id="m-r1"></div>
      <div class="bar" title="메인 세션 직접 도구 호출 vs 위임"><span class="direct" id="m-direct"></span><span class="delegated" id="m-deleg"></span></div>
      <div class="row" id="m-r2"></div>
      <div class="bar" title="판정 분포"><span class="ok" id="m-ok"></span><span class="rework" id="m-rework"></span><span class="fail" id="m-fail"></span></div>
      <div id="m-models"></div>`;
  }
  const pending = k.rows.filter(r => r.match === 'pending').length;
  const tot = k.direct + k.delegated || 1, v = k.verdicts, vt = v.ok + v.rework + v.fail;
  const lv = level(k.matchRate);
  const big = $('m-big');
  big.className = `big lv-${lv}`;
  big.querySelector('.n').textContent = k.matchRate == null ? '기록 없음' : pct(k.matchRate);
  big.querySelector('small').hidden = k.matchRate == null;
  const pairs = [...new Set(k.rows.filter(r => r.match === 'no').map(r => `${r.want || '미지정'}→${r.actual}`))];
  const say = lv === 'none'
    ? (pending ? `위임 ${pending}건 결과 확인 중이에요` : k.rows.length ? '모델 미지정 위임만 있어요' : '오늘 위임이 아직 없어요')
    : `${{ ok: '규칙 준수 중', warn: '주의 · 일부 위반', bad: '규칙 위반 많음' }[lv]} · ${k.no ? `위반 ${k.no}건 (${pairs.slice(0, 2).join(', ')}${pairs.length > 2 ? ' …' : ''})` : '위반 없음'}`;
  const sayEl = $('m-say'); sayEl.className = `say lv-${lv}`; sayEl.textContent = say;
  setHTML($('m-chips'), [k.yes && `<span class="chip yes">✓ 일치 ${k.yes}</span>`, k.no && `<span class="chip no">✗ 불일치 ${k.no}</span>`,
    k.unset && `<span class="chip" title="sub.model 없이 위임(상속)">모델 미지정 ${k.unset}</span>`,
    pending && `<span class="chip">확인 대기 ${pending}</span>`].filter(Boolean).join(''));
  setHTML($('m-r1'), `<span>Fable 직접 도구 <b>${k.direct}</b></span><span>위임 <b>${k.delegated}</b> · 직접 비율 ${pct(k.directRatio)}</span>`);
  setW('m-direct', k.direct / tot); setW('m-deleg', k.delegated / tot);
  setHTML($('m-r2'), `<span>판정 ${vt}건 · 재작업률 ${pct(vt ? (v.rework + v.fail) / vt : null)}</span><span>통과 ${v.ok} · 재작업 ${v.rework} · 실패 ${v.fail}</span>`);
  for (const x of ['ok', 'rework', 'fail']) setW(`m-${x}`, vt ? v[x] / vt : 0);
  const models = [...MODELS, ...Object.keys(k.byModel).filter(x => !MODELS.includes(x))].filter(x => k.byModel[x]);
  setHTML($('m-models'), models.length ? `<table class="mtable"><thead><tr><th>모델</th><th>위임</th><th>평균 소요</th><th>재작업률</th></tr></thead><tbody>${
    models.map(x => { const b = k.byModel[x]; return `<tr title="통과 ${b.ok} · 재작업 ${b.rework} · 실패 ${b.fail}"><td><span class="mbadge" style="${mstyle(x)}">${esc(x)}</span></td>
      <td>${b.n}</td><td>${fmtDur(b.avgMs)}</td><td>${b.reworkRate == null ? '판정 전' : pct(b.reworkRate)}</td></tr>`; }).join('')}</tbody></table>` : '');
}

function renderNow(room) {
  const chars = room ? Object.values(room.chars).sort((a, b) => (a.aid ? 1 : 0) - (b.aid ? 1 : 0) || a.enteredAt - b.enteredAt) : [];
  if (!chars.length) { setHTML($('now'), '<p class="empty-note">이 방에는 아직 아무도 없어요.</p>'); return; }
  setHTML($('now'), chars.map(c => {
    const since = c.phase === 'tool' && c.toolSince ? c.toolSince : c.lastTs;
    const badges = [c.blocked && '<span class="sbadge red">승인 대기</span>', c.stuck && '<span class="sbadge amber">막힘 1분+</span>',
      c.dozing && '<span class="sbadge grey">💤 3분+</span>', c.failCount && `<span class="sbadge red">실패 ${c.failCount}</span>`,
      c.verdict && `<span class="vstamp ${c.verdict}">${VERDICT_KO[c.verdict] || esc(c.verdict)}</span>`].filter(Boolean).join(' ');
    return `<div class="agent${c.obs === 'stale' ? ' is-stale' : ''}" style="${mstyle(c.model)}"><span class="sw"></span>
      <div class="name"><i class="obs ${c.obs}" title="${OBS_KO[c.obs]}"></i>${esc(c.aid ? `${c.atype}·${c.aid.slice(0, 4)}` : 'Fable')}
        <span class="mbadge">${esc(c.model)}</span>${pipsSpan(c.effort, c.model)}</div>
      <div class="right" title="${esc(c.phase === 'tool' ? '이 도구 실행 경과' : '마지막 이벤트 이후')}">${fmtDur(state.now - since)}</div>
      <div class="meta">${esc(c.label || ACT_KO[c.act] || c.act)}${c.target ? ` · ${esc(head(c))}` : ''} ${badges}</div></div>`;
  }).join(''));
}

function renderDeleg(k) {
  const rows = k.rows.slice(-15).reverse().sort((a, b) => (b.match === 'no') - (a.match === 'no'));   // ✗ first, then newest
  if (!rows.length) { setHTML($('deleg'), '<p class="empty-note">오늘 위임 기록이 없어요.</p>'); return; }
  const MARK = { yes: '✓', no: '✗', pending: '…', unset: '?', failed: '실패', expired: '만료' };
  const dot = (m, label) => `<i class="mdot${m ? '' : ' none'}" style="${m ? mstyle(m) : ''}" title="${esc(label)}"></i>`;
  setHTML($('deleg'), rows.map(r => `<div class="drow${r.match === 'no' ? ' bad' : ''}" title="${esc(r.desc)} · 세션 ${esc(r.sid.slice(0, 8))}">
    <span class="who">${esc(r.type)}${r.child ? `·${esc(r.child.slice(0, 4))}` : ''}</span>
    <span class="mm">${dot(r.want, `의도: ${r.want || '미지정'}`)}<span class="arrow">→</span>${dot(r.actual, `실제: ${r.actual || r.resolved || ({ failed: '호출 실패', expired: '결과 없음(만료)' }[r.match] ?? '확인 중')}`)}${
      r.match === 'no' ? ` <small>${esc(r.want || '미지정')}→${esc(r.actual)}</small>` : ''} <span class="mark ${esc(r.match)}">${MARK[r.match] ?? esc(r.match)}</span></span>
    <span class="dur">${r.durMs != null ? fmtDur(r.durMs) : r.match === 'expired' ? '응답 없음' : r.child ? '진행 중' : '—'}</span>
    <span class="vstamp ${r.verdict || 'none'}">${r.verdict ? VERDICT_KO[r.verdict] || esc(r.verdict) : '판정 전'}</span></div>`).join(''));
}

function renderStats() {
  const rooms = Object.values(state.floors).reduce((n, f) => n + Object.keys(f.rooms).length, 0), st = state.stats;
  setHTML($('stats'), `<div class="kv"><span>도구 실패<b class="${st.failures ? 'hot' : ''}">${st.failures}</b></span><span>승인 요청<b>${st.permissions}</b></span>
    <span>세션<b>${rooms}</b></span><span>이벤트<b>${st.events}</b></span></div>`);
}

// Ticker: at most ~2 DOM updates per second; new items are prepended (old ones never re-rendered), tool-done lines dropped.
let tickerWaiting = false;
function tickerLine(t) {
  let s = String(t.text ?? '');
  if (t.kind === 'PreToolUse') s = s.replace(/^(\w+)/, (_, w) => toolKo(w));
  else if (t.kind === 'PostToolUseFailure') s = s.replace(/^(\w+)/, (_, w) => toolNoun(w));
  else if (t.kind === 'PermissionRequest') s = s.replace(/^승인 요청 (\w+)/, (_, w) => `승인 요청 · ${toolNoun(w)}`);
  else if (t.kind === 'verdict') s = s.replace(/판정 (OK|REWORK|FAIL)/, (_, w) => `판정 ${VERDICT_KO[w.toLowerCase()]}`);
  return s;
}
function renderTicker(now) {
  const items = state.ticker, top = items[0]?.seq ?? 0;
  if (top <= lastTickerSeq) { tickerWaiting = false; return; }
  if (now - lastTickerAt < 500) { tickerWaiting = true; return; }
  const ol = $('ticker'), animate = lastTickerSeq > 0;
  const html = items.filter(t => t.seq > lastTickerSeq && t.kind !== 'PostToolUse').map(t => `<li class="k-${esc(t.kind)}${animate ? ' new' : ''}">
    <time>${clock(t.ts)}</time><b>${esc(t.who)}</b> ${esc(tickerLine(t))}</li>`).join('');
  if (html) ol.insertAdjacentHTML('afterbegin', html);
  while (ol.childElementCount > 30) ol.lastElementChild.remove();
  lastTickerSeq = top; lastTickerAt = now; tickerWaiting = false;
}

function renderPanel(sel) {
  const k = compliance(state);
  renderMeter(k); renderNow(sel.room); renderDeleg(k); renderStats();
  let blocked = 0;
  for (const f of Object.values(state.floors)) for (const r of Object.values(f.rooms)) for (const c of Object.values(r.chars)) if (c.blocked) blocked++;
  $('needs').hidden = !blocked;
  $('needs').querySelector('b').textContent = blocked;
  if (blocked > lastBlocked && ui.sound) chime();
  lastBlocked = blocked;
}

// ---------------- frame loop (runs only while something changes or moves) ----------------
let raf = 0;
function kick() { if (!raf) raf = requestAnimationFrame(frame); }
function frame(now) {
  raf = 0;
  drain();
  if (sceneDirty || panelDirty) {
    const sel = select();
    renderTabs(sel);
    if (sceneDirty) { syncScene(sel.room); sceneDirty = false; }
    if (panelDirty && now - lastPanelAt > 250) { renderPanel(sel); panelDirty = false; lastPanelAt = now; }
  }
  renderTicker(now);
  if (move(now) || panelDirty || queue.length || tickerWaiting) kick();
}

new ResizeObserver(() => {
  measure();
  for (const sp of sprites.values()) if (!sp.path.length) { const p = anchor(sp.c.room, sp.c, sp.slot, sp.n); sp.x = p.x; sp.y = p.y; sp.seg = null; }
  kick();
}).observe(scene);
measure();
connect();
kick();
