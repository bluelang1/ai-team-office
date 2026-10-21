// AI Team Office v2 — 대표실 answer cards. Relay items arrive on SSE `event: ceo`
// ({type:'snapshot'|'ask'|'answered'|'resolved'|'withdrawn'|'expired'}); answers go to POST /relay/answer.
// Without a relay (older server) nothing arrives and the 대표실 cards stay view-only.

import { HIGH } from './ceo.js';

const esc = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
export const relay = { items: new Map() };            // id -> { item, status, at }
const drafts = new Map();                              // id -> { sel: {qi: Set<label>|label}, deny: bool, why: string, note: string }
const STATUS_KO = { sending: '보내는 중…', answered: '답변 전송됨', released: '돌려보냈어요 · 터미널에서 계속돼요', terminal: '터미널에서 답함', withdrawn: '터미널에서 답함', expired: '만료 · 터미널에서 답해 주세요' };
const OPEN = new Set(['pending', 'sending']);

const valid = it => it && typeof it === 'object' && typeof it.id === 'string' && typeof it.sid === 'string' && (it.kind === 'permission' || it.kind === 'question');
function upsert(it) { const r = relay.items.get(it.id); if (r) r.item = it; else relay.items.set(it.id, { item: it, status: 'pending', at: 0 }); }
function close(id, status, now) { const r = relay.items.get(id); if (!r) return false; r.status = status; r.at = now; return true; }

/** Apply one `event: ceo` frame. Returns true when something changed. */
export function applyFrame(f, now = Date.now()) {
  if (!f || typeof f !== 'object') return false;
  switch (f.type) {
    case 'snapshot': {
      const keep = new Set();
      for (const it of Array.isArray(f.items) ? f.items : []) if (valid(it)) { keep.add(it.id); upsert(it); }
      for (const [id, r] of relay.items) if (!keep.has(id) && OPEN.has(r.status)) relay.items.delete(id);
      return true;
    }
    case 'ask': if (valid(f.item)) { upsert(f.item); return true; } return false;
    case 'answered': return close(f.id, f.by === 'dashboard' ? 'answered' : 'terminal', now);
    case 'resolved': return close(f.id, f.reason === 'timeout' ? 'expired' : f.reason === 'released' ? 'released' : 'terminal', now);
    case 'withdrawn': return close(f.id, 'withdrawn', now);
    case 'expired': return close(f.id, 'expired', now);
    default: return false;
  }
}
/** The `${sid}|${aid|main}` key a frame resolves when it means the human decided (dashboard or terminal), else null.
 *  A timeout (`resolved` reason timeout, `expired`) is not a decision: the terminal prompt is still waiting. */
export function decidedKey(f) {
  if (!f || typeof f !== 'object') return null;
  const decided = f.type === 'answered' || f.type === 'withdrawn' || (f.type === 'resolved' && f.reason !== 'timeout');
  const it = decided ? relay.items.get(f.id)?.item : null;
  return it ? keyOfItem(it) : null;
}
/** Key of a relay record (for a local answer in the simulator or after POST /relay/answer). */
export const keyOfRelay = r => (r?.item ? keyOfItem(r.item) : null);
/** Forget closed cards a few seconds after they closed. */
export function sweep(now, ms = 6000) {
  let changed = false;
  for (const [id, r] of relay.items) if (!OPEN.has(r.status) && now - r.at > ms) { relay.items.delete(id); drafts.delete(id); changed = true; }
  return changed;
}
export function resetRelay() { relay.items.clear(); drafts.clear(); }

const keyOfItem = it => `${it.sid}|${it.aid || 'main'}`;
const textOf = it => (it.kind === 'question' ? it.questions?.[0]?.question || '질문이 있어요' : `${it.tool || ''} ${it.target ?? ''}`.trim() || '승인이 필요해요');
/** Waiting list (ceo.js) + relay items: each entry gets `.relay` (newest item for that character); relay-only items become entries. */
export function mergeQueue(list) {
  const byKey = new Map(list.map(q => [q.key, { ...q }]));
  const items = [...relay.items.values()].sort((a, b) => (a.item.createdAt || 0) - (b.item.createdAt || 0));
  for (const r of items) {
    const it = r.item, k = keyOfItem(it);
    let q = byKey.get(k);
    if (!q && !OPEN.has(r.status)) continue;             // answered/closed cards never keep (or bring back) someone in line
    if (!q) {
      q = { key: k, sid: it.sid, proj: it.proj || '(unknown)', aid: it.aid || null, atype: it.atype || null, kind: it.kind === 'question' ? 'ask' : 'perm',
        prio: HIGH, text: textOf(it), since: it.createdAt || Date.now(), tool: it.tool || null };
      byKey.set(k, q);
    }
    q.relay = r;
  }
  return [...byKey.values()].sort((a, b) => a.since - b.since || (a.key < b.key ? -1 : 1));
}

