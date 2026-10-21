// AI Team Office v3 — voxel-style pixel art drawn in code (no image files, no copied textures).
// Characters: 16×24 body grid (8×8 block head, 8×8 torso, 4×8 limbs) on a 24×32 canvas, shown at the world scale with
// image-rendering: pixelated. Seated at a desk the body drops 6px and the legs are hidden; back views face a desk or rack. The 4px side / 8px top margin holds props and status overlays (cloud, sweat, bolt).
// Every (look, model, pose, frame, prop, fx) combination is drawn once, outlined, and cached.

export const SW = 24, SH = 32;
const OX = 4, OY = 8;
export const MODEL_HEX = { fable: '#8b5cf6', opus: '#3b5bdb', sonnet: '#12a594', haiku: '#f0a020', unknown: '#9aa3af' };
const OUT = '#2b2230', EYE = '#2b2230', WHITE = '#ffffff';

const hx = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
/** f < 0 darkens toward black, f > 0 lightens toward white. */
export function shade(h, f) {
  const t = f < 0 ? 0 : 255, k = Math.abs(f);
  return '#' + hx(h).map(v => Math.round(v + (t - v) * k).toString(16).padStart(2, '0')).join('');
}

// Clothes and hair are fixed per job so the job reads first; the model color only shows on the lanyard.
const LOOKS = {
  ceo:     { hair: '#3a2a22', skin: '#f2c6a0', top: '#2c3e70', pants: '#1f2c52', shoe: '#191820', shirt: '#f4f1ea', tie: '#d0453b', tall: 1 },
  fable:   { hair: '#4b2f63', skin: '#f5cfae', top: '#f1ece4', pants: '#3d3550', shoe: '#2a2433', vest: '#7b4fd0', band: '#b48cff', glasses: 1 },
  dev:     { hair: '#5a3b2a', skin: '#eebf98', top: '#4a6fa5', pants: '#2e3440', shoe: '#1d2129', hood: 1 },
  clerk:   { hair: '#2f2a28', skin: '#f3cfb0', top: '#7d8fa8', pants: '#4a5160', shoe: '#22252c', sleeve: '#e9eef4', collar: 1 },
  intern:  { hair: '#c08a4a', skin: '#f6d3b6', top: '#f0c060', pants: '#6b7a8f', shoe: '#3a3330', beret: '#c0504d' },
  qa:      { hair: '#2c2c34', skin: '#e9b993', top: '#f7f7f2', pants: '#3a3f4b', shoe: '#1f2026', pen: '#d64545', coat: 1 },
  ops:     { hair: '#3b3b3b', skin: '#d9a57c', top: '#e67e22', pants: '#34495e', shoe: '#22262b', belt: '#6d4c2f', headset: '#222428' },
  field:   { hair: '#6b4226', skin: '#f0c39e', top: '#7a9a5a', pants: '#4d4436', shoe: '#2b241d', hat: '#a0784a', bag: '#8a5a2b' },
  plan:    { hair: '#8c4b6e', skin: '#f4cdb0', top: '#f2a6b8', pants: '#4b4a5e', shoe: '#2a2930', glasses: 1, postit: '#ffe066' },
  teacher: { hair: '#5b5148', skin: '#efc6a4', top: '#8fb3a0', pants: '#4a4f5c', shoe: '#2a2a2f', glasses: 1 },
  staff:   { hair: '#4a3a30', skin: '#f0c8a8', top: '#a8b4c4', pants: '#4a4f5c', shoe: '#26282e' },
  // the 19:00 secretary (five outfits; smart office wear, knee-length skirt or trousers)
  sec1: { hair: '#5a3825', skin: '#f6d2b8', top: '#2c3e6b', pants: '#e8c9b4', shoe: '#2a2433', skirt: '#5b6170', blouse: 1, long: 1 },
  sec2: { hair: '#1f1c22', skin: '#f2c7a5', top: '#7a2e3e', pants: '#3b3440', shoe: '#1f1b22', blouse: 1, bun: 1, glasses: 1 },
  sec3: { hair: '#8a4f2a', skin: '#f7d6bd', top: '#d9c3a0', pants: '#e8c9b4', shoe: '#5a3a2a', skirt: '#2f3b5c', blouse: 1, bob: 1 },
  sec4: { hair: '#2d2420', skin: '#eec09c', top: '#1f6f73', pants: '#2e3440', shoe: '#1d2129', blouse: 1, long: 1 },
  sec5: { hair: '#9a4a32', skin: '#f6d2b8', top: '#8e7cc3', pants: '#e8c9b4', shoe: '#3a3044', skirt: '#3d3a48', blouse: 1, long: 1, headset: '#3a3d46' },
};

