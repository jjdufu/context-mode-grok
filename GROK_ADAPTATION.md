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


## Project dir: GROK_HOME vs GROK_PROJECT_DIR (1.0.169-grok.2)

`GROK_HOME` is Grok's **config root** (`~/.grok`), not the working project. Treating it as a workspace env caused `resolveProjectDir({ strictPlatform: "grok" })` to root sessions under `~/.grok` whenever `GROK_HOME` was set.

Fix:
- `PLATFORM_ENV_VARS` grok: `GROK_HOME` → identification; `GROK_PROJECT_DIR` → workspace
- `start.mjs` sets `GROK_PROJECT_DIR` from the safe original cwd (same as `CLAUDE_PROJECT_DIR`)
- `isPluginInstallPath` also matches `.grok/(installed-plugins|plugins)/` so plugin install trees do not poison the project dir

## Verify

```bash
# Platform detect (even with CLAUDE_* set)
GROK_PLUGIN_ROOT=/tmp/x CLAUDE_PROJECT_DIR=/tmp/y node -e \
  "import('./hooks/core/platform-detect.mjs').then(m=>console.log(m.detectPlatformFromEnv(process.env)))"
# → grok

grok plugin validate /path/to/context-mode
grok mcp doctor context-mode
```

## Grok plugin hooks caveat (1.0.24)

Grok lists plugin hooks in `grok inspect` (`has_hooks=true`) but **does not activate** them at runtime on this version: it opens `~/.grok/trusted-plugins`, and when that file is missing, plugin hooks stay inert. `grok plugin install --trust` does not create the file (format still undocumented).

**Auto-install (preferred):** `~/.grok/hooks/context-mode.json` is installed idempotently by:

- `start.mjs` on MCP boot when `CONTEXT_MODE_PLATFORM=grok`, `GROK_PLUGIN_ROOT` is set, or the package lives under `~/.grok/installed-plugins` / `~/.grok/plugins`
- `scripts/postinstall.mjs` when `~/.grok` already exists (or the same Grok signals above)

The bridge points at `hooks/grok/pretooluse.mjs` / `posttooluse.mjs` (deny → ctx_*). Verified: large `read_file` returns `Hook denied` and steers toward `context-mode__ctx_execute_file`. Re-runs skip rewrite when the JSON already targets the same plugin root.

**Manual fallback** (if auto-install did not run — e.g. no MCP start yet and no `~/.grok`):

```bash
node scripts/grok-install-global-hooks.mjs
# or from an installed plugin copy:
node ~/.grok/installed-plugins/context-mode-<id>/scripts/grok-install-global-hooks.mjs
```

Keep shipping `hooks/hooks.json` + `.grok-plugin/plugin.json` for when plugin trust lands; the global bridge is the reliable path today.

## Private marketplace install

This repo doubles as a Grok marketplace (`context-mode-grok`) and the plugin itself.

```bash
grok plugin marketplace add jjdufu/context-mode-grok
grok plugin install context-mode --trust
grok plugin enable context-mode
```

After rename from `jjdufu/context-mode`, use the new GitHub name above. MCP start auto-installs `~/.grok/hooks/context-mode.json`.

## Large read_file pagination bypass fix (1.0.169-grok.3)

Grok converts soft Read guidance to deny, but `guidanceOnce` only fires once. After the first deny, later `read_file` calls were ALLOW — and models bypassed mid-size files (~31KB, under the shared 50KB hard path) via `offset`/`limit` pagination (`ctx_stats` stayed at 0 processing calls).

Fix (`hooks/grok/large-read-gate.mjs`, applied in `hooks/grok/pretooluse.mjs` after `routePreToolUse`):
- Always deny (every call) when file size > **8192** bytes
- Always deny when `offset`/`limit` present and size > **4096** bytes
- Deny reason includes an explicit **filled** `use_tool("context-mode__ctx_execute_file", { path, language, code })` example

Claude soft-nudge (`guidanceOnce` / 50KB) semantics are unchanged.

## Large-read gate: noisy-path only (1.0.171)

Session analysis (方案.md language review): blanket >8KB deny of human docs forced `ctx_execute_file` → model dumped full `FILE_CONTENT` via `console.log` → **0 tokens saved**, plus deny/search_tool/MCP tax made context worse than native `read_file`.

Policy (`hooks/grok/large-read-gate.mjs`):
- **Hard-deny only** noisy/compressible paths: `.log`, `.jsonl`, locks, `node_modules`/`dist`/`build`/`fixtures`, minified, large data (`.json`/CSV/…) over size thresholds (8KB hard / 4KB paginated).
- **Allow** native `read_file` (and offset/limit) for prose/source (`.md`, `.mdx`, `.txt`, `.ts`/`.js`/`.py`/…) even when >8KB.
- First deny for a path: short filled `use_tool` example; subsequent denies in-session: one line (`use context-mode__ctx_execute_file on <path>`), via `/tmp/context-mode-grok-deny/<session>/`.
- Starter code is summary-only — never print full `FILE_CONTENT`.
