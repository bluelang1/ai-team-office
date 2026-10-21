// AI Team Office v3 — the floor as one pixel-art picture (drawn in code, no image files, no copied game assets).
// World = 416×344 logical pixels, shown at an integer-ish scale. A modern open office inside a 360° glass curtain wall:
// west (left) the snowy mountains and plains, east (right) a downtown skyline over a park. Sky follows the local clock.
// This module owns: room rectangles, seats (where characters sit), the aisle network (how they walk) and two painters:
// drawWorld() (static, redrawn on theme/sky change) and drawFx() (blinking LEDs, screens; a few Hz).

import { PARK_LAMPS, PATH_Y, coupleAt } from './ambient.js';

export const W = 416, H = 344;
export const AISLE_TOP = 154, AISLE_BOT = 232;
const SPINES = [40, 130, 198, 254, 326];

// ---------- rooms (world coords) ----------
// door: x on the room wall, inY = just inside the room, outY = the aisle in the open office.
export const ROOMS = {
  library:  { x: 8, y: 44, w: 120, h: 76, label: '도서관', icon: 'book', lx: 10, ly: 46, door: { x: 61, inY: 114, outY: AISLE_TOP } },
  pantry:   { x: 130, y: 44, w: 96, h: 76, label: '탕비실', icon: 'mug', lx: 132, ly: 46, door: { x: 196, inY: 114, outY: AISLE_TOP } },
  review:   { x: 228, y: 44, w: 78, h: 76, label: 'QA실', icon: 'lens', lx: 230, ly: 46, door: { x: 266, inY: 114, outY: AISLE_TOP } },
  external: { x: 308, y: 44, w: 100, h: 76, label: '외근·민원실', icon: 'door', lx: 310, ly: 46, door: { x: 372, inY: 114, outY: AISLE_TOP } },
  floor:    { x: 8, y: 120, w: 400, h: 120, label: '사무실', icon: 'desk', lx: 40, ly: 122, door: null },
  server:   { x: 8, y: 240, w: 88, h: 100, label: '서버룸', icon: 'rack', lx: 50, ly: 242, door: { x: 70, inY: 262, outY: AISLE_BOT } },
  meeting:  { x: 98, y: 240, w: 100, h: 100, label: '회의실', icon: 'table', lx: 100, ly: 242, door: { x: 106, inY: 264, outY: AISLE_BOT } },
  bench:    { x: 200, y: 240, w: 72, h: 100, label: '개발실', icon: 'keys', lx: 202, ly: 242, door: { x: 266, inY: 262, outY: AISLE_BOT } },
  ceo:      { x: 274, y: 240, w: 134, h: 100, label: '대표실', icon: 'crown', door: { x: 284, inY: 250, outY: AISLE_BOT } },
  elevator: { x: 12, y: 120, w: 24, h: 28, label: '엘리베이터', icon: 'lift', door: null },
};

// ---------- seats ----------
// kind: desk (sits behind a desk facing you, legs hidden) · back (sits facing away) · sofa (sits, legs visible)
//       stand (stands facing you) · standback (stands facing away, e.g. at a rack or shelf)
// alt: stagger name tags of neighbours so they do not overlap.
const S = (x, y, kind, alt = 0, tb = 0) => ({ x, y, kind, alt, tb });   // tb: desk seat with nobody in front -> tag below
export const SEATS = {
  library: [S(115, 76, 'desk', 0, 1), S(25, 112, 'back'), S(47, 112, 'back', 1), S(75, 112, 'back'), S(97, 112, 'back', 1), S(66, 82, 'standback', 1), S(88, 82, 'standback')],
  pantry: [S(157, 95, 'desk'), S(173, 95, 'desk', 1), S(165, 112, 'back'), S(144, 86, 'standback', 1), S(206, 112, 'stand', 1)],
  review: [S(248, 86, 'desk', 0, 1), S(285, 86, 'desk', 1, 1), S(266, 110, 'stand')],
  external: [S(328, 78, 'desk', 0, 1), S(356, 78, 'desk', 1, 1), S(391, 96, 'stand'), S(326, 114, 'sofa', 1), S(346, 114, 'sofa')],
  server: [S(20, 316, 'standback'), S(38, 316, 'standback', 1), S(56, 316, 'standback'), S(84, 318, 'desk', 1, 1)],
  meeting: [S(124, 296, 'desk'), S(148, 296, 'desk', 1), S(172, 296, 'desk'), S(124, 322, 'back', 1), S(148, 322, 'back'), S(172, 322, 'back', 1), S(108, 300, 'stand', 1)],
  bench: [S(214, 284, 'back'), S(233, 284, 'back', 1), S(252, 284, 'back'), S(222, 312, 'desk', 1, 1), S(248, 312, 'desk', 0, 1)],
  // open office: [0..5] = reducer desks (6-cluster), then 4-cluster, singles, lounge sofa. `main` is separate.
  floor: [S(59, 178, 'desk'), S(85, 178, 'desk', 1), S(111, 178, 'desk'), S(59, 212, 'back', 1), S(85, 212, 'back'), S(111, 212, 'back', 1),
    S(149, 178, 'desk'), S(175, 178, 'desk', 1), S(149, 212, 'back', 1), S(175, 212, 'back'),
    S(273, 206, 'back'), S(305, 206, 'back', 1), S(348, 226, 'sofa'), S(370, 226, 'sofa', 1)],
};
export const MAIN_SEAT = S(226, 176, 'desk');
export const ELEVATOR_SPOT = { x: 24, y: 156 };
export const DROP_SPOT = { x: 240, y: 200 };            // in front of the 실장 desk (대표 drops the 지시서)

/** The aisle point a spot is reached from, plus the in-room waypoints after it. */
export function chainOf(room, spot) {
  const r = ROOMS[room];
  if (room === 'floor' || room === 'desk' || room === 'main') {
    const ay = spot.kind === 'desk' || spot.kind === 'standback' ? AISLE_TOP : AISLE_BOT;
    return [{ x: spot.x, y: ay }];
  }
  if (room === 'elevator') return [{ x: spot.x, y: AISLE_TOP }];
  if (room === 'drop') return [{ x: spot.x, y: AISLE_BOT }];
  if (!r?.door) return [{ x: spot.x, y: AISLE_TOP }];
  // through the door, down the in-room lane (door.x), then along the seat's row: behind the table for `desk`
  // seats, in front of it for everyone else, so nobody walks across a table.
  const d = r.door, rowY = spot.kind === 'desk' ? spot.y - 12 : spot.y;
  return [{ x: d.x, y: d.outY }, { x: d.x, y: d.inY }, { x: d.x, y: rowY }, { x: spot.x, y: rowY }];
}
const nearestAisle = y => (Math.abs(y - AISLE_TOP) <= Math.abs(y - AISLE_BOT) ? AISLE_TOP : AISLE_BOT);
/** Polyline (world coords, excluding `from`) from a point to a spot via the aisles. `fromChain` = chain of where we stand. */
export function route(from, fromChain, toRoom, to) {
  const out = [];
  const back = fromChain ? fromChain.slice().reverse() : [{ x: from.x, y: nearestAisle(from.y) }];
  out.push(...back);
  const a = back[back.length - 1], tc = chainOf(toRoom, to), b = tc[0];
  if (a.y !== b.y) {
    let best = SPINES[0], bd = Infinity;
    for (const s of SPINES) { const d = Math.abs(a.x - s) + Math.abs(s - b.x); if (d < bd) { bd = d; best = s; } }
    out.push({ x: best, y: a.y }, { x: best, y: b.y });
  }
  out.push(...tc, { x: to.x, y: to.y });
  // drop zero-length legs
  const pts = []; let p = from;
  for (const q of out) { if (Math.abs(q.x - p.x) + Math.abs(q.y - p.y) > 0.5) pts.push(q); p = q; }
  return pts;
}