function painter(ctx) {
  return (x, y, c, w = 1, h = 1) => { ctx.fillStyle = c; ctx.fillRect(OX + x, OY + y, w, h); };
}

function drawHead(p, L, y) {
  p(4, y, L.skin, 8, 8);
  p(11, y, shade(L.skin, -0.12), 1, 8);                 // block side shade
  p(4, y, L.hair, 8, 2); p(4, y + 2, L.hair, 1, 2); p(11, y + 2, shade(L.hair, -0.15), 1, 1);
  p(5, y + 4, WHITE); p(6, y + 4, EYE); p(9, y + 4, EYE); p(10, y + 4, WHITE);
  p(7, y + 6, shade(L.skin, -0.3), 2, 1);
  if (L.glasses) { p(5, y + 3, OUT, 2, 1); p(9, y + 3, OUT, 2, 1); p(7, y + 4, OUT, 2, 1); }
  if (L.band) p(4, y + 1, L.band, 8, 1);
  if (L.blouse) { p(5, y + 5, '#f2a0a0'); p(10, y + 5, '#f2a0a0'); p(7, y + 6, '#c4615a', 2, 1); }   // blush + smile
  if (L.long) { p(3, y + 1, L.hair, 1, 9); p(12, y + 1, shade(L.hair, -0.15), 1, 9); p(4, y + 2, L.hair, 1, 1); }
  if (L.bun) { p(6, y - 2, L.hair, 4, 2); p(7, y - 3, shade(L.hair, 0.1), 2, 1); }
  if (L.bob) { p(3, y + 1, L.hair, 1, 6); p(12, y + 1, shade(L.hair, -0.15), 1, 6); p(5, y + 2, L.hair, 3, 1); }
  if (L.beret) { p(3, y - 1, L.beret, 9, 2); p(5, y - 2, L.beret, 5, 1); p(8, y - 3, shade(L.beret, -0.2), 1, 1); }
  if (L.hat) { p(2, y + 1, shade(L.hat, -0.15), 12, 1); p(4, y - 2, L.hat, 8, 3); p(4, y, shade(L.hat, -0.3), 8, 1); }
  if (L.headset) { p(4, y - 1, L.headset, 8, 1); p(3, y + 2, L.headset, 1, 4); p(12, y + 2, L.headset, 1, 4); p(4, y + 6, L.headset, 2, 1); }
}

