// AI Team Office v2 — 대표실 answer cards. Relay items arrive on SSE `event: ceo`
// ({type:'snapshot'|'ask'|'answered'|'resolved'|'withdrawn'|'expired'}); answers go to POST /relay/answer.
// Without a relay (older server) nothing arrives and the 대표실 cards stay view-only.

import { HIGH, LOW } from './ceo.js';

const esc = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
export const relay = { items: new Map(), seenInstruct: false, ends: [], seen: new Set(), startedAt: 0 };   // id -> { item, status, at }; seenInstruct: an
                                                       // instruct item ever arrived on this page (= ceo-stop.sh installed)
const drafts = new Map();                              // id -> { sel: {qi: Set<label>|label}, deny: bool, why: string, text: string, note: string }
/** Quick chips on an instruct card: they only fill the box (the human still presses 보내기). */
export const INSTRUCT_CHIPS = ['진행해 주세요', '머지해 주세요', '보류해 주세요'];
export const INSTRUCT_MAX = 2000;
const STATUS_KO = { sending: '보내는 중…', answered: '답변 전송됨', released: '터미널로 넘겼어요 · 터미널에서 답해 주세요', terminal: '터미널에서 답함', withdrawn: '터미널에서 답함', expired: '만료 · 터미널에서 답해 주세요' };
const OPEN = new Set(['pending', 'sending']);

const valid = it => it && typeof it === 'object' && typeof it.id === 'string' && typeof it.sid === 'string' && (it.kind === 'permission' || it.kind === 'question' || it.kind === 'instruct');
function upsert(it) { relay.seen.add(it.sid); if (it.kind === 'instruct') relay.seenInstruct = true; const r = relay.items.get(it.id); if (r) r.item = it; else relay.items.set(it.id, { item: it, status: 'pending', at: 0 }); }
function close(id, status, now) { const r = relay.items.get(id); if (!r) return false; r.status = status; r.at = now; return true; }
const END_OK = new Set(['timeout', 'no-viewer', 'hidden', 'withdrawn', 'released', 'cap', 'unchecked']);
/** Remember why a request ended without a decision (server `ended` frames, snapshot `ends`, or a closing item). */
function noteEnd(e) {
  if (!e || typeof e.sid !== 'string' || !END_OK.has(e.reason)) return;
  relay.seen.add(e.sid);
  relay.ends.push({ sid: e.sid, aid: typeof e.aid === 'string' && e.aid ? e.aid : null, tool: typeof e.tool === 'string' ? e.tool : '', reason: e.reason,
    wait: Number.isFinite(e.wait) ? e.wait : null, at: Number.isFinite(e.at) ? e.at : 0 });
  if (relay.ends.length > 300) relay.ends.splice(0, relay.ends.length - 300);
}
const endFromItem = (id, reason, now) => { const it = relay.items.get(id)?.item; if (it) noteEnd({ sid: it.sid, aid: it.aid, tool: it.tool, reason, wait: it.expiresAt - it.createdAt, at: now }); };