// ---------- palette ----------
const PAL = {
  light: {
    wall: '#f3f1ec', wallCap: '#dcd6cc', wallBase: '#c9c1b4', wallLine: '#b9b0a2',
    wood: '#ead6b2', woodLine: '#d8bf95', woodAlt: '#e4cda5', tile: '#f1f3f5', grout: '#d7dce1', terr: '#e9e5de', terrDot: '#cfc8bc',
    carpetBlue: '#c4d2e2', carpetWarm: '#ead7c3', carpetSage: '#cddcc6', carpetLav: '#d6d0ea', carpetCeo: '#e7dccb', rug: '#c88f6f', rugIn: '#e3b598',
    raised: '#d9dde3', raisedLine: '#b4bcc6', perf: '#9aa5b2',
    deskTop: '#f7f3ec', deskEdge: '#fffdf8', deskFace: '#d9d0c1', deskShade: '#c3b8a6', leg: '#8b929c',
    oak: '#d4a877', oakFace: '#b3854f', oakDark: '#8c6238',
    chair: '#3d4553', chairHi: '#58637a', chairSeat: '#4a5466',
    mon: '#2a2f37', screenOff: '#3d4654', screenOn: '#86d3f2', screenOn2: '#a6ecc9',
    pot: '#ece6dc', potShade: '#cdc5b8', terracotta: '#c9805b', leaf: '#5aa461', leafHi: '#7cc472', leafDk: '#3d7f49',
    glass: 'rgba(170, 214, 240, 0.42)', glassHi: 'rgba(255, 255, 255, 0.75)', glassEdge: '#9cc3dc', mullion: '#7d8894', frame: '#5d6772',
    metal: '#aab2bc', metalDk: '#7c8590', white: '#ffffff', ink: '#2b2f36', paper: '#fbfaf6',
    rack: '#2b3038', rackHi: '#3d4450', unit: '#4a525e', unitHi: '#5d6672', tray: '#e2b13c', trayDk: '#a77d1d',
  },
  dark: {
    wall: '#3a3d48', wallCap: '#2c2f38', wallBase: '#25272f', wallLine: '#22242b',
    wood: '#6b5842', woodLine: '#5a4936', woodAlt: '#655340', tile: '#454a54', grout: '#373b44', terr: '#4a4740', terrDot: '#3b3832',
    carpetBlue: '#3a475a', carpetWarm: '#55483d', carpetSage: '#3f4d40', carpetLav: '#474260', carpetCeo: '#4f4538', rug: '#7a4c3a', rugIn: '#8f6048',
    raised: '#454b55', raisedLine: '#353a42', perf: '#2d3138',
    deskTop: '#cfc8bb', deskEdge: '#e2dccf', deskFace: '#9f9686', deskShade: '#857d6e', leg: '#5f656e',
    oak: '#9a744d', oakFace: '#7a5733', oakDark: '#5c3f22',
    chair: '#1e222a', chairHi: '#363d4b', chairSeat: '#2b313c',
    mon: '#16191e', screenOff: '#262c35', screenOn: '#5fb8e0', screenOn2: '#7fd6a8',
    pot: '#a7a196', potShade: '#857f75', terracotta: '#8f5a40', leaf: '#3f7a46', leafHi: '#55955a', leafDk: '#2b5833',
    glass: 'rgba(110, 160, 200, 0.28)', glassHi: 'rgba(200, 230, 255, 0.35)', glassEdge: '#4d6a80', mullion: '#2f353d', frame: '#262b32',
    metal: '#6f7782', metalDk: '#4c535d', white: '#e8e8e8', ink: '#e8e8ee', paper: '#d8d4ca',
    rack: '#14171c', rackHi: '#232830', unit: '#2c323b', unitHi: '#3a414c', tray: '#9c7a26', trayDk: '#6e5617',
  },
};

// ---------- tiny drawing kit ----------
let ctx = null, P = PAL.light;
const R = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };
function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
const hx = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
function mix(a, b, t) { const A = hx(a), B = hx(b); return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join(''); }
function shade(h, f) { return mix(h, f < 0 ? '#000000' : '#ffffff', Math.abs(f)); }

function planks(x, y, w, h, base, line, alt, seed) {
  const r = rng(seed);
  R(x, y, w, h, base);
  for (let yy = y; yy < y + h; yy += 5) {
    const row = (yy - y) / 5 | 0, off = (row * 13) % 28;
    if (row % 3 === 1) R(x, yy, w, 4, alt);
    R(x, yy + 4, w, 1, line);
    for (let xx = x - off; xx < x + w; xx += 28 + ((r() * 3) | 0)) if (xx > x) R(xx, yy, 1, 4, line);
  }
}
function tiles(x, y, w, h, base, grout, size) {
  R(x, y, w, h, base);
  for (let yy = y + size - 1; yy < y + h; yy += size) R(x, yy, w, 1, grout);
  for (let xx = x + size - 1; xx < x + w; xx += size) R(xx, y, 1, h, grout);
}
function carpet(x, y, w, h, base, seed) {
  R(x, y, w, h, base);
  const r = rng(seed), dk = shade(base, -0.06), lt = shade(base, 0.08);
  for (let i = 0; i < (w * h) / 14; i++) R(x + ((r() * w) | 0), y + ((r() * h) | 0), 1, 1, r() < 0.5 ? dk : lt);
  R(x, y, w, 1, shade(base, -0.1)); R(x, y + h - 1, w, 1, shade(base, -0.1)); R(x, y, 1, h, shade(base, -0.1)); R(x + w - 1, y, 1, h, shade(base, -0.1));
}
function terrazzo(x, y, w, h, seed) {
  R(x, y, w, h, P.terr);
  const r = rng(seed);
  for (let i = 0; i < (w * h) / 10; i++) R(x + ((r() * w) | 0), y + ((r() * h) | 0), 1, 1, r() < 0.7 ? P.terrDot : shade(P.terr, 0.12));
}
/** Back wall face (seen from the front) with cap and baseboard. */
function wallFace(x, y, w, h) {
  R(x, y, w, h, P.wall); R(x, y, w, 2, P.wallCap); R(x, y + h - 2, w, 2, P.wallBase);
}
function glassFace(x, y, w, h) {
  R(x, y, w, h, P.glass); R(x, y, w, 1, P.glassEdge); R(x, y + h - 1, w, 1, P.glassEdge);
  for (let i = 4; i < w; i += 22) { R(x + i, y + 2, 1, h - 4, P.glassHi); R(x + i + 2, y + 4, 1, h - 8, P.glassHi); }
  for (let i = 0; i < w; i += 30) R(x + i, y, 1, h, P.glassEdge);
}
function glassSide(x, y, h) { R(x, y, 2, h, P.glassEdge); R(x, y, 1, h, P.glassHi); }
function wallSide(x, y, h) { R(x, y, 2, h, P.wallCap); R(x + 2, y, 1, h, P.wallLine); }