function drawTorso(p, L, y, model) {
  p(4, y, L.top, 8, 8);
  p(11, y, shade(L.top, -0.15), 1, 8);
  if (L.tie) { p(6, y, L.shirt, 4, 3); p(7, y, L.tie, 2, 5); p(4, y + 7, shade(L.top, -0.25), 8, 1); }
  if (L.vest) { p(4, y, L.vest, 3, 8); p(9, y, L.vest, 3, 8); p(11, y, shade(L.vest, -0.2), 1, 8); }
  if (L.hood) { p(4, y, shade(L.top, -0.2), 8, 1); p(6, y + 1, WHITE, 1, 2); p(9, y + 1, WHITE, 1, 2); p(5, y + 5, shade(L.top, -0.18), 6, 2);
    p(3, y, '#2b2b2b', 2, 2); p(11, y, '#2b2b2b', 2, 2); p(5, y - 1, '#2b2b2b', 6, 1); }        // headphones resting on the neck
  if (L.collar) { p(5, y, WHITE, 2, 1); p(9, y, WHITE, 2, 1); p(7, y, shade(L.top, -0.3), 2, 4); }
  if (L.coat) { p(7, y, shade(L.top, -0.2), 1, 8); p(9, y + 2, L.pen, 2, 2); }
  if (L.belt) { p(4, y + 6, L.belt, 8, 1); p(5, y + 7, '#b8bcc6', 1, 1); p(9, y + 7, '#e0b040', 1, 1); }
  if (L.bag) { for (let i = 0; i < 6; i++) p(5 + i, y + i, shade(L.bag, -0.2)); }
  if (L.postit) p(5, y + 2, L.postit, 2, 2);
  if (L.blouse) { p(6, y, '#ffffff', 4, 3); p(7, y + 3, '#ffffff', 2, 1); p(5, y, shade(L.top, -0.22), 1, 5); p(10, y, shade(L.top, -0.22), 1, 5); p(5, y + 4, '#f2c14e', 2, 1); }
  if (model) {                                          // lanyard + ID card: the only place the model color shows
    const M = MODEL_HEX[model] || MODEL_HEX.unknown;
    p(5, y, M); p(6, y + 1, M); p(10, y, M); p(9, y + 1, M);
    p(7, y + 2, WHITE, 2, 2); p(7, y + 2, M, 2, 1);
  }
}

function drawArm(p, L, x, y, len = 8) {
  p(x, y, L.top, 4, len - 2);
  if (L.sleeve) p(x, y + Math.max(2, len - 5), L.sleeve, 4, 3);   // 팔토시
  if (L.vest) p(x, y, L.top, 4, len - 2);
  p(x, y + len - 2, L.skin, 4, 2);
  p(x + 3, y, shade(L.top, -0.15), 1, len - 2);
}

function drawLegs(p, L, top, liftL, liftR, sit) {
  if (L.skirt && !sit) {                                  // knee-length skirt over tights
    for (const [x, l] of [[4, liftL], [8, liftR]]) { p(x + 1, top + 4, L.pants, 2, 4 - l - 2); p(x, 24 - l - 2, L.shoe, 4, 2); }
    p(4, top, L.skirt, 8, 5); p(11, top, shade(L.skirt, -0.15), 1, 5); p(4, top + 4, shade(L.skirt, -0.2), 8, 1);
    return;
  }
  if (sit) { p(4, top + 3, L.pants, 8, 3); p(4, top + 6, L.shoe, 2, 2); p(10, top + 6, L.shoe, 2, 2); return; }
  for (const [x, l] of [[4, liftL], [8, liftR]]) {
    const bottom = 24 - l;
    p(x, top, L.pants, 4, bottom - 2 - top);
    p(x, bottom - 2, L.shoe, 4, 2);
  }
  p(7, top, shade(L.pants, -0.2), 1, 6);
}

