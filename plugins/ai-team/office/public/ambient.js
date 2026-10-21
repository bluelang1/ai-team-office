// AI Team Office — night life through the glass: shooting stars over the snowy peaks and couples strolling in the
// city park. Pure state machine (inject rng + clock for tests); world.js draws it. Only at night (the sky period, or
// the dark-mode night view) and never under prefers-reduced-motion.

export const PARK_SEGMENTS = [[218, 264], [298, 402]];      // walkable park path (the pond sits between them)
export const PARK_LAMPS = [220, 237, 254, 305, 322, 339, 356, 373, 390];
export const PATH_Y = 41;                                    // feet line of the park path (world px)
const STAR_MIN = 8000, STAR_MAX = 25000, COUPLE_MIN = 20000, COUPLE_MAX = 60000;

export class Ambient {
  /** opts: { rng: () => [0,1), force: 'star' | 'couple' | 'star,couple' (test hook: spawn at once and often) } */
  constructor({ rng = Math.random, force = '' } = {}) {
    this.rng = rng; this.force = String(force || '');
    this.star = null; this.couples = []; this.nextStar = null; this.nextCouple = null; this.seq = 0;
  }
  get on() { return !!this.star || this.couples.length > 0; }
  between(a, b) { return a + this.rng() * (b - a); }
  /** Advance to time t (ms). env: { sky, reduced }. Returns true while something is on screen. */
  step(t, env) {
    if (env.sky !== 'night' || env.reduced) { this.star = null; this.couples = []; this.nextStar = this.nextCouple = null; return false; }
    const fStar = this.force.includes('star'), fCouple = this.force.includes('couple');
    // shooting star: one at a time, every 8–25 s, crossing diagonally above the peaks in 0.6–1 s
    if (this.star && t >= this.star.t0 + this.star.dur) { this.star = null; this.nextStar = t + (fStar ? 1500 : this.between(STAR_MIN, STAR_MAX)); }
    if (this.nextStar == null) this.nextStar = t + (fStar ? 200 : this.between(STAR_MIN, STAR_MAX));
    if (!this.star && t >= this.nextStar) {
      const x0 = this.between(60, 200), len = this.between(36, 60);
      this.star = { t0: t, dur: this.between(600, 1000), x0, y0: this.between(2, 8), x1: x0 - len, y1: this.between(14, 22) };
    }
    // couples: 0–2 at a time, a new one every 20–60 s, each visit 8–20 s
    this.couples = this.couples.filter(c => t < c.t0 + c.dur);
    if (this.nextCouple == null) this.nextCouple = t + (fCouple ? 100 : this.between(COUPLE_MIN, COUPLE_MAX));
    if (t >= this.nextCouple) {
      if (this.couples.length < 2) this.couples.push(this.makeCouple(t));
      this.nextCouple = t + (fCouple ? 9000 : this.between(COUPLE_MIN, COUPLE_MAX));
    }
    return this.on;
  }
  makeCouple(t) {
    const [a, b] = PARK_SEGMENTS[Math.floor(this.rng() * PARK_SEGMENTS.length) % PARK_SEGMENTS.length];
    const dir = this.rng() < 0.5 ? 1 : -1, dur = this.between(8000, 20000), speed = 0.006;           // px per ms
    const x0 = dir > 0 ? a + this.rng() * 10 : b - this.rng() * 10;
    const lamps = PARK_LAMPS.filter(l => l > a + 4 && l < b - 4 && (l - x0) * dir > 6);
    const stop = lamps.length && this.rng() < 0.65
      ? { x: lamps[Math.floor(this.rng() * lamps.length) % lamps.length], len: this.between(1600, 2600), kind: this.rng() < 0.5 ? 'hug' : 'kiss' } : null;
    const looks = [['#5b3a2a', '#3b6fb6', '#2f2a35'], ['#2a1f1d', '#d9534f', '#3a3f55'], ['#8a5a3a', '#f2c14e', '#33384a'], ['#3b2a22', '#6cc070', '#2f3440'], ['#c9a46a', '#a77bf3', '#2f2a35']];
    const pick = () => looks[Math.floor(this.rng() * looks.length) % looks.length];
    return { id: ++this.seq, t0: t, dur, x0, dir, speed, min: a, max: b, stop, a: pick(), b: pick() };
  }
}

/** Where a couple is at time t: { x, walking, moment: null|'hug'|'kiss', mt (ms into the moment), alpha } (pure). */
export function coupleAt(c, t) {
  const e = Math.max(0, t - c.t0);
  const toStop = c.stop ? Math.abs(c.stop.x - c.x0) / c.speed : Infinity;
  let x, walking = true, moment = null, mt = 0;
  if (e < toStop) x = c.x0 + c.dir * c.speed * e;
  else if (e < toStop + c.stop.len) { x = c.stop.x; walking = false; moment = c.stop.kind; mt = e - toStop; }
  else x = c.stop.x + c.dir * c.speed * (e - toStop - c.stop.len);
  if (x <= c.min || x >= c.max) { x = Math.max(c.min, Math.min(c.max, x)); walking = false; }
  const left = c.t0 + c.dur - t, alpha = Math.max(0, Math.min(1, e / 700, left / 700));
  return { x, walking, moment, mt, alpha };
}