// ---------- furniture ----------
function desk(x, y, w, d, opts = {}) {
  const top = opts.wood ? P.oak : P.deskTop, face = opts.wood ? P.oakFace : P.deskFace;
  R(x, y, w, d, top); R(x, y, w, 1, opts.wood ? shade(P.oak, 0.18) : P.deskEdge);
  R(x, y + d, w, 4, face); R(x, y + d + 3, w, 1, opts.wood ? P.oakDark : P.deskShade);
  R(x + 1, y + d + 4, 2, 2, P.leg); R(x + w - 3, y + d + 4, 2, 2, P.leg);
}
function chairFront(cx, y) {            // chair behind a desk, facing you (mostly hidden by the sitter)
  R(cx - 5, y, 10, 7, P.chair); R(cx - 4, y + 1, 8, 2, P.chairHi);
}
function chairBack(cx, y) {             // chair in front of a desk, seen from behind
  R(cx - 5, y, 10, 8, P.chair); R(cx - 4, y + 1, 8, 1, P.chairHi);
  R(cx - 6, y + 8, 12, 2, P.chairSeat); R(cx - 1, y + 10, 2, 2, P.leg); R(cx - 4, y + 12, 8, 1, P.leg);
}
function monitor(cx, y, w = 10) {       // screen faces you; frame + stand. y = top of frame
  R(cx - w / 2, y, w, 7, P.mon); R(cx - w / 2 + 1, y + 1, w - 2, 5, P.screenOff);
  R(cx - 1, y + 7, 2, 2, P.mon); R(cx - 3, y + 9, 6, 1, P.mon);
}
function laptopClosed(cx, y) { R(cx - 4, y, 8, 2, P.metal); R(cx - 4, y + 2, 8, 1, P.metalDk); }
function papers(x, y) { R(x, y, 5, 4, P.paper); R(x + 1, y - 1, 5, 4, P.white); R(x + 2, y, 3, 1, P.metal); }
function mug(x, y, c = '#d6604f') { R(x, y, 3, 3, P.white); R(x, y, 3, 1, c); R(x + 3, y + 1, 1, 1, P.white); }
function plant(x, y, size = 1, pot = P.pot) {   // x,y = bottom-left of pot
  const pw = 6 + size * 2, ph = 5 + size;
  R(x, y - ph, pw, ph, pot); R(x, y - ph, pw, 1, shade(pot, 0.15)); R(x + pw - 2, y - ph, 2, ph, P.potShade);
  const cx = x + pw / 2, top = y - ph;
  const leaves = [[0, -3, 3], [-3, -5, 3], [3, -6, 3], [-1, -8, 3], [2, -10, 2], [-4, -9, 2], [4, -3, 2]];
  for (const [dx, dy, r] of leaves.slice(0, 4 + size)) {
    const lx = cx + dx * (1 + size * 0.25), ly = top + dy * (1 + size * 0.35);
    R(lx - r, ly - r + 1, r * 2, r * 2 - 1, P.leaf); R(lx - r + 1, ly - r + 1, r, 1, P.leafHi); R(lx - r, ly + r - 1, r * 2, 1, P.leafDk);
  }
}
function tallPlant(x, y) { plant(x, y, 2, P.terracotta); R(x + 4, y - 22, 2, 6, P.leafDk); R(x + 1, y - 26, 8, 5, P.leaf); R(x + 2, y - 26, 3, 1, P.leafHi); }
function bookshelf(x, y, w, h, seed) {  // y = top. Wood frame, shelves every 7px, books of many colours.
  const BOOK = ['#c0504d', '#e1a64a', '#3b82c4', '#5aa461', '#8e6cc9', '#2f9e96', '#d9775a', '#f0cf5a', '#5d6b85', '#b5577e', '#e9e3d6', '#3d5a80'];
  const r = rng(seed);
  R(x, y, w, h, P.oakFace); R(x, y, w, 2, P.oak); R(x + w - 2, y, 2, h, P.oakDark);
  for (let sy = y + 2; sy + 6 <= y + h - 2; sy += 7) {
    R(x + 2, sy, w - 4, 6, shade(P.oakDark, -0.2));
    let bx = x + 2;
    while (bx < x + w - 3) {
      const bw = 1 + ((r() * 2.4) | 0), bh = 3 + ((r() * 3) | 0), c = BOOK[(r() * BOOK.length) | 0];
      if (r() < 0.07) { bx += 2; continue; }
      R(bx, sy + 6 - bh, bw, bh, c); if (bw > 1) R(bx, sy + 6 - bh, 1, bh, shade(c, 0.18));
      bx += bw;
    }
    R(x + 2, sy + 6, w - 4, 1, P.oak);
  }
  R(x, y + h - 1, w, 1, P.oakDark);
}
function ladder(x, y, h) { R(x, y, 1, h, P.oakDark); R(x + 6, y, 1, h, P.oakDark); for (let yy = y + 3; yy < y + h; yy += 4) R(x, yy, 7, 1, P.oak); }
function lamp(x, y) { R(x, y, 1, 4, P.metalDk); R(x - 3, y - 2, 7, 2, '#2f7d4f'); R(x - 2, y - 3, 5, 1, '#3f9a63'); R(x - 2, y + 4, 5, 1, P.metalDk); }
function copier(x, y) {                 // y = top
  R(x, y, 24, 6, '#e9ecef'); R(x + 2, y + 1, 12, 3, '#cfd5db'); R(x + 16, y + 1, 6, 2, '#5d6b7a'); R(x + 17, y + 1, 1, 1, '#64d97b');
  R(x, y + 6, 24, 18, '#d8dde2'); R(x, y + 6, 24, 1, '#f5f7f9'); R(x + 2, y + 9, 20, 3, '#bfc6ce'); R(x + 2, y + 14, 20, 3, '#bfc6ce');
  R(x + 2, y + 19, 20, 3, '#bfc6ce'); R(x + 22, y + 6, 2, 18, '#b4bcc5'); R(x - 4, y + 9, 4, 1, '#f5f7f9'); R(x - 4, y + 10, 4, 2, P.white);
}
function waterCooler(x, y) {            // y = top of bottle
  R(x + 2, y, 6, 8, '#9fd4f2'); R(x + 3, y + 1, 1, 6, '#d4eefb'); R(x + 3, y + 8, 4, 1, '#7fb6d6');
  R(x, y + 9, 10, 16, '#eef1f4'); R(x + 8, y + 9, 2, 16, '#cdd3d9'); R(x + 2, y + 12, 2, 2, '#4a7fd4'); R(x + 6, y + 12, 2, 2, '#d9534f');
  R(x + 1, y + 16, 8, 1, '#cdd3d9');
}
function sofa(x, y, w, c) {             // facing you; y = top of backrest
  R(x, y, w, 7, c); R(x, y, w, 1, shade(c, 0.2)); R(x - 2, y + 3, 3, 10, shade(c, -0.12)); R(x + w - 1, y + 3, 3, 10, shade(c, -0.12));
  R(x, y + 7, w, 5, shade(c, 0.1)); R(x, y + 12, w, 3, shade(c, -0.2)); R(x + w / 2, y + 7, 1, 5, shade(c, -0.1));
}
function rack(x, y, seed) {             // y = top face; 16 wide, front 38 tall with 1U/2U units
  const r = rng(seed);
  R(x, y, 16, 4, P.rackHi); R(x, y + 4, 16, 38, P.rack); R(x, y + 42, 16, 2, '#111');
  let yy = y + 6;
  while (yy < y + 40) {
    const u = r() < 0.35 ? 4 : 2;
    R(x + 2, yy, 12, u - 1, P.unit); R(x + 2, yy, 12, 1, P.unitHi);
    if (u === 4) { R(x + 4, yy + 1, 5, 1, '#1d2127'); R(x + 4, yy + 2, 5, 1, '#1d2127'); }
    yy += u;
  }
  R(x + 1, y + 4, 1, 38, '#5a6270'); R(x + 14, y + 4, 1, 38, '#5a6270');
}
function crac(x, y) {                   // computer-room air conditioner: tall cabinet with vents and a display
  R(x, y, 18, 4, '#e7eaee'); R(x, y + 4, 18, 40, '#d3d8de'); R(x + 16, y + 4, 2, 40, '#b8bfc7');
  R(x + 3, y + 7, 10, 5, '#1f2a36'); R(x + 4, y + 8, 4, 1, '#62e0a1');
  for (let yy = y + 15; yy < y + 40; yy += 3) R(x + 2, yy, 13, 1, '#a9b1ba');
}