// ---------- props (in front of the body) ----------
const PROPS = {
  laptop(p, y, f) { p(2, y + 4, '#9aa0ab', 12, 5); p(3, y + 5, '#b8bcc6', 10, 3); p(7, y + 6, '#e6e8ec', 2, 1);
    p(2, y + 9, '#6e7480', 12, 1); if (f) p(4 + f * 6, y + 3, '#ffe066'); },
  book(p, y, f) { p(2, y + 3, '#f4ecd8', 12, 5); p(7, y + 3, '#b08850', 2, 5); p(3, y + 4, '#c9bfa8', 3, 1); p(10, y + 5, '#c9bfa8', 3, 1);
    p(2, y + 8, '#8a5a2b', 12, 1); if (f) p(9, y + 1, '#fffaf0', 2, 3); },
  notebook(p, y, f) { p(3, y + 3, '#f6f1e2', 7, 6); p(3, y + 3, '#5a6b7d', 7, 1); p(4, y + 5 + f, '#8a8f9c', 4, 1); p(11, y + 2, '#2b2230', 1, 4); },
  books(p, y) { p(3, y + 3, '#c0504d', 10, 2); p(4, y + 5, '#3b82c4', 9, 2); p(3, y + 7, '#6cc070', 10, 2); },
  magnifier(p, y) { p(13, y - 2, '#8a8f9c', 4, 1); p(13, y + 2, '#8a8f9c', 4, 1); p(12, y - 1, '#8a8f9c', 1, 3); p(17, y - 1, '#8a8f9c', 1, 3);
    p(13, y - 1, '#bfe6f7', 4, 3); p(14, y - 1, WHITE); p(15, y + 3, '#7a5230', 1, 3); },
  stamp(p, y) { p(13, y + 2, '#7a5230', 2, 3); p(12, y + 5, '#d64545', 4, 2); },
  megaphone(p, y) { p(12, y - 1, '#e8e8ee', 2, 3); p(14, y - 2, '#e8e8ee', 2, 5); p(16, y - 3, '#d64545', 2, 7); p(13, y + 2, '#8a8f9c', 1, 2); },
  mug(p, y, f) { const v = y + 4 - f * 3; p(13, v, WHITE, 3, 3); p(16, v + 1, WHITE, 1, 1); p(13, v, '#d64545', 3, 1); if (!f) p(14, v - 3, '#d9dde3', 1, 2); },
  envelope(p, y) { p(1, y + 4, '#f6e7c1', 7, 5); p(2, y + 5, '#d9c08a', 5, 1); p(4, y + 6, '#d64545', 1, 1); },
  clipboard(p, y) { p(1, y + 2, '#a0784a', 7, 8); p(2, y + 3, WHITE, 5, 6); p(3, y + 2, '#8a8f9c', 3, 1); p(3, y + 5, '#8a8f9c', 3, 1); p(3, y + 7, '#8a8f9c', 2, 1); },
  umbrella(p, y) { p(-1, y - 3, '#3b6fb6', 4, 3); p(0, y - 4, '#3b6fb6', 2, 1); p(1, y, '#555b66', 1, 9); p(0, y + 9, '#555b66', 1, 1); },
  wrench(p, y) { p(14, y + 1, '#b8bcc6', 1, 6); p(13, y, '#b8bcc6', 3, 1); p(13, y + 7, '#b8bcc6', 3, 1); },
  marker(p, y) { p(14, y - 1, '#3b82c4', 1, 4); p(14, y - 2, '#1d2129'); },
  phone(p, y) { p(13, y + 1, '#2b2230', 2, 4); p(13, y + 2, '#8fd3f4', 2, 2); },
};

// ---------- overlays (status) in the top margin ----------
const FX = {
  cloud(p) { p(12, -7, WHITE, 5, 1); p(11, -6, WHITE, 8, 3); p(12, -3, WHITE, 6, 1); p(10, -1, WHITE, 1, 1);
    p(12, -5, '#8a8f9c'); p(14, -5, '#8a8f9c'); p(16, -5, '#8a8f9c'); },
  sweat(p) { p(13, 1, '#7cc8f0', 1, 1); p(12, 2, '#7cc8f0', 3, 2); p(13, 2, WHITE); },
  bolt(p) { p(15, -8, '#ffd23f', 3, 2); p(14, -6, '#ffd23f', 3, 2); p(15, -4, '#ffd23f', 3, 1); p(16, -3, '#ffd23f', 2, 2); p(17, -1, '#ffd23f', 1, 1); },
  zz(p) { p(13, -6, '#9cc9f0', 3, 1); p(14, -5, '#9cc9f0'); p(13, -4, '#9cc9f0', 3, 1); p(17, -3, '#9cc9f0', 2, 1); p(17, -2, '#9cc9f0', 2, 1); },
};

function outline(ctx) {
  const img = ctx.getImageData(0, 0, SW, SH), d = img.data, out = new Uint8Array(SW * SH);
  const a = (x, y) => (x < 0 || y < 0 || x >= SW || y >= SH ? 0 : d[(y * SW + x) * 4 + 3]);
  for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) if (!a(x, y) && (a(x - 1, y) || a(x + 1, y) || a(x, y - 1) || a(x, y + 1))) out[y * SW + x] = 1;
  ctx.fillStyle = OUT;
  for (let i = 0; i < out.length; i++) if (out[i]) ctx.fillRect(i % SW, (i / SW) | 0, 1, 1);
}