/** Apply one `event: ceo` frame. Returns true when something changed. */
export function applyFrame(f, now = Date.now()) {
  if (!f || typeof f !== 'object') return false;
  switch (f.type) {
    case 'snapshot': {
      const keep = new Set();
      if (Array.isArray(f.ends)) { relay.ends = []; for (const e of f.ends) noteEnd(e); }
      if (Number.isFinite(f.startedAt)) relay.startedAt = f.startedAt;
      for (const it of Array.isArray(f.items) ? f.items : []) if (valid(it)) { keep.add(it.id); upsert(it); }
      for (const [id, r] of relay.items) if (!keep.has(id) && OPEN.has(r.status)) relay.items.delete(id);
      return true;
    }
    case 'ask': if (valid(f.item)) { upsert(f.item); return true; } return false;
    case 'ended': noteEnd(f.end); return true;           // not held at all (no dashboard open / only background tabs)
    case 'answered': return close(f.id, f.by === 'dashboard' ? 'answered' : 'terminal', now);
    case 'resolved': endFromItem(f.id, f.reason, now); return close(f.id, f.reason === 'timeout' ? 'expired' : f.reason === 'released' ? 'released' : 'terminal', now);
    case 'withdrawn': endFromItem(f.id, 'withdrawn', now); return close(f.id, 'withdrawn', now);
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
export function resetRelay() { relay.items.clear(); drafts.clear(); relay.ends = []; relay.seen = new Set(); relay.startedAt = 0; }

const durKo = ms => { const s = Math.max(1, Math.round(ms / 1000)), m = Math.floor(s / 60), r = s % 60; return m ? (r ? `${m}분 ${r}초` : `${m}분`) : `${r}초`; };
/** Why a 대표실 request (perm / ask / notify entry) has no answer buttons, as specifically as the data allows.
 *  q = the waiting entry (key, sid, aid, tool, since); st = { ends, seen, startedAt } (relay state). The latest
 *  ending for the same character (and tool, when both know it) at or after the request (1s slack for whole-second
 *  hook ts) wins. -> { text, inferred } . Pure. */
export function whyNoButtons(q, st = relay) {
  const aid = q.aid || null, since = (q.since || 0) - 1000;
  const end = [...(st.ends || [])].reverse().find(e => e.sid === q.sid && (e.aid || null) === aid && e.at >= since && (!q.tool || !e.tool || e.tool === q.tool));
  const tail = ' · 터미널에서 답해 주세요';
  if (end?.reason === 'timeout') return { text: `${end.wait ? durKo(end.wait) : '정해진 시간'} 동안 대시보드 답을 기다리다 터미널로 넘겼어요${tail}`, inferred: false };
  if (end?.reason === 'no-viewer') return { text: `대시보드가 열려 있지 않아 터미널로 갔어요${tail}`, inferred: false };
  if (end?.reason === 'hidden') return { text: `대시보드 탭이 뒤에 있어 터미널로 갔어요${tail}`, inferred: false };
  if (end?.reason === 'released') return { text: `터미널로 넘겼어요${tail}`, inferred: false };
  if (end?.reason === 'withdrawn') return { text: '터미널에서 먼저 답했거나 훅이 끝났어요 · 터미널을 확인해 주세요', inferred: false };
  if (!st.seen?.has?.(q.sid) && st.startedAt && q.since >= st.startedAt) return { text: `대표실 중계가 설치되지 않았어요${tail}`, inferred: true };
  return { text: `이 요청은 여기서 답할 수 없어요 (지난 요청이거나 서버가 다시 시작됨)${tail}`, inferred: false };
}

const keyOfItem = it => `${it.sid}|${it.aid || 'main'}`;
const textOf = it => (it.kind === 'instruct' ? '결정을 기다려요' : it.kind === 'question' ? it.questions?.[0]?.question || '질문이 있어요' : `${it.tool || ''} ${it.target ?? ''}`.trim() || '승인이 필요해요');
/** Waiting list (ceo.js) + relay items: each entry gets `.relay` (newest item for that character); relay-only items become entries. */
export function mergeQueue(list) {
  const byKey = new Map(list.map(q => [q.key, { ...q }]));
  const items = [...relay.items.values()].sort((a, b) => (a.item.createdAt || 0) - (b.item.createdAt || 0));
  for (const r of items) {
    const it = r.item, k = keyOfItem(it);
    let q = byKey.get(k);
    if (!q && !OPEN.has(r.status)) continue;             // answered/closed cards never keep (or bring back) someone in line
    if (!q) {
      q = it.kind === 'instruct'                          // the hook asked before the office-events Stop line arrived
        ? { key: k, sid: it.sid, proj: it.proj || '(unknown)', aid: null, atype: null, kind: 'report', prio: LOW, asks: true, text: textOf(it),
            since: it.createdAt || Date.now(), tool: null, ...(typeof it.msg === 'string' && it.msg ? { body: it.msg } : {}) }
        : { key: k, sid: it.sid, proj: it.proj || '(unknown)', aid: it.aid || null, atype: it.atype || null, kind: it.kind === 'question' ? 'ask' : 'perm',
            prio: HIGH, text: textOf(it), since: it.createdAt || Date.now(), tool: it.tool || null };
      byKey.set(k, q);
    }
    q.relay = r;
  }
  return [...byKey.values()].sort((a, b) => a.since - b.since || (a.key < b.key ? -1 : 1));
}

const draftOf = id => { let d = drafts.get(id); if (!d) { d = { sel: {}, deny: false, why: '', text: '', note: '' }; drafts.set(id, d); } return d; };
const fmtLeft = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}분 ${String(s % 60).padStart(2, '0')}초`; };

/** Static answer section (live countdown is filled by relayLive). */
export function relayHTML(r) {
  const it = r.item, d = draftOf(it.id), dis = OPEN.has(r.status) && r.status !== 'sending' ? '' : 'disabled', rid = `data-rid="${esc(it.id)}"`;
  // 터미널에서 답할게요: end the hold now with no decision (POST /relay/release) so the terminal prompt shows at once.
  // The card stays (unlike 돌려보내기, which also hides it) and says it went to the terminal.
  const handoff = label => `<button type="button" class="chipbtn term" data-a="handoff" ${rid} ${dis} title="대시보드에서 답하지 않고 지금 터미널에 프롬프트를 띄워요">${label}</button>`;
  const status = r.status === 'pending' ? '' : `<p class="rl-st st-${r.status}">${STATUS_KO[r.status] || esc(r.status)}</p>`;
  const note = d.note ? `<p class="rl-note">${esc(d.note)}</p>` : '';
  if (it.kind === 'instruct') {
    const ready = d.text.trim() && !dis;
    return `<div class="rl rl-ins"><p class="rl-h"><b>대시보드에서 지시하기</b><span class="live-left pill" title="남은 대기"></span></p>
      <div class="ins-chips" role="group" aria-label="빠른 지시">${INSTRUCT_CHIPS.map(c => `<button type="button" class="opt" data-a="chip" ${rid} data-v="${esc(c)}" ${dis}>${esc(c)}</button>`).join('')}</div>
      <textarea class="ins" rows="3" maxlength="${INSTRUCT_MAX}" aria-label="다음 지시" placeholder="다음 지시를 적어 주세요 (Ctrl/⌘+Enter 로 보내기)" ${dis}>${esc(d.text)}</textarea>
      <div class="btns"><button type="button" class="chipbtn primary" data-a="instruct" ${rid} ${ready ? '' : 'disabled'}>보내기</button>
        ${handoff('터미널에서 할게요')}</div>
      <p class="rl-left">보낸 글은 대표님이 친 지시처럼 세션에 전달돼요</p>${status}${note}</div>`;
  }
  if (it.kind === 'permission') {
    return `<div class="rl"><div class="rl-t"><b>${esc(it.tool)}</b>${it.target != null ? `<code>${esc(it.target)}</code>` : ''}${it.clipped ? '<small>(길어서 잘렸어요)</small>' : ''}<span class="live-left pill" title="남은 대기"></span></div>
      <div class="btns"><button type="button" class="chipbtn ok" data-a="allow" ${rid} ${dis}>승인</button>
        <button type="button" class="chipbtn no" data-a="deny-open" ${rid} aria-expanded="${d.deny}" ${dis}>거부…</button>${handoff('터미널에서 답할게요')}</div>
      ${d.deny ? `<div class="deny"><input class="why" maxlength="500" placeholder="거부 사유 한 줄 (선택)" value="${esc(d.why)}" ${dis}>
        <button type="button" class="chipbtn no" data-a="deny" ${rid} ${dis}>거부 보내기</button></div>` : ''}
      <p class="rl-left">이번 한 번만 적용돼요</p>${status}${note}</div>`;
  }
  const qs = Array.isArray(it.questions) ? it.questions : [];
  const quick = qs.length === 1 && !qs[0].multiSelect;
  const ready = qs.every((q, i) => (q.multiSelect ? d.sel[i]?.size : d.sel[i]));
  return `<div class="rl">${qs.map((q, i) => `<fieldset class="rq"><legend>${q.header ? `<span class="hchip">${esc(q.header)}</span>` : ''}${esc(q.question)}${
    q.multiSelect ? ' <small>(여러 개 고를 수 있어요)</small>' : ''}</legend><div class="opts">${q.options.map(o => q.multiSelect
      ? `<label class="opt" title="${esc(o.description)}"><input type="checkbox" data-q="${i}" value="${esc(o.label)}" ${d.sel[i]?.has(o.label) ? 'checked' : ''} ${dis}><span>${esc(o.label)}</span></label>`
      : `<button type="button" class="opt" data-a="pick" ${rid} data-q="${i}" data-v="${esc(o.label)}" aria-pressed="${d.sel[i] === o.label}" title="${esc(o.description)}" ${dis}>${esc(o.label)}${
        o.description ? `<small>${esc(o.description)}</small>` : ''}</button>`).join('')}</div></fieldset>`).join('')}
    <div class="btns">${quick ? '' : `<button type="button" class="chipbtn primary" data-a="send" ${rid} ${ready && !dis ? '' : 'disabled'}>확인 · 답 보내기</button>`}${handoff('터미널에서 답할게요')}</div>
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
  const it = r.item;                                      // remembered so the card can keep saying "터미널로 넘겼어요"
  noteEnd({ sid: it.sid, aid: it.aid, tool: it.tool, reason: 'released', wait: it.expiresAt - it.createdAt, at: Date.now() });
  if (sim || String(r.item.id).startsWith('sim-')) { r.status = 'released'; r.at = Date.now(); return 'released'; }
  try {
    const res = await fetch('/relay/release', { method: 'POST', headers: officeHeaders(), body: JSON.stringify({ id: r.item.id }) });
    if (res.ok || [404, 409, 410].includes(res.status)) { r.status = 'released'; r.at = Date.now(); return res.ok ? 'released' : 'gone'; }
  } catch { /* server down: clear locally anyway */ }
  r.status = 'released'; r.at = Date.now();
  return 'local';
}

