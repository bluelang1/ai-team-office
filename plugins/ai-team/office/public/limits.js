// AI Team Office v3 — 플랜 한도 (5시간 / 7일) and per-session context windows. Pure HTML builders (testable).
// Snapshot contract (server limits.mjs): {account:{five_hour:{pct,resetsAt(epoch s),capturedAt}|null, seven_day|null, stale},
// sessions:[{sid, proj, model, family, ctx:{size,pct,inTokens}, costUsd?, capturedAt, stale}]}.

const esc = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const FAMS = ['fable', 'opus', 'sonnet', 'haiku'];
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** green < 60, amber 60–85, red > 85 */
export const levelOf = pct => (pct == null ? 'none' : pct > 85 ? 'red' : pct >= 60 ? 'amber' : 'green');
/** "2시간 13분", "3일 4시간", "45분", "1분 미만" */
export function fmtLeft(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms <= 0) return '곧 리셋';
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d >= 1) return `${d}일 ${h % 24}시간`;
  if (h >= 1) return `${h}시간 ${m % 60}분`;
  return m >= 1 ? `${m}분` : '1분 미만';
}
/** 41만 / 100만 style token counts. */
export const tokKo = n => (n == null ? '—' : n >= 1e8 ? `${+(n / 1e8).toFixed(1)}억` : n >= 1e4 ? `${Math.round(n / 1e4)}만` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}천` : String(Math.round(n)));
const clockOf = s => new Date(s * 1000).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

function gauge(label, w, nowMs) {
  if (!w) return `<div class="lim-row none"><span class="lim-l">${label}</span><span class="lim-bar"><i style="width:0"></i></span><b class="lim-p">—</b>
    <small class="lim-r">리셋됨 · 다음 응답 후 표시</small></div>`;
  const pct = num(w.pct), lv = levelOf(pct), left = w.resetsAt ? w.resetsAt * 1000 - nowMs : null;
  return `<div class="lim-row lv-${lv}"><span class="lim-l">${label}</span>
    <span class="lim-bar" role="meter" aria-label="${label} 사용률" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct ?? 0}"><i style="width:${Math.max(0, Math.min(100, pct ?? 0)).toFixed(1)}%"></i></span>
    <b class="lim-p">${pct == null ? '—' : `${Math.round(pct)}%`}</b>
    <small class="lim-r" ${w.resetsAt ? `title="리셋 ${esc(clockOf(w.resetsAt))}"` : ''}>${w.resetsAt ? `리셋까지 ${fmtLeft(left)}` : '리셋 시각 모름'}</small></div>`;
}

/** The two account gauges. snap null/without account -> the "no data" note. */
export function limitsHTML(snap, nowMs = Date.now()) {
  const a = snap && snap.account;
  if (!a || (!a.five_hour && !a.seven_day)) return '<p class="empty-note lim-none">데이터 없음 (Pro/Max 로그인 세션에서 응답 후 표시)</p>';
  return gauge('5시간', a.five_hour, nowMs) + gauge('7일', a.seven_day, nowMs);
}

/** Today's sessions' context bars (newest first). opts: { labelOf(proj), all, max=5 } */
export function ctxHTML(snap, opts = {}) {
  const list = Array.isArray(snap?.sessions) ? snap.sessions.filter(s => s && s.ctx) : [];
  if (!list.length) return '<p class="empty-note">오늘 컨텍스트 기록이 없어요.</p>';
  const max = opts.max ?? 5, rows = opts.all ? list : list.slice(0, max), labelOf = opts.labelOf || (p => p);
  return `<div class="ctx-list">${rows.map(s => {
    const pct = num(s.ctx.pct), size = num(s.ctx.size), used = num(s.ctx.inTokens) ?? (pct != null && size ? (pct / 100) * size : null);
    const fam = FAMS.includes(s.family) ? s.family : 'unknown', lv = levelOf(pct);
    return `<div class="ctx-row lv-${lv}${s.stale ? ' stale' : ''}" title="${esc(`${s.proj || '?'} · 세션 ${String(s.sid || '').slice(0, 8)} · ${s.model || fam}${s.stale ? ' · 오래됨(10분+)' : ''}`)}">
      <span class="ctx-p">${esc(labelOf(s.proj || '?'))}</span><span class="mbadge" style="--m:var(--${fam});--mi:var(--${fam}-ink)">${esc(fam === 'unknown' ? (s.model || '?') : fam)}</span>
      <span class="ctx-bar"><i style="width:${Math.max(0, Math.min(100, pct ?? 0)).toFixed(1)}%"></i></span>
      <small class="ctx-n"><b>${pct == null ? '—' : `${Math.round(pct)}%`}</b> ${tokKo(used)}/${tokKo(size)} 토큰</small></div>`;
  }).join('')}</div>${list.length > max ? `<button type="button" class="chipbtn ctx-more" data-a="ctx-more" aria-expanded="${!!opts.all}">${opts.all ? '접기' : `더보기 (${list.length - max})`}</button>` : ''}`;
}

/** The context of one session (for the 실장 desk monitor), or null. */
export function ctxOf(snap, sid) {
  const s = Array.isArray(snap?.sessions) ? snap.sessions.find(x => x && x.sid === sid && x.ctx) : null;
  if (!s) return null;
  const pct = num(s.ctx.pct);
  return { pct, lv: levelOf(pct), size: num(s.ctx.size), used: num(s.ctx.inTokens), stale: !!s.stale };
}
