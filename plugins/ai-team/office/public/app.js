// AI Team Office v2 — renderer. Reads reducer state (reduce/tick/compliance), usage records and the 대표실 queue;
// never invents activity. Only ?sim=1 adds made-up data (sim.js), and the UI says so.
import { initState, reduceAll, tick, compliance, bashTokens, MODELS } from './reducer.js';
import { paint, applyTextures, applyIcons } from './sprites.js';
import { W, H, ROOMS, SEATS, MAIN_SEAT, ELEVATOR_SPOT, DROP_SPOT, AISLE_TOP, chainOf, route, drawWorld, drawFx, drawAmbient } from './world.js';
import { Ambient } from './ambient.js';
import { mountClock, ymd } from './clock.js';
import { limitsHTML, ctxHTML, ctxOf, tokKo } from './limits.js';
import { openSecretary } from './secretary.js';
import { SeatBook } from './seats.js';
import { displayName, lookOf, rankOf, jobOf, JOB_LONG, nickname, nameFromWho, resetNames, ACT_KO, hash32, mainTitle } from './roles.js';
import { layoutFloors, mountBuilding, renderOverview, elevatorFx } from './building.js';
import { openFloorEditor } from './editor.js';
import { ceoStep, ceoList, ceoResolve, ceoReset, ceoExpire, HIGH, dismissKey, visibleQueue, releasePlan, DismissStore, ceoSpots, reportText, reportDecision, reportBlocks, linkParts, readerSame, ceoTable, nextSort, LIST_COLS, ceoMore, ceoGroupPlan, groupTip, groupEntry, pruneSel, selectRows, selectRange, selState, selHigh, selHidden, selEntries, CEO_PLAN, CEO_KNOCK, ceoEntry, HoverHold } from './ceo.js';
import { Usage, bindTips, usageSummaryHTML, detailHTML } from './charts.js';
import { relay as relayState, whyNoButtons, instructOff, applyFrame, sweep, resetRelay, mergeQueue, relayHTML, relayLive, onRelayClick, onRelayInput, decidedKey, keyOfRelay, releaseRelay, officeHeaders, staleBoot } from './ceocard.js';
import * as sim from './sim.js';

const $ = id => document.getElementById(id);
const scene = $('scene'), spritesEl = $('sprites'), stage = $('stage');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const narrowMQ = matchMedia('(max-width: 760px)');
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
const SIM = /[?&]sim=1/.test(location.search);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* per-viewer convenience only */ } },
};
const esc = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const safeJSON = s => { try { return JSON.parse(s); } catch { return null; } };

const EFFORT = { low: 1, medium: 2, high: 3, xhigh: 4, max: 4 };
const OBS_KO = { observed: '관측', inferred: '추정', stale: '오래됨' };
const VERDICT_KO = { ok: '통과', rework: '재작업', fail: '실패' };
const TOOL_ACT = { Read: 'reading', Grep: 'reading', Glob: 'reading', LSP: 'reading', WebFetch: 'reading', WebSearch: 'reading', ToolSearch: 'reading',
  Bash: 'running', Edit: 'writing', Write: 'writing', NotebookEdit: 'writing', Agent: 'delegating' };
const toolKo = t => ACT_KO[TOOL_ACT[t]] || t || '';
const toolNoun = t => toolKo(t).replace(/ 중$/, '');
const CARRY = { intern: 'books', field: 'umbrella', qa: 'magnifier', plan: 'notebook' };

let state = initState();
let queue = [];
const ui = { floor: null, sid: null, pinned: false, sound: store.get('office.sound') === '1', theme: store.get('office.theme') || 'auto',
  mode: '실시간', overview: false, live: false, pricing: false, limits: null, ctxAll: false };
let panelDirty = true, sceneDirty = true, bldDirty = true, lastPanelAt = 0, lastTickerSeq = 0, lastTickerAt = 0, lastHigh = 0;
const usage = new Usage();
/** The main session's model comes from its own usage records (no aid), most recent wins; null when unknown. */
const mainFam = sid => (sid ? usage.mainFamily(sid) : null);
const view = (c, sid) => (c.aid || c.ceo ? c : { ...c, model: mainFam(sid) || 'unknown' });
const waiting = new Map();            // 대표실 queue, folded with ceo.js
const bows = new Map();               // resolved queue key -> time (bow, then walk back)
const counts = new Map();             // `${sid}|${aid||'main'}` -> tool calls today
const projSeen = [], projSet = new Set();
let serverBuilding = null, localBuilding = safeJSON(store.get('office.building')), memBuilding = null, stopSim = null;
const buildingConfig = () => memBuilding || localBuilding || serverBuilding || (SIM ? sim.DEMO_BUILDING : null);
const dirtyAll = () => { panelDirty = sceneDirty = bldDirty = true; kick(); };

// ---------------- theme, sky, sound ----------------
const isDark = () => ui.theme === 'dark' || (ui.theme === 'auto' && darkMQ.matches);
function applyTheme() {
  const root = document.documentElement;
  if (ui.theme === 'auto') delete root.dataset.theme; else root.dataset.theme = ui.theme;
  $('theme').textContent = { auto: '◐', light: '☀', dark: '☾' }[ui.theme];
  $('theme').title = `테마: ${{ auto: '자동', light: '라이트', dark: '다크' }[ui.theme]}`;
  applyTextures(root, isDark());
  applySky(true);
}
$('theme').onclick = () => { ui.theme = { auto: 'light', light: 'dark', dark: 'auto' }[ui.theme]; store.set('office.theme', ui.theme); applyTheme(); };
darkMQ.addEventListener('change', applyTheme);
// Sky through the glass follows the local clock; dark mode always shows the night view (city lights).
const SKY_Q = new URLSearchParams(location.search).get('sky');
function skyNow() {
  if (isDark()) return 'night';
  if (['morning', 'day', 'evening', 'night'].includes(SKY_Q)) return SKY_Q;
  const h = new Date().getHours();
  return h >= 6 && h < 10 ? 'morning' : h >= 10 && h < 17 ? 'day' : h >= 17 && h < 20 ? 'evening' : 'night';
}
let worldSig = '';
function applySky(force) {
  const sky = skyNow(), sig = `${sky}|${isDark()}`;
  if (document.documentElement.dataset.sky !== sky) document.documentElement.dataset.sky = sky;
  if (sig === worldSig && !force) return;
  worldSig = sig;
  drawWorld($('world'), { dark: isDark(), sky });
  fxDirty = true; kick();
}
function applySound() { $('sound').textContent = ui.sound ? '🔔' : '🔕'; $('sound').setAttribute('aria-pressed', String(ui.sound)); }
$('sound').onclick = () => { ui.sound = !ui.sound; store.set('office.sound', ui.sound ? '1' : '0'); applySound(); if (ui.sound) chime(); };
let audio = null;
function chime() {
  try {
    audio ||= new AudioContext();
    const t = audio.currentTime;
    [660, 880].forEach((f, i) => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = f; o.type = 'square';
      g.gain.setValueAtTime(0.0001, t + i * 0.16); g.gain.exponentialRampToValueAtTime(0.06, t + i * 0.16 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.16 + 0.3);
      o.connect(g).connect(audio.destination); o.start(t + i * 0.16); o.stop(t + i * 0.16 + 0.35);
    });
  } catch { /* audio unavailable */ }
}
/** Two soft wooden knocks (only when the sound toggle is on). */
function knockSound() {
  try {
    audio ||= new AudioContext();
    const t = audio.currentTime;
    [0, 0.13].forEach(d => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.setValueAtTime(190, t + d); o.frequency.exponentialRampToValueAtTime(90, t + d + 0.07); o.type = 'triangle';
      g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.12, t + d + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.09);
      o.connect(g).connect(audio.destination); o.start(t + d); o.stop(t + d + 0.1);
    });
  } catch { /* audio unavailable */ }
}
applyIcons(document.documentElement); applySound();
let toastT = 0;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3200); }