// ---------- exterior (through the glass) ----------
const SKY = {
  morning: { top: '#8ab4e6', bot: '#fbdcb3', sun: [372, 22, '#ffe7a0', 5], snow: '#fff4ea', far: '#9fa9cc', near: '#7f9a86', plain: '#9fd07a', plain2: '#8cc169',
    bld: ['#b9c2d0', '#a5b0c2', '#cbd2dc', '#95a2b5'], win: '#eef4fb', park: '#79b862', tree: '#4f9452', water: '#8fd0ee' },
  day: { top: '#5aa2ea', bot: '#d3ecfb', sun: [300, 8, '#fff3b0', 5], snow: '#ffffff', far: '#8ea5c8', near: '#6f9476', plain: '#95cf6f', plain2: '#82c060',
    bld: ['#a9b7c9', '#8fa2b8', '#c4cdd8', '#7e93ab'], win: '#e7f2fb', park: '#72b75a', tree: '#46904c', water: '#7cc8ee' },
  evening: { top: '#52529e', mid: '#e5826b', bot: '#f7c27c', sun: [92, 30, '#ffb35c', 7], snow: '#f8d2c2', far: '#7c6b9e', near: '#5d5a6e', plain: '#8d9a5c', plain2: '#7a8a50',
    bld: ['#6d6a8a', '#5e5b7a', '#7b7896', '#545170'], win: '#ffd88a', park: '#5d7f4a', tree: '#3d5e3a', water: '#c99ab0' },
  night: { top: '#0a1230', bot: '#26325f', moon: [330, 9], snow: '#9aa6c6', far: '#2d3756', near: '#1f2a36', plain: '#24402e', plain2: '#1d3527',
    bld: ['#1b2238', '#161c30', '#222a44', '#121828'], win: '#ffd56b', park: '#1e3a28', tree: '#15291c', water: '#24406a' },
};
const HORIZON = 36;
function skyBand(x0, y0, w, h, S) {
  for (let y = 0; y < h; y += 2) {
    const t = y / Math.max(1, h - 2);
    const c = S.mid ? (t < 0.55 ? mix(S.top, S.mid, t / 0.55) : mix(S.mid, S.bot, (t - 0.55) / 0.45)) : mix(S.top, S.bot, t);
    R(x0, y0 + y, w, 2, c);
  }
}
function drawExterior(sky) {
  const S = SKY[sky] || SKY.day;
  skyBand(0, 0, W, 44, S);
  const r = rng(7);
  if (sky === 'night') {
    for (let i = 0; i < 70; i++) R((r() * W) | 0, (r() * 30) | 0, 1, 1, r() < 0.8 ? '#dfe6ff' : '#fff2b0');
    const [mx, my] = S.moon; R(mx - 3, my - 3, 7, 7, '#f4f1dc'); R(mx - 4, my - 2, 9, 5, '#f4f1dc'); R(mx, my - 3, 4, 4, '#dcd8bf'); R(mx + 1, my - 3, 4, 6, mix(S.top, S.bot, 0.3));
  } else {
    const [sx, sy, sc, sr] = S.sun;
    R(sx - sr, sy - sr + 2, sr * 2, sr * 2 - 4, sc); R(sx - sr + 2, sy - sr, sr * 2 - 4, sr * 2, sc);
    R(sx - sr - 2, sy - 1, 2, 2, shade(sc, 0.3)); R(sx + sr, sy - 1, 2, 2, shade(sc, 0.3));
    for (const [cx, cy, cw] of [[40, 8, 22], [150, 5, 18], [250, 12, 26], [380, 6, 16]]) {   // clouds
      const cc = sky === 'evening' ? '#f3b9a4' : sky === 'morning' ? '#fff3e6' : '#ffffff';
      R(cx, cy, cw, 3, cc); R(cx + 4, cy - 2, cw - 10, 2, cc); R(cx + 2, cy + 3, cw - 4, 1, shade(cc, -0.08));
    }
  }
  // west: snowy peaks (two layers) over plains
  const peaks = [[6, 22], [26, 14], [48, 25], [70, 12], [96, 20], [118, 10], [142, 19], [166, 13], [190, 21], [214, 28]];
  const ridge = x => { let best = 40; for (const [px, py] of peaks) best = Math.min(best, py + Math.abs(x - px) * 0.62); return best; };
  for (let x = 0; x < 230; x++) {
    const top = Math.round(ridge(x)), fade = x > 200 ? (x - 200) / 30 : 0;
    if (top >= HORIZON) continue;
    const far = mix(S.far, S.top, fade * 0.6);
    R(x, top, 1, HORIZON - top, far);
    const snowH = Math.max(0, Math.round(5 - (top - 10) * 0.35));
    if (snowH) R(x, top, 1, snowH, mix(S.snow, far, fade));
    if (((x * 7) % 11) === 0 && top < 30) R(x, top + snowH, 1, 2, shade(far, -0.12));
  }
  const near = x => 31 + Math.round(Math.sin(x * 0.07) * 2 + Math.sin(x * 0.19) * 1.2);
  for (let x = 0; x < 214; x++) { const t = near(x); R(x, t, 1, HORIZON - t, S.near); }
  R(0, HORIZON, 214, 44 - HORIZON, S.plain);
  for (let y = HORIZON + 1; y < 44; y += 3) R(0, y, 214, 1, S.plain2);
  for (let x = 6; x < 206; x += 23) { R(x, HORIZON - 2, 2, 3, S.tree); R(x - 1, HORIZON - 4, 4, 2, S.tree); }   // tree line
  // east: downtown skyline over a park
  const rb = rng(31);
  let x = 208;
  while (x < W) {
    const w = 6 + ((rb() * 10) | 0), h = 8 + ((rb() * 22) | 0) + (x > 300 && x < 345 ? 6 : 0), c = S.bld[(rb() * 4) | 0];
    const top = HORIZON + 2 - h;
    R(x, top, w, h, c); R(x, top, 1, h, shade(c, 0.12)); R(x + w - 1, top, 1, h, shade(c, -0.12));
    for (let wy = top + 2; wy < HORIZON - 1; wy += 3) for (let wx = x + 2; wx < x + w - 2; wx += 2) {
      const lit = sky === 'night' ? rb() < 0.42 : sky === 'evening' ? rb() < 0.18 : rb() < 0.5;
      if (lit) R(wx, wy, 1, 1, sky === 'night' || sky === 'evening' ? S.win : shade(S.win, -0.05 * ((wx + wy) % 3)));
    }
    x += w + ((rb() * 2) | 0);
  }
  R(336, 2, 8, 34, S.bld[2]); R(337, 2, 1, 34, shade(S.bld[2], 0.15)); R(339, -2, 2, 4, S.bld[1]);   // the tall tower with a spire
  for (let wy = 5; wy < 34; wy += 3) for (let wx = 338; wx < 343; wx += 2) R(wx, wy, 1, 1, sky === 'night' ? (wy % 2 ? S.win : '#9fd3ff') : shade(S.win, -0.04));
  R(214, HORIZON, W - 214, 44 - HORIZON, S.park);
  R(268, HORIZON + 3, 26, 3, S.water); R(272, HORIZON + 2, 18, 1, S.water); R(271, HORIZON + 6, 20, 1, S.water);
  const rt = rng(5);
  for (let tx = 216; tx < W; tx += 5 + ((rt() * 5) | 0)) {
    if (tx > 266 && tx < 296) continue;
    const ty = HORIZON + 1 + ((rt() * 3) | 0);
    R(tx, ty, 4, 3, S.tree); R(tx + 1, ty - 1, 2, 1, S.tree); R(tx + 1, ty + 3, 1, 1, shade(S.tree, -0.3));
    if (sky !== 'night') R(tx + 1, ty, 1, 1, shade(S.tree, 0.2));
  }
  if (sky === 'night') for (const lx of PARK_LAMPS) {                                                             // park lamps
    R(lx, HORIZON + 1, 1, 5, '#3a4250'); R(lx, HORIZON, 1, 1, '#ffe39a');
    ctx.fillStyle = 'rgba(255, 220, 140, 0.18)'; ctx.fillRect(lx - 2, HORIZON - 1, 5, 3); ctx.fillRect(lx - 1, HORIZON + 2, 3, 4);
  }
  // glass: mullions, transom, reflections, sill
  const mull = sky === 'night' ? '#2c333c' : P.mullion;
  R(0, 0, W, 2, P.frame);
  for (let mx = 0; mx <= W; mx += 32) R(Math.min(mx, W - 2), 0, 2, 44, mull);
  for (let i = 10; i < W; i += 64) { ctx.fillStyle = 'rgba(255,255,255,0.10)'; for (let k = 0; k < 14; k++) ctx.fillRect(i + k, 30 - k * 2, 2, 2); }
  R(0, 42, W, 2, P.frame);
  // side glass strips + bottom sill
  for (const [sx, west] of [[0, true], [W - 8, false]]) {
    for (let y = 44; y < H; y += 4) R(sx, y, 8, 4, mix(S.bot, west ? S.plain : S.park, Math.min(1, (y - 44) / 260) * 0.9));
    for (let y = 44; y < H; y += 40) R(sx, y, 8, 2, mull);
    R(west ? sx + 7 : sx, 44, 1, H - 44, P.frame); R(west ? sx + 2 : sx + 5, 50, 1, H - 60, 'rgba(255,255,255,0.18)');
  }
  R(0, H - 4, W, 4, P.frame); R(8, H - 4, W - 16, 1, P.glassEdge);
}