const WALK = { lift: [[1, 0], [0, 0], [0, 1], [0, 0]], bob: [0, -1, 0, -1], arm: [[-1, 1], [0, 0], [1, -1], [0, 0]] };

// ---------- back view (facing a desk, a monitor or a rack) ----------
function drawHeadBack(p, L, y) {
  p(4, y, L.hair, 8, 8); p(11, y, shade(L.hair, -0.18), 1, 8); p(4, y + 7, shade(L.hair, -0.12), 8, 1);
  p(3, y + 4, L.skin, 1, 2); p(12, y + 4, shade(L.skin, -0.12), 1, 2);               // ears
  if (L.band) p(4, y + 1, L.band, 8, 1);
  if (L.beret) { p(3, y - 1, L.beret, 9, 2); p(5, y - 2, L.beret, 5, 1); }
  if (L.hat) { p(2, y + 1, shade(L.hat, -0.15), 12, 1); p(4, y - 2, L.hat, 8, 3); }
  if (L.headset) { p(4, y - 1, L.headset, 8, 1); p(3, y + 2, L.headset, 1, 4); p(12, y + 2, L.headset, 1, 4); }
  if (L.glasses) { p(3, y + 3, '#2b2230', 1, 1); p(12, y + 3, '#2b2230', 1, 1); }
}
function drawTorsoBack(p, L, y) {
  p(4, y, L.vest || L.top, 8, 8); p(11, y, shade(L.vest || L.top, -0.18), 1, 8);
  if (L.hood) { p(5, y, shade(L.top, -0.2), 6, 3); p(3, y, '#2b2b2b', 2, 2); p(11, y, '#2b2b2b', 2, 2); }
  if (L.coat) p(7, y + 4, shade(L.top, -0.2), 2, 4);
  if (L.tie || L.collar) p(6, y, L.shirt || '#ffffff', 4, 1);
  if (L.belt) p(4, y + 6, L.belt, 8, 1);
  if (L.bag) for (let i = 0; i < 6; i++) p(10 - i, y + i, shade(L.bag, -0.2));
}
/** Seen from behind: seated on a chair (seat 'back') or standing (seat 'standback'). */
function drawBack(p, L, spec, f) {
  const sitting = spec.seat === 'back', pose = spec.pose;
  const by = sitting ? 14 : 8, hy = by - 8;
  if (!sitting) { p(4, 16, L.pants, 4, 6); p(8, 16, shade(L.pants, -0.1), 4, 6); p(4, 22, L.shoe, 4, 2); p(8, 22, L.shoe, 4, 2); }
  const work = pose === 'type' && spec.anim;
  if (pose === 'hand') { drawArm(p, L, 0, by, 7); drawArm(p, L, 12, by - 7, 8); }
  else if (!sitting && work) { drawArm(p, L, 0, by + (f ? 0 : -3), 7); drawArm(p, L, 12, by + (f ? -3 : 0), 7); }
  else { drawArm(p, L, 0, by + (work ? f : 0), sitting ? 6 : 8); drawArm(p, L, 12, by + (work ? 1 - f : 0), sitting ? 6 : 8); }
  drawTorsoBack(p, L, by);
  drawHeadBack(p, L, hy);
  if (sitting) { p(3, by + 4, '#3d4553', 10, 6); p(4, by + 5, '#58637a', 8, 1); p(3, by + 9, '#2a303b', 10, 1); }   // chair back
}

