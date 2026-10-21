// AI Team Office v2 — the building: left cross-section (project = floor), rooftop sign, elevator car, overview.
// Floors come from building.json ({floors:{proj:{floor,label}}, ceo, top?}); unregistered projects take the
// highest free floor number in order of first activity today. R (대표실) is always on top.

const esc = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
export const MIN_FLOORS = 5;

/** Pure: rows top→bottom [{n, proj|null, label, fixed}] for a config and the projects seen today (first-activity order). */
export function layoutFloors(config, projs = []) {
  const conf = config && typeof config === 'object' && config.floors && typeof config.floors === 'object' ? config.floors : {};
  const byN = new Map();                                 // several projects may share one floor (same number)
  for (const [proj, v] of Object.entries(conf)) {
    const n = Number(v?.floor);
    if (!Number.isInteger(n) || n <= 0 || n >= 200) continue;
    const row = byN.get(n);
    if (row) row.projs.push(proj); else byN.set(n, { projs: [proj], label: String(v.label || proj), fixed: true });
  }
  const placed = new Set([...byN.values()].flatMap(x => x.projs));
  const loose = [...new Set(projs)].filter(p => p && !placed.has(p));
  let top = Math.max(MIN_FLOORS, Number(config?.top) || 0, ...byN.keys());
  while (top - byN.size < loose.length) top++;
  for (const proj of loose) {
    let n = top;
    while (byN.has(n)) n--;
    byN.set(n, { projs: [proj], label: proj, fixed: false });
  }
  const rows = [];
  for (let n = top; n >= 1; n--) { const x = byN.get(n); rows.push(x ? { n, proj: x.projs[0], projs: x.projs, label: x.label, fixed: x.fixed } : { n, proj: null, projs: [], label: '', fixed: false }); }
  return rows;
}

