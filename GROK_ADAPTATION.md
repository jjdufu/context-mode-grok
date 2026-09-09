# Grok Build CLI adaptation

This fork adds a first-class **Grok Build** (`grok`) platform adapter so context-mode works beyond MCP-only: stdio MCP, hooks, skills, plugin install, and session DB under `~/.grok/context-mode/`.

## What changed

- New platform id: `grok` (`src/adapters/grok/`, `PlatformId`, `detect.ts`, `client-map.ts`)
- Detection **before** `claude-code` via `GROK_PLUGIN_ROOT` / `GROK_PLUGIN_DATA` / `GROK_HOME` / `GROK_AGENT_ID` (Grok also injects `CLAUDE_*`)
- Hook payload normalization: camelCase `toolName` / `toolInput` / `sessionId` + Read `target_file`
- Tool aliases: `run_terminal_command`→Bash, `spawn_subagent`→Agent, `open_page`→WebFetch
- MCP wire names: `context-mode__ctx_*` (`server__tool`); external MCP matcher understands that shape
- `hooks/grok/` + `.grok-plugin/` (plugin.json, marketplace.json)
- Routing docs: `configs/grok/AGENTS.md`, SKILL.md Grok section, `docs/platform-support.md`
- Session storage: `~/.grok/context-mode/sessions/` (honors `$GROK_HOME`)

## How to enable

```bash
cd /path/to/context-mode
npm install
npm run build   # if you changed TypeScript / need fresh bundles
npm link        # or: npm install -g .

# MCP (recommended — uses global binary, avoids npx cold-start timeout)
grok mcp add context-mode -- context-mode
# optional in ~/.grok/config.toml:
# [mcp_servers.context-mode]
# command = "context-mode"
# startup_timeout_sec = 30

grok mcp doctor context-mode

# Plugin (hooks + skills + MCP via start.mjs)
grok plugin validate .
grok plugin install /path/to/context-mode --trust

# Project routing rules (SessionStart stdout is discarded on Grok)
cp configs/grok/AGENTS.md ./AGENTS.md   # or merge into your project rules
```

Copy `configs/grok/AGENTS.md` into the project (or `~/.grok/`) so the model sees `search_tool` + `use_tool("context-mode__ctx_*")` instructions.

## Remaining limitations

1. **SessionStart / UserPromptSubmit** — Grok discards stdout / allow-path `additionalContext`. Routing must live in skill + AGENTS.md + PreToolUse deny reasons.
2. **PreToolUse `additionalContext` timing** — arrives after the tool runs; first large Read/Bash can still enter context unless denied.
3. **Cannot rewrite `use_tool` to another tool** — `updatedInput` may change args but not retarget the tool.
4. **Two-step tool calling** — model must `search_tool` then `use_tool("context-mode__ctx_…")`; compliance is not 100% without deny hooks.
5. **Plugin MCP** uses `${GROK_PLUGIN_ROOT}/start.mjs`. Prefer `grok mcp add … -- context-mode` after `npm link` for a faster, PATH-stable binary.

## Verify

```bash
# Platform detect (even with CLAUDE_* set)
GROK_PLUGIN_ROOT=/tmp/x CLAUDE_PROJECT_DIR=/tmp/y node -e \
  "import('./hooks/core/platform-detect.mjs').then(m=>console.log(m.detectPlatformFromEnv(process.env)))"
# → grok

grok plugin validate /path/to/context-mode
grok mcp doctor context-mode
```
