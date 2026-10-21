// AI Team Office v2 — 층 설정 editor. Drag projects onto floors, drag floors to reorder, rename inline.
// Keyboard: Enter on a project chip puts it on the highest empty floor; ↑/↓ move a floor; ✕ removes.
// Output keeps the building.json shape: { floors: { proj: { floor, label } }, ceo, top }.

import { MIN_FLOORS } from './building.js';

const esc = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/** Draft rows (top→bottom) from a config: only floors the user fixed; everything else is 미배정. */
export function draftFrom(config) {
  const floors = config?.floors && typeof config.floors === 'object' ? config.floors : {};
  const byN = new Map();
  for (const [proj, v] of Object.entries(floors)) {
    const n = Number(v?.floor);
    if (!Number.isInteger(n) || n <= 0 || n >= 200) continue;
    const row = byN.get(n);
    if (row) row.projs.push(proj); else byN.set(n, { projs: [proj], label: String(v.label || proj) });
  }
  const top = Math.max(MIN_FLOORS, Number(config?.top) || 0, ...byN.keys());
  return Array.from({ length: top }, (_, i) => byN.get(top - i) || { projs: [], label: '' });
}
export function configFrom(rows, ceo = '대표') {
  const floors = {};
  rows.forEach((r, i) => { for (const p of r.projs) floors[p] = { floor: rows.length - i, label: (r.label || p).slice(0, 40) }; });
  return { floors, ceo, top: rows.length };
}

/**
 * opts: { host, config, projects: string[], onApply(config), onSave(config) -> Promise<string|null> (null = saved on server) }
 */