/** Mount the building into `el`. handlers: onSelect(proj, how), onAuto(), onOverview(), onSettings(). */
export function mountBuilding(el, handlers) {
  el.innerHTML = `
    <div class="bld-bar">
      <button type="button" class="ib" data-act="overview" title="전체 보기 (모든 층)" aria-pressed="false"><i class="ico" style="--i:var(--ico-tower)"></i></button>
      <button type="button" class="chipbtn" data-act="auto" aria-pressed="true" title="가장 최근 활동 층을 따라가요">자동</button>
      <button type="button" class="ib" data-act="settings" title="층 설정"><i class="ico" style="--i:var(--ico-gear)"></i></button>
    </div>
    <div class="sign" aria-label="옥상 전광판"><b class="clk">--:--</b><span>위임 <b class="s-del">0</b></span><span>준수 <b class="s-cmp">—</b></span>
      <span class="s-bell" hidden title="대표님께 온 요청"><i class="ico" style="--i:var(--ico-bell)"></i><b>0</b></span></div>
    <div class="tower">
      <div class="roof" aria-hidden="true"><i class="torch"></i><i class="torch"></i></div>
      <div class="fl fl-r" data-floor="R" title="대표실은 층과 상관없이 씬 오른쪽 아래에 있어요"><span class="fn">R</span><span class="fl-l">대표실</span>
        <span class="hc r-q" hidden></span></div>
      <div class="flist" role="listbox" aria-label="층 (프로젝트)"></div>
      <div class="shaft" aria-hidden="true"><div class="car" title="끌어서 층 이동"><i></i></div></div>
      <div class="lobby"><span>로비</span></div>
    </div>`;
  const list = el.querySelector('.flist'), car = el.querySelector('.car'), tower = el.querySelector('.tower');
  const st = { rows: [], sel: null, sig: '', drag: null };

  el.addEventListener('click', ev => {
    const b = ev.target.closest('[data-act]');
    if (b) { ({ overview: handlers.onOverview, auto: handlers.onAuto, settings: handlers.onSettings })[b.dataset.act]?.(); return; }
    const f = ev.target.closest('.fl[data-proj]');
    if (f) handlers.onSelect(f.dataset.proj, 'click');
  });
  // Mouse wheel over the tower: one floor per notch (only floors with a project).
  let wheelAt = 0;
  tower.addEventListener('wheel', ev => {
    if (matchMedia('(max-width: 760px)').matches) return;
    ev.preventDefault();
    const now = performance.now();
    if (now - wheelAt < 220 || !ev.deltaY) return;
    wheelAt = now;
    const occ = st.rows.filter(r => r.proj);
    if (!occ.length) return;
    const i = occ.findIndex(r => r.proj === st.sel);
    const j = i < 0 ? 0 : Math.max(0, Math.min(occ.length - 1, i + (ev.deltaY > 0 ? 1 : -1)));
    if (occ[j].proj !== st.sel) handlers.onSelect(occ[j].proj, 'wheel');
  }, { passive: false });
  // Drag the elevator car to a floor.
  car.addEventListener('pointerdown', ev => {
    ev.preventDefault();
    car.setPointerCapture(ev.pointerId);
    st.drag = { y0: ev.clientY, top0: car.offsetTop };
    car.classList.add('drag');
  });
  car.addEventListener('pointermove', ev => {
    if (!st.drag) return;
    const max = list.offsetTop + list.offsetHeight - car.offsetHeight;
    car.style.top = `${Math.max(list.offsetTop, Math.min(max, st.drag.top0 + ev.clientY - st.drag.y0))}px`;
  });
  const drop = () => {
    if (!st.drag) return;
    st.drag = null; car.classList.remove('drag');
    const mid = car.offsetTop + car.offsetHeight / 2;
    let best = null, bd = Infinity;
    for (const f of list.querySelectorAll('.fl[data-proj]')) {
      const d = Math.abs(f.offsetTop + f.offsetHeight / 2 - mid);
      if (d < bd) { bd = d; best = f; }
    }
    if (best && best.dataset.proj !== st.sel) handlers.onSelect(best.dataset.proj, 'drag'); else placeCar();
  };
  car.addEventListener('pointerup', drop); car.addEventListener('pointercancel', drop);

  function placeCar() {
    if (st.drag) return;
    const f = st.sel != null ? list.querySelector(`.fl[data-proj="${CSS.escape(st.sel)}"]`) : null;
    car.hidden = !f;
    if (f) car.style.top = `${f.offsetTop + (f.offsetHeight - car.offsetHeight) / 2}px`;
  }

  /** model: { rows, sel, auto, overview, info: {proj: {count, lit, bell}}, sign: {deleg, comp, bell}, ceoWaiting } */
  function render(m) {
    const sig = JSON.stringify(m.rows.map(r => [r.n, r.projs, r.label]));
    if (sig !== st.sig) {
      st.sig = sig;
      list.innerHTML = m.rows.map(r => r.proj
        ? `<button type="button" class="fl" role="option" data-proj="${esc(r.proj)}" title="${esc(`${r.n}층 · ${r.label} (${r.projs.join(', ')})${r.fixed ? '' : ' · 자동 배정'}`)}">
            <span class="fn">${r.n}</span><span class="fw" aria-hidden="true"><i></i><i></i><i></i></span><span class="fl-l">${esc(r.label)}</span>
            <span class="hc"></span><i class="bell" title="승인 대기"></i></button>`
        : `<div class="fl empty" aria-hidden="true"><span class="fn">${r.n}</span><span class="fw"><i></i><i></i><i></i></span><span class="fl-l">빈 층</span></div>`).join('');
    }
    st.rows = m.rows; st.sel = m.sel;
    for (const f of list.querySelectorAll('.fl[data-proj]')) {
      const i = m.info[f.dataset.proj] || {};
      f.classList.toggle('lit', !!i.lit); f.classList.toggle('ring', !!i.bell);
      f.setAttribute('aria-selected', String(f.dataset.proj === m.sel));
      const hc = f.querySelector('.hc'), txt = i.count ? String(i.count) : '';
      if (hc.textContent !== txt) hc.textContent = txt;
      hc.title = i.count ? `지금 ${i.count}명 근무 중` : '';
    }
    el.querySelector('[data-act=auto]').setAttribute('aria-pressed', String(!!m.auto));
    el.querySelector('[data-act=overview]').setAttribute('aria-pressed', String(!!m.overview));
    const clk = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
    const set = (sel, v) => { const n = el.querySelector(sel); if (n.textContent !== v) n.textContent = v; };
    set('.clk', clk); set('.s-del', String(m.sign.deleg)); set('.s-cmp', m.sign.comp);
    const sb = el.querySelector('.s-bell'); sb.hidden = !m.sign.bell; set('.s-bell b', String(m.sign.bell || 0));
    const rq = el.querySelector('.r-q'); rq.hidden = !m.ceoWaiting; set('.r-q', m.ceoWaiting ? `대기 ${m.ceoWaiting}` : '');
    placeCar();
  }
  new ResizeObserver(placeCar).observe(list);
  return { render };
}