/** Draw one frame. spec: { look, model, pose: stand|walk|type|read|hand|sit|bow, seat?: desk|back|standback, frame, prop, fx } */
export function drawChar(ctx, spec) {
  const L = LOOKS[spec.look] || LOOKS.staff, p = painter(ctx), f = spec.frame | 0;
  const pose = spec.pose || 'stand';
  if (spec.seat === 'back' || spec.seat === 'standback') {
    drawBack(p, L, spec, f);
    const fx = FX[spec.fx]; if (fx) fx(p);
    outline(ctx);
    return;
  }
  const atDesk = spec.seat === 'desk';
  const tall = L.tall && !atDesk ? -1 : 0;
  let bob = 0, liftL = 0, liftR = 0, aL = 0, aR = 0;
  if (pose === 'walk') { [liftL, liftR] = WALK.lift[f % 4]; bob = WALK.bob[f % 4]; [aL, aR] = WALK.arm[f % 4]; }
  if (pose === 'sit') bob = 3;
  if (atDesk) bob = 6;                                   // behind a desk: legs hidden, waist at the desk top
  const by = 8 + bob + tall, hy = pose === 'bow' ? by - 6 : by - 8;
  if (!atDesk) drawLegs(p, L, 16 + tall + Math.min(bob, 0), liftL, liftR, pose === 'sit');
  // arms behind/beside the torso
  if (pose === 'hand') { drawArm(p, L, 0, by, 8); drawArm(p, L, 12, by - 7, 8); }
  else if (pose === 'wave') { drawArm(p, L, 0, by, 8); drawArm(p, L, 12 + f, by - 7 - f, 8); }
  else if (pose === 'sit') { drawArm(p, L, 0, by, atDesk ? 7 : 8); drawArm(p, L, 12, by - 5, 7); }
  else if (pose === 'type' || pose === 'read') { drawArm(p, L, 0, by + (pose === 'type' ? f : 0), 7); drawArm(p, L, 12, by + (pose === 'type' ? 1 - f : 0), 7); }
  else { drawArm(p, L, 0, by + aL, atDesk ? 7 : 8); drawArm(p, L, 12, by + aR, atDesk ? 7 : 8); }
  drawTorso(p, L, by, spec.look === 'ceo' ? null : spec.model);
  drawHead(p, L, hy);
  if (pose === 'sit' && spec.fx === 'bolt') p(11, hy - 1, L.skin, 2, 2);          // scratching the head
  const prop = PROPS[spec.prop];
  if (prop) prop(p, by, f);
  const fx = FX[spec.fx];
  if (fx) fx(p);
  outline(ctx);
}

const cache = new Map();
export function frame(spec) {
  const key = `${spec.look}|${spec.model}|${spec.pose}|${spec.seat || ''}|${spec.anim ? 1 : 0}|${spec.frame | 0}|${spec.prop || ''}|${spec.fx || ''}`;
  let c = cache.get(key);
  if (!c) {
    c = document.createElement('canvas'); c.width = SW; c.height = SH;
    drawChar(c.getContext('2d', { willReadFrequently: true }), spec);
    cache.set(key, c);
    if (cache.size > 600) cache.delete(cache.keys().next().value);
  }
  return { key, canvas: c };
}
/** Paint a spec into a visible 24×32 canvas; returns false when the frame is unchanged. */
export function paint(canvas, spec) {
  const { key, canvas: src } = frame(spec);
  if (canvas._k === key) return false;
  const ctx = canvas._ctx || (canvas._ctx = canvas.getContext('2d'));
  ctx.clearRect(0, 0, SW, SH); ctx.drawImage(src, 0, 0);
  canvas._k = key;
  return true;
}

