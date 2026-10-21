// AI Team Office v2 — 직급(model) · 직무(agent type) · 동물 별명(aid). Pure lookups + one per-day nickname registry.
// The user is 대표, the main session is always the 실장 (titled by its real model: "Opus 실장", "Fable 실장", or just "실장");
// subagents read as `직급 직무 별명` (e.g. `책임 개발 여우`).

export const RANK = { fable: '실장', opus: '책임', sonnet: '주임', haiku: '인턴', unknown: '계약직' };
const JOB = {
  'backend-dev': '개발', implementer: '개발', 'code-reviewer': '심사', reviewer: '심사',
  'aws-ops': '운영', 'ops-investigator': '운영', lookup: '조사', explore: '조사', 'web-fetch': '외근',
  plan: '기획', 'general-purpose': '총무', 'claude-code-guide': '사내강사',
};
export const JOB_LONG = { 개발: '개발', 심사: '심사(QA)', 운영: '운영', 조사: '조사(사서)', 외근: '외근', 기획: '기획',
  총무: '총무(만능)', 사내강사: '사내강사', 사원: '사원' };
export const ANIMALS = ['수달', '여우', '너구리', '펭귄', '고슴도치', '두더지', '햄스터', '알파카',
  '카피바라', '올빼미', '판다', '토끼', '고양이', '강아지', '다람쥐', '코알라'];

// Friendly room names (reducer room id -> 이름). `pantry`, `ceo-door`, `ceo` are render-only places.
export const ROOM_KO = { library: '도서관', bench: '개발실', server: '서버룸', meeting: '회의실', review: 'QA실',
  external: '외근·민원실', pantry: '탕비실', ceo: '대표실', 'ceo-door': '대표실 앞', elevator: '엘리베이터', desk: '사무실' };
export const ROOM_ICON = { library: 'book', bench: 'keys', server: 'rack', meeting: 'table', review: 'lens',
  external: 'door', pantry: 'mug', ceo: 'crown', elevator: 'lift', desk: 'desk' };

export const ACT_KO = { idle: '대기', thinking: '생각 중', reading: '자료 조사', running: '실행 중', writing: '작성 중',
  delegating: '위임 중', reviewing: '검수 중', external: '외부 연락', blocked: '승인 대기', leaving: '퇴장',
  arriving: '도착', working: '작업 중' };

const known = m => (m in RANK ? m : 'unknown');
export const rankOf = model => RANK[known(model)];
export function jobOf(atype) {
  if (typeof atype !== 'string' || !atype) return '사원';
  const a = atype.toLowerCase();
  return JOB[atype] || JOB[a] || (/(^|-)(dev|developer|implementer)$/.test(a) ? '개발' : '사원');   // any *-dev agent is a developer
}

/** FNV-1a 32-bit: stable across reloads and browsers. */
export function hash32(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

// aid -> nickname. The first aid to land on an animal keeps the bare name; later collisions get 2, 3, …
// Deterministic for a given arrival order; reset with the day.
const names = new Map(), taken = new Map();
export function resetNames() { names.clear(); taken.clear(); }
export function nickname(aid) {
  if (!aid) return '실장';
  let n = names.get(aid);
  if (n) return n;
  const animal = ANIMALS[hash32(aid) % ANIMALS.length];
  const k = (taken.get(animal) || 0) + 1;
  taken.set(animal, k);
  n = k === 1 ? animal : `${animal}${k}`;
  names.set(aid, n);
  return n;
}
/** Ticker `who` strings from the reducer are `atype·aid4`; map them back to a display name when we know the aid. */
export function nameFromWho(who) {
  const m = /^(.+)·([0-9a-z]{4})$/i.exec(String(who || ''));
  if (!m) return who === 'Fable' ? '실장' : who;
  for (const [aid, nick] of names) if (aid.startsWith(m[2])) return `${jobOf(m[1])} ${nick}`;
  return `${jobOf(m[1])} ${m[2]}`;
}

/** The main session's title: model family (from its usage records) + the 실장 role. Unknown model -> "실장". */
export function mainTitle(fam) {
  return fam && fam in RANK && fam !== 'unknown' ? `${fam[0].toUpperCase()}${fam.slice(1)} 실장` : '실장';
}

/** Name tag text. For the main session pass `model` = its family from usage (or 'unknown'). */
export function displayName(c, ceoName = '대표') {
  if (!c) return '';
  if (c.ceo) return ceoName;
  if (!c.aid) return mainTitle(c.model);
  return `${rankOf(c.model)} ${jobOf(c.atype)} ${nickname(c.aid)}`;
}

/** Which sprite look a character wears. 직무 first (so the job reads before the model), then 직급 for generic types. */
export function lookOf(c) {
  if (!c) return 'staff';
  if (c.ceo) return 'ceo';
  if (!c.aid) return 'fable';
  const job = jobOf(c.atype);
  const byJob = { 개발: 'dev', 조사: 'intern', 심사: 'qa', 운영: 'ops', 외근: 'field', 기획: 'plan', 사내강사: 'teacher' }[job];
  if (byJob) return byJob;
  if (job === '총무') return 'clerk';
  return { sonnet: 'clerk', haiku: 'intern', opus: 'dev' }[c.model] || 'staff';
}
