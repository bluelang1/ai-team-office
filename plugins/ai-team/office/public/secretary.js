// AI Team Office — 19:00 퇴근 인사: 냥비서 하린. A chubby pixel-art office cat (96×112 logical px drawn in code on a
// <canvas>, shown 3× with image-rendering: pixelated; no images, no libraries) who says one line per day in 해요체
// with a typewriter reveal, a mouth that follows the Korean vowel of each syllable (ω / small / O / wide), blinks,
// twitching ears, a swishing tail, expressions and paw gestures cued by the words. Fur and accessories rotate daily.
// Pure parts (the day's look and line, lip timeline, cues, renderFrame -> RGBA pixels) are exported for tests.
// The DOM part (openSecretary) only runs while the popup is open and removes everything on close.

// ---------------- deterministic picks ----------------
export function hash32(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0; h ^= h >>> 12;
  return h >>> 0;
}
const pad2 = n => String(n).padStart(2, '0');
/** Local date -> 'YYYY-MM-DD'. */
export const dayKey = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
/** 'YYYY-MM-DD' of the day before (local calendar arithmetic, no time zones). */
export function prevDay(key) {
  const [y, m, d] = key.split('-').map(Number), t = new Date(y, m - 1, d - 1);
  return dayKey(t);
}

// Fur (pattern + palette + eye colour). pattern: tabby | tuxedo | calico | points | socks | solid
export const FURS = [
  { id: 'orange', name: '치즈 태비', pattern: 'tabby', base: '#f2a65a', mark: '#d07a2a', belly: '#fff1dc', eyes: 'green' },
  { id: 'gray', name: '고등어 태비', pattern: 'tabby', base: '#a7adb9', mark: '#6c7180', belly: '#f1f2f6', eyes: 'amber' },
  { id: 'tuxedo', name: '턱시도', pattern: 'tuxedo', base: '#34323a', belly: '#fbf7f1', paws: '#fbf7f1', eyes: 'yellow' },
  { id: 'calico', name: '삼색이', pattern: 'calico', base: '#fbf7f1', belly: '#ffffff', eyes: 'amber' },
  { id: 'ragdoll', name: '랙돌 포인트', pattern: 'points', base: '#fbf3e6', mark: '#8a6a55', belly: '#ffffff', ears: '#8a6a55', paws: '#e9dccb', eyes: 'blue' },
  { id: 'socks', name: '양말 신은 까만 고양이', pattern: 'socks', base: '#2b2a31', belly: '#3a3940', paws: '#fbf7f1', eyes: 'yellow' },
  { id: 'cream', name: '크림', pattern: 'solid', base: '#f6dfb8', belly: '#fff6e6', eyes: 'blue' },
];
/** The day's look: fur, then 1–2 office accessories from different groups (neck / head / face / body), all seeded by the local date. */
export function pickLook(key) {
  const fur = FURS[hash32(`${key}|fur`) % FURS.length];
  const a1 = ACCESSORIES[hash32(`${key}|acc1`) % ACCESSORIES.length], acc = [a1];
  if (hash32(`${key}|acc2?`) % 10 < 6) {
    const rest = ACCESSORIES.filter(a => a.group !== a1.group);
    acc.push(rest[hash32(`${key}|acc2`) % rest.length]);
  }
  return { key, fur, acc: acc.map((a, i) => ({ ...a, color: ACC_COLORS[hash32(`${key}|col${i}`) % ACC_COLORS.length] })) };
}

// ---------------- lines and cues ----------------
// Each line = segments; a segment's gesture comes from its words (cueOf) unless given. wink: playful wink on that segment.
export const MESSAGES = [
  [['대표님, 7시예요!'], [' 오늘도 수고 많으셨어요.'], [' 이제 퇴근하세요~ 냥 🌙']],
  [['대표님, 벌써 저녁 7시예요.'], [' 남은 일은 팀에게 맡기고'], [' 오늘은 푹 쉬세요. 퇴근하세요~ 냥 🐾']],
  [['벌써 7시예요, 대표님!'], [' 오늘 결재도 회의도 정말 잘하셨어요.'], [' 이제 퇴근하실 시간이에요~ 냥']],
  [['대표님, 퇴근 시간이에요!'], [' 밤에는 서버도 팀도 제가 잘 지켜볼게요 🌙'], [' 내일 또 화이팅해요, 냥!']],
  [['대표님, 7시 됐어요.'], [' 커피는 내일 아침에 제가 내려 드릴게요 ☕', null, true], [' 오늘은 이만 퇴근하세요~ 냥 🐾']],
  [['오늘 하루도 고생 많으셨어요, 대표님.'], [' 맛있는 저녁 드시고 푹 쉬세요.'], [' 내일 아침에 뵐게요, 화이팅 냥!']],
  [['대표님, 오늘도 최고였어요!'], [' 회의도 결재도 척척, 정말 멋지셨어요.'], [' 이제 퇴근하세요~ 냥 🐾']],
  [['대표님, 저녁 7시예요.'], [' 밤공기가 선선하니 따뜻하게 입고 가세요 🌙'], [' 오늘도 수고 많으셨어요, 냥!']],
  [['7시 알림이에요, 대표님!'], [' 오늘 쌓인 피로는 여기 두고 가세요.'], [' 퇴근하시고 내일 또 화이팅해요~ 냥!']],
  [['대표님, 퇴근 시간이에요.'], [' 내일 커피는 제가 준비해 둘게요 ☕'], [' 오늘도 정말 잘하셨어요~ 냥!']],
];
/** Gesture for a piece of text (first match wins). The first segment of a line is always a greeting bow. */
export function cueOf(text, first = false) {
  if (first) return 'bow';
  const t = String(text);
  if (/☕|커피/.test(t)) return 'coffee';
  if (/퇴근/.test(t)) return 'wave';
  if (/🌙|밤/.test(t)) return 'cheek';
  if (/내일|화이팅/.test(t)) return 'fist';
  if (/잘하셨|최고|멋지/.test(t)) return 'thumbs';
  if (/수고|고생/.test(t)) return 'clap';
  return 'idle';
}
export const EXPR = { bow: 'warm', clap: 'proud', thumbs: 'proud', wave: 'happy', coffee: 'playful', cheek: 'warm', fist: 'happy', idle: 'warm' };
/** Day number of a 'YYYY-MM-DD' key (calendar days, no time zones). */
const dayNo = key => { const [y, m, d] = key.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };
const ANCHOR = dayNo('2026-01-01');
/** Index of the day's line: a seeded walk from 2026-01-01 that always moves 1..N-1 steps, so no day repeats the
 *  day before (also across month/year ends). Days before the anchor walk backwards the same way. */
