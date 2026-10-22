# ai-team-office — contributor guide for Claude Code

Claude Code plugin `ai-team` (marketplace `ai-team-office`): model-routed subagents, a delegation log with verdicts, and **AI Team Office**, a real-time pixel-art dashboard of what every Claude Code session and subagent is doing.

## Layout
- `.claude-plugin/marketplace.json` — marketplace manifest.
- `plugins/ai-team/` — the plugin.
  - `agents/` lookup (haiku), implementer (opus), reviewer (opus), ops-investigator (sonnet).
  - `hooks/hooks.json` + `office-events.sh` (12 hook events → `~/.claude/logs/office-events.jsonl`) + `delegation-log.sh` (Agent calls + verdicts → `~/.claude/logs/delegation.jsonl`).
  - `bin/` `ai-team-verdict`, `statusline-tee` (opt-in statusline wrapper).
  - `skills/ai-team-setup` (rules block + opt-in CEO relay and plan-limit wrapper), `skills/office` (start/stop/open).
  - `office/` — the dashboard. Zero dependencies, Node ≥ 20, no build step.
    - `server.mjs` HTTP + SSE on 127.0.0.1:4747; `relay.mjs` CEO-room approve/answer relay; `usage.mjs` token usage from transcripts; `limits.mjs` plan limits/context from statusline JSON; `focus.mjs` bring terminal to front (macOS).
    - `hooks/ceo-relay.sh` PermissionRequest / PreToolUse(AskUserQuestion) hook (opt-in).
    - `public/` vanilla ES modules: `reducer.js` (pure event→state), `app.js` (scene + panels), `world.js` (rooms/furniture/sky), `sprites.js`, `roles.js`, `seats.js`, `ceo.js`/`ceocard.js` (CEO room), `building.js`/`editor.js` (floors), `charts.js`, `limits.js`, `clock.js`, `ambient.js` (shooting stars, park couples), `secretary.js` (19:00 cat), `sim.js`.
    - `test/` node:test suites; `test/home.mjs` gives every suite a temp HOME.
    - `DESIGN.md`, `DESIGN-v2.md` — the design contracts. Update them when behaviour changes.

## Commands
```bash
cd plugins/ai-team/office
node --test test/                                   # all tests (must stay green)
HOME=$(mktemp -d) node server.mjs --port 4762       # scratch server, never touches real ~/.claude
open "http://127.0.0.1:4762/?sim=1&speed=20"        # simulator (fake data)
# handy URL flags: ?sky=morning|day|evening|night  ?fx=star,couple  ?bye=1&day=YYYY-MM-DD  ?read=1 (first report card in the 크게 보기 drawer)  ?list=1 (대표실 list drawer)
claude plugin validate . && claude plugin validate plugins/ai-team
curl -s http://127.0.0.1:4747/healthz | jq '{version,viewers,hiddenViewers,pending}'   # what is running + who can hold relay items
jq -nc '{session_id:"0f1e2d3c-aaaa-bbbb-cccc-00000000beef",cwd:"/x/relay-test",hook_event_name:"PermissionRequest",tool_name:"Bash",tool_input:{command:"echo test"}}' \
  | OFFICE_RELAY_WAIT_MS=300000 hooks/ceo-relay.sh   # fake approval card; prints the decision, runs nothing
jq -nc '{session_id:"0f1e2d3c-aaaa-bbbb-cccc-00000000beef",cwd:"/x/relay-test",hook_event_name:"PermissionRequest",permission_mode:"bypassPermissions",tool_name:"AskUserQuestion",tool_input:{questions:[{question:"어느 쪽?",header:"선택",multiSelect:false,options:[{label:"A",description:""},{label:"B",description:""}]}]}}' \
  | OFFICE_RELAY_WAIT_MS=300000 hooks/ceo-relay.sh   # fake permission-for-question card: a question card (options + 직접 입력); prints allow + updatedInput.answers
jq -nc '{session_id:"0f1e2d3c-aaaa-bbbb-cccc-00000000beef",cwd:"/x/relay-test",hook_event_name:"Stop",stop_hook_active:false,last_assistant_message:"정리했어요.\n다음 결정: 머지할지 정해 주세요."}' \
  | OFFICE_RELAY_STOP_WAIT_MS=120000 hooks/ceo-stop.sh   # fake 결정 대기 card with a box (needs a VISIBLE tab); prints {"decision":"block",...}
"<Chrome>" --headless=new --window-size=1400,300 --timeout=4000 --screenshot=out.png "http://127.0.0.1:4762/?sim=1"   # may hang: run in background, kill after ~10s
```

## Gotchas
- Swapping the server on 4747 (e.g. running repo code for a test) leaves open tabs disconnected for a while; relay requests in that window are not held. Check `~/.claude/ai-team-office/run/server.log` for `not relayed: <reason>`.
- Claude Code sends `Notification idle_prompt` ~60s after every `Stop`; 대표실 logic must not let it overwrite the report card.
- A session's event order is the ground truth: grep `~/.claude/logs/office-events.jsonl` for `"sid":"<8 chars>` before guessing at UI bugs.
- Sessions started before a hook change keep the old hook until restarted (e.g. reports still cut at 300 chars).
- Relay holds differ: PermissionRequest does NOT block the terminal (dialog shows too, first answer wins → 540s default); PreToolUse(AskUserQuestion) and Stop DO block (question UI / input) → keep them short (120s).
- A Stop-hook instruction shows in the terminal as "Stop hook blocking error … : <text>"; that is the normal label, not a failure.
- Browsers launched from Claude Code are refused by the relay's process-tree guard; `OFFICE_TEST_ANCESTRY` only works under `node --test`, never on a real server.
- `--headless --screenshot` fires before the sim plays (empty 대표실); for interactive shots drive Chrome over CDP.
- Enter-to-send handlers must skip `ev.isComposing || ev.keyCode === 229` (Korean IME ends a syllable with Enter).

## Rules
- **Safety first** (it is installed on real machines):
  - Bind 127.0.0.1 only; keep the Host/Origin checks.
  - The relay may produce allow/deny ONLY from `POST /relay/answer` with same-origin + viewer token, and never from a caller whose process tree contains Claude Code.
  - Every hook must exit 0 and print nothing unless it is deliberately returning a decision.
  - When the dashboard is down, hooks step aside in ~1s.
- **Honesty**: never invent status. Mark data as observed/inferred/stale, and document limits in README rather than faking them.
- **XSS**: any log, relay or statusline string reaching the DOM goes through `esc()` or `textContent`.
- **No external assets**: no CDN, no image files for sprites (everything is procedural), no copied game assets, no pixel fonts for text (use the system gothic stack).
- **Privacy**:
  - No personal paths, emails, company or project names in code, fixtures, docs or screenshots. Use generic names (`shop-backend-app`, `web-ui`, `/Users/x`).
  - User config lives in `~/.claude/ai-team-office/` and is never committed.
  - Before every commit: `grep -rIil "<your-home-dir-name>\|<company-names>" --exclude-dir=.git .` must be empty.
- **Performance**: 60fps with 13 characters; respect `prefers-reduced-motion`.
- **UI copy** is Korean, 해요체 for friendly notes.

## Release
1. Bump `plugins/ai-team/.claude-plugin/plugin.json` version and add a `CHANGELOG.md` entry.
2. Run tests + validate + leak grep. Screenshots in `docs/` are taken from a temp HOME in sim mode.
3. Commit, then push (a human approves the push).
4. Users update with `claude plugin marketplace update ai-team-office && claude plugin update ai-team@ai-team-office`, then restart the dashboard (`office/start.sh restart`).