// ---------- rooms ----------
function drawLibrary() {
  const r = ROOMS.library;
  carpet(r.x, r.y, r.w, r.h, P.carpetWarm, 11);
  bookshelf(52, 44, 24, 30, 3); bookshelf(77, 44, 24, 30, 9);
  ladder(97, 47, 28);
  R(10, 52, 3, 60, P.oakFace); R(10, 52, 1, 60, P.oak); for (let y = 56; y < 110; y += 7) R(12, y, 2, 5, ['#c0504d', '#3b82c4', '#5aa461', '#e1a64a', '#8e6cc9', '#2f9e96', '#d9775a', '#5d6b85'][(y >> 3) % 8]);   // side shelf
  R(18, 64, 20, 6, P.oak); R(18, 70, 20, 2, P.oakFace); for (let x = 19; x < 37; x += 3) R(x, 60 + (x % 2), 2, 4, ['#c0504d', '#3b82c4', '#f0cf5a', '#5aa461'][x % 4]);
  R(20, 72, 2, 2, P.leg); R(34, 72, 2, 2, P.leg);                                                   // book cart
  R(41, 57, 7, 7, '#5aa0d8'); R(42, 58, 3, 2, '#7cc472'); R(45, 61, 2, 2, '#7cc472'); R(44, 64, 1, 5, P.oakDark); R(41, 69, 7, 2, P.oakDark);   // globe
  desk(104, 70, 22, 10); chairFront(115, 63); papers(107, 72); R(120, 71, 4, 3, '#8e6cc9'); R(120, 70, 4, 1, '#b39ae0');      // librarian desk
  for (const [tx, lx] of [[14, 36], [64, 86]]) { desk(tx, 88, 44, 10, { wood: true }); lamp(lx, 86); R(tx + 6, 91, 6, 3, P.paper); R(tx + 30, 91, 5, 3, '#c0504d'); }
  for (const x of [25, 47, 75, 97]) chairBack(x, 102);
  plant(116, 116, 1);
}
function drawPantry() {
  const r = ROOMS.pantry;
  tiles(r.x, r.y, r.w, r.h, P.tile, P.grout, 8);
  // counter against the glass
  R(132, 62, 70, 8, '#e9ecef'); R(132, 62, 70, 1, P.white); R(132, 70, 70, 8, '#8fa3b5'); R(132, 77, 70, 1, '#71859a');
  for (let x = 140; x < 200; x += 16) R(x, 71, 1, 6, '#71859a');
  R(138, 46, 12, 16, '#2f343c'); R(139, 47, 10, 4, '#444b55'); R(141, 52, 6, 3, '#1d2026'); R(143, 55, 2, 3, '#7a5230'); R(140, 58, 8, 4, '#3a4049'); R(146, 48, 2, 1, '#64d97b'); // coffee machine
  mug(152, 59); mug(156, 59, '#3b82c4');
  R(162, 54, 12, 8, '#d7dce1'); R(163, 55, 8, 6, '#2b3038'); R(172, 56, 1, 3, '#8b929c');   // microwave
  R(178, 63, 10, 4, '#b8c4ce'); R(182, 58, 1, 5, P.metal); R(182, 58, 3, 1, P.metal);         // sink + tap
  R(186, 46, 14, 16, '#c9ced4'); for (let y = 49; y < 62; y += 4) R(186, y, 14, 1, '#9aa3ad');   // snack shelf
  for (const [sx, sy, c] of [[187, 47, '#e1574c'], [191, 47, '#f2c14e'], [195, 47, '#4aa3df'], [188, 51, '#5bbf6a'], [193, 51, '#e98ac0'], [187, 55, '#f29a3a'], [192, 55, '#8e6cc9'], [196, 55, '#e1574c'], [189, 59, '#f2c14e'], [194, 59, '#4aa3df']])
    R(sx, sy, 3, 2, c);
  R(204, 42, 18, 36, '#e9edf1'); R(204, 42, 18, 1, P.white); R(220, 42, 2, 36, '#c3cad2'); R(204, 58, 16, 1, '#c3cad2'); R(206, 46, 1, 8, '#9aa3ad'); R(206, 61, 1, 10, '#9aa3ad'); // fridge
  R(210, 47, 3, 3, '#f2c14e'); R(213, 49, 3, 3, '#e98ac0');                                 // fridge magnets
  // round table + stools
  chairFront(157, 82); chairFront(173, 82);
  R(150, 89, 30, 10, P.deskTop); R(148, 91, 34, 6, P.deskTop); R(150, 89, 30, 1, P.deskEdge); R(150, 99, 30, 3, P.deskFace); R(164, 102, 2, 4, P.leg); R(160, 105, 10, 1, P.leg);
  mug(156, 91); R(170, 92, 6, 3, '#f2c14e');
  chairBack(165, 102);
  plant(208, 116, 2, P.terracotta);
}
function drawReview() {
  const r = ROOMS.review;
  tiles(r.x, r.y, r.w, r.h, P.tile, P.grout, 10);
  R(232, 50, 14, 26, '#c9ced4'); for (let y = 52; y < 76; y += 8) { R(233, y, 12, 7, '#dfe3e7'); R(237, y + 3, 4, 1, '#8b929c'); }   // filing cabinet
  R(250, 64, 30, 10, '#e1e6eb'); R(250, 74, 30, 3, '#b8c0c9'); R(253, 60, 8, 4, '#4aa36a'); R(263, 60, 8, 4, '#e1574c'); R(273, 61, 5, 3, P.paper);  // pass/fail trays on a credenza
  plant(290, 76, 1);
  for (const x of [248, 285]) { chairFront(x, 73); desk(x - 14, 80, 28, 12); papers(x + 5, 82); R(x - 10, 83, 4, 3, '#d64545'); R(x - 9, 82, 2, 1, '#7a5230'); }
  R(276, 80, 1, 3, P.metalDk); R(273, 79, 7, 1, P.metalDk);   // magnifier lamp
}
function drawExternal() {
  const r = ROOMS.external;
  terrazzo(r.x, r.y, r.w, r.h, 23);
  R(314, 48, 26, 16, P.oakFace); R(314, 48, 26, 1, P.oak); for (let x = 316; x < 338; x += 6) { R(x, 50, 5, 5, '#c8a26a'); R(x, 57, 5, 5, '#b98f57'); }   // parcel shelf
  R(346, 48, 18, 12, '#2b3a55'); R(348, 50, 14, 8, '#6fa0d8'); R(352, 52, 6, 4, '#9fd37a');   // world map screen
  for (const x of [328, 356]) chairFront(x, 65);
  R(314, 72, 56, 10, '#f3efe6'); R(314, 72, 56, 1, P.white); R(314, 82, 56, 8, '#4f6d8f'); R(314, 89, 56, 1, '#3c5674'); R(338, 84, 8, 3, '#f2c14e');   // counter
  R(341, 70, 3, 2, '#e1b13c');   // desk bell
  // phone booth (glass box)
  R(378, 46, 26, 52, P.glass); R(378, 46, 26, 2, P.frame); R(378, 46, 1, 52, P.frame); R(403, 46, 1, 52, P.frame); R(378, 97, 26, 1, P.frame);
  R(392, 58, 6, 8, '#3a4049'); R(393, 59, 4, 3, '#8fd3f4'); R(381, 50, 1, 40, P.glassHi);
  sofa(316, 100, 40, '#6d8fb8');
  plant(362, 118, 1);
}
function drawOffice() {
  const r = ROOMS.floor;
  wallFace(8, 120, 400, 28);
  planks(8, 148, 400, 92, P.wood, P.woodLine, P.woodAlt, 41);
  carpet(42, 160, 152, 64, P.carpetBlue, 51);
  carpet(200, 158, 52, 46, P.carpetWarm, 61);
  carpet(332, 200, 64, 32, P.carpetSage, 71);
  // elevator core
  R(10, 120, 28, 28, '#c9ced6'); R(10, 120, 28, 1, '#e4e8ed');
  // doors into the top-row rooms
  for (const name of ['library', 'pantry', 'review', 'external']) {
    const d = ROOMS[name].door;
    R(d.x - 7, 124, 14, 24, P.wallLine); R(d.x - 6, 125, 12, 23, name === 'pantry' ? shade(P.tile, -0.05) : name === 'external' ? P.terr : name === 'library' ? P.carpetWarm : P.tile);
    R(d.x - 6, 125, 12, 1, P.wallBase);
  }
  // wall decor: framed pictures, team sign, clock-free (the clock lives in 대표실)
  for (const [fx, c1, c2] of [[84, '#7fb0d9', '#9fd37a'], [126, '#f2b880', '#e1574c'], [236, '#a8c7e8', '#5aa461'], [306, '#c9b6ea', '#f2c14e']]) {
    R(fx, 127, 16, 12, P.oakFace); R(fx + 1, 128, 14, 10, c1); R(fx + 1, 134, 14, 4, c2); R(fx + 4, 130, 3, 3, P.white);
  }
  R(150, 126, 30, 13, '#2b3a55'); R(152, 128, 26, 9, '#3d5a80'); for (let i = 0; i < 5; i++) R(154 + i * 5, 133 - i, 3, 3 + i, ['#9fd37a', '#f2c14e', '#86d3f2', '#e98ac0', '#f29a3a'][i]);   // team dashboard TV
  R(330, 128, 34, 10, '#ffffff'); R(331, 129, 32, 8, '#eaf2fb'); for (let i = 0; i < 4; i++) R(334 + i * 8, 131, 5, 4, ['#f2c14e', '#e98ac0', '#86d3f2', '#9fd37a'][i]);   // sticky-note board
  // 6-cluster and 4-cluster (rear row faces you, front row faces the monitors)
  for (const [x0, n] of [[46, 3], [136, 2]]) {
    for (let i = 0; i < n; i++) chairFront(x0 + 13 + i * 26, 164);
    desk(x0, 172, n * 26, 24);
    R(x0, 183, n * 26, 2, 'rgba(160, 200, 225, 0.85)'); R(x0, 183, n * 26, 1, P.white);     // low frosted divider
    for (let i = 0; i < n; i++) {
      const cx = x0 + 13 + i * 26;
      laptopClosed(cx, 175); if (i % 2) mug(cx + 7, 174); else papers(cx - 11, 175);
      monitor(cx, 186);
      chairBack(cx, 200);
    }
  }
  // 실장 desk (wood, bigger)
  R(214, 160, 24, 10, P.chair); R(216, 161, 20, 3, P.chairHi);
  desk(204, 170, 44, 12, { wood: true }); R(206, 172, 8, 5, '#2a2f37'); R(207, 173, 6, 3, '#4c7bb5'); mug(236, 173); R(240, 172, 6, 4, P.paper);
  plant(250, 190, 0);
  // singles (face the monitors)
  for (const x of [260, 292]) { desk(x, 180, 26, 12); monitor(x + 13, 181); R(x + 2, 183, 5, 3, P.paper); chairBack(x + 13, 194); }
  // copier, water cooler, plants, lounge
  copier(334, 160); waterCooler(366, 160); tallPlant(388, 190);
  sofa(338, 204, 42, '#d98f6a'); R(384, 214, 10, 8, P.oak); R(384, 222, 10, 2, P.oakFace); mug(387, 212);
  plant(12, 238, 2, P.terracotta);
  R(36, 228, 10, 6, '#c7ccd2'); R(37, 227, 8, 1, '#e4e8ed');     // recycle bin
}
function drawServer() {
  const r = ROOMS.server;
  wallFace(8, 240, 88, 16);
  tiles(8, 256, 88, 84, P.raised, P.raisedLine, 8);
  for (let y = 259; y < 340; y += 16) for (let x = 11; x < 96; x += 16) for (let k = 0; k < 3; k++) R(x + k * 2, y + (k % 2), 1, 1, P.perf);   // perforated tiles
  R(12, 242, 24, 12, '#1d2530'); R(13, 243, 22, 10, '#22303f');      // monitoring screen (fx draws the graph)
  R(40, 244, 10, 6, '#c9ced4'); for (let y = 245; y < 250; y += 2) R(41, y, 8, 1, '#9aa3ad');   // vent
  R(10, 252, 58, 3, P.tray); R(10, 255, 58, 1, P.trayDk);              // cable tray
  for (const x of [17, 22, 35, 40, 53, 58]) R(x, 255, 1, 4, ['#3b82c4', '#e1574c', '#f2c14e'][x % 3]);
  for (let i = 0; i < 3; i++) rack(12 + i * 18, 258, 100 + i);
  crac(76, 256);
  R(66, 241, 8, 15, P.wallLine);   // doorway
  desk(72, 312, 22, 8); R(80, 313, 6, 3, '#2a2f37'); R(81, 314, 4, 1, '#62e0a1'); chairFront(84, 305);
}
function drawMeeting() {
  const r = ROOMS.meeting;
  glassFace(98, 240, 100, 16);
  carpet(98, 256, 100, 84, P.carpetLav, 81);
  R(130, 241, 30, 17, '#1d2127'); R(131, 242, 28, 13, '#26303c'); R(143, 258, 4, 2, '#1d2127');     // TV (fx draws the chart)
  R(164, 242, 30, 14, P.white); R(164, 242, 30, 1, '#c9ced4'); R(164, 255, 30, 2, '#9aa3ad');        // whiteboard
  R(167, 245, 12, 1, '#3b82c4'); R(167, 248, 18, 1, '#3b82c4'); R(167, 251, 8, 1, '#d64545'); R(183, 250, 6, 4, '#f2c14e');
  R(100, 244, 12, 12, P.wallLine); R(101, 245, 10, 11, P.glass);   // glass door
  for (const x of [124, 148, 172]) chairFront(x, 283);
  desk(112, 290, 72, 16, { wood: true });
  for (const x of [124, 148, 172]) { R(x - 3, 293, 6, 4, P.paper); R(x - 2, 292, 6, 4, P.white); }
  R(146, 300, 6, 3, '#3a4049');                                     // conference phone
  for (const x of [124, 148, 172]) chairBack(x, 310);
  plant(184, 338, 1);
  glassSide(96, 240, 100); glassSide(198, 240, 100);
}
function drawBench() {
  const r = ROOMS.bench;
  wallFace(200, 240, 72, 16);
  planks(200, 256, 72, 84, P.woodAlt, P.woodLine, P.wood, 91);
  R(206, 242, 30, 12, '#e8edf2'); R(206, 242, 30, 1, '#c9ced4'); for (let i = 0; i < 3; i++) R(207 + i * 10, 243, 9, 10, i === 1 ? '#dbe8f5' : '#eef3f7');   // kanban
  for (const [k, c] of [[0, '#f2c14e'], [1, '#e98ac0'], [2, '#9fd37a'], [3, '#86d3f2'], [4, '#f2c14e']]) R(209 + (k % 3) * 10, 245 + (k > 2 ? 4 : 0), 5, 3, c);
  R(240, 243, 16, 10, '#2b3a55'); R(242, 245, 12, 6, '#f29a3a');   // poster
  R(262, 241, 8, 15, P.wallLine);                                  // doorway
  desk(204, 258, 58, 12);
  for (const cx of [214, 233, 252]) { monitor(cx - 5, 249, 8); monitor(cx + 5, 249, 8); R(cx - 4, 266, 8, 2, '#3a4049'); }
  for (const cx of [214, 233, 252]) chairBack(cx, 274);
  for (const cx of [222, 248]) chairFront(cx, 299);
  desk(208, 306, 54, 10, { wood: true }); laptopClosed(222, 309); laptopClosed(248, 309); mug(234, 308);
  plant(262, 338, 0);
}
function drawCeo() {
  const r = ROOMS.ceo;
  glassFace(274, 240, 44, 34); R(279, 246, 12, 28, P.wallLine); R(280, 247, 10, 27, P.glass); R(288, 258, 1, 4, P.metal);   // glass wall + door
  R(318, 240, 90, 34, P.oakFace); for (let x = 320; x < 408; x += 9) R(x, 241, 1, 33, P.oakDark); R(318, 240, 90, 2, P.oak); R(318, 272, 90, 2, P.oakDark);  // wood panel
  carpet(274, 274, 134, 66, P.carpetCeo, 99);
  R(300, 296, 60, 34, P.rug); R(302, 298, 56, 30, P.rugIn); R(304, 300, 52, 26, P.rug);
  R(320, 276, 16, 12, P.oakFace); R(320, 276, 16, 2, P.oak); R(323, 279, 3, 6, '#3b82c4'); R(327, 280, 3, 5, '#c0504d'); R(331, 279, 2, 6, '#f2c14e');   // credenza
  glassSide(272, 240, 100);
}

