# NOTES - which doc each format came from

All fetched 2026-10-21 from code.claude.com.

| Artifact | Format source |
|---|---|
| `.claude-plugin/marketplace.json` (required `name`, `owner{name}`, `plugins[]{name,source}`, relative source `./...`, reserved names) | https://code.claude.com/docs/en/plugins/create-marketplace and https://code.claude.com/docs/en/plugins/marketplace-reference (the URL /docs/en/plugin-marketplaces now redirects into these) |
| `plugins/ai-team/.claude-plugin/plugin.json` (only `name` required; `author` is an object; standard layout; `${CLAUDE_PLUGIN_ROOT}`; `bin/` on PATH) | https://code.claude.com/docs/en/plugins/manifest-reference (overview: https://code.claude.com/docs/en/plugins) |
| `hooks/hooks.json` (top-level `"hooks"` wrapper, event -> matcher groups -> handlers, `async`, `timeout` in seconds, quoted `"${CLAUDE_PLUGIN_ROOT}"` in shell form, event names) | https://code.claude.com/docs/en/hooks and the manifest reference "hooks" section |
| `agents/*.md` frontmatter (`name`, `description`, `tools`, `disallowedTools`, `model`, `effort`, `maxTurns`; plugin agents ignore `hooks`, `mcpServers`, `permissionMode`) | https://code.claude.com/docs/en/sub-agents |
| `skills/*/SKILL.md` frontmatter (`name`, `description`, `argument-hint`, `disable-model-invocation`, `user-invocable`, `allowed-tools`; `$ARGUMENTS`; `${CLAUDE_PLUGIN_ROOT}` substituted in skill body and `allowed-tools`; plugin skills invoked as `/plugin:skill`) | https://code.claude.com/docs/en/skills |

## Deviations from the brief (docs win)

- Skill command is `/ai-team:ai-team-setup` as briefed (plugin name + skill dir name). Confirmed.
- Hook `timeout` is not enforced on `async: true` command hooks; kept at 10 anyway as documentation of intent.
- `${CLAUDE_PLUGIN_ROOT}` is NOT in the environment of Bash commands Claude runs, and is not substituted in CLAUDE.md. So the rules block cannot point at `<plugin>/hooks/delegation-log.sh`; a `bin/ai-team-verdict` wrapper (auto on PATH while the plugin is enabled) is provided and the rules use it.
- Both skills set `disable-model-invocation: true` (manual `/` invocation only); `user-invocable` is true by default so it is not written.
- Plugin agents cannot set `permissionMode`, so read-only is enforced only via `tools`/`disallowedTools`; Bash remains available to lookup/reviewer/ops-investigator, so "no mutating commands" is prompt-enforced, not hard-enforced.
- Marketplace `owner` must be an object (`name`, optional `url`), not a bare string.