// ---------- tile textures (16×16, seeded noise; light and dark sets) ----------
function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
const TEX = {
  plank(set, r, d) {                                     // oak-like boards, 4px tall, staggered joints
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const b = y >> 2, seam = (y & 3) === 3, joint = (x + b * 6) % 16 === 0;
      const base = shade(d ? '#6b5440' : '#d2ae7c', (b % 2 ? -0.06 : 0.02) + (r() - 0.5) * 0.08);
      set(x, y, seam || joint ? shade(base, -0.3) : base);
    }
  },
  cobble(set, r, d) {                                    // granite lobby tiles
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const base = d ? '#3d4048' : '#d9d6cf';
      set(x, y, x % 8 === 7 || y % 8 === 7 ? shade(base, -0.15) : shade(base, (r() - 0.5) * 0.1));
    }
  },
  carpet(set, r, d, hue) { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) set(x, y, shade(hue || (d ? '#4b3f6b' : '#c8b6f0'), (r() - 0.5) * 0.1 + ((x + y) % 4 === 0 ? -0.04 : 0))); },
  tile(set, r, d) { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) set(x, y, x % 8 === 0 || y % 8 === 0 ? (d ? '#3a3846' : '#cfd6dc') : shade(d ? '#55606a' : '#f2f6f8', (r() - 0.5) * 0.04)); },
  metal(set, r, d) {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const rivet = [2, 13].includes(x) && [2, 13].includes(y), seam = x === 7 || y === 7;
      const base = d ? '#2f3540' : '#9aa3b2';
      set(x, y, rivet ? shade(base, 0.35) : seam ? shade(base, -0.25) : shade(base, (r() - 0.5) * 0.05));
    }
  },
  grass(set, r, d) { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) set(x, y, shade(d ? '#4f7a4a' : '#8fcf7e', (r() - 0.5) * 0.18 + (r() < 0.08 ? 0.15 : 0))); },
  brick(set, r, d) {                                     // glass curtain-wall facade: panels + mullions (name kept for CSS)
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const mull = x === 0 || y === 0, refl = (x + y) % 16 < 3 && x > 1 && y > 1;
      const base = d ? '#2c3a4e' : '#b9d4ea';
      set(x, y, mull ? (d ? '#1c232e' : '#8496a8') : refl ? shade(base, d ? 0.08 : 0.25) : shade(base, (y / 16) * (d ? -0.1 : -0.12)));
    }
  },
  wall(set, r, d) { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) set(x, y, shade(d ? '#2c2a36' : '#efe4d0', (r() - 0.5) * 0.04 + (y === 15 ? -0.12 : 0))); },
  wool(set, r, d) { TEX.carpet(set, r, d, d ? '#6b2f3a' : '#e58a8a'); },
};
export function texture(kind, dark) {
  const c = document.createElement('canvas'); c.width = c.height = 16;
  const ctx = c.getContext('2d');
  const set = (x, y, col) => { ctx.fillStyle = col; ctx.fillRect(x, y, 1, 1); };
  TEX[kind](set, rng(kind.length * 977 + (dark ? 7 : 3)), dark);
  return c.toDataURL();
}
/** Write --tx-<kind> custom properties for the current theme. Cached per theme. */
const texCache = {};
export function applyTextures(root, dark) {
  const k = dark ? 'd' : 'l';
  texCache[k] ||= Object.fromEntries(Object.keys(TEX).map(n => [n, texture(n, dark)]));
  for (const [n, url] of Object.entries(texCache[k])) root.style.setProperty(`--tx-${n}`, `url(${url})`);
}

// ---------- 8×8 icons ----------
const IC = { k: OUT, w: '#ffffff', r: '#e05a4f', R: '#a83a32', y: '#ffd23f', o: '#f0a020', g: '#6cc070', G: '#3f8a4a', b: '#b07a48',
  B: '#7a5230', c: '#8fd3f4', C: '#3b82c4', l: '#c9ccd3', L: '#8a8f9c', p: '#a77bf3', s: '#f2c6a0' };