export function messageIndex(key) {
  const N = MESSAGES.length, n = dayNo(key) - ANCHOR, step = i => 1 + (hash32(`msg|${i}`) % (N - 1));
  let idx = hash32('msg|anchor') % N;
  if (n >= 0) for (let i = 1; i <= n; i++) idx = (idx + step(i)) % N;
  else for (let i = 0; i > n; i--) idx = (idx - step(i) + N * 2) % N;
  return idx;
}
/** Line for a date: different from the day before. Returns { idx, segs:[{text, cue, expr, wink}] }. */
export function pickMessage(key) {
  const idx = messageIndex(key);
  const segs = MESSAGES[idx].map(([text, cue, wink], i) => { const c = cue || cueOf(text, i === 0); return { text, cue: c, expr: EXPR[c], wink: !!wink }; });
  return { idx, segs };
}

// ---------------- lip timeline ----------------
const BILABIAL_CHO = new Set([6, 7, 8, 17]);          // ㅁ ㅂ ㅃ ㅍ
const BILABIAL_JONG = new Set([16, 17, 26]);          // ㅁ ㅂ ㅍ
const V_A = new Set([0, 1, 2, 3, 4, 6, 9, 10]);       // ㅏ ㅐ ㅑ ㅒ ㅓ ㅕ ㅘ ㅙ  (open)
const V_O = new Set([8, 12, 13, 14, 17]);             // ㅗ ㅛ ㅜ ㅝ ㅠ        (round)
/** Hangul syllable -> {cho, jung, jong} or null. */
export function hangul(ch) {
  const c = ch.codePointAt(0) - 0xac00;
  if (c < 0 || c > 11171) return null;
  return { cho: Math.floor(c / 588), jung: Math.floor((c % 588) / 28), jong: c % 28 };
}
/** Mouth for a jungseong index: 'A' open, 'O' round, 'I' wide (ㅔ ㅖ ㅚ ㅞ ㅟ ㅡ ㅢ ㅣ). */
export const mouthOfVowel = j => (V_A.has(j) ? 'A' : V_O.has(j) ? 'O' : 'I');
/** Steps [{at, n (chars shown), mouth, seg}] for segments, ~70ms per syllable; punctuation/emoji pause with a closed mouth. */
export function timeline(segs, per = 70) {
  const steps = []; let at = 0, n = 0;
  const push = (mouth, dur, seg) => { steps.push({ at, n, mouth, seg }); at += dur; };
  segs.forEach((s, si) => {
    for (const ch of Array.from(s.text)) {
      n++;
      const h = hangul(ch);
      if (h) {
        const v = mouthOfVowel(h.jung), m1 = BILABIAL_CHO.has(h.cho), m2 = BILABIAL_JONG.has(h.jong);
        if (m1) push('M', 20, si);
        push(v, per - (m1 ? 20 : 0) - (m2 ? 20 : 0), si);
        if (m2) push('M', 20, si);
      } else if (ch === ' ') push('rest', 45, si);
      else if (ch === ',') push('rest', 200, si);
      else if ('.!?'.includes(ch)) push('rest', 320, si);
      else if (ch === '~') push('I', 160, si);
      else if (/[0-9A-Za-z]/.test(ch)) push('I', 60, si);
      else push('rest', 360, si);                      // emoji and other symbols: a smiling pause
    }
  });
  return { steps, total: at, chars: n };
}


// ---------------- pixel art (96×112 logical px, shown 3×) ----------------
// renderFrame(look, state) -> { w, h, data: Uint8ClampedArray RGBA }: polygon/ellipse masks painted with a ramp
// (highlight / base / mid / dark) and a 1-px selective outline, plus hand-placed detail pixels. Static layers are
// cached per look; head (ear state), tail (swish frame) and paws (pose frame) are cached per variant.
export const PW = 96, PH = 112;
const hexRGB = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const toHex = v => '#' + v.map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
export function tone(h, f) { const v = hexRGB(h), t = f < 0 ? 0 : 255, k = Math.abs(f); return toHex(v.map(x => x + (t - x) * k)); }
const mixHex = (a, b, t) => { const A = hexRGB(a), B = hexRGB(b); return toHex(A.map((x, i) => x + (B[i] - x) * t)); };
/** 5-step ramp from a base colour: hi, base, mid, dark, line (outline). */
export const ramp = (base, warm = 0) => { const lum = hexRGB(base).reduce((a, v) => a + v, 0) / 765; return { hi: tone(base, 0.22), base, mid: tone(base, -0.12), dark: tone(base, -0.26), line: lum > 0.7 ? tone(base, -0.45) : mixHex(tone(base, -0.55), warm ? '#3a1a14' : '#1d1a26', 0.35) }; };