const RELAY_ACTIONS = new Set(['allow', 'deny-open', 'deny', 'pick', 'send', 'chip', 'instruct', 'handoff']);
/** Click inside the card. Returns a promise when an answer was sent (re-render after it settles), true when the click
 *  was a relay action that is handled or refused, false when it is not a relay button. Refused (no second POST):
 *  the item is no longer open or is already sending (double Enter / double click), or the button was rendered for a
 *  different relay item than the one now under this card (data-rid ≠ r.item.id). */
export function onRelayClick(ev, r, rerender, sim) {
  const b = ev.target.closest('button[data-a]');
  if (!b || !RELAY_ACTIONS.has(b.dataset.a)) return false;
  if (!r || b.disabled || b.dataset.rid !== r.item.id || !OPEN.has(r.status) || r.status === 'sending') return true;
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
    case 'chip': d.text = b.dataset.v || ''; rerender({ focus: '.ins' }); return true;
    case 'instruct': { const text = d.text.trim(); if (!text) return true; return go({ text: Array.from(text).slice(0, INSTRUCT_MAX).join('') }); }
    case 'handoff': { const p = releaseRelay(r, sim).then(() => rerender({ focus: '[data-a="focus"]' })); rerender(); return p; }
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
  if (ev.target.classList.contains('ins')) {                // no re-render while typing; only the 보내기 button follows
    const had = !!d.text.trim(); d.text = ev.target.value;
    const btn = ev.target.closest('.rl')?.querySelector('[data-a="instruct"]');
    if (btn && had !== !!d.text.trim()) btn.disabled = !d.text.trim();
    return;
  }
  if (ev.target.type === 'checkbox') {
    const i = Number(ev.target.dataset.q);
    const set = d.sel[i] instanceof Set ? d.sel[i] : (d.sel[i] = new Set());
    if (ev.target.checked) set.add(ev.target.value); else set.delete(ev.target.value);
    rerender();
  }
}