// ---------- overview: every floor as a thin strip, characters as moving dots ----------
const ZONES = [['library', '도서관'], ['meeting', '회의실'], ['review', 'QA실'], ['desk', '사무실'], ['server', '서버룸'], ['bench', '개발실'], ['external', '외근'], ['elevator', '🛗']];
const ZX = Object.fromEntries(ZONES.map(([k], i) => [k, (i + 0.5) / ZONES.length]));
const dotsBy = new Map();

/** floors: [{n, proj, label, chars:[{id, model, room, name, blocked}]}] */
export function renderOverview(el, floors) {
  if (!el._built) {
    el._built = true;
    el.innerHTML = `<div class="ov-head"><span>전체 보기 · 층을 누르면 그 층으로 가요</span><span class="ov-zones">${ZONES.map(([, n]) => `<i>${n}</i>`).join('')}</span></div><div class="ov-list"></div>`;
  }
  const list = el.querySelector('.ov-list');
  const sig = floors.map(f => `${f.n}|${f.proj}|${f.label}`).join(',');
  if (list._sig !== sig) {
    list._sig = sig; dotsBy.clear();
    list.innerHTML = floors.length ? floors.map(f => `<button type="button" class="ov-fl" data-proj="${esc(f.proj)}"><span class="fn">${f.n}F</span>
      <span class="ov-l">${esc(f.label)}</span><span class="ov-track"></span></button>`).join('')
      : '<p class="empty-note">아직 출근한 층이 없어요.</p>';
  }
  for (const f of floors) {
    const track = list.querySelector(`.ov-fl[data-proj="${CSS.escape(f.proj)}"] .ov-track`);
    if (!track) continue;
    const seen = new Set(), perZone = {};
    for (const c of f.chars) {
      const id = `${f.proj}|${c.id}`; seen.add(id);
      let d = dotsBy.get(id);
      if (!d) { d = document.createElement('i'); d.className = 'dot'; track.append(d); dotsBy.set(id, d); }
      const z = ZX[c.room] ?? ZX.desk, k = perZone[c.room] = (perZone[c.room] || 0) + 1;
      d.style.left = `calc(${(z * 100).toFixed(2)}% + ${((k - 1) % 4) * 7 - 10}px)`;
      d.style.top = `${4 + Math.floor((k - 1) / 4) * 8}px`;
      d.style.setProperty('--m', `var(--${c.model in { fable: 1, opus: 1, sonnet: 1, haiku: 1 } ? c.model : 'unknown'})`);
      d.classList.toggle('blk', !!c.blocked);
      d.title = c.name;
    }
    for (const [id, d] of dotsBy) if (id.startsWith(`${f.proj}|`) && !seen.has(id)) { d.remove(); dotsBy.delete(id); }
  }
}

/** Short elevator-door transition over `stage` (0.4s; pass a non-scrolling box). Skipped under reduced motion.
 *  The overlay clips its doors (overflow: hidden) and is removed when the animation ends: the doors rest at
 *  ±100% outside the box, so a lingering overlay used to cover the building and the right panel. */
export function elevatorFx(stage, label) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let fx = stage.querySelector('.lift-fx');
  if (!fx) {
    fx = document.createElement('div'); fx.className = 'lift-fx'; fx.setAttribute('aria-hidden', 'true');
    fx.innerHTML = '<i class="d l"></i><i class="d r"></i><b></b>';
    fx.addEventListener('animationend', ev => { if (ev.target.classList.contains('r')) fx.classList.remove('run'); });
    stage.append(fx);
  }
  fx.querySelector('b').textContent = label;
  fx.classList.remove('run'); void fx.offsetWidth; fx.classList.add('run');
  clearTimeout(fx._t); fx._t = setTimeout(() => fx.classList.remove('run'), 700);   // safety net if animationend is missed
}