class Layer {
  constructor() { this.d = new Uint8ClampedArray(PW * PH * 4); }
  set(x, y, hex, a = 255) {
    x |= 0; y |= 0; if (x < 0 || y < 0 || x >= PW || y >= PH || !hex) return;
    const i = (y * PW + x) * 4, [r, g, b] = hexRGB(hex);
    if (a >= 255) { this.d[i] = r; this.d[i + 1] = g; this.d[i + 2] = b; this.d[i + 3] = 255; return; }
    if (!this.d[i + 3]) { this.d[i] = r; this.d[i + 1] = g; this.d[i + 2] = b; this.d[i + 3] = a; return; }
    const k = a / 255, ia = this.d[i + 3] / 255;
    this.d[i] = r * k + this.d[i] * (1 - k); this.d[i + 1] = g * k + this.d[i + 1] * (1 - k); this.d[i + 2] = b * k + this.d[i + 2] * (1 - k);
    this.d[i + 3] = Math.round((k + ia * (1 - k)) * 255);
  }
  rect(x, y, w, h, hex) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, hex); }
}
class Mask {
  constructor() { this.m = new Uint8Array(PW * PH); }
  has(x, y) { return x >= 0 && y >= 0 && x < PW && y < PH && this.m[y * PW + x] === 1; }
  add(x, y) { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < PW && y < PH) this.m[y * PW + x] = 1; }
  del(x, y) { if (x >= 0 && y >= 0 && x < PW && y < PH) this.m[y * PW + x] = 0; }
  /** Scanline polygon fill (pixel centres, even-odd). */
  poly(pts) {
    let y0 = Infinity, y1 = -Infinity;
    for (const [, y] of pts) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
      const cy = y + 0.5, xs = [];
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
        if ((ay <= cy && by > cy) || (by <= cy && ay > cy)) xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.ceil(xs[k] - 0.5); x <= Math.floor(xs[k + 1] - 0.5); x++) this.add(x, y);
    }
    return this;
  }
  disc(cx, cy, r) { for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r + 0.3) this.add(x, y); return this; }
  /** Thick segment (round caps), width tapering from w0 to w1. */
  seg(x0, y0, x1, y1, w0, w1 = w0) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
    for (let i = 0; i <= n; i++) { const t = i / n; this.disc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, (w0 + (w1 - w0) * t) / 2); }
    return this;
  }
}
/** Paint a mask: light from the upper left (hi on the left of each run, mid/dark on the right), 1-px outline. */
function paint(L, M, R, opts = {}) {
  const line = opts.line ?? R.line, flat = opts.flat;
  for (let y = 0; y < PH; y++) {
    let x = 0;
    while (x < PW) {
      if (!M.has(x, y)) { x++; continue; }
      let x1 = x; while (M.has(x1 + 1, y)) x1++;
      const len = x1 - x + 1;
      for (let i = x; i <= x1; i++) {
        const edge = !M.has(i - 1, y) || !M.has(i + 1, y) || !M.has(i, y - 1) || !M.has(i, y + 1);
        if (edge && line) { L.set(i, y, line); continue; }
        const t = len <= 2 ? 0.5 : (i - x) / (len - 1);
        const top = !M.has(i, y - 2);
        let c = R.base;
        if (!flat) { if (t < 0.2 && len > 4) c = R.hi; else if (t > 0.86 && len > 5) c = R.dark; else if (t > 0.68) c = R.mid; if (top && t < 0.6 && len > 4) c = R.hi; }
        L.set(i, y, c);
      }
      x = x1 + 1;
    }
  }
}
const mirrorPts = pts => pts.map(([x, y]) => [96 - x, y]);
const both = (M, pts) => { M.poly(pts); M.poly(mirrorPts(pts)); return M; };

function blit(dst, src, dx = 0, dy = 0) {
  const s = src.d, d = dst.d;
  for (let y = 0; y < PH; y++) { const ty = y + dy; if (ty < 0 || ty >= PH) continue;
    for (let x = 0; x < PW; x++) { const i = (y * PW + x) * 4; if (!s[i + 3]) continue; const tx = x + dx; if (tx < 0 || tx >= PW) continue;
      const j = (ty * PW + tx) * 4, a = s[i + 3] / 255;
      if (a >= 1) { d[j] = s[i]; d[j + 1] = s[i + 1]; d[j + 2] = s[i + 2]; d[j + 3] = 255; }
      else { d[j] = s[i] * a + d[j] * (1 - a); d[j + 1] = s[i + 1] * a + d[j + 1] * (1 - a); d[j + 2] = s[i + 2] * a + d[j + 2] * (1 - a); d[j + 3] = Math.max(d[j + 3], s[i + 3]); } } }
  return dst;
}

