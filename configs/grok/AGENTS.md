# context-mode — MANDATORY routing rules (Grok Build)

context-mode MCP tools are available via Grok's two-step tool calling. Rules protect the context window from flooding. One unrouted `run_terminal_command` / `read_file` can dump tens of KB into context. Follow strictly.

## How to call context-mode on Grok Build

Grok does **not** expose `ctx_*` as native tools. Always:

1. `search_tool("ctx_execute")` (or `ctx_search`, `ctx_execute_file`, `ctx_batch_execute`, `ctx_fetch_and_index`)
2. `use_tool("context-mode__ctx_execute", { ... })` — note the `server__tool` name

Do **not** invent `mcp__plugin_context-mode_...` names; those are Claude Code wire names.

## Think in Code — MANDATORY

Analyze/count/filter/compare/search/parse/transform data: **write code** via `use_tool("context-mode__ctx_execute", { language, code })`, `console.log()` only the answer. Do NOT read raw data into context.

## BLOCKED — do NOT use

### curl / wget in run_terminal_command — FORBIDDEN
Use: `context-mode__ctx_fetch_and_index` or `context-mode__ctx_execute` with `fetch(...)`.

### Direct web_fetch / open_page for large pages — FORBIDDEN
Use: `context-mode__ctx_fetch_and_index` then `context-mode__ctx_search`.

## REDIRECTED — use sandbox

### run_terminal_command (>20 lines output)
Whitelist only: `git` writes, `mkdir`, `rm`, `mv`, `cd`, `ls`, `npm install`, `pip install`, `echo`.
Otherwise: `context-mode__ctx_batch_execute` or `context-mode__ctx_execute`.

### read_file — when native is OK vs sandbox
- **Prose / source review or editing** (`.md`, `.mdx`, `.txt`, `.ts`/`.tsx`/`.js`/`.py`/…): native `read_file` is OK — including full text for language/style review. Do **not** dump `FILE_CONTENT` via `console.log` if the goal is saving tokens.
- **Large logs / data / noisy paths** (`.log`, `.jsonl`, locks, `node_modules`, minified, fixtures, big `.json`/CSV): use `context-mode__ctx_execute_file` for aggregation/search. Hard gate denies native read on these when large.

**After Hook denied for `read_file`:** immediately `search_tool("ctx_execute_file")` then `use_tool("context-mode__ctx_execute_file", { path, language, code })`. Do **NOT** retry `read_file` on the same noisy path. Use the filled `use_tool` example from the first deny (later denies are one short line). `console.log` **summary only** — never the full file.

### grep (large results)
Prefer `context-mode__ctx_execute` in the sandbox for filtering/counting.

## Tool selection

0. **MEMORY**: `context-mode__ctx_search` with `sort: "timeline"` after resume.
1. **GATHER**: `context-mode__ctx_batch_execute`.
2. **FOLLOW-UP**: `context-mode__ctx_search`.
3. **PROCESSING**: `context-mode__ctx_execute` | `context-mode__ctx_execute_file`.
4. **WEB**: `context-mode__ctx_fetch_and_index` then `context-mode__ctx_search`.

## Session continuity note

Grok discards SessionStart / UserPromptSubmit stdout. These AGENTS.md rules + the `context-mode` skill + PreToolUse deny reasons are the authoritative routing surface. Session DB lives under `~/.grok/context-mode/sessions/`.