// ---------------- data: SSE -> queue -> reducer ----------------
function setConn(st, text) { const el = $('conn'); el.dataset.state = st; el.textContent = text; }
let es = null, dayEnd = 0;
function resetView() {
  state = initState(); queue = []; clearSprites(); lastTickerSeq = 0; $('ticker').textContent = '';
  usage.reset(); ceoReset(waiting); ceoKnown = null; bows.clear(); decided.clear(); resetRelay(); lastList = []; queueKeys = new Set(); counts.clear(); projSeen.length = 0; projSet.clear(); resetNames();
  ui.live = false; stopSim?.(); stopSim = null; dirtyAll();
}
// Viewer id for this page: lets POST /viewer say "this tab is hidden" so a background tab does not hold relay items.
const VID = (crypto.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');
function eventsUrl() {
  const q = new URLSearchParams(location.search);
  q.set('vid', VID);
  if (document.hidden) q.set('visible', '0');
  return '/events?' + q;
}
function reportVisibility() {
  if (SIM) return;
  fetch('/viewer', { method: 'POST', headers: officeHeaders(), body: JSON.stringify({ vid: VID, visible: !document.hidden }) }).catch(() => {});
}
document.addEventListener('visibilitychange', reportVisibility);
function connect() {
  es = new EventSource(eventsUrl());
  es.onopen = () => { resetView(); setConn('live', ui.mode); kick(); };
  es.addEventListener('batch', m => { const arr = safeJSON(m.data); if (Array.isArray(arr)) { queue.push(...arr); kick(); } });
  es.addEventListener('usage-batch', m => { if (usage.addAll(safeJSON(m.data))) { panelDirty = sceneDirty = bldDirty = true; kick(); } });
  es.addEventListener('ceo', m => {
    const f = safeJSON(m.data);
    if (applyFrame(f)) { resolveLocal(decidedKey(f)); sceneDirty = bldDirty = true; if (pop.kind) renderPop(); kick(); }
  });
  es.addEventListener('limits', m => { ui.limits = safeJSON(m.data); renderLimits(); sceneDirty = true; kick(); });
  es.addEventListener('usage', m => { if (usage.add(safeJSON(m.data))) { panelDirty = sceneDirty = true; kick(); } });
  es.addEventListener('ready', m => {
    const info = safeJSON(m.data) || {};
    // The server restarted while this page stayed open: its viewer token is gone, so answers would be refused. Reload.
    const boot = document.querySelector('meta[name="office-boot"]')?.content;
    if (!SIM && staleBoot(boot, info.boot)) { location.reload(); return; }
    ui.mode = SIM ? '시뮬레이터' : info.mode === 'replay' ? '리플레이' : '실시간';
    if (info.redact) ui.mode += ' · 가림';
    if ('building' in info) serverBuilding = info.building && typeof info.building === 'object' ? info.building : null;
    ui.pricing = !!info.hasPricing;
    if ('limits' in info) ui.limits = info.limits || null;
    setConn('live', ui.mode);
    reportVisibility();                             // an auto-reconnect reuses the first URL: re-state this tab's visibility
    scheduleMidnight(info.dayStart);
    queue.push({ __ready: true });                  // events before this marker are history: no walk-in scenes for them
    if (SIM) {
      const speed = Number(new URLSearchParams(location.search).get('speed')) || 1;
      usage.addAll(sim.usageHistory()); sceneDirty = true;
      const simSids = () => Object.values(state.floors).flatMap(f => Object.values(f.rooms).map(r => [r.sid, f.proj]));
      ui.limits = sim.simLimits(Date.now(), simSids()); setTimeout(() => { ui.limits = sim.simLimits(Date.now(), simSids()); renderLimits(); sceneDirty = true; kick(); }, 4000);
      stopSim?.(); stopSim = sim.play(speed, e => { queue.push(e); kick(); }, f => { applyFrame(f); sceneDirty = bldDirty = true; kick(); });
    }
    dirtyAll();
  });
  es.onmessage = m => { const e = safeJSON(m.data); if (e) { queue.push(e); kick(); } };
  es.onerror = () => setConn('err', '재연결 중…');
}
function scheduleMidnight(dayStart) {
  const ds = typeof dayStart === 'number' ? dayStart : typeof dayStart === 'string' ? Date.parse(dayStart) : NaN;
  dayEnd = Number.isFinite(ds) ? ds + 86400000 : 0;
}
function maybeNewDay(now) {
  if (!dayEnd || now < dayEnd) return;
  dayEnd = 0; es?.close(); resetView(); setConn('wait', '새 날 시작…'); connect(); kick();
}
/** The human decided (dashboard answer, terminal answer reported by the relay, or the simulator's local answer):
 *  the character bows and walks back to its seat now, freeing its place in line. */
const decided = new Map();             // queue key -> Date.now() of the human's decision (until the next event arrives)
function resolveLocal(key, keys) {
  for (const g of keys || ceoResolve(waiting, key)) { bows.set(g, performance.now()); decided.set(g, Date.now()); sceneDirty = bldDirty = true; }
  kick();
}
/** After a decision the character is no longer blocked, even before its next event arrives (the simulator never sends one). */
const settle = (c, sid) => { const t = decided.get(`${sid}|${c.aid || 'main'}`); return t != null && c.blocked && c.lastTs <= t ? { ...c, blocked: false, act: 'thinking' } : c; };
/** Bookkeeping that the reducer does not keep: first-activity order, per-character counts, the 대표실 queue. */
function observe(e) {
  if (typeof e.proj === 'string' && e.proj && !projSet.has(e.proj)) { projSet.add(e.proj); projSeen.push(e.proj); bldDirty = true; }
  if (typeof e.ev !== 'string' || typeof e.sid !== 'string') return;
  if (e.ev === 'PreToolUse') { const k = `${e.sid}|${e.aid || 'main'}`; counts.set(k, (counts.get(k) || 0) + 1); }
  const gone = ceoStep(waiting, e);
  if (ui.live) {
    for (const g of gone) bows.set(g, performance.now());
    if (e.ev === 'UserPromptSubmit' && !e.aid && (e.sid === ui.sid || (!ui.sid && !ui.pinned))) ceoVisit(e.sid);
  }
  if (SIM) { const r = sim.usageFor(e); if (r) usage.add(r); }
}
function drain() {
  if (!queue.length) return;
  const batch = [];
  for (const e of queue.splice(0)) {
    if (!e || typeof e !== 'object') continue;
    if (e.__ready) { ui.live = true; continue; }
    try { observe(e); } catch { /* bookkeeping must never block the reducer */ }
    batch.push(e);
  }
  try { state = reduceAll(state, batch); } catch {
    let bad = 0;
    for (const e of batch) { try { state = reduceAll(state, [e]); } catch { bad++; } }
    console.warn(`office: skipped ${bad} event(s) the reducer could not apply`);
  }
  try { state = tick(state, Date.now()); } catch { /* keep last good state */ }
  dirtyAll();
}
setInterval(() => {
  const now = Date.now();
  maybeNewDay(now); applySky();
  const done = ceoExpire(waiting, now); if (done.length && ui.live) resolveLocal(null, done);
  maybeBye(false);
  renderLimits();
  if (sweep(now)) sceneDirty = bldDirty = true;
  try { state = tick(state, now); } catch { /* keep last good state */ }
  dirtyAll(); if (pop.kind) renderPop();
  renderReader();
}, 1000);

// ---------------- floors (building) and rooms (sessions) ----------------
let rowsCache = { key: '', rows: [] };
function floorRows() {
  const conf = buildingConfig(), key = JSON.stringify(conf) + projSeen.join('\n');
  if (rowsCache.key !== key) rowsCache = { key, rows: layoutFloors(conf, projSeen) };
  return rowsCache.rows;
}
const rowOf = proj => floorRows().find(r => r.projs.includes(proj));
const floorKey = proj => rowOf(proj)?.proj ?? proj;   // primary project of the floor a project sits on
const floorLabel = proj => { const r = rowOf(proj); return r ? `${r.n}F ${r.label}` : proj; };
const blockedIn = r => Object.values(r.chars).some(c => c.blocked);
function select() {
  const floors = Object.values(state.floors).sort((a, b) => b.lastTs - a.lastTs);
  if (!ui.pinned) ui.floor = floors[0]?.proj ?? null;
  const projs = rowOf(ui.floor)?.projs || [ui.floor];
  const rooms = projs.flatMap(p => Object.values(state.floors[p]?.rooms || {})).sort((a, b) => b.lastTs - a.lastTs);
  if (!ui.pinned || !rooms.some(r => r.sid === ui.sid)) ui.sid = rooms[0]?.sid ?? null;
  const room = rooms.find(r => r.sid === ui.sid) || null;
  if (room) ui.floor = room.proj;
  return { floors, rooms, room };
}
function selectFloor(proj, how) {
  const row = rowOf(proj), from = floorKey(ui.floor);
  const live = (row?.projs || [proj]).filter(p => state.floors[p]).sort((a, b) => state.floors[b].lastTs - state.floors[a].lastTs);
  const changed = (row?.proj ?? proj) !== from || ui.overview;
  ui.pinned = true; ui.floor = live[0] || proj; ui.sid = null; ui.overview = false;
  if (changed && how !== 'auto') elevatorFx($('stage-box'), row ? `${row.n}F` : '');   // non-scrolling wrapper: covers the visible office, also when it scrolls sideways
  dirtyAll();
}
let tabSig = '';
function renderTabs({ rooms }) {
  const r = rowOf(ui.floor);
  const title = ui.overview ? '전체 보기' : r ? `${r.n}F · ${r.label}` : ui.floor || '—';
  if ($('floor-title').textContent !== title) $('floor-title').textContent = title;
  const fno = scene.querySelector('.flno'), nTxt = r ? String(r.n) : '-';
  if (fno.textContent !== nTxt) { scene.querySelector('.arr').textContent = r && Number(fno.textContent) > r.n ? '▼' : '▲'; fno.textContent = nTxt; }
  const sig = JSON.stringify([ui.pinned, ui.sid, ui.overview, rooms.map(x => [x.sid, blockedIn(x), x.ended])]);
  if (sig === tabSig) return;
  tabSig = sig;
  $('roomtabs').innerHTML = ui.overview ? '' : `<button type="button" class="slot" data-auto aria-pressed="${!ui.pinned}" title="가장 최근 활동 층/방을 따라가요">자동</button>` +
    rooms.map((x, i) => `<button type="button" class="slot${x.ended ? ' ended' : ''}" data-sid="${esc(x.sid)}" title="세션 ${esc(x.sid)} · ${esc(x.proj)}" aria-pressed="${x.sid === ui.sid}">
      <small>${i + 1}</small>${esc(x.sid.slice(0, 4))}${blockedIn(x) ? '<i class="dot-red"></i>' : ''}</button>`).join('');
}
$('roomtabs').onclick = ev => {
  const b = ev.target.closest('button'); if (!b) return;
  if (b.hasAttribute('data-auto')) ui.pinned = false; else { ui.pinned = true; ui.sid = b.dataset.sid; }
  dirtyAll();
};
const bld = mountBuilding($('building'), {
  onSelect: selectFloor,
  onAuto: () => { ui.pinned = false; ui.overview = false; dirtyAll(); },
  onOverview: () => { ui.overview = !ui.overview; if (ui.overview && pop.kind === 'q') closePop(); dirtyAll(); },
  onSettings: openEditor,
});
function renderBuilding(k, list) {
  const info = {}, now = Date.now(), rows = floorRows();
  for (const row of rows) if (row.proj) {
    let count = 0, bell = false, last = 0;
    for (const p of row.projs) {
      const f = state.floors[p]; if (!f) continue;
      last = Math.max(last, f.lastTs);
      for (const r of Object.values(f.rooms)) for (const c of Object.values(r.chars)) { if (c.leaveAt == null) count++; if (c.blocked) bell = true; }
    }
    info[row.proj] = { count, lit: now - last < 30000, bell };
  }
  for (const w of list) if (w.prio === HIGH) (info[floorKey(w.proj)] ||= {}).bell = true;
  const high = list.filter(w => w.prio === HIGH).length;
  bld.render({ rows, sel: floorKey(ui.floor), auto: !ui.pinned, overview: ui.overview, info, ceoWaiting: list.length,
    sign: { deleg: state.stats.delegated, comp: k.matchRate == null ? '—' : pct(k.matchRate), bell: high } });
}
function openEditor() {
  openFloorEditor({
    host: document.body, config: buildingConfig() || { floors: {}, ceo: '대표' }, projects: projSeen.slice(),
    fetchUnknown: () => fetch('/building.json').then(r => (r.ok ? r.json() : null)).then(b => b?.unknownKeys ?? b?.building?.unknownKeys ?? null).catch(() => null),
    fetchProjects: () => fetch('/projects.json').then(r => (r.ok ? r.json() : null)).catch(() => null),
    onApply: cfg => { memBuilding = cfg; dirtyAll(); },
    onSave: async cfg => {
      try {
        const r = await fetch('/building.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ floors: cfg.floors, ceo: cfg.ceo }) });
        if (r.ok) { serverBuilding = cfg; memBuilding = localBuilding = null; store.set('office.building', null); dirtyAll(); return null; }
      } catch { /* server without the endpoint */ }
      localBuilding = cfg; store.set('office.building', JSON.stringify(cfg)); dirtyAll();
      return '이 브라우저에만 저장했어요. 저장은 서버 업데이트 후 활성화돼요.';
    },
  });
}

// ---------------- scene geometry: one pixel world (world.js) at scale `S` ----------------
let S = 2;
const fitMQ = matchMedia('(min-width: 1181px) and (min-height: 640px)');
const worldCv = $('world'), fxCv = $('fx');
const toPx = v => Math.round(v * S);
function fit() {
  const wrap = $('scene-wrap'), aw = wrap.clientWidth;
  const ah = fitMQ.matches ? wrap.clientHeight - $('stage-h').offsetHeight - $('legend').offsetHeight - 22 : Infinity;
  let s = Math.min(aw / W, ah / H);
  if (narrowMQ.matches) s = Math.max(s, 1.25);
  s = Math.max(1, Math.floor(s * 8) / 8);
  if (s === S && scene.style.width) return false;
  S = s;
  stage.style.setProperty('--s', String(S));
  scene.style.width = `${W * S}px`; scene.style.height = `${H * S}px`;
  layoutOverlays();
  return true;
}
function place(el, x, y, w, h) {
  el.style.left = `${toPx(x)}px`; el.style.top = `${toPx(y)}px`;
  if (w != null) el.style.width = `${toPx(w)}px`;
  if (h != null) el.style.height = `${toPx(h)}px`;
}
const labelEls = {};
function buildLabels() {
  $('labels').innerHTML = Object.entries(ROOMS).filter(([, r]) => r.lx != null).map(([k, r]) =>
    `<span class="rlab" data-room="${k}"><i class="ico" style="--i:var(--ico-${r.icon})"></i>${r.label}<b class="count" hidden></b></span>`).join('');
  for (const el of $('labels').children) labelEls[el.dataset.room] = el;
}
function layoutOverlays() {
  for (const [k, el] of Object.entries(labelEls)) place(el, ROOMS[k].lx, ROOMS[k].ly);
  const e = ROOMS.elevator; place(scene.querySelector('.elevator'), e.x, e.y, e.w, e.h);
  place($('plate'), MAIN_SEAT.x + 14, 183); place($('deskctx'), 206, 172, 8, 5); place($('memo'), 231, 171);
  const ceo = $('ceo');
  if (narrowMQ.matches) ceo.removeAttribute('style');
  else { const c = ROOMS.ceo; place(ceo, c.x, c.y, c.w, c.h); }
}
const hashSlot = id => hash32(id) % 2;
// Name tag: 직무 별명 only (the lanyard color already carries the 직급); the full name is on hover / in the card.
const tagName = (c, sid) => (c.ceo ? displayName(c) : !c.aid ? mainTitle(mainFam(sid)) : `${jobOf(c.atype)} ${nickname(c.aid)}`);

// ---------------- seats: who sits where (stable while they stay in a room) ----------------
const seats = new SeatBook(Object.fromEntries(Object.entries(SEATS).map(([k, v]) => [k, v.length])), room => (room === 'floor' ? [0, 1, 2, 3, 4, 5] : []));
const releaseSeat = id => { if (seats.release(id)) sceneDirty = true; };   // a promoted stander walks to the freed seat on the next sync
const claimSeat = (id, room, c) => seats.claim(id, room, room === 'floor' && c.desk != null && c.desk < 6 ? { force: c.desk } : {});
function overflowSpot(room, k) {
  const r = ROOMS[room], d = r.door;
  if (room === 'floor') return { x: 330 + (k % 4) * 16, y: 238 - Math.floor(k / 4) * 4, kind: 'stand', alt: k % 2 };
  const side = k % 2 ? 1 : -1, step = Math.ceil((k + 1) / 2);
  const x = Math.max(r.x + 8, Math.min(r.x + r.w - 8, d.x + side * step * 14));
  return { x, y: d.inY - (d.outY === AISLE_TOP ? 2 : -6), kind: 'stand', alt: k % 2 };
}
const CEO_DOOR = { x: ROOMS.ceo.door.x, y: ROOMS.ceo.door.inY, kind: 'stand' };
/** Where a character wants to be for a render place: { room, x, y, kind, alt, key, vanish? } (world coords). */
function wantOf(c, place) {
  if (place === 'ceo-q') return { room: 'ceo', ...CEO_DOOR, key: 'ceo-q', vanish: true };
  // Leaving: walk to one of the 2 spots beside the shaft and step into the lift (hidden) at once — nobody idles there.
  if (place === 'elevator') { releaseSeat(c.id); const k = hashSlot(c.id); return { room: 'elevator', x: ELEVATOR_SPOT.x + k * 10, y: ELEVATOR_SPOT.y + k * 2, kind: 'stand', key: 'lift', vanish: 'lift' }; }
  if (place === 'desk' && !c.aid) { releaseSeat(c.id); return { room: 'main', ...MAIN_SEAT, key: 'main' }; }
  const room = place === 'desk' ? 'floor' : SEATS[place] ? place : 'floor';
  const s = claimSeat(c.id, room, c);
  const spot = s.i != null ? SEATS[room][s.i] : overflowSpot(room, s.over);
  return { room, ...spot, key: s.i != null ? `${room}:${s.i}` : `${room}:o${s.over}` };
}
const transitSpot = room => {
  const r = ROOMS[room];
  if (!r?.door) return null;
  return { room, x: r.door.x, y: r.door.inY + (r.door.outY === AISLE_TOP ? -4 : 10), kind: 'stand' };
};

// ---------------- characters ----------------
const sprites = new Map();
let spriteSid = null;
function clearSprites(keepSid) {
  for (const [k, sp] of sprites) if (!(sp.special && keepSid && sp.forSid === keepSid)) { sp.el.remove(); sprites.delete(k); releaseSeat(k); }
  spriteSid = null; seats.reset();
}
function makeSprite(c, start) {
  const el = document.createElement('div');
  el.className = 'char';
  el.dataset.id = c.id;
  el.innerHTML = `<div class="above"><span class="badge b-block">승인 대기</span><span class="badge b-stuck">1분+</span><div class="bubble"></div></div>
    <canvas width="24" height="32"></canvas><div class="stamp"></div><div class="mis" title="의도한 모델과 실제 모델이 달라요">✗</div>
    <div class="tag"><i class="obs"></i><span class="nm"></span><i class="pips"></i></div>`;
  spritesEl.append(el);
  const sp = { key: c.id, el, c, cv: el.querySelector('canvas'), queue: [], route: [], leg: null, at: null, want: null, seen: 0, dwell: 0, gone: false, fading: false,
    walking: false, left: false, bubble: el.querySelector('.bubble'), pips: el.querySelector('.pips'), stamp: el.querySelector('.stamp'), obs: el.querySelector('.obs'),
    nm: el.querySelector('.nm'), wx: 0, wy: 0, sig: '', mis: false, talk: true, place: c.room, look: lookOf(c), inCeo: false, bowUntil: 0, cls: '' };
  const fresh = !start && c.aid && c.visits[0]?.room === 'elevator' && state.now - c.enteredAt < 15000 && !reducedMotion.matches;
  if (start) { sp.wx = start.x; sp.wy = start.y; sp.at = start; }
  else if (fresh) { sp.wx = ELEVATOR_SPOT.x; sp.wy = ELEVATOR_SPOT.y; sp.at = { room: 'elevator', ...ELEVATOR_SPOT, kind: 'stand' }; sp.atKey = 'elevator'; }
  else sp.snap = true;
  sp.seen = fresh ? c.visits[0].seq : (c.visits?.at(-1)?.seq ?? 0);
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
function bubbleText(c, sp) {
  if (sp.place === 'ceo-q') return '';
  if (c.blocked) return c.target ? `승인? ${head(c)}` : '승인 기다리는 중';
  if (c.label) return c.label;
  if (c.act === 'thinking') return '';
  if (['idle', 'leaving', 'arriving'].includes(c.act)) return '';
  return head(c);
}
function applyClass(sp) {
  const c = sp.c, m = c.ceo ? 'unknown' : !c.aid ? (mainFam(spriteSid) || 'unknown') : MODELS.includes(c.model) ? c.model : 'unknown';
  const kind = !sp.walking && sp.at ? sp.at.kind : 'walk';
  const cls = ['char', `m-${m}`, `act-${c.act}`, c.ceo ? 'boss' : c.aid ? 'sub' : 'main', `k-${kind}`, !sp.walking && sp.at?.tb && 'tb', sp.wx < 34 && 'edge-l', sp.wx > W - 34 && 'edge-r', !sp.walking && sp.at?.alt && 'alt',
    c.blocked && 'blocked', c.stuck && 'stuck', c.obs === 'stale' && 'stale', c.verdict && `v-${c.verdict}`, sp.mis && 'mismatch',
    sp.walking && 'walking', sp.left && 'face-left', (sp.fading || sp.inCeo) && 'gone'].filter(Boolean).join(' ');
  if (cls !== sp.cls) { sp.cls = cls; sp.el.className = cls; }
}
const pipsHTML = effort => (EFFORT[effort] ? [1, 2, 3, 4].map(i => `<i class="${i <= EFFORT[effort] ? 'on' : ''}"></i>`).join('') : '');
let lastList = [], queueKeys = new Set();     // merged 대표실 list (ceo.js queue + relay items), refreshed every frame
function placeOf(c, sid, room) {
  if (queueKeys.has(`${sid}|${c.aid || 'main'}`)) return 'ceo-q';
  if (c.act === 'idle' && c.dozing && c.leaveAt == null) return 'pantry';
  // a subagent that just arrived joins the briefing when the 실장 is in the meeting room, else goes to its desk
  if (c.aid && c.act === 'arriving' && c.room === 'elevator') return room?.chars.main?.room === 'meeting' ? 'meeting' : 'desk';
  return c.room;
}

const busy = {};
function syncScene(room) {
  if ((room?.sid ?? null) !== spriteSid) { clearSprites(room?.sid); spriteSid = room?.sid ?? null; }
  const any = Object.keys(state.floors).length > 0;
  $('empty').hidden = !!room || ui.overview;
  $('empty').textContent = any ? '이 층은 오늘 아직 조용해요. 다른 층을 눌러 보세요.' : '빈 사무실이에요. 오늘 기록된 이벤트가 아직 없어요.';
  const chars = room ? Object.values(room.chars).map(c => settle(c, room.sid)).sort((a, b) => (a.aid ? 1 : 0) - (b.aid ? 1 : 0) || (a.enteredAt - b.enteredAt) || (a.id < b.id ? -1 : 1)) : [];
  const places = new Map(), newest = {};
  for (const c of chars) places.set(c.id, placeOf(c, room.sid, room));
  const keyOf = c => { const p = places.get(c.id); return p === 'desk' ? `desk:${c.id}` : p; };
  for (const c of chars) { const k = keyOf(c); if (!newest[k] || c.lastTs >= newest[k].lastTs) newest[k] = c; }
  const mism = new Set(compliance(state).rows.filter(r => r.match === 'no' && r.child).map(r => r.child));
  const now = performance.now();
  for (const c of chars) {
    const sp = sprites.get(c.id) || makeSprite(c);
    sp.c = c; sp.gone = false; sp.look = lookOf(c);
    const k = keyOf(c), pl = places.get(c.id);
    if (sp.place === 'ceo-q' && pl !== 'ceo-q') {
      sp.inCeo = false;
      const b = bows.get(`${room.sid}|${c.aid || 'main'}`);
      if (b && !reducedMotion.matches) sp.bowUntil = now + 450;
    }
    sp.place = pl;
    sp.want = wantOf(c, pl);
    for (const v of c.visits) if (v.seq > sp.seen) { sp.queue.push({ room: v.room }); sp.seen = v.seq; }
    if (sp.queue.length > 2) sp.queue.splice(0, sp.queue.length - 2);
    if (pl === 'ceo-q') sp.queue.length = 0;                       // straight to 대표실
    sp.talk = newest[k] === c || c.blocked;
    sp.mis = mism.has(c.id);
    const fam = c.aid ? c.model : mainFam(room.sid);
    const sig = [fam, c.act, c.blocked, c.stuck, c.obs, c.verdict, c.target, c.effort, c.atype, c.desk, c.label, sp.talk, sp.mis, pl].join('|');
    if (sig !== sp.sig) {
      sp.sig = sig;
      sp.bubble.textContent = sp.talk ? bubbleText(c, sp) : '';
      sp.pips.innerHTML = pipsHTML(c.effort);
      sp.stamp.textContent = c.verdict ? VERDICT_KO[c.verdict] || c.verdict : '';
      sp.obs.className = `obs ${c.obs}`;
      sp.nm.textContent = tagName(c, room.sid); sp.nm.title = displayName(view(c, room.sid));
      applyClass(sp);
    }
  }
  for (const sp of sprites.values()) if (!sp.special && !room?.chars[sp.key] && !sp.gone) {
    sp.gone = true; releaseSeat(sp.key);
    // Removed by the reducer. Already inside the lift: just drop the sprite. Otherwise walk to the shaft and vanish.
    // (Bug fixed: the exit target used the same key as the leaving spot, so a leaver standing there never got a
    //  new leg and stayed beside the shaft forever — the elevator crowd.)
    if (sp.inCeo && sp.want?.vanish === 'lift') { sp.fading = true; sp.el.remove(); sprites.delete(sp.key); continue; }
    sp.inCeo = false;
    sp.want = { room: 'elevator', x: ELEVATOR_SPOT.x + hashSlot(sp.key) * 10, y: ELEVATOR_SPOT.y + hashSlot(sp.key) * 2, kind: 'stand', key: 'lift-exit', exit: true };
  }
  for (const k of Object.keys(busy)) delete busy[k];
  for (const c of chars) { const p = places.get(c.id); if (p !== 'desk' && p !== 'elevator' && p !== 'ceo-q') busy[p] = (busy[p] || 0) + 1; }
  for (const [name, el] of Object.entries(labelEls)) {
    const v = busy[name] ? String(busy[name]) : '', cnt = el.querySelector('.count');
    if (cnt.textContent !== v) cnt.textContent = v;
    cnt.hidden = !v; el.classList.toggle('busy', !!v);
  }
  const liftOpen = chars.some(c => c.act === 'arriving' || c.act === 'leaving') || [...sprites.values()].some(sp => sp.gone && !sp.fading && !sp.special);
  scene.querySelector('.elevator').classList.toggle('open', liftOpen);
  fxDirty = true;
}

// The 대표 walks from 대표실 to the 실장 desk, leaves the 지시서 and goes back (< 3s). Skipped under reduced motion.
function ceoVisit(sid) {
  if (reducedMotion.matches || ui.overview || narrowMQ.matches || sprites.has('__ceo')) { if (!ui.overview) dropMemo(); return; }
  const c = { id: '__ceo', ceo: true, aid: null, model: 'unknown', act: 'arriving', room: '__door', visits: [] };
  const sp = makeSprite(c, { room: 'ceo', ...CEO_DOOR });
  Object.assign(sp, { special: true, forSid: sid, fast: true,
    queue: [{ room: 'drop', spot: { room: 'drop', ...DROP_SPOT, kind: 'stand' }, onArrive: dropMemo }, { room: 'ceo', spot: { room: 'ceo', ...CEO_DOOR }, exit: true }] });
  sp.gone = true;
  sp.nm.textContent = buildingConfig()?.ceo || '대표'; sp.bubble.textContent = '지시서예요';
  applyClass(sp);
  $('ceo').classList.add('away');
  setTimeout(() => $('ceo').classList.remove('away'), 3200);
}
function dropMemo() { const m = $('memo'); m.classList.remove('show'); void m.offsetWidth; m.classList.add('show'); }

// Movement: constant-speed walk along the aisle polyline (world.js route), then sit down on arrival.
function startLeg(sp, leg) {
  const to = leg.spot;
  sp.inCeo = false;                                     // stepping out of the 대표실 line or the lift: visible again
  const fromChain = !sp.walking && sp.at && Math.abs(sp.at.x - sp.wx) < 1 && Math.abs(sp.at.y - sp.wy) < 1 ? chainOf(sp.at.room, sp.at) : null;
  sp.route = route({ x: sp.wx, y: sp.wy }, fromChain, to.room, to);
  sp.leg = leg;
  if (reducedMotion.matches) { sp.wx = to.x; sp.wy = to.y; sp.route = []; }
}
function arrive(sp, now) {
  const leg = sp.leg; sp.leg = null; sp.walking = false;
  leg.onArrive?.();
  sp.at = leg.spot;
  sp.atKey = leg.final ? leg.spot.key : null;
  if (leg.exit) { sp.fading = true; applyClass(sp); setTimeout(() => { sp.el.remove(); if (sprites.get(sp.key) === sp) sprites.delete(sp.key); }, reducedMotion.matches ? 0 : 450); return; }
  if (leg.spot.vanish) sp.inCeo = true;
  if (!leg.final) sp.dwell = reducedMotion.matches ? 0 : now + (sp.fast ? 300 : 420);
}
let lastMove = 0;
function move(now) {
  const dt = Math.min(50, Math.max(0, now - (lastMove || now))); lastMove = now;
  let active = false;
  for (const sp of sprites.values()) {
    if (sp.fading) continue;
    if (sp.snap && sp.want) { sp.snap = false; sp.wx = sp.want.x; sp.wy = sp.want.y; sp.at = sp.want; sp.atKey = sp.want.key; if (sp.want.vanish) sp.inCeo = true; }
    if (sp.dwell > now || sp.bowUntil > now) { active = true; position(sp); continue; }
    if (!sp.leg) {
      let leg = null;
      while (!leg && sp.queue.length) {
        const q = sp.queue.shift();
        if (q.spot) leg = q;
        else if (q.room !== sp.want?.room && q.room !== sp.place && q.room !== 'desk') { const t = transitSpot(q.room); if (t) leg = { room: q.room, spot: t }; }
      }
      if (!leg && sp.want && sp.atKey !== sp.want.key) leg = { room: sp.want.room, spot: sp.want, final: true, exit: sp.want.exit };
      if (!leg && sp.gone && sp.special) leg = { room: 'ceo', spot: { room: 'ceo', ...CEO_DOOR }, exit: true };
      if (leg) startLeg(sp, leg);
    } else if (sp.leg.final && sp.want && sp.leg.spot.key !== sp.want.key) startLeg(sp, { room: sp.want.room, spot: sp.want, final: true, exit: sp.want.exit });
    if (sp.leg) {
      const wasLeft = sp.left;
      let v = (sp.fast ? 0.26 : sp.look === 'intern' ? 0.22 : 0.16) * dt;
      while (v > 0 && sp.route.length) {
        const q = sp.route[0], dx = q.x - sp.wx, dy = q.y - sp.wy, d = Math.hypot(dx, dy);
        if (Math.abs(dx) > 0.5) sp.left = dx < 0;
        if (d <= v) { sp.wx = q.x; sp.wy = q.y; sp.route.shift(); v -= d; } else { sp.wx += (dx / d) * v; sp.wy += (dy / d) * v; v = 0; }
      }
      if (!sp.route.length) arrive(sp, now);
      else { sp.walking = true; active = true; }
      if (wasLeft !== sp.left) applyClass(sp);
    }
    if (!sp.fading) applyClass(sp);
    position(sp);
  }
  return active;
}
function position(sp) {
  const tf = `translate3d(${Math.round((sp.wx - 12) * S)}px, ${Math.round((sp.wy - 32) * S)}px, 0)`;
  if (sp._tf !== tf) { sp._tf = tf; sp.el.style.transform = tf; }
  const z = String(sp.c.ceo ? 9999 : Math.round(sp.wy) + (sp.walking ? 1 : 0));
  if (sp._z !== z) { sp._z = z; sp.el.style.zIndex = z; }
}
// Sprite frames: what each character is doing, drawn as a pose + seat + prop + status overlay.
// Under reduced motion every frame is static (anim 0), so the 120ms animation loop stops.
function specOf(sp, now) { const s = specFrame(sp, now); if (reducedMotion.matches) { s.anim = 0; s.frame = 0; } return s; }
function specFrame(sp, now) {
  const c = sp.c, L = sp.look, rm = reducedMotion.matches;
  const f2 = ms => (rm ? 0 : Math.floor(now / ms) % 2);
  if (sp.bowUntil > now) return { pose: 'bow' };
  if (sp.walking) return { pose: 'walk', frame: rm ? 0 : Math.floor(now / (L === 'intern' ? 85 : 125)) % 4, anim: 1,
    prop: c.ceo ? 'envelope' : sp.place === 'ceo-q' ? 'clipboard' : CARRY[L] || null };
  if (c.ceo) return { pose: 'stand', prop: 'envelope' };
  const kind = sp.at?.kind || 'stand';
  const fx = c.flash ? 'bolt' : c.stuck ? 'sweat' : c.dozing ? 'zz' : c.act === 'thinking' ? 'cloud' : null;
  let pose = 'stand', prop = null, anim = 0, frame = 0;
  if (c.flash) pose = 'sit';
  else if (c.blocked) { pose = 'hand'; prop = 'clipboard'; }
  else switch (c.act) {
    case 'writing':
      if (L === 'clerk' || L === 'staff') { pose = 'read'; prop = 'notebook'; frame = f2(420); anim = 1; }
      else if (L === 'plan') { pose = 'hand'; prop = 'marker'; }
      else { pose = 'type'; prop = 'laptop'; frame = f2(240); anim = 1; }
      break;
    case 'reading': pose = 'read'; prop = 'book'; frame = f2(650); anim = 1; break;
    case 'reviewing': pose = 'read'; prop = f2(900) ? 'stamp' : 'magnifier'; anim = 1; break;
    case 'running': pose = 'type'; prop = L === 'ops' ? 'wrench' : 'laptop'; frame = f2(300); anim = 1; break;
    case 'delegating': prop = L === 'fable' ? 'megaphone' : 'clipboard'; break;
    case 'external': prop = L === 'field' ? 'umbrella' : 'phone'; break;
    case 'idle': prop = 'mug'; break;
    default: prop = L === 'fable' ? 'clipboard' : c.act === 'thinking' ? null : CARRY[L] || null;
  }
  if (kind === 'desk') {
    if (pose === 'stand') pose = 'sit';
    if (prop === 'umbrella' || prop === 'books') prop = prop === 'books' ? 'book' : null;
    return { pose, seat: 'desk', prop, frame, anim, fx };
  }
  if (kind === 'back' || kind === 'standback') return { pose: pose === 'hand' ? 'hand' : anim ? 'type' : 'stand', seat: kind, frame, anim, fx };
  if (kind === 'sofa') return { pose: c.flash ? 'sit' : 'sit', prop: prop === 'laptop' ? 'laptop' : prop, frame, anim, fx };
  return { pose, prop, frame, anim, fx };
}
let fxDirty = true, fxAt = 0;
const ambient = new Ambient({ force: new URLSearchParams(location.search).get('fx') || '' });   // ?fx=star,couple forces them (testing)
function animate(now) {
  let anim = false;
  for (const sp of sprites.values()) {
    const s = specOf(sp, now);
    if (s.anim) anim = true;
    const m = sp.c.ceo ? null : !sp.c.aid ? (mainFam(spriteSid) || 'unknown') : MODELS.includes(sp.c.model) ? sp.c.model : 'unknown';
    paint(sp.cv, { look: sp.look, model: m, ...s });
  }
  const f = reducedMotion.matches ? 0 : Math.floor(now / 1600) % 2;
  paint($('boss'), { look: 'ceo', model: null, view: 'side', pose: 'sit', seat: 'exec', empty: $('ceo').classList.contains('away'), frame: f });
  for (const fg of figs.values()) paint(fg.cv, fg.spec);
  const night = ambient.step(now, { sky: skyNow(), reduced: reducedMotion.matches });     // shooting stars, park couples
  if (fxDirty || night || ambient.was || (!reducedMotion.matches && now - fxAt > 240)) {
    fxDirty = false; fxAt = now; ambient.was = night;
    const taken = new Set();
    for (const [key, id] of seats.keys()) { const sp = sprites.get(id); if (sp && !sp.walking && sp.atKey === key) taken.add(key); }
    drawFx(fxCv, { t: now, dark: isDark(), sky: skyNow(), taken, busy, still: reducedMotion.matches });
    drawAmbient(fxCv, ambient, now);
  }
  if (night) kick();                                                                    // smooth while something crosses the sky
  return anim || !reducedMotion.matches;
}

// ---------------- 대표실 (fixed corner room, all floors) ----------------
const figs = new Map();
let ceoKnown = null;   // queue keys at the previous live render; null until the first one (reload/replay: nobody knocks)
/** A newcomer has knocked: walk from the door to the current spot (unless already sent back). */
function endKnock(f) {
  f.knock = false; f.el.classList.remove('knock');
  if (f.leaving) return;
  f.el.classList.add('entering'); f.el.style.setProperty('--qr', String(f.r));
  f.spec = { ...f.spec, pose: f.q.prio === HIGH ? 'hand' : 'stand' };
  setTimeout(() => f.el.classList.remove('entering'), CEO_KNOCK.walk);
}
const charOf = aid => { for (const f of Object.values(state.floors)) for (const r of Object.values(f.rooms)) if (r.chars[aid]) return r.chars[aid]; return null; };
function whoOf(q) {
  const c = q.aid ? charOf(q.aid) : null;
  const model = q.aid ? c?.model || state.agentModel[q.aid] || 'unknown' : mainFam(q.sid) || 'unknown';
  return { aid: q.aid, atype: q.atype || c?.atype, model };
}
// ---------------- 돌려보내기: send waiting characters back without a decision ----------------
const RELEASE_BTN = '<button type="button" class="chipbtn ghost" data-a="release" title="결정 없이 돌려보내요. 질문·승인은 터미널에서 계속 받을 수 있어요">돌려보내기</button>';
const dismissed = new DismissStore((() => { try { return sessionStorage; } catch { return null; } })());
/** Relay items: POST /relay/release (no decision -> the terminal prompt takes over). Every entry: dismiss this
 *  occurrence (persisted per tab so a reload keeps it gone; a later wait is a new occurrence), bow, walk back. */
async function sendBack(list) {
  const plan = releasePlan(list);
  await Promise.all(plan.map(p => (p.relayId ? releaseRelay(list.find(q => q.key === p.key).relay, SIM) : null)));
  for (const p of plan) dismissed.add(p.dkey);
  const keys = plan.map(p => p.key);
  for (const k of keys) ceoResolve(waiting, k);
  resolveLocal(null, keys);
  sceneDirty = bldDirty = true; kick();
}
$('ceo-all').addEventListener('click', async () => {
  const n = lastList.length;
  if (n < 2 || !confirm(`대표실에서 기다리는 ${n}명을 모두 결정 없이 돌려보낼까요?\n질문·승인은 터미널에서 계속 받을 수 있어요.`)) return;
  await sendBack(lastList.slice());
  toast(`${n}명을 돌려보냈어요`);
});

function renderCeo(list) {
  $('ceo-all').hidden = list.length < 2;
  const high = list.filter(q => q.prio === HIGH).length;
  $('ceo-n').textContent = `대기 ${list.length}`;
  $('ceo-bell').hidden = !high; $('ceo-bell').querySelector('b').textContent = high;
  $('ceo').classList.toggle('ringing', high > 0);
  const line = $('ceo-line'), keys = new Set(), now = performance.now();
  // Queue spots in front of the desk on the door side (ceo.js CEO_PLAN); everyone faces right, toward the 대표.
  const cs = parseFloat(getComputedStyle($('ceo')).getPropertyValue('--s')) || S, roomW = (line.clientWidth || 268) / cs;
  // Adaptive grouping (ceo.js ceoGroupPlan): everyone stands individually while the line fits; only when it would
  // overflow, each session becomes one figure (its highest-priority member, ×N badge). +N then counts groups.
  const seats = ceoSpots(99, roomW).length, plan = ceoGroupPlan(list, seats);
  // +N is a real button (≥ 34×32 px) by the door, a few units clear of the last figure (ceo.js ceoMore).
  const lay = ceoMore(plan.figures.length, roomW, Math.ceil(36 / cs), 3), spots = lay.spots, cap = spots.length;
  plan.figures.slice(0, cap).forEach((g, i) => {
    const q = g.rep;
    keys.add(g.key);
    let f = figs.get(g.key);
    if (!f) {
      const el = document.createElement('button');
      el.type = 'button'; el.className = 'qf';
      el.innerHTML = '<span class="qb"></span><span class="qk" aria-hidden="true">똑똑</span><canvas width="24" height="32"></canvas><span class="qn"></span><span class="qx" hidden></span>';
      // Newcomers stop at the door, knock ("똑똑"), then walk to their spot (ceo.js groupEntry/ceoEntry; never on
      // reload/replay; people already waiting who only regroup, or join an existing group, never knock again).
      const entry = groupEntry(g, { known: ceoKnown, sameFloor: g.sid === ui.sid, reduced: reducedMotion.matches });
      if (entry.anim) el.classList.add(entry.anim);
      line.append(el);
      f = { el, cv: el.querySelector('canvas'), q, knock: entry.knock, n: g.n };
      figs.set(g.key, f);
      if (entry.knock) {
        // at the door (kept fully inside the room); a second simultaneous newcomer waits a step behind
        f.door = Math.min(CEO_PLAN.door, roomW - 14) - 14 * [...figs.values()].filter(h => h.knock && h !== f).length;
        el.classList.add('knock');
        const ff = f; setTimeout(() => endKnock(ff), CEO_KNOCK.ms);
        if (ui.sound) setTimeout(knockSound, CEO_KNOCK.bubbleAt);
      }
    } else if (g.n > f.n && ceoKnown && !reducedMotion.matches) {   // someone joined this group: pulse the badge once
      const x = f.el.querySelector('.qx'); x.classList.remove('pulse'); void x.offsetWidth; x.classList.add('pulse');
      setTimeout(() => x.classList.remove('pulse'), 700);
    }
    f.n = g.n; f.members = g.members.map(m => m.key);
    const w = whoOf(q), sp = spots[i];
    f.q = q; f.r = sp.r; f.el.classList.toggle('front', i === 0);
    f.el.dataset.key = g.n === 1 ? q.key : ''; f.el.dataset.group = g.n > 1 ? g.sid : '';
    f.el.style.setProperty('--qr', String(f.knock ? f.door : sp.r)); f.el.dataset.face = sp.face;
    f.el.classList.toggle('hi', g.high); f.el.classList.toggle('lo', !g.high); f.el.classList.toggle('can', g.members.some(m => m.relay?.status === 'pending'));
    const txt = q.text.length > 18 ? `${q.text.slice(0, 17)}…` : q.text;
    const qb = f.el.querySelector('.qb'); if (qb.textContent !== txt) qb.textContent = txt;
    const nm = displayName(w), fn = rowOf(q.proj)?.n, short = `${fn ? `${fn}F ` : ''}${q.aid ? nickname(q.aid) : '실장'}`;
    const qn = f.el.querySelector('.qn'); if (qn.textContent !== short) qn.textContent = short;
    const qx = f.el.querySelector('.qx'); qx.hidden = g.n < 2; qx.textContent = `×${g.n}`; qx.classList.toggle('hot', g.high);
    const tip = g.n > 1 ? `세션 ${g.sid.slice(0, 4)} · ${groupTip(g)}` : '';
    if (g.n > 1) { f.el.title = tip; f.el.setAttribute('aria-label', `${nm} 외 ${g.n - 1}건 (${tip}) · 목록 보기`); f.el.setAttribute('aria-haspopup', 'dialog'); }
    else { f.el.removeAttribute('title'); f.el.setAttribute('aria-label', `${nm}: ${q.text}`); f.el.removeAttribute('aria-haspopup'); }
    f.spec = { look: lookOf(w), model: MODELS.includes(w.model) ? w.model : 'unknown', view: 'side', pose: f.knock || g.high ? 'hand' : 'stand', prop: 'clipboard' };
  });
  ceoKnown = ui.live ? new Set(list.map(q => q.key)) : null;
  const waitingNow = new Set(list.map(q => q.key));
  for (const [k, f] of figs) if (!keys.has(k) && !f.leaving) {
    // Only someone who actually left the line bows out. A figure whose people are still waiting (regrouped, or moved
    // behind +N) is replaced in place without a bow.
    if ((f.members || [f.q?.key]).some(m => waitingNow.has(m))) { f.el.remove(); figs.delete(k); continue; }
    f.leaving = now; f.spec = { ...f.spec, pose: 'bow', prop: null }; f.el.classList.add('bye');
    setTimeout(() => { f.el.remove(); figs.delete(k); }, reducedMotion.matches ? 0 : 480);
  }
  let more = line.querySelector('.qmore');
  if (lay.more) {
    if (!more) { more = document.createElement('button'); more.type = 'button'; more.className = 'qmore'; more.setAttribute('aria-haspopup', 'dialog'); line.append(more); }
    const unit = plan.grouped ? '팀' : '명';
    more.textContent = `+${lay.more}`; more.title = `대기 ${lay.more}${unit} 더 · 목록 보기`; more.setAttribute('aria-label', `대기 ${lay.more}${unit} 더 · 대표실 목록 보기`);
    more.style.setProperty('--qr', String(lay.r));
  } else more?.remove();
  $('needs').hidden = !high; $('needs').querySelector('b').textContent = high;
  if (high > lastHigh && ui.sound && ui.live) chime();
  lastHigh = high;
}
/** The 대표실 figure standing for an entry (itself, or its session group). */
const figFor = (key, sid = null) => (key && figs.get(key)) || [...figs.values()].find(f => !f.leaving && key && f.members?.includes(key))
  || (sid ? [...figs.values()].find(f => !f.leaving && f.el.dataset.group === sid) : null);
const togglePop = (kind, key, el) => { if (pop.pinned && pop.kind === kind && pop.key === key) closePop(); else openPop(kind, key, el, true); };
$('ceo-line').addEventListener('click', ev => {
  if (ev.target.closest('.qmore')) { closePop(); openList(ev.target.closest('.qmore')); return; }
  const b = ev.target.closest('.qf'); if (!b) return;
  if (b.dataset.group) { closePop(); openList(b, { sid: b.dataset.group }); return; }   // a session group: its list
  if (b.dataset.key) togglePop('q', b.dataset.key, b);
});
// Hover (mouse, wide): HoverHold decides — a short rest on another person is needed to switch cards, so crossing
// someone on the way to the open card never swaps it. Touch / narrow: open at once as before.
$('ceo-line').addEventListener('pointerover', ev => {
  const b = ev.target.closest('.qf'); if (!b || pop.pinned || !b.dataset.key) return;   // groups: title tooltip, no card
  const key = b.dataset.key;
  if (holdable(ev)) hover.over(`q:${key}`, () => { const el = [...$('ceo-line').querySelectorAll('.qf')].find(x => x.dataset.key === key); if (el) openPop('q', key, el, false); });
  else openPop('q', key, b, false);
});
// Narrow screens: opening the 대표실 banner jumps straight to the first request that needs an answer (2 taps to approve).
function openFirstCard() {
  if (!narrowMQ.matches) return;
  const q = lastList.find(x => x.relay?.status === 'pending') || lastList.find(x => x.prio === HIGH) || lastList[0];
  const f = q && figFor(q.key);
  if (f) requestAnimationFrame(() => openPop('q', q.key, f.el, true));
}
$('ceo-h').onclick = () => { const o = $('ceo').classList.toggle('open'); $('ceo-h').setAttribute('aria-expanded', String(o)); if (o) openFirstCard(); else closePop(); };
$('needs').onclick = () => {
  if (ui.overview) { openList($('needs')); return; }     // 전체 보기 hides the 대표실 corner: show the list instead
  $('ceo').classList.add('open', 'flash'); $('ceo-h').setAttribute('aria-expanded', 'true'); openFirstCard(); $('ceo').scrollIntoView({ block: 'nearest' }); setTimeout(() => $('ceo').classList.remove('flash'), 900); };

// ---------------- popover card: character or 대표실 request ----------------
const pop = { kind: null, key: null, pinned: false, anchor: null };
function openPop(kind, key, anchorEl, pinned) { Object.assign(pop, { kind, key, pinned, anchor: anchorEl }); renderPop(); }
function closePop() { pop.kind = null; pop.pinned = false; $('pop').hidden = true; hover.reset(); }
// Hover cards (mouse, wide screens): the card stays open while the pointer is on the character or on the card; leaving
// either gives ~300ms to cross over, so 승인/거절 work on the first click without pinning. Touch/narrow: unchanged.
const hover = new HoverHold(() => { if (!pop.pinned) closePop(); });
const holdable = ev => ev.pointerType === 'mouse' && !narrowMQ.matches;
/** The pointer left a hover anchor (character or 대표실 figure). */
function anchorOut(ev, key) { if (pop.pinned) return; if (holdable(ev)) hover.out(key); else closePop(); }
let liveSince = 0, repBody = '';
const EST_TAG = '<span class="est" title="보고 끝부분의 질문·결정 문구로 추정했어요 (관측 아님)">추정</span>';
const READ_BTN = '<button type="button" class="chipbtn" data-a="read" aria-haspopup="dialog" title="이 카드를 오른쪽에 크게 열어요">크게 보기</button>';
const COPYALL_BTN = '<button type="button" class="chipbtn" data-a="copyall">전체 복사</button>';
const FOCUS_BTN = '<button type="button" class="chipbtn primary" data-a="focus">터미널로</button>';
const prioKo = q => (q.prio === HIGH ? '답이 필요해요' : q.kind === 'idle' ? '대기 중' : q.asks ? '결정 대기' : '보고');
/** One card's parts, shared by the small popover card and the 크게 보기 drawer (same markup, same handlers).
 *  kind 'q' = 대표실 entry (key = queue key), 'c' = character (key = sprite key, sid = that room's session).
 *  -> { q?, c?, sid, since, body, head (header + meta), main (small-card middle), btns (bottom row), note } | null */
function cardParts(kind, key, sid) {
  if (kind === 'q') {
    const q = lastList.find(x => x.key === key);
    if (!q) return null;
    const w = whoOf(q), body = q.kind === 'report' && typeof q.body === 'string' ? q.body : '';
    const top = `<header><b>${esc(displayName(w))}</b><span class="tags">${q.asks ? EST_TAG : ''}<span class="prio ${q.prio}">${prioKo(q)}</span></span></header>
      <dl><dt>층</dt><dd>${esc(floorLabel(q.proj))}${rowOf(q.proj)?.label !== q.proj ? ` <small>${esc(q.proj)}</small>` : ''}</dd>
      <dt>세션</dt><dd class="mono">${esc(q.sid.slice(0, 4))}</dd><dt>기다린 시간</dt><dd class="live-wait"></dd></dl>`;
    const note = q.relay || q.kind === 'report' ? '' : `<p class="rl-left">${q.kind === 'idle' ? idleNote : whyHTML(q)}</p>`;
    // A report that asks: with an instruct relay item (hooks/ceo-stop.sh) the card can send the next instruction;
    // without one, say so honestly instead of showing a box that cannot send anything.
    const insOff = q.kind === 'report' && q.asks && q.relay?.item?.kind !== 'instruct'
      ? `<p class="rl-left ins-off">${esc(instructOff(q, relayState))}</p>` : '';
    const main = q.kind === 'report' ? `${reportHTML(body)}${q.relay ? relayHTML(q.relay) : insOff}` : q.relay ? relayHTML(q.relay) : `<p class="ask">${esc(q.text)}</p>${note}`;
    const btns = `${RELEASE_BTN}${READ_BTN}${q.kind === 'report' ? '' : '<button type="button" class="chipbtn" data-a="copy">복사</button>'}${FOCUS_BTN}`;
    return { q, sid: q.sid, since: q.since, body, head: top, main, btns, note, insOff };
  }
  const sp = sprites.get(key), c = sp?.c && view(sp.c, sid);
  if (!c || c.ceo) return null;
  const job = jobOf(c.atype), since = c.phase === 'tool' && c.toolSince ? c.toolSince : c.lastTs, body = typeof c.msg === 'string' ? c.msg : '';
  const v = c.aid ? (c.verdict || state.verdicts[c.aid]?.v) : null;
  const mine = !c.aid ? state.deleg.filter(d => d.sid === sid && (d.verdict || state.verdicts[d.child]?.v)).map(d => d.verdict || state.verdicts[d.child].v) : [];
  const vs = c.aid ? (v ? `<span class="vstamp ${v}">${VERDICT_KO[v]}</span> ${esc(state.verdicts[c.aid]?.note || '')}` : '판정 전')
    : mine.length ? ['ok', 'rework', 'fail'].map(x => `${VERDICT_KO[x]} ${mine.filter(m => m === x).length}`).join(' · ') : '아직 없음';
  const top = `<header><b>${esc(displayName(c))}</b><span class="mbadge" style="${mstyle(c.model)}">${esc(c.model)}</span></header>
      <dl><dt>직급</dt><dd>${c.aid ? rankOf(c.model) : '실장'}</dd><dt>직무</dt><dd>${c.aid ? `${JOB_LONG[job]} <small>${esc(c.atype)}</small>` : '실장 (메인 세션)'}</dd>
      <dt>모델</dt><dd>${c.model === 'unknown' && !c.aid ? '아직 모름 <small>(사용량 기록 대기)</small>' : esc(c.model)}</dd><dt>effort</dt><dd>${esc(c.effort || '—')} ${pipsSpan(c.effort, c.model)}</dd>
      <dt>현재 일</dt><dd>${esc(c.label || ACT_KO[c.act] || c.act)}${c.target ? ` · ${esc(head(c))}` : ''}</dd>
      <dt>경과</dt><dd class="live-elapsed"></dd><dt>오늘 건수</dt><dd>도구 ${counts.get(`${sid}|${c.aid || 'main'}`) || 0}건</dd>
      <dt>판정</dt><dd>${vs}</dd><dt>상태</dt><dd>${OBS_KO[c.obs]}${c.failCount ? ` · 실패 ${c.failCount}` : ''}</dd></dl>`;
  const queued = queueKeys.has(`${sid}|${c.aid || 'main'}`);
  const note = queued ? '<p class="rl-left">대표실에서 기다리는 중이에요</p>' : '';
  return { c, sid, since: null, body, head: top, main: `${body ? reportHTML(body, '마지막 보고') : ''}${note}`, btns: `${queued ? RELEASE_BTN : ''}${READ_BTN}`, note, live: since };
}
function renderPop() {
  const el = $('pop');
  const sid = pop.kind === 'c' ? spriteSid : null;
  const p = pop.kind === 'q' || pop.kind === 'c' ? cardParts(pop.kind, pop.key, sid) : undefined;
  if (p === undefined) return;
  if (!p) return closePop();
  repBody = p.body;
  if (pop.kind === 'c') liveSince = p.live;
  const html = `${p.head}\n      ${p.main}\n      <div class="btns">${p.btns}</div>`;
  const st = p.q?.relay?.status || '';
  if (el._h !== html && !(typingIn(el) && el._st === st)) {     // only when the content changed (live values below use textContent);
    const keep = el._rep === repBody ? el.querySelector('.report')?.scrollTop || 0 : 0;   // same report: keep the reader's place
    const caret = typingIn(el) && inputState();                                          // never under a reason/instruction being typed,
    el._h = html; el._rep = repBody; el._st = st; el.innerHTML = html;                   // unless the relay status changed
    const rep = el.querySelector('.report'); if (rep && keep) rep.scrollTop = keep;
    restoreInput(el, caret);
  }
  cardLive(el, p);
  el.hidden = false;
  const r = pop.anchor?.getBoundingClientRect?.();
  if (r) {
    const w = el.offsetWidth, h = el.offsetHeight;
    const x = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    const y = r.top - h - 8 > 8 ? r.top - h - 8 : Math.min(innerHeight - h - 8, r.bottom + 8);
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
}
/** Text fields whose typing must survive a repaint: the deny reason and the instruction box. */
const TYPING = '.why, .ins';
const typingIn = el => { const a = document.activeElement; return !!a && el.contains(a) && a.matches(TYPING); };
const inputState = () => { const a = document.activeElement; return { cls: a.classList.contains('ins') ? '.ins' : '.why', v: a.value, s: a.selectionStart, e: a.selectionEnd }; };
function restoreInput(el, c) {
  const n = c && el.querySelector(c.cls);
  if (!n || n.disabled) return;
  n.value = c.v; try { n.focus({ preventScroll: true }); n.setSelectionRange(c.s, c.e); } catch { /* gone */ }
}
/** Live values inside a card (textContent only): wait / elapsed time and the relay countdown. */
function cardLive(el, p) {
  const n = el.querySelector('.live-elapsed'); if (n && p.c) n.textContent = fmtDur(state.now - p.live);
  const lw = el.querySelector('.live-wait'); if (lw && p.q) lw.textContent = fmtDur(Date.now() - p.q.since);
  if (p.q?.relay) relayLive(el, p.q.relay);
}
const idleNote = '할 일을 마치고 다음 지시를 기다려요. 잠시 뒤 자리로 돌아가요.';
/** Why this request has no buttons (ceocard.js whyNoButtons: timeout with the real wait, no dashboard, background tab,
 *  hook gone, relay not installed (추정), or an old request). */
const NOT_INSTALLED_TIP = '서버가 시작된 뒤 이 세션에서 대표실 중계 요청을 한 번도 받지 못했어요 (추정)';
const whyHTML = q => { const w = whyNoButtons(q, relayState); return `${esc(w.text)}${w.inferred ? ` <span class="est" title="${esc(NOT_INSTALLED_TIP)}">추정</span>` : ''}`; };
/** The 실장's (or a subagent's) final report: escaped plain text with line breaks, its own scroll, and 전체 복사. */
function reportHTML(body, title = '보고 내용') {
  const t = reportText(body);
  if (!t) return `<p class="ask">보고 드렸어요</p><p class="rl-left">보고 본문이 기록되지 않았어요 (가림 모드이거나 이전 훅).</p>`;
  return `<div class="report-h"><b>${esc(title)}</b>${COPYALL_BTN}</div>
      <div class="report" tabindex="0" role="region" aria-label="${esc(title)}">${esc(t)}</div>`;
}
const popReport = () => {
  const v = pop.kind === 'q' ? popQ()?.body : sprites.get(pop.key)?.c?.msg;
  return typeof v === 'string' ? v : '';
};
const popQ = () => lastList.find(x => x.key === pop.key);
/** Re-render every open card view (popover + drawer) after an answer / draft change. */
function rerenderCards() { if (pop.kind) renderPop(); renderReader(true); }
async function focusTerminal(sid) {
  if (!sid) { toast('어느 세션인지 몰라요. 터미널에서 확인해 주세요'); return; }
  let ok = false;
  try { ok = (await fetch(`/focus?sid=${encodeURIComponent(sid)}`)).ok; } catch { /* old server */ }
  toast(ok ? '터미널을 앞으로 가져왔어요' : `터미널에서 답해 주세요 · 세션 ${sid.slice(0, 4)}`);
}
/** One click on a card action: the popover and the drawer both route here, so relay rules stay in one place.
 *  ctx = { kind 'q'|'c', key, sid, body (for 전체 복사), done (close that view), opener }. */
async function cardClick(ev, ctx) {
  const b = ev.target.closest('button'); if (!b) return;
  const box = ev.target.closest('#pop, #rd-act');
  if (b.dataset.a === 'read') { openReader(ctx.kind, ctx.key, ctx.sid, b); return; }
  if (b.dataset.a === 'copyall') {
    try { await navigator.clipboard.writeText(ctx.body || ''); toast('보고 전체를 복사했어요'); } catch { toast('복사가 막혔어요. 보고를 직접 선택해 주세요'); }
    return;
  }
  if (b.dataset.a === 'release') {
    const key = ctx.kind === 'q' ? ctx.key : `${ctx.sid}|${sprites.get(ctx.key)?.c.aid || 'main'}`;
    const q = lastList.find(x => x.key === key);
    if (q) { b.disabled = true; await sendBack([q]); ctx.done(); toast('돌려보냈어요 · 질문·승인은 터미널에서 계속 받을 수 있어요'); }
    return;
  }
  const q = ctx.kind === 'q' ? lastList.find(x => x.key === ctx.key) : null;
  if (!q) { if (b.dataset.a === 'focus') focusTerminal(ctx.sid); return; }
  const r = q.relay;
  const after = opt => {
    if (r?.status === 'answered') { resolveLocal(keyOfRelay(r)); toast(r.item.kind === 'instruct' ? '지시를 보냈어요 · 세션이 이어서 일해요' : '답을 보냈어요'); }
    if (r?.status === 'released') toast(r.item.kind === 'instruct' ? '터미널에서 이어 주세요 · 세션은 멈춰 있어요' : '터미널로 넘겼어요 · 터미널에서 답해 주세요');
    sceneDirty = true; rerenderCards(); kick();
    const f = opt?.focus && box?.querySelector(opt.focus);
    if (f) { f.focus({ preventScroll: true }); try { f.setSelectionRange(f.value.length, f.value.length); } catch { /* not a text field */ } }
  };
  if (onRelayClick(ev, r, after, SIM)) return;
  const qt = q.relay?.item?.kind === 'question' ? (q.relay.item.questions || []).map(x => x.question).join('\n') : q.text;
  if (b.dataset.a === 'copy') {
    try { await navigator.clipboard.writeText(qt); toast('질문을 복사했어요'); } catch { toast('복사가 막혔어요. 질문을 직접 선택해 주세요'); }
  } else if (b.dataset.a === 'focus') focusTerminal(q.sid);
}
/** Relay inputs (deny reason, checkboxes) and Enter-to-send, for a card container. */
function bindCardInputs(el, relayOf) {
  el.addEventListener('input', ev => onRelayInput(ev, relayOf(), rerenderCards));
  el.addEventListener('change', ev => { if (ev.target.type === 'checkbox' && ev.target.dataset.q != null) onRelayInput(ev, relayOf(), rerenderCards); });
  el.addEventListener('keydown', ev => {
    if (ev.key !== 'Enter') return;
    if (ev.target.classList.contains('why')) ev.target.closest('.deny')?.querySelector('[data-a="deny"]')?.click();
    // instruction box: Enter = new line; Ctrl/⌘+Enter = 보내기 (same button, same double-submit guard)
    else if (ev.target.classList.contains('ins') && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); ev.target.closest('.rl')?.querySelector('[data-a="instruct"]')?.click(); }
  });
}
bindCardInputs($('pop'), () => popQ()?.relay);
$('pop').addEventListener('click', ev => cardClick(ev, { kind: pop.kind, key: pop.key, sid: pop.kind === 'q' ? popQ()?.sid : spriteSid, body: popReport(), done: closePop }));
spritesEl.addEventListener('pointerover', ev => {
  const ch = ev.target.closest('.char'); if (!ch || pop.pinned || ch.dataset.id === '__ceo') return;
  const id = ch.dataset.id;
  if (holdable(ev)) hover.over(`c:${id}`, () => { const sp = sprites.get(id); if (sp) openPop('c', id, sp.el, false); });
  else openPop('c', id, ch, false);
});
spritesEl.addEventListener('pointerout', ev => { const ch = ev.target.closest('.char'); if (ch && !ch.contains(ev.relatedTarget)) anchorOut(ev, `c:${ch.dataset.id}`); });
$('ceo-line').addEventListener('pointerout', ev => { const b = ev.target.closest('.qf'); if (b && !b.contains(ev.relatedTarget)) anchorOut(ev, `q:${b.dataset.key}`); });
$('pop').addEventListener('pointerenter', ev => { if (!pop.pinned && holdable(ev)) hover.enter('card'); });
$('pop').addEventListener('pointerleave', ev => { if (!pop.pinned && holdable(ev)) hover.leave('card'); });
// Pressing anything inside a hover-opened card pins it, so typing a reason or a slow click never loses it.
const pinHovered = () => { if (pop.kind && !pop.pinned) { pop.pinned = true; hover.reset(); } };
$('pop').addEventListener('pointerdown', pinHovered);
$('pop').addEventListener('focusin', pinHovered);      // tabbing into the reason box pins it too
spritesEl.addEventListener('click', ev => { const ch = ev.target.closest('.char'); if (ch && ch.dataset.id !== '__ceo') togglePop('c', ch.dataset.id, ch); });
document.addEventListener('pointerdown', ev => {
  if (reader.open) { if (!ev.target.closest('#reader')) closeReader(); return; }   // outside the drawer: close it only
  if (pop.pinned && !ev.target.closest('#pop, .char, .qf')) closePop();
});
document.addEventListener('keydown', ev => {
  if (ev.key !== 'Escape') return;
  if (reader.open) { closeReader(); return; }
  closePop(); if (!$('umodal').hidden) closeModal();
});

// ---------------- 크게 보기 drawer: a whole card, or the 대표실 list, on the right ----------------
// Card mode: the same card as the popover (cardParts / cardClick: same markup, same relay rules), laid out for
// reading: header + meta on top, a big reading area (decision lines, list items, links; A−/A+), the card's actions
// at the bottom. Report text and request content are built with textContent / DOM links only (http/https, noopener).
// It follows the same source (readerSame: same session and wait occurrence; the session id is captured at open, so
// 터미널로 always targets it). When the entry leaves the line, or a character key now belongs to another session
// (floor/room switch), the content freezes and 지난 보고 / 지난 요청 shows; its actions are removed.
// List mode (대표 or +N): every waiting entry in a table (ceo.js ceoTable): sort, filter, multi-select + bulk
// 돌려보내기 (sendBack: release without a decision + dismiss; never answers), new rows behind a "새 요청 N건" bar.
const READ_SIZES = [12, 13, 14, 15, 16, 18, 20, 22];
const reader = { open: false, mode: 'card', src: null, key: null, sid: null, since: null, body: '', past: false, opener: null, fromList: false,
  auto: /[?&]read=1/.test(location.search), autoList: /[?&]list=1/.test(location.search), sig: {},
  list: { sort: { col: 'at', dir: 'asc' }, filter: 'all', shown: new Set(), sel: new Set(), anchor: null, scroll: 0, confirm: false, html: '' } };
const readerSize = () => { const v = Number(store.get('office.readerSize')); return READ_SIZES.includes(v) ? v : 15; };
/** What sits under the drawer's key right now ({ sid, since } or null) — for readerSame. */
function readerSource(src, key) {
  if (src === 'q') { const q = lastList.find(x => x.key === key); return q ? { sid: q.sid, since: q.since } : null; }
  return sprites.get(key)?.c && spriteSid ? { sid: spriteSid, since: null } : null;
}
/** Text with http(s) links as DOM nodes (text nodes + <a>, no HTML parsing). */
function fillLinks(el, text) {
  for (const p of linkParts(text)) {
    if (p.t === 'url') { const a = document.createElement('a'); a.href = p.v; a.textContent = p.v; a.target = '_blank'; a.rel = 'noopener noreferrer'; el.append(a); }
    else el.append(document.createTextNode(p.v));
  }
  return el;
}
const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
/** The reading area: { label, decide: [lines], blocks: () => fills #rd-body } for a card's parts. */
function readingOf(p) {
  if (p.body) return { label: p.c ? '마지막 보고' : '보고 내용', decide: reportDecision(p.body), sig: `r|${p.body}`, fill(body) {
    let ul = null;
    for (const b of reportBlocks(reportText(p.body))) {
      if (b.t === 'li') {
        if (!ul) { ul = mk('ul'); body.append(ul); }
        const li = fillLinks(mk('li'), b.text); if (b.depth) li.style.marginLeft = `${b.depth * 1.2}em`; ul.append(li);
        continue;
      }
      ul = null;
      body.append(b.t === 'gap' ? mk('div', 'rd-sp') : fillLinks(mk('p'), b.text));
    }
  } };
  const it = p.q?.relay?.item;
  if (it?.kind === 'permission') {
    const cmd = typeof it.input?.command === 'string' ? it.input.command : it.target;
    return { label: '승인 요청', decide: [], sig: `p|${it.id}|${it.tool}|${cmd}|${it.input?.description || ''}`, fill(body) {
      body.append(mk('p', 'rd-k', '도구'), mk('p', 'rd-v', it.tool || '—'));
      if (cmd != null) { body.append(mk('p', 'rd-k', it.input?.command != null ? '명령' : '대상')); body.append(mk('pre', 'rd-code', String(cmd))); }
      if (typeof it.input?.description === 'string' && it.input.description) body.append(mk('p', 'rd-k', '설명'), fillLinks(mk('p'), it.input.description));
      if (it.clipped) body.append(mk('p', 'rd-note', '(길어서 잘렸어요)'));
    } };
  }
  if (it?.kind === 'question') {
    const qs = Array.isArray(it.questions) ? it.questions : [];
    return { label: qs.length > 1 ? `질문 ${qs.length}개` : '질문', decide: [], sig: `q|${it.id}|${JSON.stringify(qs)}`, fill(body) {
      for (const q of qs) {
        const h = mk('p', 'rd-qh'); if (q.header) h.append(mk('span', 'hchip', q.header), ' '); h.append(fillLinks(mk('span'), q.question || '')); body.append(h);
        const ul = mk('ul');
        for (const o of q.options || []) { const li = mk('li'); li.append(mk('b', null, o.label)); if (o.description) li.append(' — ', fillLinks(mk('span'), o.description)); ul.append(li); }
        body.append(ul);
      }
    } };
  }
  const q = p.q;
  if (q) return { label: q.kind === 'idle' ? '상태' : '요청 내용', decide: [], sig: `t|${q.text}|${q.tool}|${whyNoButtons(q, relayState).text}`, fill(body) {
    if (q.tool && q.kind !== 'idle') body.append(mk('p', 'rd-k', '도구'), mk('p', 'rd-v', q.tool));
    body.append(fillLinks(mk('p', 'rd-v'), q.text));
    if (q.kind === 'idle' || q.kind === 'report') body.append(mk('p', 'rd-note', q.kind === 'idle' ? idleNote : '보고 본문이 기록되지 않았어요 (가림 모드이거나 이전 훅).'));
    else { const w = whyNoButtons(q, relayState), n = mk('p', 'rd-note', w.text); if (w.inferred) { n.append(' '); const t = mk('span', 'est', '추정'); t.title = NOT_INSTALLED_TIP; n.append(t); } body.append(n); }
  } };
  return { label: '마지막 보고', decide: [], sig: 'none', fill(body) { body.append(mk('p', 'rd-note', '아직 보고가 없어요.')); } };
}
function setMode(mode) {
  reader.mode = mode;
  $('rd-card').hidden = mode !== 'card'; $('rd-list').hidden = mode !== 'list';
  $('rd-back').hidden = !(mode === 'card' && reader.fromList);
  reader.sig = {};
}
/** Paint the card view from parts (only the pieces whose content changed; never while typing a reason). */
function paintCard(p) {
  const head = $('rd-head'), act = $('rd-act'), sig = reader.sig;
  if (sig.head !== p.head) { sig.head = p.head; head.innerHTML = p.head; }   // cardParts: every log string is esc()'d
  const rd = readingOf(p);
  if (sig.read !== rd.sig) {
    sig.read = rd.sig; reader.body = p.body;
    const body = $('rd-body'), dl = $('rd-dl'), keep = body.scrollTop;
    body.replaceChildren(); dl.replaceChildren(); rd.fill(body);
    for (const l of rd.decide) dl.append(fillLinks(mk('p'), l));
    $('rd-decide').hidden = !rd.decide.length; $('rd-lbl').textContent = rd.label; body.setAttribute('aria-label', rd.label);
    body.scrollTop = keep;
  }
  const actHTML = `${p.q?.relay ? relayHTML(p.q.relay) : p.insOff || ''}<div class="btns">${p.btns.replace(READ_BTN, '')}${p.body ? COPYALL_BTN : ''}${p.c ? FOCUS_BTN : ''}</div>`;
  // Never repaint under the reason field while typing, unless the relay status changed (sending / answered / expired):
  // then repaint and put the reason text and caret back. Checkboxes and buttons repaint as usual.
  const typing = typingIn(act), st = p.q?.relay?.status || '';
  if (sig.act !== actHTML && (!typing || sig.st !== st)) {
    const caret = typing && inputState();
    sig.act = actHTML; sig.st = st; act.innerHTML = actHTML;
    restoreInput(act, caret);
  }
  cardLive($('rd-card'), p);
}
function freezeCard() {
  reader.past = true;
  $('rd-past').textContent = reader.body ? '지난 보고' : '지난 요청'; $('rd-past').hidden = false;
  const act = $('rd-act'); act.replaceChildren(mk('p', 'rl-left', '대표실 줄에서 나갔어요. 마지막으로 받은 내용이에요.'));
  if (reader.body) { const d = mk('div', 'btns'); d.innerHTML = COPYALL_BTN; act.append(d); }
  for (const n of $('rd-head').querySelectorAll('.live-wait, .live-elapsed')) if (!n.textContent) n.textContent = '—';
  reader.sig.act = null;
}
function showReader(opener) {
  const el = $('reader');
  if (!reader.open) reader.opener = opener || document.activeElement;
  reader.open = true;
  el.style.setProperty('--rd-fs', `${readerSize()}px`);
  el.hidden = false;
  requestAnimationFrame(() => el.querySelector(reader.mode === 'list' ? '#rd-tbody tr, [data-r="close"]' : '[data-r="close"]')?.focus({ preventScroll: true }));
}
function openReader(src, key, sid, opener, fromList = false) {
  const p = cardParts(src, key, src === 'q' ? lastList.find(x => x.key === key)?.sid : sid);
  if (!p) return;
  Object.assign(reader, { src, key, sid: p.sid, since: p.since, body: p.body, past: false, fromList });
  setMode('card');
  $('rd-t').textContent = '크게 보기'; $('rd-sub').textContent = readerSub(p); $('rd-past').hidden = true;
  paintCard(p);
  $('rd-body').scrollTop = 0;
  showReader(opener);
}
/** Subtitle, computed once at open time (who · floor · session) and kept even after the source moves on. */
function readerSub(p) {
  if (p.q) return `${displayName(whoOf(p.q))} · ${floorLabel(p.q.proj)} · 세션 ${p.q.sid.slice(0, 4)}`;
  const proj = Object.values(state.floors).find(f => Object.values(f.rooms).some(r => r.sid === p.sid))?.proj;
  return [displayName(p.c), proj ? floorLabel(proj) : null, p.sid ? `세션 ${p.sid.slice(0, 4)}` : null].filter(Boolean).join(' · ');
}
function openList(opener, { sid = null } = {}) {
  const L = reader.list;
  L.shown = new Set(lastList.map(q => q.key)); L.confirm = false; L.html = ''; L.sid = sid;
  reader.fromList = false; reader.past = false; $('rd-past').hidden = true; $('rd-sub').textContent = '';
  setMode('list');
  paintList();
  $('rd-tw').scrollTop = 0;
  showReader(opener);
}
function backToList() {
  const L = reader.list, key = reader.key;
  reader.fromList = false; reader.past = false; $('rd-past').hidden = true; $('rd-sub').textContent = '';
  setMode('list'); L.html = ''; paintList();
  $('rd-tw').scrollTop = L.scroll;
  requestAnimationFrame(() => ($('rd-tbody').querySelector(`tr[data-key="${CSS.escape(key || '')}"]`) || $('reader').querySelector('[data-r="close"]'))?.focus({ preventScroll: true }));
}
const SORT_KO = { at: '온 시각', wait: '기다린 시간', kind: '종류', proj: '프로젝트', who: '누가', text: '내용' };
function listRows() {
  const L = reader.list;
  L.sel = pruneSel(L.sel, lastList);                                     // resolved rows drop out of the selection
  const opts = { sort: L.sort, filter: L.filter, sid: L.sid || null, now: Date.now(), nameOf: q => displayName(whoOf(q)), projOf: q => floorLabel(q.proj) };
  let t = ceoTable(lastList, { ...opts, shown: L.shown });
  if (!t.rows.length && t.fresh) { for (const q of lastList) L.shown.add(q.key); t = ceoTable(lastList, { ...opts, shown: L.shown }); }   // nothing to jump from
  return t;
}
function paintList() {
  const L = reader.list, { rows, fresh } = listRows(), tw = $('rd-tw');
  $('rd-t').textContent = `대표실 대기 ${lastList.length}`;
  for (const b of $('rd-list').querySelectorAll('[data-f]')) b.setAttribute('aria-pressed', String(b.dataset.f === L.filter));
  const chip = $('rd-sidchip');                             // one session (opened from a 대표실 group): removable chip
  chip.hidden = !L.sid;
  if (L.sid) {
    const mine = lastList.filter(q => q.sid === L.sid), proj = mine[0]?.proj;
    const txt = `${proj ? `${floorLabel(proj)} · ` : ''}세션 ${L.sid.slice(0, 4)} · ${mine.length}건`;
    const lbl = chip.querySelector('span'); if (lbl.textContent !== txt) lbl.textContent = txt;
  }
  const st = selState(L.sel, rows);
  const th = `<tr><th class="ck"><input type="checkbox" data-s="all" aria-label="보이는 행 모두 선택" ${st === 'all' ? 'checked' : ''}></th>${LIST_COLS.map(c => {
    const on = L.sort.col === c, dir = L.sort.dir === 'asc' ? 'ascending' : 'descending';
    return `<th class="c-${c}" aria-sort="${on ? dir : 'none'}"><button type="button" data-sort="${c}">${SORT_KO[c]}${on ? (L.sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>`;
  }).join('')}</tr>`;
  if ($('rd-thead')._h !== th) { $('rd-thead')._h = th; $('rd-thead').innerHTML = th; }
  const all = $('rd-thead').querySelector('[data-s="all"]'); if (all) all.indeterminate = st === 'some';
  // The wait cell ticks every second: it is filled below with textContent and is not part of the compared HTML, so a
  // ticking clock never replaces the rows (clicks and focus survive).
  const body = rows.map(r => `<tr tabindex="0" data-key="${esc(r.key)}" data-dk="${esc(r.dkey)}" class="k-${r.kind}${L.sel.has(r.dkey) ? ' sel' : ''}" aria-selected="${L.sel.has(r.dkey)}">
    <td class="ck"><input type="checkbox" data-s="row" aria-label="선택" ${L.sel.has(r.dkey) ? 'checked' : ''}></td><td class="c-at mono">${esc(clock(r.at))}</td><td class="c-wait mono" data-at="${r.at}"></td>
    <td class="c-kind"><i class="kd k-${r.kind}"></i>${esc(r.label)}</td><td class="c-proj">${esc(r.proj)}</td><td class="c-who">${esc(r.who)}</td><td class="c-text" title="${esc(r.text)}">${esc(r.text)}</td></tr>`).join('');
  if (L.html !== body) {
    const fk = document.activeElement?.closest?.('#rd-tbody tr')?.dataset.key, fck = document.activeElement?.dataset?.s === 'row';
    const keep = tw.scrollTop;
    L.html = body; $('rd-tbody').innerHTML = body; tw.scrollTop = keep;
    if (fk) { const tr = $('rd-tbody').querySelector(`tr[data-key="${CSS.escape(fk)}"]`); (fck ? tr?.querySelector('input') : tr)?.focus({ preventScroll: true }); }
  }
  const now = Date.now();
  for (const td of $('rd-tbody').querySelectorAll('td.c-wait')) { const v = fmtDur(Math.max(0, now - Number(td.dataset.at))); if (td.textContent !== v) td.textContent = v; }
  $('rd-empty').hidden = rows.length > 0; $('rd-empty').textContent = L.filter === 'need' && lastList.length ? '답이 필요한 요청이 없어요' : '대기 중인 요청이 없어요';
  const fb = $('rd-fresh'); fb.hidden = !fresh; if (fresh) fb.textContent = `새 요청 ${fresh}건 · 보기`;
  paintSelBar(rows);
}
function paintSelBar(rows = listRows().rows) {
  const L = reader.list, n = L.sel.size, bar = $('rd-selbar'), hid = selHidden(L.sel, rows);
  bar.hidden = !n; if (!n) { L.confirm = false; bar._h = ''; return; }
  const high = selHigh(L.sel, lastList);
  const html = L.confirm
    ? `<span class="rd-warn">승인·질문 ${high}건은 터미널에서 여전히 기다려요. 돌려보낼까요?</span><button type="button" class="chipbtn no" data-s="go">돌려보내기</button><button type="button" class="chipbtn" data-s="cancel">취소</button>`
    : `<b>${n}건 선택</b>${hid ? `<small class="rd-hid">숨은 ${hid}건 포함</small>` : ''}<button type="button" class="chipbtn" data-s="send" title="결정 없이 대시보드에서만 치워요. 승인·질문은 터미널에서 계속 받을 수 있어요">돌려보내기</button><button type="button" class="chipbtn ghost" data-s="clear">선택 해제</button>`;
  if (bar._h !== html) { bar._h = html; bar.innerHTML = html; }
}
async function bulkSendBack() {
  const L = reader.list, picked = selEntries(L.sel, lastList);
  L.sel = new Set(); L.confirm = false;
  if (picked.length) { await sendBack(picked); toast(`${picked.length}건을 돌려보냈어요 · 승인·질문은 터미널에서 계속 받을 수 있어요`); }
  L.html = ''; paintList();
}
function closeReader() {
  if (!reader.open) return;
  reader.open = false; $('reader').hidden = true; reader.list.confirm = false;
  // Focus goes back to what opened it; if that re-rendered or closed: the 대표실 figure, the 대표실 header, the theme button.
  // (Characters in the scene are not focusable, so a character-card drawer falls back to the header.)
  const live = el => el && el !== document.body && el.isConnected && !el.closest('[hidden]') && !el.disabled && el.getClientRects().length > 0;
  const back = [reader.opener, !$('pop').hidden && $('pop').querySelector('[data-a="read"]'), (reader.mode === 'list' ? figFor(null, reader.list.sid)?.el : reader.src === 'q' && figFor(reader.key, reader.sid)?.el), $('ceo-boss'), $('ceo-h'), $('theme')].find(live);
  try { back?.focus?.({ preventScroll: true }); } catch { /* gone */ }
  reader.opener = null;
}
/** Called every frame / second (force: after an answer). ?read=1 opens the first report card, ?list=1 the list. */
function renderReader(force) {
  if (!reader.open) {
    if (reader.autoList && ui.live) { reader.autoList = false; openList(null); return; }
    if (!reader.auto) return;
    const q = lastList.find(x => x.kind === 'report' && x.asks && x.body) || lastList.find(x => x.kind === 'report' && x.body);
    if (q) { reader.auto = false; openReader('q', q.key, q.sid, null); }
    return;
  }
  if (reader.mode === 'list') { paintList(); return; }
  if (reader.past) return;                                  // frozen: a past card never comes back to life
  const same = readerSame({ sid: reader.sid, since: reader.since }, readerSource(reader.src, reader.key));
  const p = same ? cardParts(reader.src, reader.key, reader.sid) : null;
  if (!p) { freezeCard(); return; }
  if (force) reader.sig.act = null;
  paintCard(p);
}
bindCardInputs($('rd-act'), () => (reader.src === 'q' && !reader.past ? lastList.find(x => x.key === reader.key)?.relay : null));
$('rd-act').addEventListener('click', ev => {
  if (reader.past) {                                        // frozen card: only 전체 복사 is left
    if (ev.target.closest('[data-a="copyall"]')) navigator.clipboard.writeText(reader.body).then(() => toast('보고 전체를 복사했어요'), () => toast('복사가 막혔어요. 보고를 직접 선택해 주세요'));
    return;
  }
  cardClick(ev, { kind: reader.src, key: reader.key, sid: reader.sid, body: reader.body, done: () => (reader.fromList ? backToList() : closeReader()) });
});
$('reader').addEventListener('click', ev => {
  const b = ev.target.closest('button[data-r]'); if (!b) return;
  const a = b.dataset.r;
  if (a === 'close') return closeReader();
  if (a === 'back') return backToList();
  if (a === 'smaller' || a === 'bigger') {
    const i = READ_SIZES.indexOf(readerSize()), v = READ_SIZES[Math.max(0, Math.min(READ_SIZES.length - 1, i + (a === 'bigger' ? 1 : -1)))];
    store.set('office.readerSize', String(v)); $('reader').style.setProperty('--rd-fs', `${v}px`);
  }
});
// list mode: filter chips, sort headers, new-rows bar, rows (click / Enter), checkboxes (shift = range), bulk bar
$('rd-list').addEventListener('click', ev => {
  const L = reader.list, t = ev.target;
  const f = t.closest('[data-f]'); if (f) { L.filter = f.dataset.f; L.html = ''; paintList(); return; }
  if (t.closest('#rd-sidchip button')) { L.sid = null; L.html = ''; paintList(); $('rd-list').querySelector('[data-f="all"]')?.focus(); return; }
  const so = t.closest('[data-sort]'); if (so) { L.sort = nextSort(L.sort, so.dataset.sort); L.html = ''; paintList(); return; }
  if (t.closest('#rd-fresh')) { for (const q of lastList) L.shown.add(q.key); L.html = ''; paintList(); return; }
  const sb = t.closest('#rd-selbar [data-s]');
  if (sb) {
    const a = sb.dataset.s;
    if (a === 'clear') { L.sel = new Set(); L.html = ''; paintList(); }
    else if (a === 'send') { if (selHigh(L.sel, lastList)) { L.confirm = true; paintSelBar(); $('rd-selbar').querySelector('[data-s="cancel"]')?.focus(); } else bulkSendBack(); }
    else if (a === 'go') bulkSendBack();
    else if (a === 'cancel') { L.confirm = false; paintSelBar(); }
    return;
  }
  const ck = t.closest('input[data-s]');
  if (ck) {
    const { rows } = listRows();
    if (ck.dataset.s === 'all') L.sel = selectRows(L.sel, rows, ck.checked);
    else {
      const d = ck.closest('tr').dataset.dk;
      L.sel = ev.shiftKey && L.anchor ? selectRange(L.sel, rows, L.anchor, d, ck.checked) : selectRows(L.sel, rows.filter(r => r.dkey === d), ck.checked);
      L.anchor = d;
    }
    L.confirm = false; L.html = ''; paintList();
    return;
  }
  if (t.closest('td.ck')) return;                           // the checkbox cell's padding: not a row open
  const tr = t.closest('#rd-tbody tr'); if (tr) openFromRow(tr);
});
$('rd-list').addEventListener('keydown', ev => {
  const tr = ev.target.closest?.('#rd-tbody tr');
  if (!tr || ev.target !== tr) return;
  if (ev.key === 'Enter') { ev.preventDefault(); openFromRow(tr); }
  else if (ev.key === ' ') { ev.preventDefault(); tr.querySelector('input[data-s="row"]')?.click(); }
  else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); (ev.key === 'ArrowDown' ? tr.nextElementSibling : tr.previousElementSibling)?.focus(); }
});
function openFromRow(tr) {
  const key = tr.dataset.key, q = lastList.find(x => x.key === key);
  if (!q) return;
  reader.list.scroll = $('rd-tw').scrollTop;
  openReader('q', key, q.sid, null, true);
}
$('ceo-boss').addEventListener('click', ev => { ev.stopPropagation(); openList(ev.currentTarget); });
// Keep Tab inside the drawer while it is open (focus returns to what opened it on close).
$('reader').addEventListener('keydown', ev => {
  if (ev.key !== 'Tab') return;
  const f = [...$('reader').querySelectorAll('button, [href], input, [tabindex="0"]')].filter(x => !x.closest('[hidden]') && !x.disabled);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
});

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
const setHTML = (el, html) => { if (el._h !== html) { el._h = html; el.innerHTML = html; } };
const setW = (id, frac) => { const w = `${(Math.max(0, frac) * 100).toFixed(2)}%`; const el = $(id); if (el.style.width !== w) el.style.width = w; };
const level = r => (r == null ? 'none' : r >= 0.9 ? 'ok' : r >= 0.7 ? 'warn' : 'bad');
const hearts = r => {
  if (r == null) return Array(10).fill('<i class="ht h0"></i>').join('');
  const h = Math.round(r * 20);
  return Array.from({ length: 10 }, (_, i) => `<i class="ht ${h >= (i + 1) * 2 ? 'h2' : h === i * 2 + 1 ? 'h1' : 'h0'}"></i>`).join('');
};

let usageVer = -1, usageAt = 0;
function renderUsage(force) {
  const a = usage.agg();
  if (!force && a.ver === usageVer && performance.now() - usageAt < 30000) return;
  usageVer = a.ver; usageAt = performance.now();
  $('usage-sub').textContent = SIM ? '오늘 · 시뮬레이터 가짜 데이터' : '오늘 · 출력 토큰';
  setHTML($('usage-body'), usageSummaryHTML(a, { sim: SIM, pricing: ui.pricing }));
  $('usage-more').disabled = !a.n;
  if (!$('umodal').hidden) setHTML($('um-body'), detailHTML(a, { sim: SIM, pricing: ui.pricing, now: new Date(), labelOf: floorLabel }));
}
$('usage-more').onclick = () => { $('umodal').hidden = false; renderUsage(true); $('um-x').focus(); };
function closeModal() { $('umodal').hidden = true; $('usage-more').focus(); }
$('um-x').onclick = closeModal;
$('umodal').addEventListener('click', ev => { if (ev.target === $('umodal')) closeModal(); });

function renderMeter(k) {
  const m = $('meter');
  if (!m.dataset.built) {
    m.dataset.built = '1';
    m.innerHTML = `<header class="chest-h"><i class="ico" style="--i:var(--ico-heart)"></i><h2>② 모델 분배 준수</h2><span class="sub">오늘 · 전체 세션</span></header>
      <div class="big" id="m-big"><span class="n"></span><small>의도 모델 = 실제 모델</small></div>
      <div class="hearts" id="m-hearts" role="img"></div>
      <div class="say" id="m-say"></div><div class="chips" id="m-chips"></div>
      <div class="row" id="m-r1"></div>
      <div class="bar" title="메인 세션 직접 도구 호출 vs 위임"><span class="direct" id="m-direct"></span><span class="delegated" id="m-deleg"></span></div>
      <div class="row" id="m-r2"></div>
      <div class="bar" title="판정 분포"><span class="ok" id="m-ok"></span><span class="rework" id="m-rework"></span><span class="fail" id="m-fail"></span></div>
      <div id="m-models"></div><div class="kv" id="m-kv"></div>`;
  }
  const pending = k.rows.filter(r => r.match === 'pending').length;
  const tot = k.direct + k.delegated || 1, v = k.verdicts, vt = v.ok + v.rework + v.fail;
  const judged = (k.yes || 0) + (k.no || 0);
  const lv0 = level(k.matchRate), few = lv0 === 'bad' && judged < 5, lv = few ? 'warn' : lv0;   // 4 delegations are no verdict
  const big = $('m-big');
  big.className = `big lv-${lv}`;
  big.querySelector('.n').textContent = k.matchRate == null ? '기록 없음' : pct(k.matchRate);
  big.querySelector('small').hidden = k.matchRate == null;
  setHTML($('m-hearts'), hearts(k.matchRate));
  $('m-hearts').setAttribute('aria-label', `준수율 하트 ${k.matchRate == null ? '기록 없음' : pct(k.matchRate)}`);
  const pairs = [...new Set(k.rows.filter(r => r.match === 'no').map(r => `${r.want || '미지정'}→${r.actual}`))];
  const say = lv === 'none'
    ? (pending ? `위임 ${pending}건 결과 확인 중이에요` : k.rows.length ? '모델 미지정 위임만 있어요' : '오늘 위임이 아직 없어요')
    : `${few ? `표본 적음 (위임 ${judged}건)` : { ok: '규칙 준수 중', warn: '주의 · 일부 위반', bad: '규칙 위반 많음' }[lv]} · ${k.no ? `위반 ${k.no}건 (${pairs.slice(0, 2).join(', ')}${pairs.length > 2 ? ' …' : ''})` : '위반 없음'}`;
  const sayEl = $('m-say'); sayEl.className = `say lv-${lv}`; sayEl.textContent = say;
  setHTML($('m-chips'), [k.yes && `<span class="chip yes">✓ 일치 ${k.yes}</span>`, k.no && `<span class="chip no">✗ 불일치 ${k.no}</span>`,
    k.unset && `<span class="chip" title="sub.model 없이 위임(상속)">모델 미지정 ${k.unset}</span>`, pending && `<span class="chip">확인 대기 ${pending}</span>`].filter(Boolean).join(''));
  const fams = new Set(); for (const f of Object.values(state.floors)) for (const sid of Object.keys(f.rooms)) fams.add(mainFam(sid) || 'unknown');
  const mf = fams.size === 1 ? [...fams][0] : null, who = mf && mf !== 'unknown' ? mainTitle(mf) : '실장';
  $('m-direct').style.background = `var(--${mf && mf !== 'unknown' ? mf : 'slate'})`;
  $('m-direct').parentElement.title = `메인 세션(${who}) 직접 도구 호출 vs 위임${fams.size > 1 ? ` · 메인 모델 ${[...fams].join('·')}` : ''}`;
  setHTML($('m-r1'), `<span>${esc(who)} 직접 도구 <b>${k.direct}</b></span><span>위임 <b>${k.delegated}</b> · 직접 비율 ${pct(k.directRatio)}</span>`);
  setW('m-direct', k.direct / tot); setW('m-deleg', k.delegated / tot);
  setHTML($('m-r2'), `<span>판정 ${vt}건 · 재작업률 ${pct(vt ? (v.rework + v.fail) / vt : null)}</span><span>통과 ${v.ok} · 재작업 ${v.rework} · 실패 ${v.fail}</span>`);
  for (const x of ['ok', 'rework', 'fail']) setW(`m-${x}`, vt ? v[x] / vt : 0);
  const models = [...MODELS, ...Object.keys(k.byModel).filter(x => !MODELS.includes(x))].filter(x => k.byModel[x]);
  setHTML($('m-models'), models.length ? `<table class="mtable"><thead><tr><th>직급·모델</th><th>위임</th><th>평균 소요</th><th>재작업률</th></tr></thead><tbody>${
    models.map(x => { const b = k.byModel[x]; return `<tr title="통과 ${b.ok} · 재작업 ${b.rework} · 실패 ${b.fail}"><td><span class="mbadge" style="${mstyle(x)}">${rankOf(x)} ${esc(x)}</span></td>
      <td>${b.n}</td><td>${fmtDur(b.avgMs)}</td><td>${b.reworkRate == null ? '판정 전' : pct(b.reworkRate)}</td></tr>`; }).join('')}</tbody></table>` : '');
  const st = state.stats, rooms = Object.values(state.floors).reduce((n, f) => n + Object.keys(f.rooms).length, 0);
  setHTML($('m-kv'), `<span>도구 실패<b class="${st.failures ? 'hot' : ''}">${st.failures}</b></span><span>승인 요청<b>${st.permissions}</b></span>
    <span>세션<b>${rooms}</b></span><span>이벤트<b>${st.events}</b></span>`);
}
function renderNow(room) {
  const chars = room ? Object.values(room.chars).sort((a, b) => (a.aid ? 1 : 0) - (b.aid ? 1 : 0) || a.enteredAt - b.enteredAt) : [];
  if (!chars.length) { setHTML($('now'), '<p class="empty-note">이 방에는 아직 아무도 없어요.</p>'); return; }
  setHTML($('now'), chars.map(c0 => {
    const c = view(settle(c0, room.sid), room.sid), since = c.phase === 'tool' && c.toolSince ? c.toolSince : c.lastTs;
    const inCeo = queueKeys.has(`${room.sid}|${c.aid || 'main'}`);
    const badges = [inCeo && '<span class="sbadge red">대표실</span>', c.blocked && !inCeo && '<span class="sbadge red">승인 대기</span>',
      c.stuck && '<span class="sbadge amber">막힘 1분+</span>', c.dozing && '<span class="sbadge grey">💤 3분+</span>',
      c.failCount && `<span class="sbadge red">실패 ${c.failCount}</span>`, c.verdict && `<span class="vstamp ${c.verdict}">${VERDICT_KO[c.verdict] || esc(c.verdict)}</span>`].filter(Boolean).join(' ');
    return `<div class="agent${c.obs === 'stale' ? ' is-stale' : ''}" style="${mstyle(c.model)}"><span class="sw"></span>
      <div class="name"><i class="obs ${c.obs}" title="${OBS_KO[c.obs]}"></i>${esc(displayName(c))}<span class="mbadge">${esc(c.model)}</span>${pipsSpan(c.effort, c.model)}</div>
      <div class="right" title="${esc(c.phase === 'tool' ? '이 도구 실행 경과' : '마지막 이벤트 이후')}">${fmtDur(state.now - since)}</div>
      <div class="meta">${esc(c.label || ACT_KO[c.act] || c.act)}${c.target ? ` · ${esc(head(c))}` : ''} ${badges}</div></div>`;
  }).join(''));
}
function renderDeleg(k) {
  const rows = k.rows.slice(-15).reverse().sort((a, b) => (b.match === 'no') - (a.match === 'no'));
  if (!rows.length) { setHTML($('deleg'), '<p class="empty-note">오늘 위임 기록이 없어요.</p>'); return; }
  const MARK = { yes: '✓', no: '✗', pending: '…', unset: '?', failed: '실패', expired: '만료' };
  const dot = (m, label) => `<i class="mdot${m ? '' : ' none'}" style="${m ? mstyle(m) : ''}" title="${esc(label)}"></i>`;
  setHTML($('deleg'), rows.map(r => `<div class="drow${r.match === 'no' ? ' bad' : ''}" title="${esc(`${r.type} · ${r.desc} · 세션 ${r.sid.slice(0, 8)}`)}">
    <span class="who">${esc(jobOf(r.type))} ${r.child ? esc(nickname(r.child)) : '<span class="muted">호출 중</span>'}</span>
    <span class="mm">${dot(r.want, `의도: ${r.want || '미지정'}`)}<span class="arrow">→</span>${dot(r.actual, `실제: ${r.actual || r.resolved || ({ failed: '호출 실패', expired: '결과 없음(만료)' }[r.match] ?? '확인 중')}`)}${
      r.match === 'no' ? ` <small>${esc(r.want || '미지정')}→${esc(r.actual)}</small>` : ''} <span class="mark ${esc(r.match)}">${MARK[r.match] ?? esc(r.match)}</span></span>
    <span class="dur">${r.durMs != null ? fmtDur(r.durMs) : r.match === 'expired' ? '응답 없음' : r.child ? '진행 중' : '—'}</span>
    <span class="vstamp ${r.verdict || 'none'}">${r.verdict ? VERDICT_KO[r.verdict] || esc(r.verdict) : '판정 전'}</span></div>`).join(''));
}

// Ticker: at most ~2 DOM updates per second; new items prepended, tool-done lines dropped.
let tickerWaiting = false;
function tickerLine(t) {
  let s = String(t.text ?? '');
  if (t.kind === 'PreToolUse') s = s.replace(/^(\w+)/, (_, w) => toolKo(w));
  else if (t.kind === 'PostToolUseFailure') s = s.replace(/^(\w+)/, (_, w) => toolNoun(w));
  else if (t.kind === 'PermissionRequest') s = s.replace(/^승인 요청 (\w+)/, (_, w) => `승인 요청 · ${toolNoun(w)}`);
  else if (t.kind === 'verdict') s = s.replace(/판정 (OK|REWORK|FAIL)/, (_, w) => `판정 ${VERDICT_KO[w.toLowerCase()]}`);
  else if (t.kind === 'UserPromptSubmit') s = '대표님 지시';
  return s;
}
function renderTicker(now) {
  const items = state.ticker, top = items[0]?.seq ?? 0;
  if (top <= lastTickerSeq) { tickerWaiting = false; return; }
  if (now - lastTickerAt < 500) { tickerWaiting = true; return; }
  const ol = $('ticker'), animate2 = lastTickerSeq > 0;
  const html = items.filter(t => t.seq > lastTickerSeq && t.kind !== 'PostToolUse').map(t => `<li class="k-${esc(t.kind)}${animate2 ? ' new' : ''}">
    <time>${clock(t.ts)}</time><b>${esc(t.who === 'Fable' ? mainTitle(mainFam(t.sid)) : nameFromWho(t.who))}</b> ${esc(tickerLine(t))}</li>`).join('');
  if (html) ol.insertAdjacentHTML('afterbegin', html);
  while (ol.childElementCount > 30) ol.lastElementChild.remove();
  lastTickerSeq = top; lastTickerAt = now; tickerWaiting = false;
}

// 플랜 한도 card (above ①) + the 실장 desk context monitor; the countdown re-renders every second.
function renderLimits() {
  const L = ui.limits, now = Date.now();
  setHTML($('lim-body'), limitsHTML(L, now));
  $('lim-stale').hidden = !(L?.account?.stale && (L.account.five_hour || L.account.seven_day));
  setHTML($('ctx-body'), ctxHTML(L, { labelOf: p => rowOf(p)?.label || p, all: ui.ctxAll }));
  const c = ctxOf(L, ui.sid), el = $('deskctx');
  el.hidden = !c;
  if (c) {
    el.className = `deskctx lv-${c.lv}${c.stale ? ' stale' : ''}`;
    const w = `${Math.max(0, Math.min(100, c.pct ?? 0))}%`; if (el.firstChild.style.width !== w) el.firstChild.style.width = w;
    const t = `실장 컨텍스트 ${c.pct == null ? '—' : `${Math.round(c.pct)}%`} · ${tokKo(c.used)}/${tokKo(c.size)} 토큰`;
    if (el.title !== t) { el.title = t; el.setAttribute('aria-label', t); }
  }
}
$('ctx-body').addEventListener('click', ev => { if (ev.target.closest('[data-a="ctx-more"]')) { ui.ctxAll = !ui.ctxAll; renderLimits(); } });
function renderPanel(sel, k) { renderLimits(); renderUsage(false); renderMeter(k); renderNow(sel.room); renderDeleg(k); }
function overviewFloors() {
  return floorRows().filter(r => r.proj).map(r => {
    const chars = [];
    for (const p of r.projs) for (const rm of Object.values(state.floors[p]?.rooms || {})) for (const c of Object.values(rm.chars)) if (c.leaveAt == null) {
      const v = view(c, rm.sid); chars.push({ id: `${rm.sid}|${c.id}`, model: v.model, room: placeOf(c, rm.sid, rm) === 'ceo-q' ? 'elevator' : c.room, name: displayName(v), blocked: c.blocked });
    }
    return { n: r.n, proj: r.proj, label: r.label, chars };
  });
}
$('overview').addEventListener('click', ev => { const b = ev.target.closest('.ov-fl'); if (b) selectFloor(b.dataset.proj, 'click'); });

// ---------------- 19:00 퇴근 인사 (secretary.js: once a day; ?bye=1 forces it, &day=YYYY-MM-DD previews a day's look) ----------------
let byeOpen = null;
function maybeBye(force) {
  const d = new Date(), key = `office.bye.${ymd(d)}`;
  if (byeOpen || (!force && (d.getHours() !== 19 || d.getMinutes() >= 30 || store.get(key)))) return;
  if (!force) store.set(key, '1');
  const q = new URLSearchParams(location.search).get('day'), m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(q || '');
  const date = force && m ? new Date(+m[1], +m[2] - 1, +m[3], 19) : d;
  const prev = document.activeElement;
  byeOpen = openSecretary({ date, reduced: reducedMotion.matches, onClose: () => { byeOpen = null; try { prev?.focus?.({ preventScroll: true }); } catch { /* gone */ } } });
}

// ---------------- frame loop ----------------
let raf = 0, animT = 0;
function kick() { if (!raf) raf = requestAnimationFrame(frame); }
function frame(now) {
  raf = 0; clearTimeout(animT);
  drain();
  if (sceneDirty || panelDirty || bldDirty) {
    const sel = select(), list = lastList = visibleQueue(mergeQueue(ceoList(waiting, Date.now())), dismissed), k = compliance(state);   // sent-back occurrences stay gone after a reconnect replays history
    queueKeys = new Set(list.map(q => q.key));
    renderTabs(sel);
    stage.classList.toggle('ov', ui.overview); $('overview').hidden = !ui.overview;
    if (sceneDirty) { syncScene(sel.room); renderCeo(list); if (ui.overview) renderOverview($('overview'), overviewFloors()); sceneDirty = false; }
    if (bldDirty) { renderBuilding(k, list); bldDirty = false; }
    if (panelDirty && now - lastPanelAt > 250) { renderPanel(sel, k); panelDirty = false; lastPanelAt = now; }
    renderReader();
  }
  renderTicker(now);
  const moving = move(now), anim = animate(now);
  if (moving || panelDirty || queue.length || tickerWaiting) kick();
  else if (anim) animT = setTimeout(kick, 120);
}

new ResizeObserver(() => { if (fit()) { for (const sp of sprites.values()) position(sp); sceneDirty = true; } kick(); }).observe($('scene-wrap'));
narrowMQ.addEventListener('change', () => { layoutOverlays(); fit(); });
bindTips($('tip'));
buildLabels();
fit();
applyTheme();
mountClock({ cal: $('cal'), clocks: [$('wclock'), $('mclock')], compact: $('ceo-date') });
maybeBye(/[?&]bye=1/.test(location.search));
// "(v0.2.3)" next to the title: the version the running server was started from (plugin.json), so a stale install shows.
fetch('/healthz').then(r => (r.ok ? r.json() : null)).then(h => {
  if (typeof h?.version !== 'string') return;
  const el = $('ver'); el.textContent = `(v${h.version})`; el.hidden = false;
}).catch(() => {});
connect();
kick();
if (narrowMQ.matches) requestAnimationFrame(() => { stage.scrollLeft = Math.max(0, MAIN_SEAT.x * S - stage.clientWidth / 2); });
