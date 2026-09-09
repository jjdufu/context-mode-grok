/**
 * adapters/grok/hooks — Grok Build CLI hook definitions.
 *
 * Grok Build uses a Claude-compatible JSON stdin/stdout hook protocol with
 * camelCase payload fields (`toolName`, `toolInput`, `sessionId`) and native
 * tool names (`run_terminal_command`, `read_file`, `web_fetch`/`open_page`,
 * `spawn_subagent`, `grep`). MCP tools appear as `server__tool`
 * (e.g. `context-mode__ctx_execute`).
 *
 * Known limitations (verified against ~/.grok/docs/user-guide/10-hooks.md):
 *   - SessionStart / UserPromptSubmit: stdout / additionalContext discarded on allow
 *   - PreToolUse additionalContext arrives AFTER the tool runs
 *   - Cannot rewrite use_tool to a different tool via updatedInput
 */

export const HOOK_TYPES = {
  PRE_TOOL_USE: "PreToolUse",
  POST_TOOL_USE: "PostToolUse",
  PRE_COMPACT: "PreCompact",
  SESSION_START: "SessionStart",
  USER_PROMPT_SUBMIT: "UserPromptSubmit",
  STOP: "Stop",
} as const;

export type HookType = (typeof HOOK_TYPES)[keyof typeof HOOK_TYPES];

/**
 * External MCP catch-all for Grok (`server__tool`). Charset-clean literal —
 * no lookaround. Own tools filtered in routing.mjs isExternalMcpTool().
 */
export const EXTERNAL_MCP_MATCHER_PATTERN = "context-mode__|mcp__";

/** Grok-native + Claude-alias matchers for PreToolUse routing. */
export const PRE_TOOL_USE_MATCHERS = [
  // Grok-native
  "run_terminal_command",
  "read_file",
  "web_fetch",
  "open_page",
  "grep",
  "spawn_subagent",
  // Claude aliases (Grok matcher layer also maps Bash→run_terminal_command)
  "Bash",
  "Read",
  "WebFetch",
  "Grep",
  "Agent",
  "Task",
  // Own MCP tools (Grok qualifies as server__tool)
  "context-mode__ctx_execute",
  "context-mode__ctx_execute_file",
  "context-mode__ctx_batch_execute",
  // Claude-style MCP prefix (compat) + Grok external catch-all handled in body
  "mcp__",
] as const;

export const PRE_TOOL_USE_MATCHER_PATTERN = PRE_TOOL_USE_MATCHERS.join("|");

export const ROUTING_INSTRUCTIONS_PATH = "configs/grok/AGENTS.md";

export const HOOK_SCRIPTS: Partial<Record<HookType, string>> = {
  [HOOK_TYPES.PRE_TOOL_USE]: "pretooluse.mjs",
  [HOOK_TYPES.POST_TOOL_USE]: "posttooluse.mjs",
  [HOOK_TYPES.SESSION_START]: "sessionstart.mjs",
  [HOOK_TYPES.USER_PROMPT_SUBMIT]: "userpromptsubmit.mjs",
  [HOOK_TYPES.PRE_COMPACT]: "precompact.mjs",
  [HOOK_TYPES.STOP]: "stop.mjs",
};