const draftOf = id => { let d = drafts.get(id); if (!d) { d = { sel: {}, deny: false, why: '', note: '' }; drafts.set(id, d); } return d; };
const fmtLeft = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}분 ${String(s % 60).padStart(2, '0')}초`; };

/** Static answer section (live countdown is filled by relayLive). */
export function relayHTML(r) {
  const it = r.item, d = draftOf(it.id), dis = OPEN.has(r.status) && r.status !== 'sending' ? '' : 'disabled';
  const status = r.status === 'pending' ? '' : `<p class="rl-st st-${r.status}">${STATUS_KO[r.status] || esc(r.status)}</p>`;
  const note = d.note ? `<p class="rl-note">${esc(d.note)}</p>` : '';
  if (it.kind === 'permission') {
    return `<div class="rl"><div class="rl-t"><b>${esc(it.tool)}</b>${it.target != null ? `<code>${esc(it.target)}</code>` : ''}${it.clipped ? '<small>(길어서 잘렸어요)</small>' : ''}<span class="live-left pill" title="남은 대기"></span></div>
      <div class="btns"><button type="button" class="chipbtn ok" data-a="allow" ${dis}>승인</button>
        <button type="button" class="chipbtn no" data-a="deny-open" aria-expanded="${d.deny}" ${dis}>거부…</button></div>
      ${d.deny ? `<div class="deny"><input class="why" maxlength="500" placeholder="거부 사유 한 줄 (선택)" value="${esc(d.why)}" ${dis}>
        <button type="button" class="chipbtn no" data-a="deny" ${dis}>거부 보내기</button></div>` : ''}
      <p class="rl-left">이번 한 번만 적용돼요</p>${status}${note}</div>`;
  }
  const qs = Array.isArray(it.questions) ? it.questions : [];
  const quick = qs.length === 1 && !qs[0].multiSelect;
  const ready = qs.every((q, i) => (q.multiSelect ? d.sel[i]?.size : d.sel[i]));
  return `<div class="rl">${qs.map((q, i) => `<fieldset class="rq"><legend>${q.header ? `<span class="hchip">${esc(q.header)}</span>` : ''}${esc(q.question)}${
    q.multiSelect ? ' <small>(여러 개 고를 수 있어요)</small>' : ''}</legend><div class="opts">${q.options.map(o => q.multiSelect
      ? `<label class="opt" title="${esc(o.description)}"><input type="checkbox" data-q="${i}" value="${esc(o.label)}" ${d.sel[i]?.has(o.label) ? 'checked' : ''} ${dis}><span>${esc(o.label)}</span></label>`
      : `<button type="button" class="opt" data-a="pick" data-q="${i}" data-v="${esc(o.label)}" aria-pressed="${d.sel[i] === o.label}" title="${esc(o.description)}" ${dis}>${esc(o.label)}${
        o.description ? `<small>${esc(o.description)}</small>` : ''}</button>`).join('')}</div></fieldset>`).join('')}
    ${quick ? '' : `<div class="btns"><button type="button" class="chipbtn primary" data-a="send" ${ready && !dis ? '' : 'disabled'}>확인 · 답 보내기</button></div>`}
    <p class="rl-left">남은 대기 <span class="live-left pill"></span></p>${status}${note}</div>`;
}
export function relayLive(el, r, now = Date.now()) {
  const n = el.querySelector('.live-left');
  if (!n) return;
  const left = OPEN.has(r.status) && r.item.expiresAt ? r.item.expiresAt - now : null;
  n.textContent = left == null ? '—' : `⏱ ${fmtLeft(left)}`;
  n.classList.toggle('urgent', left != null && left < 30000);
}

/** Viewer token the server put in index.html (<meta name="office-token">); sent on every dashboard-only call. */
export const officeToken = () => (typeof document !== 'undefined' && document.querySelector('meta[name="office-token"]')?.content) || '';
/** True when the page was served by an earlier server process than the one now streaming (`ready.boot`): its viewer
 *  token is stale, so it must reload. Missing values (simulator, older server) never trigger a reload. */
export const staleBoot = (pageBoot, readyBoot) => typeof pageBoot === 'string' && !!pageBoot && typeof readyBoot === 'string' && !!readyBoot && pageBoot !== readyBoot;
export const officeHeaders = () => ({ 'Content-Type': 'application/json', 'X-Office-Token': officeToken() });

async function send(r, decision, sim) {
  const d = draftOf(r.item.id);
  r.status = 'sending'; d.note = '';
  if (sim || String(r.item.id).startsWith('sim-')) { await new Promise(res => setTimeout(res, 250)); r.status = 'answered'; r.at = Date.now(); d.note = '시뮬레이터라 실제로 보내진 않았어요.'; return; }
  try {
    const res = await fetch('/relay/answer', { method: 'POST', headers: officeHeaders(), body: JSON.stringify({ id: r.item.id, decision }) });
    if (res.ok) { r.status = 'answered'; r.at = Date.now(); return; }
    if (res.status === 409) { r.status = 'terminal'; r.at = Date.now(); d.note = '이미 다른 곳에서 답했어요.'; return; }
    if (res.status === 404) { r.status = 'expired'; r.at = Date.now(); d.note = '만료된 요청이에요. 터미널에서 답해 주세요.'; return; }
    const j = await res.json().catch(() => ({}));
    r.status = 'pending'; d.note = `보내지 못했어요: ${j.error || res.status}`;
  } catch { r.status = 'pending'; d.note = '보내지 못했어요. 서버 연결을 확인해 주세요.'; }
}

/** 돌려보내기 for a relay card: POST /relay/release (no decision; the terminal prompt takes over). 404/409/410 mean the
 *  server has nothing left to release: the card just closes here. The simulator releases locally. */
export async function releaseRelay(r, sim) {
  if (!r || !OPEN.has(r.status)) return 'closed';
  if (sim || String(r.item.id).startsWith('sim-')) { r.status = 'released'; r.at = Date.now(); return 'released'; }
  try {
    const res = await fetch('/relay/release', { method: 'POST', headers: officeHeaders(), body: JSON.stringify({ id: r.item.id }) });
    if (res.ok || [404, 409, 410].includes(res.status)) { r.status = 'released'; r.at = Date.now(); return res.ok ? 'released' : 'gone'; }
  } catch { /* server down: clear locally anyway */ }
  r.status = 'released'; r.at = Date.now();
  return 'local';
}

/** Click inside the card. Returns a promise when an answer was sent (re-render after it settles). */
export function onRelayClick(ev, r, rerender, sim) {
  const b = ev.target.closest('button[data-a]');
  if (!b || !r || b.disabled) return false;
  const it = r.item, d = draftOf(it.id);
  const go = decision => { const p = send(r, decision, sim).then(rerender); rerender(); return p; };
  switch (b.dataset.a) {
    case 'allow': return go({ behavior: 'allow' });
    case 'deny-open': d.deny = !d.deny; rerender(); return true;
    case 'deny': { const why = d.why.trim(); return go(why ? { behavior: 'deny', message: why } : { behavior: 'deny' }); }
    case 'pick': {
      const i = Number(b.dataset.q); d.sel[i] = b.dataset.v;
      const qs = it.questions || [];
      if (qs.length === 1 && !qs[0].multiSelect) return go({ answers: { [qs[0].question]: d.sel[0] } });
      rerender(); return true;
    }
    case 'send': {
      const answers = {};
      (it.questions || []).forEach((q, i) => { answers[q.question] = q.multiSelect ? [...(d.sel[i] || [])] : d.sel[i]; });
      return go({ answers });
    }
    default: return false;
  }
}
/** Typing a deny reason / ticking a checkbox: update the draft (no re-render while typing). */
export function onRelayInput(ev, r, rerender) {
  if (!r) return;
  const d = draftOf(r.item.id);
  if (ev.target.classList.contains('why')) { d.why = ev.target.value; return; }
  if (ev.target.type === 'checkbox') {
    const i = Number(ev.target.dataset.q);
    const set = d.sel[i] instanceof Set ? d.sel[i] : (d.sel[i] = new Set());
    if (ev.target.checked) set.add(ev.target.value); else set.delete(ev.target.value);
    rerender();
  }
}
