// AI Team Office v2 — simulator extras (only with ?sim=1). Everything here is fake and labelled as such in the UI:
// a demo building, made-up token usage, and extra sessions whose characters end up waiting in 대표실: an
// AskUserQuestion from a subagent, PermissionRequests from a main session and from a subagent, a long final report
// ending with a '다음 결정' line (결정 대기 / 추정, fills the 크게 보기 drawer), a short plain report and an idle
// session — enough people (≥ 6 with the fixture) that the line overflows into the +N button.

export const DEMO_BUILDING = {
  floors: { AI_Team: { floor: 9, label: 'AI 팀 사무실' }, 'shop-backend-app': { floor: 1, label: '쇼핑 백엔드' },
    'shop-backend-oms': { floor: 2, label: '쇼핑 OMS' }, 'web-ui': { floor: 3, label: '글로벌 UI' } },
  ceo: '대표', top: 9,
};
const FAM_BY_TYPE = { 'backend-dev': 'opus', 'code-reviewer': 'sonnet', lookup: 'haiku', Explore: 'haiku', 'aws-ops': 'sonnet' };
const MODEL = { fable: 'claude-fable-5', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-5-5' };

function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
let n = 0;
function rec(ts, proj, sid, aid, family, r) {
  return { ts: new Date(ts).toISOString(), proj, sid, aid: aid || undefined, model: MODEL[family], family,
    in: Math.round(50 + r() * 700), out: Math.round(150 + r() * 2600), cacheR: Math.round(4000 + r() * 50000),
    cacheW: Math.round(300 + r() * 6000), id: `sim-${n++}` };
}

/** Made-up usage for today 00:00 → now (deterministic per day). */
export function usageHistory(now = Date.now()) {
  const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
  const r = rng(d0.getTime() / 86400000);
  const projs = Object.keys(DEMO_BUILDING.floors), out = [];
  const hours = new Date(now).getHours();
  for (let h = 0; h <= hours; h++) {
    const busy = h >= 9 && h <= 19 ? 6 + r() * 10 : r() * 3;
    for (let i = 0; i < busy; i++) {
      const ts = Math.min(now - 1000, d0.getTime() + h * 3600000 + r() * 3600000);
      const x = r(), fam = x < 0.22 ? 'fable' : x < 0.5 ? 'opus' : x < 0.78 ? 'sonnet' : 'haiku';
      const proj = projs[Math.floor(r() * projs.length)];
      out.push(rec(ts, proj, `sim-${proj}`, fam === 'fable' ? null : `asim${Math.floor(r() * 9)}`, fam, r));
    }
  }
  return out;
}

const live = rng(42);
/** One made-up usage record for a simulated tool call (so charts move with the scene). */
export function usageFor(e) {
  if (!e || (e.ev !== 'PostToolUse' && e.ev !== 'Stop')) return null;
  const fam = e.aid ? FAM_BY_TYPE[e.atype] || 'sonnet' : 'fable';
  return rec(Date.now(), e.proj || 'AI_Team', e.sid, e.aid, fam, live);
}

// Extra floors. [ms at speed 1, event]
const E = 'e1f2a3b4-0000-4000-8000-00000000000e', F = 'f5a6b7c8-0000-4000-8000-00000000000f', G = 'a9b8c7d6-0000-4000-8000-000000000007';
const REV = 'arev3c4d5e6f7a8b9', LOOK2 = 'alk2b3c4d5e6f7a8b', DEV2 = 'adv2c3d4e5f6a7b8c';
const B = 'b7c1e2d3-0000-4000-8000-00000000000b', C = 'c3d4e5f6-0000-4000-8000-00000000000c', D = 'd8e9f0a1-0000-4000-8000-00000000000d';
const REPORT = [
  '## 재고 동기화 배치 점검 결과', '',
  '한 일', '- 재고 동기화 배치의 재시도 로직을 고쳤어요 (중복 차감 방지)', '- 단위 테스트 12개 추가, 전체 통과',
  '  - 동시성 테스트는 스테이징에서만 돌려요', '- PR 을 올렸어요: https://github.com/example/shop-backend-oms/pull/23', '',
  '근거', '- `./gradlew test` 결과: 214 passed, 0 failed', '- 스테이징 리허설 로그: https://example.com/logs/oms-batch-1022', '',
  '안 한 것', '- 운영 배포 (사람 승인 필요)', '- 오래된 재고 스냅샷 정리', '',
  '막힌 것', '- 없음', '',
  '**다음 결정**: PR #23을 오늘 머지할지 정해 주세요.',
].join('\n');
const DEV = 'adev0c1d2e3f4a5b6', LOOK = 'alook7a8b9c0d1e2f';
const SCRIPT = [
  [0, { ev: 'SessionStart', sid: B, proj: 'shop-backend-app' }],
  [500, { ev: 'UserPromptSubmit', sid: B, proj: 'shop-backend-app', prompt: '주문 마이그레이션 진행해줘' }],
  [1500, { ev: 'PreToolUse', sid: B, proj: 'shop-backend-app', tool: 'Agent', effort: 'high', target: '주문 마이그레이션',
    sub: { type: 'backend-dev', model: 'opus', effort: 'high', desc: '주문 마이그레이션' } }],
  [2500, { ev: 'SubagentStart', sid: B, proj: 'shop-backend-app', aid: DEV, atype: 'backend-dev' }],
  [4000, { ev: 'PreToolUse', sid: B, proj: 'shop-backend-app', aid: DEV, atype: 'backend-dev', tool: 'Read', target: '/src/order/OrderMigration.kt' }],
  [7000, { ev: 'PostToolUse', sid: B, proj: 'shop-backend-app', aid: DEV, atype: 'backend-dev', tool: 'Read' }],
  [9000, { ev: 'PreToolUse', sid: B, proj: 'shop-backend-app', aid: DEV, atype: 'backend-dev', tool: 'AskUserQuestion',
    target: '배포 범위 확인', ask: '마이그레이션을 오늘 배포에 포함할까요, 다음 배포로 미룰까요?' }],
  [1000, { ev: 'UserPromptSubmit', sid: C, proj: 'web-ui', prompt: '릴리스 브랜치 올려줘' }],
  [3000, { ev: 'PreToolUse', sid: C, proj: 'web-ui', tool: 'Agent', effort: 'medium', target: '변경 파일 조회',
    sub: { type: 'lookup', model: 'haiku', effort: 'low', desc: '변경 파일 조회' } }],
  [3600, { ev: 'SubagentStart', sid: C, proj: 'web-ui', aid: LOOK, atype: 'lookup' }],
  [5000, { ev: 'PreToolUse', sid: C, proj: 'web-ui', aid: LOOK, atype: 'lookup', tool: 'Grep', target: 'release' }],
  [8000, { ev: 'PostToolUse', sid: C, proj: 'web-ui', aid: LOOK, atype: 'lookup', tool: 'Grep' }],
  [11000, { ev: 'PreToolUse', sid: C, proj: 'web-ui', tool: 'Bash', effort: 'medium', target: 'git push origin main' }],
  [12000, { ev: 'PermissionRequest', sid: C, proj: 'web-ui', tool: 'Bash', effort: 'medium', target: 'git push origin main',
    ask: 'Bash git push origin main' }],
  [200, { ev: 'SessionStart', sid: D, proj: 'shop-backend-oms' }],
  [700, { ev: 'UserPromptSubmit', sid: D, proj: 'shop-backend-oms', prompt: '재고 동기화 배치 고치고 보고해줘' }],
  [2000, { ev: 'PreToolUse', sid: D, proj: 'shop-backend-oms', tool: 'Bash', effort: 'high', target: './gradlew test' }],
  [6000, { ev: 'PostToolUse', sid: D, proj: 'shop-backend-oms', tool: 'Bash' }],
  [14000, { ev: 'Stop', sid: D, proj: 'shop-backend-oms', effort: 'high', msg: REPORT }],
  // session D also has two subagents waiting: with the line overflowing, D stands as ONE figure ×3 (red: HIGH inside)
  [2500, { ev: 'SubagentStart', sid: D, proj: 'shop-backend-oms', aid: LOOK2, atype: 'lookup' }],
  [3000, { ev: 'SubagentStart', sid: D, proj: 'shop-backend-oms', aid: DEV2, atype: 'backend-dev' }],
  [8000, { ev: 'PreToolUse', sid: D, proj: 'shop-backend-oms', aid: LOOK2, atype: 'lookup', tool: 'AskUserQuestion', target: '스냅샷 정리 범위',
    ask: '오래된 재고 스냅샷을 30일 기준으로 지울까요, 90일 기준으로 지울까요?' }],
  [15500, { ev: 'PermissionRequest', sid: D, proj: 'shop-backend-oms', aid: DEV2, atype: 'backend-dev', tool: 'Bash', target: './gradlew build',
    ask: 'Bash ./gradlew build' }],
  [300, { ev: 'UserPromptSubmit', sid: E, proj: 'web-ui', prompt: '변경 사항 리뷰해줘' }],
  [1200, { ev: 'PreToolUse', sid: E, proj: 'web-ui', tool: 'Agent', effort: 'high', target: '변경 리뷰',
    sub: { type: 'code-reviewer', model: 'sonnet', effort: 'medium', desc: '변경 리뷰' } }],
  [1800, { ev: 'SubagentStart', sid: E, proj: 'web-ui', aid: REV, atype: 'code-reviewer' }],
  [15000, { ev: 'PermissionRequest', sid: E, proj: 'web-ui', aid: REV, atype: 'code-reviewer', tool: 'WebFetch', target: 'https://example.com/docs/release-notes',
    ask: 'WebFetch https://example.com/docs/release-notes' }],
  [400, { ev: 'UserPromptSubmit', sid: F, proj: 'shop-backend-app', prompt: '로그 레벨 정리해줘' }],
  [16000, { ev: 'Stop', sid: F, proj: 'shop-backend-app', effort: 'medium', msg: '로그 레벨을 INFO 로 맞췄어요.\n- 테스트 통과\n- 커밋은 아직 안 했어요' }],
  [500, { ev: 'UserPromptSubmit', sid: G, proj: 'AI_Team', prompt: '문서 맞춤법 봐줘' }],
  [17000, { ev: 'Notification', sid: G, proj: 'AI_Team', ntype: 'idle_prompt', msg: 'Claude is waiting for your input' }],
];

// Relay items (what the server's `event: ceo` would carry) so the 대표실 cards can be answered in the simulator.
const RELAY = [
  [9100, { id: 'sim-q1', kind: 'question', sid: B, proj: 'shop-backend-app', aid: DEV, atype: 'backend-dev', tool: 'AskUserQuestion', target: null, input: {},
    questions: [
      { question: '마이그레이션을 오늘 배포에 포함할까요, 다음 배포로 미룰까요?', header: '배포 범위', multiSelect: false,
        options: [{ label: '오늘 포함', description: '오늘 18시 배포에 같이 나가요' }, { label: '다음 배포로', description: '목요일 배포로 미뤄요' }] },
      { question: '같이 돌릴 검증을 골라 주세요', header: '검증', multiSelect: true,
        options: [{ label: '단위 테스트', description: '' }, { label: '스테이징 리허설', description: '' }, { label: '롤백 스크립트 점검', description: '' }] },
    ] }],
  [15600, { id: 'sim-p3', kind: 'permission', sid: D, proj: 'shop-backend-oms', aid: DEV2, atype: 'backend-dev', tool: 'Bash', target: './gradlew build', input: { command: './gradlew build' } }],
  [8100, { id: 'sim-q2', kind: 'question', sid: D, proj: 'shop-backend-oms', aid: LOOK2, atype: 'lookup', tool: 'AskUserQuestion', target: null, input: {},
    questions: [{ question: '오래된 재고 스냅샷을 30일 기준으로 지울까요, 90일 기준으로 지울까요?', header: '정리 범위', multiSelect: false,
      options: [{ label: '30일', description: '더 많이 지워요' }, { label: '90일', description: '보수적으로 지워요' }] }] }],
  [15100, { id: 'sim-p2', kind: 'permission', sid: E, proj: 'web-ui', aid: REV, atype: 'code-reviewer', tool: 'WebFetch', target: 'https://example.com/docs/release-notes',
    input: { url: 'https://example.com/docs/release-notes', prompt: '릴리스 노트에서 깨지는 변경을 찾아 주세요' } }],
  [12100, { id: 'sim-p1', kind: 'permission', sid: C, proj: 'web-ui', tool: 'Bash', target: 'git push origin main', input: { command: 'git push origin main', description: 'main 브랜치를 원격에 올려요' } }],
];

/** Play the extra floors into `push(event)` and relay frames into `relayPush(frame)` at `speed`; returns a cancel function. */
export function play(speed, push, relayPush = () => {}) {
  const k = Math.max(0.1, speed);
  const timers = SCRIPT.map(([at, e]) => setTimeout(() => push({ ...e, ts: new Date().toISOString() }), at / k));
  for (const [at, item] of RELAY) timers.push(setTimeout(() => { const t = Date.now(); relayPush({ type: 'ask', item: { ...item, createdAt: t, expiresAt: t + 170000 } }); }, at / k));
  return () => timers.forEach(clearTimeout);
}

/** Made-up plan limits + context windows (same shape as the server's /limits.json). */
export function simLimits(now = Date.now(), sids = []) {
  const s = Math.floor(now / 1000), mins = new Date(now).getMinutes();
  const fams = ['fable', 'opus', 'sonnet', 'haiku'];
  return {
    account: { five_hour: { pct: 47 + (mins % 10), resetsAt: s + 2 * 3600 + 13 * 60, capturedAt: s - 20 },
      seven_day: { pct: 72, resetsAt: s + 3 * 86400 + 4 * 3600, capturedAt: s - 20 }, stale: false },
    sessions: sids.map(([sid, proj], i) => {
      const size = i % 2 ? 200000 : 1000000, pct = [41, 63, 88, 12, 30, 55][i % 6];
      return { sid, proj, model: `claude-${fams[i % 4]}`, family: fams[i % 4], ctx: { size, pct, inTokens: Math.round((size * pct) / 100) },
        capturedAt: s - 30 - i * 200, stale: i >= 4 };
    }),
  };
}
