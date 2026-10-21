// AI Team Office v2 — token usage: client-side aggregation (dedupe by record id) and pixel-style charts.
// Records: {ts, proj, sid, aid?, atype?, model, family, in, out, cacheR, cacheW, usd?, id}. No libraries; SVG + HTML.
// Colors: the four model colors + one neutral gray only.

export const FAMS = ['fable', 'opus', 'sonnet', 'haiku', 'unknown'];
const FAM_KO = { fable: 'fable', opus: 'opus', sonnet: 'sonnet', haiku: 'haiku', unknown: '기타' };
const esc = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const num = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const famOf = (f, m) => (FAMS.includes(f) ? f : (/fable|opus|sonnet|haiku/.exec(typeof m === 'string' ? m.toLowerCase() : '') || ['unknown'])[0]);

export const fmtTok = n => (n >= 1e8 ? `${(n / 1e8).toFixed(n >= 1e9 ? 1 : 2)}억` : n >= 1e4 ? `${(n / 1e4).toFixed(n >= 1e5 ? 0 : 1)}만`
  : Math.round(n).toLocaleString('ko-KR'));
const pct = (x, d = 0) => (x == null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`);
const usd = n => `$${n < 10 ? n.toFixed(2) : n.toFixed(1)}`;

export class Usage {
  constructor() { this.reset(); }
  reset() { this.byId = new Map(); this.mainFam = new Map(); this.ver = 0; this._agg = null; }
  /** The main session's model family: its own records (no aid), most recent wins. null when unknown. */
  mainFamily(sid) { return this.mainFam.get(String(sid))?.fam ?? null; }
  /** Add one record; a repeated id replaces the earlier value (streamed messages keep only the last). */
  add(r) {
    if (!r || typeof r !== 'object') return false;
    const ms = Date.parse(r.ts);
    if (!Number.isFinite(ms)) return false;
    const id = r.id != null ? String(r.id) : `${r.sid}|${r.aid || ''}|${r.ts}`;
    this.byId.set(id, { ms, proj: String(r.proj || '(unknown)'), sid: String(r.sid || ''), aid: r.aid ? String(r.aid) : null,
      fam: famOf(r.family, r.model), in: num(r.in), out: num(r.out), cR: num(r.cacheR), cW: num(r.cacheW), usd: Number.isFinite(+r.usd) ? +r.usd : null });
    // The main's model: its own records only (no aid), most recent known family wins. Unknown families (an ARN or
    // custom model string) never overwrite a known one; sidechain messages are skipped when the record says so
    // (usage.mjs does not expose isSidechain today, so this is forward-compatible only).
    if (!r.aid && r.sid && r.isSidechain !== true) {
      const k = String(r.sid), cur = this.mainFam.get(k), fam = famOf(r.family, r.model);
      if (fam !== 'unknown' && (!cur || ms >= cur.ms)) this.mainFam.set(k, { ms, fam });
    }
    this.ver++;
    return true;
  }
  addAll(list) { let n = 0; if (Array.isArray(list)) for (const r of list) n += this.add(r) ? 1 : 0; return n; }
  get size() { return this.byId.size; }
  agg() {
    if (this._agg && this._agg.ver === this.ver) return this._agg;
    const z = () => ({ in: 0, out: 0, cR: 0, cW: 0 });
    const a = { ver: this.ver, n: this.byId.size, byFam: Object.fromEntries(FAMS.map(f => [f, z()])), tot: z(),
      hours: Array.from({ length: 24 }, () => Object.fromEntries(FAMS.map(f => [f, 0]))), byProj: {}, sessions: new Set(),
      main: 0, mainBy: Object.fromEntries(FAMS.map(f => [f, 0])), sub: Object.fromEntries(FAMS.map(f => [f, 0])), usd: null };
    for (const r of this.byId.values()) {
      for (const t of [a.byFam[r.fam], a.tot]) { t.in += r.in; t.out += r.out; t.cR += r.cR; t.cW += r.cW; }
      a.hours[new Date(r.ms).getHours()][r.fam] += r.out;
      const p = a.byProj[r.proj] ||= { total: 0, ...Object.fromEntries(FAMS.map(f => [f, 0])) };
      const all = r.in + r.out + r.cR + r.cW; p.total += all; p[r.fam] += all;
      if (r.sid) a.sessions.add(r.sid);
      if (r.aid) a.sub[r.fam] += r.out; else { a.main += r.out; a.mainBy[r.fam] += r.out; }
      if (r.usd != null) a.usd = (a.usd || 0) + r.usd;
    }
    const t = a.tot;
    a.cacheHit = t.in + t.cR + t.cW ? t.cR / (t.in + t.cR + t.cW) : null;
    a.saving = t.out ? 1 - a.byFam.fable.out / t.out : null;
    a.subOut = FAMS.reduce((s, f) => s + a.sub[f], 0);
    this._agg = a;
    return a;
  }
}

// ---------- tooltips: any element with data-tip ----------
export function bindTips(tip) {
  const hide = () => { tip.hidden = true; };
  document.addEventListener('pointerover', ev => {
    const t = ev.target.closest?.('[data-tip]');
    if (!t) return hide();
    tip.textContent = t.getAttribute('data-tip'); tip.hidden = false;
  });
  document.addEventListener('pointermove', ev => {
    if (tip.hidden) return;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.transform = `translate(${Math.min(innerWidth - w - 8, ev.clientX + 12)}px, ${Math.max(8, ev.clientY - h - 10)}px)`;
  });
  document.addEventListener('pointerleave', hide);
  addEventListener('scroll', hide, { passive: true });
}

const emptyHTML = (title, sub) => `<div class="empty-chart"><i class="ico" style="--i:var(--ico-chart)"></i><p>${esc(title)}</p><small>${esc(sub)}</small></div>`;
export const EMPTY_SUB = '서버가 토큰 사용량을 보내기 시작하면 여기에 그려져요.';

// ---------- 1. pixel donut: output tokens by family; ring built from square cells ----------
export function donutSVG(a, cells = 26, cell = 5) {
  const total = a ? FAMS.reduce((s, f) => s + a.byFam[f].out, 0) : 0;
  const cuts = []; let acc = 0;
  for (const f of FAMS) { const v = total ? a.byFam[f].out / total : 0; if (v > 0) { acc += v; cuts.push([acc, f]); } }
  const famAt = t => (cuts.find(([c]) => t <= c + 1e-9) || [0, 'unknown'])[1];
  const c = (cells - 1) / 2, rOut = cells / 2 - 0.2, rIn = rOut * 0.62;
  const runs = {};
  for (let y = 0; y < cells; y++) {
    let x0 = -1, f0 = null;
    const flush = x => { if (f0) (runs[f0] ||= []).push(`<rect x="${x0 * cell}" y="${y * cell}" width="${(x - x0) * cell}" height="${cell}"/>`); f0 = null; };
    for (let x = 0; x <= cells; x++) {
      let f = null;
      if (x < cells) {
        const dx = x - c, dy = y - c, d = Math.hypot(dx, dy);
        if (d <= rOut && d >= rIn) f = total ? famAt(((Math.atan2(dx, -dy) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI)) : 'none';
      }
      if (f !== f0) { flush(x); if (f) { x0 = x; f0 = f; } }
    }
  }
  const tipOf = f => (f === 'none' ? '아직 기록 없음' : `${FAM_KO[f]} · 출력 ${fmtTok(a.byFam[f].out)} 토큰 · ${pct(a.byFam[f].out / total, 1)}`);
  const s = cells * cell;
  return `<svg class="donut" viewBox="0 0 ${s} ${s}" width="${s}" height="${s}" shape-rendering="crispEdges" role="img" aria-label="모델별 출력 토큰 비율">${
    Object.entries(runs).map(([f, r]) => `<g class="f-${f}" data-tip="${esc(tipOf(f))}">${r.join('')}</g>`).join('')}</svg>`;
}

/** Panel ①: donut + Fable 절약률 + two small numbers + legend. */
export function usageSummaryHTML(a, opts = {}) {
  if (!a || !a.n) return `<div class="u-sum">${donutSVG(null, 22, 5)}<div class="u-center"><b>—</b><small>Fable 절약률</small></div></div>${emptyHTML('아직 사용량 기록이 없어요', opts.sim ? '' : EMPTY_SUB)}`;
  const total = a.tot.out;
  const legend = FAMS.filter(f => a.byFam[f].out > 0).map(f => `<span class="lg" data-tip="${esc(`${FAM_KO[f]} 출력 ${fmtTok(a.byFam[f].out)} 토큰`)}"><i class="sq f-${f}"></i>${FAM_KO[f]} <b>${pct(a.byFam[f].out / total)}</b></span>`).join('');
  return `<div class="u-row"><div class="u-sum">${donutSVG(a, 22, 5)}<div class="u-center" data-tip="1 − fable 출력 토큰 ÷ 전체 출력 토큰"><b>${pct(a.saving)}</b><small>Fable 절약률</small></div></div>
    <div class="u-nums"><span data-tip="오늘 전체 출력 토큰">출력 토큰<b>${fmtTok(total)}</b></span>
      <span data-tip="캐시 읽기 ÷ (입력 + 캐시 읽기 + 캐시 쓰기)">캐시 적중<b>${pct(a.cacheHit)}</b></span>
      ${opts.pricing && a.usd != null ? `<span data-tip="pricing.json 단가 기준">비용<b>${usd(a.usd)}</b></span>` : ''}</div></div>
    <div class="legend-row">${legend}</div>`;
}

// ---------- 2. hourly stacked bars (output tokens), now-line ----------
export function hourlySVG(a, now = new Date()) {
  const L = 30, BW = 12, H = 96, T = 10, W = L + 24 * BW + 4;
  const tot = a.hours.map(h => FAMS.reduce((s, f) => s + h[f], 0));
  const max = Math.max(1, ...tot);
  const q = v => Math.round((v / max) * H / 2) * 2;               // 2px steps
  let bars = '';
  a.hours.forEach((h, i) => {
    let y = T + H;
    const x = L + i * BW + 1;
    for (const f of FAMS) { const hh = q(h[f]); if (!hh) continue; y -= hh; bars += `<rect class="f-${f}" x="${x}" y="${y}" width="${BW - 2}" height="${hh}"/>`; }
    const tip = `${i}시 · 출력 ${fmtTok(tot[i])}` + FAMS.filter(f => h[f]).map(f => ` · ${FAM_KO[f]} ${fmtTok(h[f])}`).join('');
    bars += `<rect class="hit" x="${L + i * BW}" y="${T}" width="${BW}" height="${H}" data-tip="${esc(tip)}"/>`;
  });
  const nx = L + (now.getHours() + now.getMinutes() / 60) * BW;
  const ticks = [0, 6, 12, 18, 23].map(hh => `<text x="${L + hh * BW + BW / 2}" y="${T + H + 12}" text-anchor="middle">${hh}</text>`).join('');
  return `<svg class="hourly" viewBox="0 0 ${W} ${T + H + 28}" shape-rendering="crispEdges" role="img" aria-label="시간대별 출력 토큰">
    <line class="axis" x1="${L}" y1="${T + H + 0.5}" x2="${W - 2}" y2="${T + H + 0.5}"/>
    <text x="${L - 4}" y="${T + 6}" text-anchor="end">${fmtTok(max)}</text><text x="${L - 4}" y="${T + H}" text-anchor="end">0</text>
    ${bars}<line class="nowline" x1="${nx}" y1="${T - 4}" x2="${nx}" y2="${T + H}"/><text class="nowt" x="${nx}" y="${T + H + 24}" text-anchor="middle">지금</text>${ticks}</svg>`;
}

// ---------- 3. per-floor horizontal bars split by family ----------
export function floorBarsHTML(a, labelOf) {
  const rows = Object.entries(a.byProj).sort((x, y) => y[1].total - x[1].total).slice(0, 10);
  if (!rows.length) return emptyHTML('층별 기록이 없어요', '');
  const max = Math.max(1, ...rows.map(([, p]) => p.total));
  return rows.map(([proj, p]) => `<div class="hb" data-tip="${esc(`${labelOf(proj)} · 총 ${fmtTok(p.total)} 토큰 (입력+출력+캐시)` + FAMS.filter(f => p[f]).map(f => ` · ${FAM_KO[f]} ${fmtTok(p[f])}`).join(''))}">
    <span class="hb-l">${esc(labelOf(proj))}</span><span class="hb-bar"><span style="width:${((p.total / max) * 100).toFixed(1)}%">${
      FAMS.filter(f => p[f]).map(f => `<i class="f-${f}" style="flex:${p[f]}"></i>`).join('')}</span></span><b>${fmtTok(p.total)}</b></div>`).join('');
}

// ---------- 4-6. gauges ----------
/** Cache hit as an XP-style bar. */
export const xpBarHTML = (frac, label, tip) => `<div class="xp" data-tip="${esc(tip)}"><span class="xp-fill" style="width:${((frac || 0) * 100).toFixed(1)}%"></span><b class="xp-n">${esc(label)}</b></div>`;

export function detailHTML(a, opts) {
  if (!a || !a.n) return emptyHTML('아직 사용량 기록이 없어요', opts.sim ? '' : EMPTY_SUB);
  const t = a.tot, inAll = t.in + t.cR + t.cW;
  const mainSub = a.main + a.subOut;
  return `
    <section class="dcard"><h3>시간대별 출력 토큰 <small>모델별 스택 · 오늘 0–23시</small></h3>${hourlySVG(a, opts.now)}
      <div class="legend-row">${FAMS.filter(f => a.byFam[f].out).map(f => `<span class="lg"><i class="sq f-${f}"></i>${FAM_KO[f]}</span>`).join('')}</div></section>
    <section class="dcard"><h3>층(프로젝트)별 총 토큰 <small>모델 색으로 나눔</small></h3><div class="hbs">${floorBarsHTML(a, opts.labelOf)}</div></section>
    <section class="dcard two">
      <div><h3>캐시 적중</h3>${xpBarHTML(a.cacheHit, pct(a.cacheHit), `캐시 읽기 ${fmtTok(t.cR)} ÷ (입력 ${fmtTok(t.in)} + 캐시 읽기 + 캐시 쓰기 ${fmtTok(t.cW)})`)}</div>
      <div><h3>입력 vs 출력</h3><div class="sbar" data-tip="${esc(`입력(캐시 포함) ${fmtTok(inAll)} · 출력 ${fmtTok(t.out)}`)}"><i class="in" style="flex:${inAll || 0}"></i><i class="out" style="flex:${t.out || 0}"></i></div>
        <div class="kv3"><span>입력<b>${fmtTok(inAll)}</b></span><span>출력 ${pct((inAll + t.out) ? t.out / (inAll + t.out) : null)}<b>${fmtTok(t.out)}</b></span><span>세션<b>${a.sessions.size}</b></span><span>메시지<b>${a.n}</b></span></div></div></section>
    <section class="dcard"><h3>메인(실장) 직접 vs 서브에이전트 <small>출력 토큰 · 분배 규칙이 실제 토큰에서 지켜지는지</small></h3>
      <div class="sbar tall" data-tip="${esc(`메인 직접 ${fmtTok(a.main)}${FAMS.filter(f => a.mainBy[f]).map(f => ` (${FAM_KO[f]} ${fmtTok(a.mainBy[f])})`).join('')} · 서브에이전트 ${fmtTok(a.subOut)}`)}">${
        FAMS.filter(f => a.mainBy[f]).map(f => `<i class="f-${f}" style="flex:${a.mainBy[f]}"></i>`).join('')}${
        FAMS.filter(f => a.sub[f]).map(f => `<i class="f-${f} sub" style="flex:${a.sub[f]}"></i>`).join('')}</div>
      <div class="kv3"><span>메인 직접<b>${pct(mainSub ? a.main / mainSub : null)}</b></span><span>서브에이전트<b>${pct(mainSub ? a.subOut / mainSub : null)}</b></span>${
        opts.pricing && a.usd != null ? `<span>오늘 비용<b>${usd(a.usd)}</b></span>` : '<span class="muted" data-tip="office/pricing.json 이 있을 때만 금액을 보여줘요">비용<b>—</b></span>'}</div></section>
    <p class="fine">요금제 5시간 한도·잔여량은 로컬 기록에 없어서 보여주지 않아요.${opts.sim ? ' 지금은 시뮬레이터 가짜 데이터예요.' : ''}</p>`;
}
