#!/usr/bin/env node
/**
 * Grok Build CLI hook bridge for context-mode.
 *
 * Observed on Grok 1.0.24:
 * - Plugin hooks appear in `grok inspect` (has_hooks=true) but do not activate
 *   at runtime. Grok opens ~/.grok/trusted-plugins; when that file is missing,
 *   plugin hooks stay inert. `grok plugin install --trust` does not create it.
 * - Global hooks in ~/.grok/hooks/*.json DO run and can deny PreToolUse.
 *
 * This script installs ~/.grok/hooks/context-mode.json that invokes this
 * package's hooks/grok/pretooluse.mjs + posttooluse.mjs with absolute paths.
 *
 * Usage:
 *   node scripts/grok-install-global-hooks.mjs
 *   # or after plugin install, point at the installed copy:
 *   node ~/.grok/installed-plugins/context-mode-*/scripts/grok-install-global-hooks.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, "..");
const pre = path.join(pluginRoot, "hooks/grok/pretooluse.mjs");
const post = path.join(pluginRoot, "hooks/grok/posttooluse.mjs");
for (const p of [pre, post]) {
  if (!fs.existsSync(p)) {
    console.error(`missing ${p}`);
    process.exit(1);
  }
}
const cmd = (script) =>
  `CONTEXT_MODE_PLATFORM=grok CLAUDE_PLUGIN_ROOT="${pluginRoot}" GROK_PLUGIN_ROOT="${pluginRoot}" node "${script}"`;
const matchers = [
  "run_terminal_command",
  "read_file",
  "web_fetch",
  "open_page",
  "grep",
  "spawn_subagent",
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "context-mode__ctx_execute",
  "context-mode__ctx_execute_file",
  "context-mode__ctx_batch_execute",
  "context-mode__",
  "mcp__",
];
const hooks = {
  hooks: {
    PreToolUse: matchers.map((matcher) => ({
      matcher,
      hooks: [{ type: "command", command: cmd(pre), timeout: 30 }],
    })),
    PostToolUse: [
      {
        matcher:
          "run_terminal_command|read_file|web_fetch|open_page|grep|spawn_subagent|Bash|Read|Write|Edit|Glob|Grep|WebFetch|WebSearch|context-mode__.*|mcp__.*",
        hooks: [{ type: "command", command: cmd(post), timeout: 30 }],
      },
    ],
  },
};
const destDir = path.join(os.homedir(), ".grok", "hooks");
fs.mkdirSync(destDir, { recursive: true });
const dest = path.join(destDir, "context-mode.json");
fs.writeFileSync(dest, JSON.stringify(hooks, null, 2) + "\n");
console.log(`Wrote ${dest}`);
console.log("Start a new grok session for hooks to load.");