export function openFloorEditor(opts) {
  let rows = draftFrom(opts.config);
  let all = [...new Set([...opts.projects, ...Object.keys(opts.config?.floors || {})])].filter(Boolean);
  const ceo = opts.config?.ceo || '대표';
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.innerHTML = `<div class="modal-card px fe" role="dialog" aria-modal="true" aria-labelledby="fe-t">
    <header class="chest-h"><i class="ico" style="--i:var(--ico-gear)"></i><h2 id="fe-t">층 설정</h2><span class="unk-chip" hidden></span><button type="button" class="ib x" title="닫기">✕</button></header>
    <div class="fe-body">
      <section class="fe-left"><h3>미배정 프로젝트</h3><div class="fe-pool" data-drop="pool"></div>
        <p class="hint">끌어서 오른쪽 층에 놓아요. 키보드는 프로젝트에서 Enter 를 누르면 가장 위 빈 층에 들어가요.</p></section>
      <section class="fe-right"><div class="fe-top"><h3>층 (위가 높은 층)</h3><button type="button" class="chipbtn" data-a="add">+ 층 추가</button></div>
        <div class="fe-row fe-r"><b class="n">R</b><span>대표실 · 고정</span></div><ol class="fe-floors"></ol></section>
    </div>
    <footer class="fe-foot"><span class="note" role="status"></span><button type="button" class="chipbtn" data-a="close">닫기</button>
      <button type="button" class="chipbtn primary" data-a="save">저장</button></footer></div>`;
  opts.host.append(wrap);
  const pool = wrap.querySelector('.fe-pool'), list = wrap.querySelector('.fe-floors'), note = wrap.querySelector('.note');
  let unknown = [];        // building.json keys the server did not recognise (GET /building.json → unknownKeys)
  const unkOf = p => unknown.some(k => k === p || k.startsWith(`floors.${p}`) || k.startsWith(`${p}.`));
  const chip = (p, where) => `<span class="pchip${unkOf(p) ? ' unk' : ''}" draggable="true" tabindex="0" data-proj="${esc(p)}" title="${esc(p)}${unkOf(p) ? ' · building.json 에 알 수 없는 키가 있어요' : ''}">${unkOf(p) ? '⚠ ' : ''}<span>${esc(p)}</span>${
    where === 'floor' ? '<button type="button" class="un" title="미배정으로 빼기" aria-label="미배정으로 빼기">✕</button>' : ''}</span>`;

  function apply() { opts.onApply(configFrom(rows, ceo)); }
  function render(focusSel) {
    const used = new Set(rows.flatMap(r => r.projs));
    const free = all.filter(p => !used.has(p));
    pool.innerHTML = free.length ? free.map(p => chip(p, 'pool')).join('') : '<p class="empty-note">모든 프로젝트가 층에 있어요.</p>';
    list.innerHTML = rows.map((r, i) => `<li class="fe-floor" draggable="true" data-i="${i}">
      <span class="grip" title="끌어서 순서 바꾸기" aria-hidden="true">⋮⋮</span><b class="n">${rows.length - i}F</b>
      <div class="slot" data-drop="${i}">${r.projs.length ? r.projs.map(p => chip(p, 'floor')).join('') : '<span class="muted">비어 있음</span>'}</div>
      <input class="lbl" data-i="${i}" value="${esc(r.label)}" maxlength="40" placeholder="${r.projs.length ? '층 이름' : '프로젝트를 먼저 놓아요'}" ${r.projs.length ? '' : 'disabled'} aria-label="${rows.length - i}층 이름">
      <span class="ops"><button type="button" class="ib" data-a="up" data-i="${i}" title="한 층 위로" ${i ? '' : 'disabled'}>↑</button>
      <button type="button" class="ib" data-a="down" data-i="${i}" title="한 층 아래로" ${i < rows.length - 1 ? '' : 'disabled'}>↓</button>
      <button type="button" class="ib" data-a="del" data-i="${i}" title="층 삭제" ${rows.length > 1 ? '' : 'disabled'}>✕</button></span></li>`).join('');
    if (focusSel) wrap.querySelector(focusSel)?.focus();
  }
  function place(proj, i) {
    rows.forEach(r => { r.projs = r.projs.filter(p => p !== proj); if (!r.projs.length) r.label = ''; });
    if (i != null) { rows[i].projs.push(proj); rows[i].label ||= proj; }
    render(); apply();
  }
  function move(i, j) {
    if (j < 0 || j >= rows.length || i === j) return;
    const [r] = rows.splice(i, 1); rows.splice(j, 0, r);
    render(`[data-a="${j < i ? 'up' : 'down'}"][data-i="${j}"]`); apply();
  }

  wrap.addEventListener('click', ev => {
    const b = ev.target.closest('button');
    if (!b) { if (ev.target === wrap) close(); return; }
    if (b.classList.contains('x')) return close();
    if (b.classList.contains('un')) return place(b.closest('.pchip').dataset.proj, null);
    const i = Number(b.dataset.i);
    switch (b.dataset.a) {
      case 'add': rows.unshift({ projs: [], label: '' }); render(); apply(); break;
      case 'up': move(i, i - 1); break;
      case 'down': move(i, i + 1); break;
      case 'del': { const [r] = rows.splice(i, 1); render(); apply(); if (r.projs.length) note.textContent = `${r.projs.join(', ')} 는 미배정으로 돌아갔어요.`; break; }
      case 'close': close(); break;
      case 'save': save(); break;
      default: break;
    }
  });
  wrap.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { close(); return; }
    const c = ev.target.closest?.('.fe-pool .pchip');
    if (c && (ev.key === 'Enter' || ev.key === ' ')) {
      ev.preventDefault();
      let i = rows.findIndex(r => !r.projs.length);
      if (i < 0) { rows.unshift({ projs: [], label: '' }); i = 0; }
      place(c.dataset.proj, i);
      wrap.querySelector('.fe-pool .pchip')?.focus();
    }
  });
  wrap.addEventListener('input', ev => {
    const inp = ev.target.closest('.lbl'); if (!inp) return;
    rows[Number(inp.dataset.i)].label = inp.value; apply();
  });
  // HTML5 drag and drop: a project chip onto a floor slot / the pool, or a floor row onto another row.
  let drag = null;
  wrap.addEventListener('dragstart', ev => {
    const c = ev.target.closest?.('.pchip'), f = ev.target.closest?.('.fe-floor');
    drag = c ? { proj: c.dataset.proj } : f ? { floor: Number(f.dataset.i) } : null;
    if (!drag) return;
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', drag.proj || `floor:${drag.floor}`);
    ev.stopPropagation();
  });
  wrap.addEventListener('dragover', ev => {
    if (!drag) return;
    const t = drag.proj ? ev.target.closest('[data-drop], .fe-floor') : ev.target.closest('.fe-floor');
    if (!t) return;
    ev.preventDefault();
    wrap.querySelectorAll('.over').forEach(n => n !== t && n.classList.remove('over'));
    t.classList.add('over');
  });
  wrap.addEventListener('dragleave', ev => ev.target.classList?.remove('over'));
  wrap.addEventListener('drop', ev => {
    if (!drag) return;
    ev.preventDefault();
    wrap.querySelectorAll('.over').forEach(n => n.classList.remove('over'));
    const slot = ev.target.closest('[data-drop]'), row = ev.target.closest('.fe-floor');
    if (drag.proj) {
      if (slot?.dataset.drop === 'pool') place(drag.proj, null);
      else if (row) place(drag.proj, Number(row.dataset.i));
    } else if (row) move(drag.floor, Number(row.dataset.i));
    drag = null;
  });
  wrap.addEventListener('dragend', () => { drag = null; wrap.querySelectorAll('.over').forEach(n => n.classList.remove('over')); });

  async function save() {
    note.textContent = '저장 중…';
    const msg = await opts.onSave(configFrom(rows, ceo));
    note.textContent = msg || '저장했어요. building.json 에 반영됐어요.';
  }
  function close() { wrap.remove(); document.removeEventListener('keydown', esc1); opts.onClose?.(); }
  const esc1 = ev => { if (ev.key === 'Escape' && !wrap.contains(document.activeElement)) close(); };
  document.addEventListener('keydown', esc1);
  render('.x');
  // Projects: server list when available (GET /projects.json), else what we saw today + configured keys.
  opts.fetchUnknown?.().then(keys => {
    if (!wrap.isConnected) return;
    unknown = (Array.isArray(keys) ? keys : keys && typeof keys === 'object' ? Object.keys(keys) : []).map(k => String(typeof k === 'object' ? k?.key ?? k?.path ?? JSON.stringify(k) : k)).filter(Boolean);
    const u = wrap.querySelector('.unk-chip');
    u.hidden = !unknown.length;
    if (unknown.length) { u.textContent = `⚠ 모르는 키 ${unknown.length}개`; u.title = `building.json 에서 무시된 키: ${unknown.join(', ')}`; }
    render();
  }).catch(() => {});
  opts.fetchProjects?.().then(list => {
    if (!Array.isArray(list) || !wrap.isConnected) return;
    all = [...new Set([...all, ...list.map(x => (typeof x === 'string' ? x : x?.proj)).filter(Boolean)])];
    render();
  }).catch(() => {});
  return { close };
}