/** Paint the static world. opts: { dark, sky } */
export function drawWorld(canvas, opts) {
  ctx = canvas.getContext('2d'); P = opts.dark ? PAL.dark : PAL.light;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);
  drawExterior(opts.sky);
  drawLibrary(); drawPantry(); drawReview(); drawExternal();
  for (const x of [128, 226, 306]) wallSide(x, 44, 76);
  drawOffice();
  drawServer(); drawMeeting(); drawBench(); drawCeo();
  wallSide(96, 240, 0);
}

// ---------- animated layer ----------
const LEDS = (() => {
  const r = rng(77), out = [];
  for (let i = 0; i < 3; i++) for (let y = 264; y < 298; y += 2) if (r() < 0.75) out.push({ x: 12 + i * 18 + 12 + ((r() * 2) | 0), y, c: r() < 0.8 ? '#4ef08a' : '#ffc94a', ph: r() * 6, sp: 0.5 + r() * 1.8 });
  return out;
})();
// screens that light up when someone sits at the seat: [room, seat index, x, y, w, h]
const SCREENS = [
  ['floor', 3, 55, 187, 8, 5], ['floor', 4, 81, 187, 8, 5], ['floor', 5, 107, 187, 8, 5], ['floor', 8, 145, 187, 8, 5], ['floor', 9, 171, 187, 8, 5],
  ['floor', 10, 269, 182, 8, 5], ['floor', 11, 301, 182, 8, 5],
  ['bench', 0, 206, 250, 6, 5], ['bench', 0, 216, 250, 6, 5], ['bench', 1, 225, 250, 6, 5], ['bench', 1, 235, 250, 6, 5], ['bench', 2, 244, 250, 6, 5], ['bench', 2, 254, 250, 6, 5],
];
/** Animated details. state: { t, dark, sky, taken: Set('room:i'), busy: {room: n}, still } */
export function drawFx(canvas, st) {
  const c = canvas.getContext('2d');
  ctx = c; P = st.dark ? PAL.dark : PAL.light;
  c.clearRect(0, 0, W, H);
  const t = st.still ? 0 : st.t / 1000, busy = st.busy || {};
  // server LEDs: faster and brighter when the server room is busy
  for (const l of LEDS) {
    const on = st.still ? l.ph > 2 : Math.sin(t * l.sp * (busy.server ? 6 : 1.4) + l.ph) > (busy.server ? -0.2 : 0.3);
    R(l.x, l.y, 1, 1, on ? l.c : '#1d2a22');
  }
  // monitoring screen: scrolling graph
  for (let i = 0; i < 20; i++) { const v = Math.sin((i + t * (busy.server ? 6 : 2)) * 0.6) * 2 + Math.sin((i + t * 3) * 1.3); R(14 + i, 248 + Math.round(v), 1, 1, busy.server ? '#62e0a1' : '#3fa673'); }
  R(14, 244, 6, 1, '#86d3f2');
  // meeting TV: tiny bar chart + trend line
  for (let i = 0; i < 6; i++) { const h = 3 + Math.round((Math.sin(i * 1.7 + (busy.meeting ? t * 2 : 0)) + 1) * 3); R(134 + i * 4, 253 - h, 3, h, ['#86d3f2', '#9fd37a', '#f2c14e', '#e98ac0', '#86d3f2', '#9fd37a'][i]); }
  R(133, 243, 10, 1, '#ffffff');
  // seat screens
  for (const [room, i, x, y, w, h] of SCREENS) {
    if (!st.taken?.has(`${room}:${i}`)) continue;
    R(x, y, w, h, (i + x) % 2 ? P.screenOn : P.screenOn2);
    if (!st.still) R(x + 1 + (Math.floor(t * 3 + x) % (w - 2)), y + 1 + ((x >> 1) % (h - 1)), 2, 1, '#ffffff');
  }
  // coffee machine steam when someone is in the pantry
  if (busy.pantry && !st.still) for (let k = 0; k < 3; k++) { const yy = 44 - ((t * 8 + k * 4) % 10); R(143 + (k % 2), yy, 1, 2, 'rgba(255,255,255,0.8)'); }
  // aircraft warning light on the tall tower (night/evening)
  if ((st.sky === 'night' || st.sky === 'evening') && (st.still || Math.floor(t) % 2 === 0)) R(339, 0, 2, 2, '#ff4a4a');
  // copier busy light
  R(355, 161, 1, 1, Math.floor(t * 2) % 2 && !st.still ? '#64d97b' : '#2f7a43');
}