// ----- the cat (head 50×42, chubby body, tail; light from the upper left) -----
Mask.prototype.ell = function ell(cx, cy, rx, ry) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++)
    if (((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1) this.add(x, y);
  return this;
};
const W2 = { white: '#fbf7f1', cream: '#fff1dc' };
const furRamp = c => ({ hi: tone(c, 0.18), base: c, mid: tone(c, -0.1), dark: tone(c, -0.22), line: mixHex(tone(c, -0.6), '#2a1d22', 0.4) });
const darkFur = f => hexRGB(f.base).reduce((a, v) => a + v, 0) / 765 < 0.3;
const HEAD = { cx: 48, cy: 42 };
const EYE_AT = [[38, 44], [58, 44]];
function headMask() { const M = new Mask(); M.ell(48, 42, 25, 20.5); M.ell(31, 50, 8, 6.5); M.ell(65, 50, 8, 6.5); M.poly([[26, 54], [24, 57], [30, 57]]); M.poly([[70, 54], [72, 57], [66, 57]]); return M; }
function earPts(side, mode) {
  const base = { normal: [[25, 34], [28, 11], [43, 25]], perk: [[26, 33], [29, 8], [43, 24]], flat: [[23, 35], [17, 20], [39, 27]], twitch: [[25, 33], [25, 12], [42, 25]] }[mode] || [[25, 34], [28, 11], [43, 25]];
  return side === 'L' ? base : mirrorPts(base);
}
function innerEar(pts) { const [a, t, b] = pts, c = [(a[0] + t[0] + b[0]) / 3, (a[1] + t[1] + b[1]) / 3]; return [a, t, b].map(([x, y]) => [c[0] + (x - c[0]) * 0.55, c[1] + (y - c[1]) * 0.55 + 1]); }
/** Fur markings on top of a painted mask (stripes, tuxedo bib, calico patches, colour points, socks). */
function markings(L, M, fur, part) {
  const F = furRamp(fur.base), mark = fur.mark ? furRamp(fur.mark) : null;
  const inM = (x, y) => M.has(x, y) && M.has(x - 1, y) && M.has(x + 1, y) && M.has(x, y - 1) && M.has(x, y + 1);
  const put = (x, y, c) => { if (inM(x, y)) L.set(x, y, c); };
  const blob = (cx, cy, rx, ry, R) => { for (let y = Math.floor(cy - ry); y <= cy + ry; y++) for (let x = Math.floor(cx - rx); x <= cx + rx; x++) if (((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1) put(x, y, (x - cx) < -rx * 0.4 ? R.hi : (x - cx) > rx * 0.5 ? R.mid : R.base); };
  switch (fur.pattern) {
    case 'tabby': {
      const c = mark.base;
      if (part === 'head') { for (const [x, y0, y1] of [[44, 26, 30], [48, 24, 31], [52, 26, 30]]) for (let y = y0; y <= y1; y++) put(x, y, c); for (const y of [45, 48]) { for (let x = 24; x < 29; x++) put(x, y + (x < 26 ? 1 : 0), c); for (let x = 68; x < 73; x++) put(x, y + (x > 70 ? 1 : 0), c); } }
      if (part === 'body') for (const y of [76, 82, 88, 94]) { for (let x = 28; x < 34; x++) put(x, y + Math.round((x - 28) * 0.3), c); for (let x = 62; x < 68; x++) put(x, y + Math.round((68 - x) * 0.3), c); }
      if (part === 'tail') for (let y = 0; y < 112; y++) for (let x = 60; x < 96; x++) if (inM(x, y) && (x + y) % 6 === 0) L.set(x, y, c);
      break;
    }
    case 'tuxedo': case 'socks':
      if (part === 'head' && fur.pattern === 'tuxedo') blob(48, 55, 11, 7.5, furRamp(W2.white));
      if (part === 'body') { blob(48, 84, fur.pattern === 'tuxedo' ? 12 : 5, fur.pattern === 'tuxedo' ? 15 : 6, furRamp(W2.white)); }
      break;
    case 'calico':
      if (part === 'head') { blob(33, 30, 11, 10, furRamp('#e8954a')); blob(64, 33, 9, 8, furRamp('#3a3438')); }
      if (part === 'body') { blob(62, 82, 8, 9, furRamp('#e8954a')); blob(35, 94, 7, 6, furRamp('#3a3438')); }
      if (part === 'tail') for (let y = 0; y < 112; y++) for (let x = 60; x < 96; x++) if (inM(x, y)) L.set(x, y, x > 76 ? '#e8954a' : '#d4823a');
      break;
    case 'points':
      if (part === 'head') { for (let y = 40; y < 62; y++) for (let x = 34; x < 63; x++) { const d = Math.hypot((x - 48) / 13, (y - 50) / 11); if (d < 1) put(x, y, mixHex(fur.base, mark.base, Math.max(0, 0.85 - d * 0.75))); } }
      if (part === 'tail') for (let y = 0; y < 112; y++) for (let x = 60; x < 96; x++) if (inM(x, y)) L.set(x, y, (x + y) % 3 ? mark.base : mark.mid);
      break;
    default: break;
  }
}
function drawTail(L, look, f) {
  const fur = look.fur, R = furRamp(fur.base), M = new Mask();
  const tip = [[84, 62], [88, 64], [80, 63]][f % 3];
  M.seg(62, 98, 74, 96, 8, 7.5); M.seg(74, 96, 82, 86, 7.5, 7); M.seg(82, 86, 85, 74, 7, 6.5); M.seg(85, 74, tip[0], tip[1], 6.5, 5.5);
  paint(L, M, R); markings(L, M, fur, 'tail');
  if (fur.pattern === 'socks' || fur.pattern === 'tuxedo') M.disc(tip[0], tip[1], 2.2), paint(L, new Mask().disc(tip[0], tip[1] + 0.5, 2.6), furRamp(W2.white));
}
function drawBody(L, look) {
  const fur = look.fur, R = furRamp(fur.base), M = new Mask();
  M.ell(48, 85, 21, 19.5); M.ell(48, 70, 16, 8);
  paint(L, M, R);
  const belly = new Mask().ell(48, 88, 11.5, 13);
  paint(L, belly, furRamp(fur.belly), { line: null });
  markings(L, M, fur, 'body');
  for (const x of [38, 58]) {                                       // feet with toe lines
    const Fm = new Mask().ell(x, 103.5, 7.5, 4.2);
    paint(L, Fm, furRamp(fur.paws || fur.base));
    L.set(x - 2, 104, furRamp(fur.paws || fur.base).line); L.set(x + 2, 104, furRamp(fur.paws || fur.base).line);
  }
}
function drawHead(L, look, ears, twitch) {
  const fur = look.fur, R = furRamp(fur.base), ER = furRamp(fur.ears || fur.base);
  for (const side of ['L', 'R']) {
    const mode = twitch === side ? 'twitch' : ears;
    const pts = earPts(side, mode), E = new Mask().poly(pts);
    paint(L, E, ER);
    paint(L, new Mask().poly(innerEar(pts)), { hi: '#ffd2d8', base: '#f7b8c2', mid: '#efa3b1', dark: '#e48fa0', line: null }, { line: null });
  }
  const M = headMask();
  paint(L, M, R);
  markings(L, M, fur, 'head');
  for (const [x, y] of [[26, 41], [27, 40], [69, 41], [68, 40]]) if (M.has(x, y)) L.set(x, y, R.hi);           // cheek fluff glints
}
const IRIS = { green: ['#3f8f45', '#6cc05f', '#a6e08a'], amber: ['#b06a1f', '#e2a33a', '#f6d07a'], blue: ['#2f6fae', '#5b9bd8', '#a8d2f4'], yellow: ['#a8891c', '#e8c547', '#f8e690'] };
function eyeCat(L, cx, cy, mode, col, lid, mirror) {
  const [d, m, l] = IRIS[col] || IRIS.green, line = '#24161a';
  if (mode === 'shut') { for (let i = -4; i <= 4; i++) L.set(cx + i, cy + 1 + (Math.abs(i) > 2 ? -1 : 0), line); return; }
  if (mode === 'happy') { for (let i = -2; i <= 2; i++) L.set(cx + i, cy - 1, line); L.set(cx - 3, cy, line); L.set(cx + 3, cy, line); L.set(cx - 4, cy + 1, line); L.set(cx + 4, cy + 1, line); return; }
  const E = new Mask().ell(cx, cy, 4.6, 5.2);
  for (let y = cy - 6; y <= cy + 6; y++) for (let x = cx - 5; x <= cx + 5; x++) {
    if (!E.has(x, y)) continue;
    const edge = !E.has(x - 1, y) || !E.has(x + 1, y) || !E.has(x, y - 1) || !E.has(x, y + 1);
    const t = (y - (cy - 5)) / 10;
    L.set(x, y, edge ? line : t < 0.3 ? d : t < 0.7 ? m : l);
  }
  for (let y = cy - 3; y <= cy + 3; y++) { L.set(cx, y, '#120a0c'); if (Math.abs(y - cy) < 2) { L.set(cx - 1, y, '#120a0c'); L.set(cx + 1, y, '#1d1216'); } }   // slit pupil, rounder in the middle
  const hx = mirror ? cx + 1 : cx - 2;
  L.set(hx, cy - 3, '#ffffff'); L.set(hx + 1, cy - 3, '#ffffff'); L.set(hx, cy - 2, '#ffffff'); L.set(hx + 1, cy - 2, '#ffffff');         // big highlight
  L.set(mirror ? cx - 2 : cx + 2, cy + 2, '#ffffff');                                                                                        // small highlight
  if (mode === 'half') for (let y = cy - 6; y <= cy - 1; y++) for (let x = cx - 5; x <= cx + 5; x++) if (E.has(x, y)) L.set(x, y, y === cy - 1 ? line : lid);
}
function mouthCat(L, m, cx = 48) {
  const ln = '#5a2a33', inn = '#6e2030', tg = '#f08aa0';
  const omega = () => { L.set(cx, 53, ln); for (const s of [-1, 1]) { L.set(cx + s, 54, ln); L.set(cx + 2 * s, 54, ln); L.set(cx + 3 * s, 53, ln); } };
  switch (m) {
    case 'A': L.set(cx, 53, ln); for (let x = -3; x <= 3; x++) { L.set(cx + x, 54, ln); } for (let x = -2; x <= 2; x++) { L.set(cx + x, 55, inn); L.set(cx + x, 56, x === -2 || x === 2 ? ln : tg); } L.set(cx - 3, 55, ln); L.set(cx + 3, 55, ln); for (let x = -1; x <= 1; x++) L.set(cx + x, 57, ln); break;
    case 'O': L.set(cx, 53, ln); L.set(cx - 1, 54, ln); L.set(cx + 1, 54, ln); L.set(cx - 2, 55, ln); L.set(cx + 2, 55, ln); L.set(cx - 1, 55, inn); L.set(cx, 55, inn); L.set(cx + 1, 55, inn); L.set(cx - 2, 56, ln); L.set(cx + 2, 56, ln); L.set(cx, 56, tg); L.set(cx - 1, 56, inn); L.set(cx + 1, 56, inn); L.set(cx - 1, 57, ln); L.set(cx, 57, ln); L.set(cx + 1, 57, ln); break;
    case 'I': omega(); for (let x = -2; x <= 2; x++) L.set(cx + x, 55, x === -2 || x === 2 ? ln : inn); L.set(cx, 55, tg); break;
    default: omega(); break;                                        // ω (rest and M/B/P)
  }
}
function face(L, look, st, ears) {
  const fur = look.fur, R = furRamp(fur.base), lid = fur.pattern === 'points' ? mixHex(fur.base, fur.mark, 0.5) : fur.pattern === 'tuxedo' || fur.pattern === 'socks' ? R.base : R.base;
  // brows (tiny tufts) carry the expression
  const tuft = darkFur(fur) ? tone(fur.base, 0.35) : R.dark, br = { warm: [0, 0], happy: [-1, -1], proud: [-2, -2], playful: [-2, 0] }[st.expr] || [0, 0];
  for (const [i, [cx, cy]] of EYE_AT.entries()) { const s = i ? 1 : -1, d = br[i]; L.set(cx - s * 2, cy - 8 + d, tuft); L.set(cx - s * 1, cy - 9 + d, tuft); L.set(cx, cy - 9 + d, tuft); if (st.expr === 'proud') L.set(cx + s * 1, cy - 10 + d, tuft); }
  eyeCat(L, EYE_AT[0][0], EYE_AT[0][1], st.eyeL, fur.eyes, lid, false);
  eyeCat(L, EYE_AT[1][0], EYE_AT[1][1], st.eyeR, fur.eyes, lid, true);
  for (const [x, y, a] of [[30, 51, 110], [31, 51, 150], [32, 51, 150], [33, 51, 110], [31, 52, 70], [32, 52, 70], [63, 51, 110], [64, 51, 150], [65, 51, 150], [66, 51, 110], [64, 52, 70], [65, 52, 70]]) L.set(x, y, '#ff8fa3', a);   // blush
  L.set(47, 50, '#f59bb0'); L.set(48, 50, '#f07f98'); L.set(49, 50, '#f07f98'); L.set(47, 51, '#e66f8a'); L.set(48, 51, '#e66f8a'); L.set(49, 51, '#d85c79'); L.set(48, 52, '#c84f6c'); L.set(47, 50, '#ffc2cf');   // nose with glint
  mouthCat(L, st.mouth);
  const wc = darkFur(fur) || fur.pattern === 'calico' ? '#f4ece4' : '#9a8478';                                                          // whiskers
  for (const [x0, y0, dy] of [[20, 50, 0], [20, 53, 1], [21, 47, -1]]) for (let i = 0; i < 7; i++) { L.set(x0 + i, y0 + Math.round(dy * (6 - i) / 4), wc, 200); L.set(76 - i, y0 + Math.round(dy * (6 - i) / 4), wc, 200); }
}
// ----- accessories -----
export const ACCESSORIES = [
  { id: 'bowtie', name: '나비넥타이', group: 'neck' }, { id: 'scarf', name: '스카프', group: 'neck' }, { id: 'necktie', name: '넥타이', group: 'neck' },
  { id: 'pearls', name: '진주 목걸이', group: 'neck' }, { id: 'ribbon', name: '귀 리본', group: 'head' }, { id: 'beret', name: '베레모', group: 'head' },
  { id: 'glasses', name: '동그란 안경', group: 'face' }, { id: 'lanyard', name: '사원증', group: 'body' }, { id: 'vest', name: '카디건 조끼', group: 'body' },
];
const ACC_COLORS = ['#d9454f', '#2c3e6b', '#2f8f7a', '#e2a33a', '#8e6cc9', '#e87fa0'];
function accBody(L, look) {
  for (const a of look.acc) {
    const C = ramp(a.color);
    if (a.id === 'vest') { const V = new Mask(); V.ell(48, 84, 20, 15); V.poly([[30, 68], [66, 68], [66, 80], [30, 80]]); for (let y = 66; y < 106; y++) for (let x = 0; x < 96; x++) if (V.has(x, y) && Math.abs(x - 48) < Math.max(0, 9 - (y - 66) * 0.6)) V.del(x, y); for (let x = 0; x < 96; x++) for (let y = 98; y < 112; y++) V.del(x, y);
      paint(L, V, C); for (let y = 70; y < 98; y += 2) for (let x = 30; x < 66; x += 3) if (V.has(x, y) && V.has(x + 1, y) && V.has(x - 1, y)) L.set(x, y, C.mid); for (const y of [82, 88, 94]) L.set(48, y, '#f6e2a8'); }
    if (a.id === 'lanyard') { for (let y = 62; y < 76; y++) { L.set(Math.round(38 + (y - 62) * 0.7), y, a.color); L.set(Math.round(58 - (y - 62) * 0.7), y, a.color); }
      const Cd = new Mask(); Cd.poly([[43.5, 75], [52.5, 75], [52.5, 87], [43.5, 87]]); paint(L, Cd, { hi: '#ffffff', base: '#fbfaf6', mid: '#eeeae2', dark: '#ddd6ca', line: '#8b7f72' }, { flat: true });
      for (let x = 45; x < 52; x++) L.set(x, 76, a.color); L.set(46, 79, '#f2c08a'); L.set(47, 79, '#f2c08a'); L.set(46, 80, '#c9926a'); L.set(47, 80, '#c9926a'); for (let x = 49; x < 52; x++) { L.set(x, 79, '#9aa1ab'); L.set(x, 81, '#c3c8cf'); } for (let x = 45; x < 52; x++) L.set(x, 84, '#c3c8cf'); }
  }
}
function accNeck(L, look) {
  for (const a of look.acc) {
    const C = ramp(a.color);
    if (a.id === 'bowtie') { const B = new Mask(); B.poly([[48, 64], [41, 60], [41, 68]]); B.poly([[48, 64], [55, 60], [55, 68]]); paint(L, B, C); paint(L, new Mask().ell(48, 64, 2.2, 2.2), C, { flat: true }); L.set(43, 62, C.hi); L.set(53, 62, C.hi); }
    if (a.id === 'scarf') { const S = new Mask(); S.poly([[32, 60], [64, 60], [64, 65], [32, 65]]); S.seg(58, 64, 61, 76, 4.5, 4); paint(L, S, C); for (let x = 33; x < 64; x += 4) L.set(x, 62, C.hi); for (let y = 66; y < 76; y += 3) L.set(60, y, C.hi); }
    if (a.id === 'necktie') { const T = new Mask(); T.poly([[46, 61], [50, 61], [49.5, 65], [46.5, 65]]); T.poly([[46.5, 65], [49.5, 65], [51.5, 78], [48, 82], [44.5, 78]]); paint(L, T, C); for (let y = 68; y < 80; y += 3) L.set(48, y, C.hi); for (let x = 37; x < 60; x++) L.set(x, 61, '#fbf7f1'); }
    if (a.id === 'pearls') for (let i = 0; i <= 12; i++) { const x = 36 + i * 2, y = 61 + Math.round(Math.sin((i / 12) * Math.PI) * 3); L.set(x, y, '#fffaf0'); L.set(x + 1, y, '#e6ddd0'); L.set(x, y + 1, '#d8cdbc'); }
  }
}
function accHead(L, look) {
  for (const a of look.acc) {
    const C = ramp(a.color);
    if (a.id === 'glasses') { const g = darkFur(look.fur) ? '#d4af52' : '#4a3a3a'; for (const [cx, cy] of EYE_AT) { const O = new Mask().ell(cx, cy, 7, 6.8), I = new Mask().ell(cx, cy, 6, 5.8); for (let y = cy - 8; y <= cy + 8; y++) for (let x = cx - 8; x <= cx + 8; x++) if (O.has(x, y) && !I.has(x, y)) L.set(x, y, g); L.set(cx - 3, cy - 4, '#ffffff', 170); } for (let x = 45; x <= 51; x++) L.set(x, 42 + (x === 48 ? -1 : 0), g); }
    if (a.id === 'beret') { const B = new Mask(); B.ell(50, 22, 14, 5.5); B.ell(54, 19, 9, 4); paint(L, B, C); L.set(52, 14, C.dark); L.set(52, 15, C.dark); for (let x = 38; x < 63; x++) if (B.has(x, 26)) L.set(x, 26, C.dark); }
    if (a.id === 'ribbon') { const B = new Mask(); B.poly([[64, 22], [58, 18], [59, 26]]); B.poly([[64, 22], [70, 17], [70, 26]]); paint(L, B, C); paint(L, new Mask().ell(64, 22, 1.8, 1.8), C, { flat: true }); L.set(60, 20, C.hi); L.set(68, 19, C.hi); }
  }
}
// ----- paws per pose frame -----
// [shoulder, paw centre, shape] per side; shapes: rest | beans (toe beans to the viewer) | fist | hold
export const PIXEL_POSES = {
  idle: [{ L: [[34, 72], [39, 83], 'rest'], R: [[62, 72], [57, 83], 'rest'] }],
  clasp: [{ L: [[34, 72], [45, 82], 'rest'], R: [[62, 72], [51, 82], 'rest'] }],
  bow: [{ L: [[34, 73], [45, 83], 'rest'], R: [[62, 73], [51, 83], 'rest'] }],
  clap: [0, 1].map(f => ({ L: [[34, 70], [f ? 45 : 42, 70], 'beans'], R: [[62, 70], [f ? 51 : 54, 70], 'beans'] })),
  thumbs: [{ L: [[34, 72], [39, 83], 'rest'], R: [[62, 68], [72, 52], 'beans'] }],
  wave: [0, 1, 2].map(f => ({ L: [[34, 72], [39, 83], 'rest'], R: [[62, 68], [[73, 46], [76, 48], [71, 47]][f], 'beans'] })),
  coffee: [{ L: [[34, 70], [43, 74], 'hold'], R: [[62, 70], [53, 74], 'hold'] }],
  cheek: [{ L: [[34, 68], [30, 56], 'beans'], R: [[62, 72], [55, 82], 'rest'] }],
  fist: [0, 1].map(f => ({ L: [[34, 68], [25, f ? 50 : 53], 'fist'], R: [[62, 68], [71, f ? 50 : 53], 'fist'] })),
};
function drawPaws(L, look, pose, frame) {
  const fur = look.fur, R = furRamp(fur.paws || fur.base), A = furRamp(fur.base);
  const P = PIXEL_POSES[pose] || PIXEL_POSES.idle, F = P[(((frame | 0) % P.length) + P.length) % P.length];
  for (const side of ['L', 'R']) {
    const [[sx, sy], [px, py], shape] = F[side];
    const arm = new Mask().seg(sx, sy, px, py, 8, 7);
    paint(L, arm, A);
    if (fur.pattern === 'tabby') for (let k = 1; k < 3; k++) { const x = Math.round(sx + (px - sx) * k / 3), y = Math.round(sy + (py - sy) * k / 3); L.set(x, y, furRamp(fur.mark).base); L.set(x + 1, y, furRamp(fur.mark).base); }
    const paw = new Mask().ell(px, py, 4.8, 4.3);
    paint(L, paw, R);
    if (shape === 'beans') { L.set(px - 1, py + 1, '#f29bb0'); L.set(px, py + 1, '#f29bb0'); L.set(px + 1, py + 1, '#f29bb0'); L.set(px, py + 2, '#e8889f'); for (const dx of [-2, 0, 2]) L.set(px + dx, py - 2, '#f6a9bb'); }
    else if (shape === 'fist' || shape === 'rest' || shape === 'hold') { L.set(px - 1, py + 2, R.line); L.set(px + 1, py + 2, R.line); }
  }
  if (pose === 'coffee') {                                          // a tiny mug in both paws, steam
    const M = new Mask(); M.poly([[44, 64], [52, 64], [52, 73], [44, 73]]); paint(L, M, { hi: '#ffffff', base: '#fbf6ee', mid: '#efe6da', dark: '#e2d6c6', line: '#8b7a68' });
    for (let x = 45; x < 52; x++) { L.set(x, 65, '#7a4a2c'); L.set(x, 66, '#9a6038'); } L.set(53, 67, '#8b7a68'); L.set(54, 68, '#8b7a68'); L.set(53, 70, '#8b7a68'); L.set(54, 69, '#8b7a68');
    L.set(46, 69, '#e87fa0'); L.set(47, 68, '#e87fa0'); L.set(48, 69, '#e87fa0'); L.set(47, 70, '#e87fa0');
    for (const [x, y] of [[46, 61], [47, 60], [46, 59], [49, 62], [50, 61], [49, 60], [50, 59]]) L.set(x, y, '#ffffff', 170);
    paint(L, new Mask().ell(43, 72, 3.6, 3.4), R); paint(L, new Mask().ell(53, 72, 3.6, 3.4), R);
  }
}
function sparkle(L, on) {
  if (!on) return;
  for (const [x, y, s] of [[80, 18, 2], [16, 30, 1], [78, 34, 1]]) { L.set(x, y, '#fff3b0'); for (let k = 1; k <= s; k++) { L.set(x - k, y, '#ffd75e'); L.set(x + k, y, '#ffd75e'); L.set(x, y - k, '#ffd75e'); L.set(x, y + k, '#ffd75e'); } }
}

// ----- compose -----
const lookCache = new Map();
function layersFor(look) {
  const k = `${look.fur.id}|${look.acc.map(a => a.id + a.color).join(',')}`;
  let c = lookCache.get(k);
  if (!c) {
    c = { body: new Layer(), neck: new Layer(), heads: new Map(), tails: new Map(), paws: new Map(), headAcc: new Layer() };
    drawBody(c.body, look); accBody(c.body, look); accNeck(c.neck, look); accHead(c.headAcc, look);
    lookCache.set(k, c); if (lookCache.size > 6) lookCache.delete(lookCache.keys().next().value);
  }
  return c;
}
const memo = (map, key, fn) => { let v = map.get(key); if (!v) { v = new Layer(); fn(v); map.set(key, v); } return v; };
/** One frame. state: { pose, frame, eyeL, eyeR ('open'|'half'|'shut'|'happy'), mouth, expr, breath (0|1), sway, tail (0..2), twitch ('L'|'R'|null), sparkle } */
export function renderFrame(look, state) {
  const c = layersFor(look), st = { pose: 'idle', frame: 0, eyeL: 'open', eyeR: 'open', mouth: 'rest', expr: 'warm', breath: 0, sway: 0, tail: 0, twitch: null, sparkle: 0, ...state };
  const ears = st.pose === 'bow' ? 'flat' : st.expr === 'happy' || st.expr === 'proud' ? 'perk' : 'normal';
  const head = memo(c.heads, `${ears}|${st.twitch || ''}`, L => drawHead(L, look, ears, st.twitch));
  const tail = memo(c.tails, String(st.tail % 3), L => drawTail(L, look, st.tail));
  const paws = memo(c.paws, `${st.pose}|${st.frame}`, L => drawPaws(L, look, st.pose, st.frame));
  const out = new Layer(), up = -st.breath, hx = st.sway + (st.pose === 'cheek' ? -2 : st.pose === 'wave' ? 1 : 0), hy = up + (st.pose === 'bow' ? 4 : 0);
  for (let x = 26; x < 92; x++) out.set(x, 108, '#000000', Math.max(0, 46 - Math.abs(x - 54) * 1.4));   // floor shadow
  blit(out, tail, st.sway, 0);
  blit(out, c.body, st.sway, 0);
  blit(out, c.neck, st.sway, up);
  blit(out, head, hx, hy);
  const F = new Layer(); face(F, look, st, ears); blit(out, F, hx, hy);
  blit(out, c.headAcc, hx, hy);
  blit(out, paws, st.sway, up);
  sparkle(out, st.sparkle);
  return { w: PW, h: PH, data: out.d };
}

// ---------------- DOM ----------------
/** Open the popup. opts: { date: Date, reduced: bool, onClose() } -> { close, look, msg, root }. */
export function openSecretary(opts = {}) {
  const date = opts.date || new Date(), key = dayKey(date), look = pickLook(key), msg = pickMessage(key);
  const reduced = !!opts.reduced;
  const root = document.createElement('div');
  root.className = `sec-modal${reduced ? ' still' : ''}`;
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'sec-line');
  const full = msg.segs.map(s => s.text).join('');
  root.innerHTML = `<div class="sec-stage"><div class="sec-fig" data-look="${look.fur.id}-${look.acc.map(a => a.id).join('+')}"><canvas class="sec-cv" width="${PW}" height="${PH}" role="img" aria-label="냥비서 하린 (${look.fur.name}, ${look.acc.map(a => a.name).join(' · ')})"></canvas></div>
    <div class="sec-bubble"><b class="sec-name">냥비서 하린</b><p class="sec-line" id="sec-line" aria-label="${full.replace(/"/g, '&quot;')}"><span class="sec-typed"></span><span class="sec-caret" aria-hidden="true"></span></p>
      <div class="sec-btns"><button type="button" class="sec-ok">네, 퇴근할게요</button></div></div></div>`;
  document.body.append(root);
  const typed = root.querySelector('.sec-typed'), chars = Array.from(full), cv = root.querySelector('canvas'), ctx = cv.getContext('2d');
  const img = ctx.createImageData(PW, PH);
  const st = { pose: reduced ? 'clasp' : 'bow', frame: 0, eyeL: 'open', eyeR: 'open', mouth: 'rest', expr: 'warm', breath: 0, sway: 0, tail: 0, twitch: null, sparkle: 0 };
  const run = { t0: 0, raf: 0, done: false, doneAt: 0, nextBlink: 0, blinkUntil: 0, winkUntil: 0, n: -1, seg: -1, cueAt: 0, closeT: 0, sig: '', nextTwitch: 0, twitchUntil: 0, twitchSide: 'L' };
  const tl = timeline(msg.segs);
  const draw = () => {
    const sig = `${st.pose}|${st.frame}|${st.eyeL}|${st.eyeR}|${st.mouth}|${st.expr}|${st.breath}|${st.sway}|${st.tail}|${st.twitch}|${st.sparkle}`;
    if (sig === run.sig) return;
    run.sig = sig; img.data.set(renderFrame(look, st).data); ctx.putImageData(img, 0, 0);
  };
  const cue = (name, s) => { st.pose = PIXEL_POSES[name] ? name : 'idle'; st.expr = s ? s.expr : 'warm'; run.cueAt = performance.now(); if (s?.wink) run.winkUntil = run.cueAt + 1300; };
  const frame = now => {
    const el = now - run.t0;
    if (el >= 0 && !run.done) {
      let i = 0; while (i + 1 < tl.steps.length && tl.steps[i + 1].at <= el) i++;
      const s = tl.steps[i];
      if (s.seg !== run.seg) { run.seg = s.seg; cue(msg.segs[s.seg].cue, msg.segs[s.seg]); }
      if (s.n !== run.n) { run.n = s.n; typed.textContent = chars.slice(0, s.n).join(''); }
      st.mouth = s.mouth;
      if (el >= tl.total) { run.done = true; run.doneAt = now; typed.textContent = full; st.mouth = 'rest'; root.classList.add('done'); run.closeT = setTimeout(close, 15000); }
    } else if (run.done && st.pose !== 'clasp' && now - run.doneAt > 1800) { st.pose = 'clasp'; st.expr = 'happy'; }
    // pose frames (wave 3, clap 2, fist 2), 1-px breathing and sway
    const t = Math.max(0, now - run.cueAt), n = PIXEL_POSES[st.pose].length;   // rAF time can trail performance.now()
    st.frame = n > 1 ? Math.floor(t / (st.pose === 'wave' ? 170 : st.pose === 'clap' ? 150 : 230)) % n : 0;
    st.breath = Math.floor(now / 1300) % 2;
    st.sway = Math.floor(now / 2900) % 4 === 3 ? 1 : 0;
    st.tail = Math.floor(now / (st.pose === 'wave' ? 160 : 520)) % 3;                    // tail swish, faster while waving
    if (now > run.nextTwitch) { run.twitchUntil = now + 160; run.twitchSide = Math.random() < 0.5 ? 'L' : 'R'; run.nextTwitch = now + 2800 + Math.random() * 3000; }
    st.twitch = now < run.twitchUntil ? run.twitchSide : null;                            // ear twitch every few seconds
    st.sparkle = (st.expr === 'happy' || st.expr === 'proud') && Math.floor(now / 450) % 3 === 0 ? 1 : 0;   // "냥~" sparkle
    // eyes: happy while bowing, blinks every 2.5–5 s (half-closed frame on the way), wink on cue
    let e = 'open';
    if (st.pose === 'bow' && t < 1100) e = 'happy';
    if (st.pose === 'cheek' && t > 300 && t < 1500) e = t < 600 || t > 1200 ? 'half' : 'shut';   // slow blink
    if (now > run.nextBlink) { run.blinkUntil = now + 150; run.nextBlink = now + 2500 + Math.random() * 2500; }
    if (now < run.blinkUntil) e = run.blinkUntil - now > 110 || run.blinkUntil - now < 40 ? 'half' : 'shut';
    st.eyeL = e; st.eyeR = now < run.winkUntil ? 'happy' : e;
    draw();
    run.raf = requestAnimationFrame(frame);
  };
  let closed = false;
  function close() {
    if (closed) return; closed = true;
    cancelAnimationFrame(run.raf); clearTimeout(run.closeT);
    document.removeEventListener('keydown', onKey);
    root.classList.add('out');
    setTimeout(() => root.remove(), reduced ? 0 : 260);
    opts.onClose?.();
  }
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  root.addEventListener('click', ev => { if (ev.target === root || ev.target.closest('.sec-ok')) close(); });
  if (reduced) {                                           // static smiling pose, the whole line at once
    typed.textContent = full; st.expr = 'happy'; draw();
    root.classList.add('done'); run.closeT = setTimeout(close, 15000);
  } else {
    draw();
    run.cueAt = performance.now(); cue('bow', msg.segs[0]);
    run.nextBlink = performance.now() + 2500 + Math.random() * 2500;
    run.t0 = performance.now() + 450;                        // let her slide in before talking
    run.raf = requestAnimationFrame(frame);
  }
  root.querySelector('.sec-ok').focus({ preventScroll: true });
  return { close, look, msg, root };
}
