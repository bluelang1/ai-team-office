// AI Team Office v3 — 대표실 wall calendar (tear-off pad) and analog wall clock, both on the real local time.
// The clock is drawn smooth at device resolution (the one non-pixel graphic, for legibility), redrawn once per
// second aligned to the second boundary (1s steps, no easing — also under prefers-reduced-motion). The calendar text is normal HTML text.

const WEEK = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
const pad = n => String(n).padStart(2, '0');
export const ymd = d => `${d.getFullYear()}년 ${pad(d.getMonth() + 1)}월 ${pad(d.getDate())}일`;
const dayClass = d => (d.getDay() === 0 ? 'sun' : d.getDay() === 6 ? 'sat' : '');

/** Draw the face for `d`. Only the clock is drawn fine (device pixels, anti-aliased) so it reads as a real clock
 *  while the rest of the office stays chunky pixel art. Coordinates are in a 100×100 box. */
export function drawClock(cv, d) {
  const css = cv.clientWidth || 52, dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1;
  const px = Math.max(26, Math.round(css * dpr * 2));                  // 2× supersampled for thin hands
  if (cv.width !== px) { cv.width = px; cv.height = px; cv._c = null; }
  const ctx = cv._c || (cv._c = cv.getContext('2d'));
  ctx.setTransform(px / 100, 0, 0, px / 100, 0, 0);
  ctx.clearRect(0, 0, 100, 100);
  const big = css >= 32;
  ctx.beginPath(); ctx.arc(50, 50, 48, 0, Math.PI * 2); ctx.fillStyle = '#2b2f36'; ctx.fill();          // rim
  ctx.beginPath(); ctx.arc(50, 50, 43, 0, Math.PI * 2); ctx.fillStyle = '#fffdf7'; ctx.fill();          // face
  ctx.lineCap = 'round';
  for (let i = 0; i < 60; i++) {                                                                        // minute + hour ticks
    if (!big && i % 5) continue;
    const a = (i / 60) * Math.PI * 2, hour = i % 5 === 0, r0 = hour ? (i % 15 ? 35 : 33) : 38.5, r1 = 41;
    ctx.beginPath(); ctx.moveTo(50 + Math.sin(a) * r0, 50 - Math.cos(a) * r0); ctx.lineTo(50 + Math.sin(a) * r1, 50 - Math.cos(a) * r1);
    ctx.strokeStyle = hour ? '#2b2f36' : '#9aa1ab'; ctx.lineWidth = hour ? (i % 15 ? 2.4 : 3.6) : 1.1; ctx.stroke();
  }
  if (big) {
    ctx.fillStyle = '#2b2f36'; ctx.font = '700 13px "Pretendard", "Apple SD Gothic Neo", "Noto Sans KR", system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const [n, x, y] of [['12', 50, 23], ['3', 76.5, 50.5], ['6', 50, 77.5], ['9', 23.5, 50.5]]) ctx.fillText(n, x, y);
  }
  const s = d.getSeconds(), m = d.getMinutes() + s / 60, h = (d.getHours() % 12) + m / 60;
  const hand = (frac, len, w, c, tail = 0) => {
    const a = frac * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(50 - Math.sin(a) * tail, 50 + Math.cos(a) * tail); ctx.lineTo(50 + Math.sin(a) * len, 50 - Math.cos(a) * len);
    ctx.strokeStyle = c; ctx.lineWidth = w; ctx.stroke();
  };
  hand(h / 12, 22, 6, '#1f232b', 4);
  hand(m / 60, 33, 3.6, '#1f232b', 5);
  hand(s / 60, 37, 1.4, '#d92d20', 9);
  ctx.beginPath(); ctx.arc(50, 50, 3.4, 0, Math.PI * 2); ctx.fillStyle = '#d92d20'; ctx.fill();
  ctx.beginPath(); ctx.arc(50, 50, 1.4, 0, Math.PI * 2); ctx.fillStyle = '#fffdf7'; ctx.fill();
}

/** Mount: els = { cal: element with .cal-ymd/.cal-d/.cal-w, clocks: [canvas], compact: element }.
 *  opts (tests): { now: () => Date, setTimer: (fn, ms) => id }. Returns { tick } (one step, for tests). */
export function mountClock(els, opts = {}) {
  const now = opts.now || (() => new Date()), setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
  let day = '';
  const tick = () => {
    const d = now();
    const key = ymd(d);
    if (key !== day) {                               // first run and every local midnight
      day = key;
      const cls = dayClass(d), w = WEEK[d.getDay()];
      if (els.cal) {
        els.cal.querySelector('.cal-ymd').textContent = key;
        const big = els.cal.querySelector('.cal-d'); big.textContent = String(d.getDate()); big.className = `cal-d ${cls}`;
        const wd = els.cal.querySelector('.cal-w'); wd.textContent = w; wd.className = `cal-w ${cls}`;
        els.cal.setAttribute('aria-label', `${key} ${w}`);
      }
      if (els.compact) els.compact.innerHTML = `${key} <b class="${cls}">(${w[0]})</b>`;
    }
    for (const cv of els.clocks || []) { drawClock(cv, d); cv.title = d.toLocaleTimeString('ko-KR', { hour12: false }); }
    setTimer(tick, 1000 - (d.getTime() % 1000) + 8);
  };
  tick();
  return { tick };
}