const ICONS = {
  book: ['..kkkkk.', '.krrrrrk', '.krwwwrk', '.krrrrrk', '.krwwwrk', '.krrrrrk', '.kwwwwwk', '..kkkkk.'],
  keys: ['........', '.kkkkkk.', '.kCCCCk.', '.kCccCk.', '.kkkkkk.', 'kllllllk', 'kLlLlLlk', '.kkkkkk.'],
  rack: ['.kkkkkk.', '.kLLLLk.', '.kLgLLk.', '.kkkkkk.', '.kLLLLk.', '.kLLyLk.', '.kkkkkk.', '..k..k..'],
  table: ['........', '........', '.kkkkkk.', 'kbbbbbbk', 'kBBBBBBk', '.k....k.', '.k....k.', '........'],
  lens: ['.kkkk...', 'kccwck..', 'kcccck..', 'kcccck..', '.kkkkb..', '.....bb.', '......bb', '........'],
  door: ['.kkkkkk.', '.kbbbbk.', '.kbBbbk.', '.kbbbbk.', '.kbbbyk.', '.kbbbbk.', '.kbbbbk.', '.kkkkkk.'],
  mug: ['........', '.w.w....', '..w.w...', 'kkkkkk..', 'kwwwwkkk', 'kwrrwk.k', 'kwwwwkkk', '.kkkk...'],
  crown: ['........', 'k..k..k.', 'kykykyk.', 'kyyyyyk.', 'kyryryk.', 'kyyyyyk.', 'kkkkkkk.', '........'],
  lift: ['...k....', '..kyk...', '.kyyyk..', 'kkkkkkk.', 'kkkkkkk.', '.kyyyk..', '..kyk...', '...k....'],
  desk: ['........', '..kkkk..', '..kCCk..', '...kk...', 'kbbbbbbk', 'kBBBBBBk', '.k....k.', '.k....k.'],
  chest: ['.kkkkkk.', 'kbbbbbbk', 'kBBBBBBk', 'kkkyykkk', 'kbbyybbk', 'kbbbbbbk', 'kBBBBBBk', '.kkkkkk.'],
  gear: ['...kk...', '.k.kk.k.', '..kLLk..', 'kkL..Lkk', 'kkL..Lkk', '..kLLk..', '.k.kk.k.', '...kk...'],
  tower: ['.kkkkkk.', '.kycyck.', '.kLLLLk.', '.kcycyk.', '.kLLLLk.', '.kycyck.', '.kLbbLk.', 'kkkkkkkk'],
  heart: ['........', '.kk.kk..', 'krrkrrk.', 'krwrrrk.', 'krrrrrk.', '.krrrk..', '..krk...', '...k....'],
  half: ['........', '.kk.kk..', 'krrkLLk.', 'krwrLLk.', 'krrrLLk.', '.krrLk..', '..krk...', '...k....'],
  empty: ['........', '.kk.kk..', 'kLLkLLk.', 'kLLLLLk.', 'kLLLLLk.', '.kLLLk..', '..kLk...', '...k....'],
  bell: ['...k....', '..kyk...', '.kyyyk..', '.kyyyk..', '.kyyyk..', 'kyyyyyk.', 'kkkkkkk.', '...k....'],
  torch: ['...y....', '..yoy...', '..oro...', '...b....', '...b....', '...B....', '...B....', '........'],
  chart: ['........', '......k.', '.....kgk', '..k..kgk', '.kCk.kgk', '.kCkkkgk', '.kCkokgk', 'kkkkkkkk'],
  scroll: ['.kkkkkk.', 'kwwwwwwk', '.kwLLwk.', '.kwwwwk.', '.kwLLwk.', '.kwwwwk.', 'kwwwwwwk', '.kkkkkk.'],
  clock: ['..kkkk..', '.kwwwwk.', 'kwwkwwwk', 'kwwkwwwk', 'kwwkkkwk', 'kwwwwwwk', '.kwwwwk.', '..kkkk..'],
  person: ['..kkkk..', '..ksskk.', '..kssk..', '...kk...', '.kCCCCk.', '.kCCCCk.', '..kLLk..', '..k..k..'],
};
export function iconURL(name) {
  const rows = ICONS[name]; if (!rows) return '';
  const c = document.createElement('canvas'); c.width = c.height = 8;
  const ctx = c.getContext('2d');
  rows.forEach((row, y) => [...row].forEach((ch, x) => { if (IC[ch]) { ctx.fillStyle = IC[ch]; ctx.fillRect(x, y, 1, 1); } }));
  return c.toDataURL();
}
/** --ico-<name> custom properties so CSS can paint icons without per-node data URLs. */
export function applyIcons(root) {
  for (const n of Object.keys(ICONS)) root.style.setProperty(`--ico-${n}`, `url(${iconURL(n)})`);
}