/** Why a report that asks has no instruction box (no instruct item attached). Latest instruct ending for the main
 *  session at or after the report wins: cap (8 continuations) / unchecked (no caller-process check on this machine)
 *  / timeout / released; else installed-but-unavailable vs. not installed. -> text. Pure. */
export function instructOff(q, st = relay) {
  const since = (q.since || 0) - 1000;
  const end = [...(st.ends || [])].reverse().find(e => e.sid === q.sid && !e.aid && (e.tool === 'Stop' || !e.tool) && e.at >= since);
  if (end?.reason === 'cap') return '연속 지시는 8번까지예요 · 터미널에서 이어 주세요';
  if (end?.reason === 'unchecked') return '이 컴퓨터에서는 대시보드 지시를 쓸 수 없어요 (호출 프로세스 확인 불가: macOS 전용) · 터미널로';
  if (end?.reason === 'timeout') return `${end.wait ? durKo(end.wait) : '정해진 시간'} 동안 지시를 기다리다 멈췄어요 · 터미널에서 이어 주세요`;
  if (end?.reason === 'released') return '터미널로 넘겼어요 · 터미널에서 이어 주세요';
  return st.seenInstruct ? '이 보고는 대시보드 지시를 받을 수 없어요 (시간이 지났거나 터미널로 넘김) · 터미널로' : '대시보드 지시는 설치 후 쓸 수 있어요 · 터미널로';
}