// ---------- night life through the glass (ambient.js decides when; this draws) ----------
const behindFrame = x => x % 32 < 2 || x < 1 || x >= W - 1;                         // mullions stay in front
function px(c, x, y, col, a = 1) { if (y < 0 || y > 41 || behindFrame(x)) return; c.globalAlpha = a; c.fillStyle = col; c.fillRect(x, y, 1, 1); }
/** Draw the shooting star and the strolling couples of `amb` at time t onto the fx canvas (world coords). */
export function drawAmbient(canvas, amb, t) {
  if (!amb.on) return;
  const c = canvas.getContext('2d');
  const s = amb.star;
  if (s) {
    const p = Math.min(1, (t - s.t0) / s.dur), e = 1 - (1 - p) ** 2, fade = Math.sin(Math.PI * p);
    const hx = s.x0 + (s.x1 - s.x0) * e, hy = s.y0 + (s.y1 - s.y0) * e, len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
    const ux = (s.x1 - s.x0) / len, uy = (s.y1 - s.y0) / len;
    for (let k = 0; k < 16; k++) px(c, Math.round(hx - ux * k), Math.round(hy - uy * k), k < 3 ? '#ffffff' : '#cfe2ff', Math.min(1, fade * 1.3) * (1 - k / 16));
    px(c, Math.round(hx) + 1, Math.round(hy), '#ffffff', fade * 0.5); px(c, Math.round(hx), Math.round(hy) - 1, '#ffffff', fade * 0.5);
  }
  for (const cp of amb.couples) {
    const st = coupleAt(cp, t), x = Math.round(st.x), y = PATH_Y, a = st.alpha, step = st.walking ? Math.floor(t / 260) % 2 : 0;
    const gap = st.moment === 'hug' ? 2 : 3, lean = st.moment === 'kiss' && st.mt > 300 && st.mt < cp.stop.len - 300 ? 1 : 0;
    const person = (x0, look, side) => {
      const [hair, top, pants] = look, h = side === 'L' ? lean : -lean;
      px(c, x0 + h, y - 4, hair, a); px(c, x0 + 1 + h, y - 4, hair, a);
      px(c, x0 + h, y - 3, '#f2c6a0', a); px(c, x0 + 1 + h, y - 3, '#e8b48c', a);
      px(c, x0, y - 2, top, a); px(c, x0 + 1, y - 2, top, a); px(c, x0, y - 1, top, a); px(c, x0 + 1, y - 1, top, a);
      px(c, x0 + (step && side === 'L' ? 1 : 0), y, pants, a); if (!step) px(c, x0 + 1, y, pants, a);
    };
    const xa = x, xb = x + gap;
    person(xa, cp.a, 'L'); person(xb, cp.b, 'R');
    if (st.moment === 'hug') { px(c, xa + 2, y - 2, '#f2c6a0', a); px(c, xb - 1, y - 2, '#f2c6a0', a); }
    else px(c, xa + 2, y - 1, '#f2c6a0', a);                                         // holding hands
    if (st.moment === 'kiss' && st.mt > 300) {                                         // a tiny heart floats up
      const k = Math.min(1, (st.mt - 300) / 1400), hy = y - 7 - Math.round(k * 5), hx = xa + 1, ha = a * (1 - k * 0.8);
      for (const [dx, dy] of [[0, 0], [2, 0], [0, 1], [1, 1], [2, 1], [1, 2]]) px(c, hx + dx, hy + dy, '#ff6f91', ha);
    }
  }
  c.globalAlpha = 1;
}
