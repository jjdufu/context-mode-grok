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
 * This module installs ~/.grok/hooks/context-mode.json that invokes this
 * package's hooks/grok/pretooluse.mjs + posttooluse.mjs with absolute paths.
 *
 * Auto-install: start.mjs (MCP boot when Grok) and scripts/postinstall.mjs
 * (when ~/.grok already exists). Manual CLI remains a fallback.
 *
 * Usage:
 *   node scripts/grok-install-global-hooks.mjs
 *   # or after plugin install, point at the installed copy:
 *   node ~/.grok/installed-plugins/context-mode-<id>/scripts/grok-install-global-hooks.mjs
 *
 * Programmatic:
 *   import { installGrokGlobalHooks } from "./grok-install-global-hooks.mjs";
 *   installGrokGlobalHooks({ pluginRoot?, force? });
 *
 * Honors $HOME / $USERPROFILE for tests (os.homedir() follows them).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLUGIN_ROOT = path.resolve(__dirname, "..");

const MATCHERS = [
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

const POST_MATCHER =
  "run_terminal_command|read_file|web_fetch|open_page|grep|spawn_subagent|Bash|Read|Write|Edit|Glob|Grep|WebFetch|WebSearch|context-mode__.*|mcp__.*";

function resolveHome() {
  // Prefer env so vitest can isolate via HOME without mocking os.homedir.
  const fromEnv = process.env.HOME || process.env.USERPROFILE;
  if (fromEnv && String(fromEnv).trim() !== "") return path.resolve(fromEnv);
  return os.homedir();
}

function buildHooksConfig(pluginRoot) {
  const pre = path.join(pluginRoot, "hooks/grok/pretooluse.mjs");
  const post = path.join(pluginRoot, "hooks/grok/posttooluse.mjs");
  const cmd = (script) =>
    `CONTEXT_MODE_PLATFORM=grok CLAUDE_PLUGIN_ROOT="${pluginRoot}" GROK_PLUGIN_ROOT="${pluginRoot}" node "${script}"`;
  return {
    hooks: {
      PreToolUse: MATCHERS.map((matcher) => ({
        matcher,
        hooks: [{ type: "command", command: cmd(pre), timeout: 30 }],
      })),
      PostToolUse: [
        {
          matcher: POST_MATCHER,
          hooks: [{ type: "command", command: cmd(post), timeout: 30 }],
        },
      ],
    },
  };
}

function targetsPluginRoot(content, pluginRoot) {
  const pre = path.join(pluginRoot, "hooks/grok/pretooluse.mjs");
  const post = path.join(pluginRoot, "hooks/grok/posttooluse.mjs");
  return content.includes(pre) && content.includes(post);
}

/**
 * Install or refresh ~/.grok/hooks/context-mode.json.
 * Idempotent: skips rewrite when existing JSON already targets this pluginRoot.
 * Best-effort: never throws — errors go to stderr and are returned.
 *
 * @param {{ pluginRoot?: string, force?: boolean }} [opts]
 * @returns {{ ok: boolean, dest?: string, skipped?: boolean, wrote?: boolean, error?: string }}
 */
export function installGrokGlobalHooks({ pluginRoot, force } = {}) {
  try {
    const root = path.resolve(pluginRoot || DEFAULT_PLUGIN_ROOT);
    const pre = path.join(root, "hooks/grok/pretooluse.mjs");
    const post = path.join(root, "hooks/grok/posttooluse.mjs");
    for (const p of [pre, post]) {
      if (!fs.existsSync(p)) {
        const msg = `context-mode: grok global hooks skipped (missing ${p})\n`;
        try {
          process.stderr.write(msg);
        } catch {
          /* ignore */
        }
        return { ok: false, error: `missing ${p}` };
      }
    }

    const hooks = buildHooksConfig(root);
    const expected = JSON.stringify(hooks, null, 2) + "\n";
    const destDir = path.join(resolveHome(), ".grok", "hooks");
    const dest = path.join(destDir, "context-mode.json");

    if (!force && fs.existsSync(dest)) {
      try {
        const existing = fs.readFileSync(dest, "utf8");
        if (existing === expected || targetsPluginRoot(existing, root)) {
          // Same pluginRoot scripts already wired — skip rewrite.
          // If content differs only in matchers but still targets this root,
          // treat as current enough for idempotency; force=true refreshes.
          if (existing === expected) {
            return { ok: true, dest, skipped: true };
          }
          if (targetsPluginRoot(existing, root) && !force) {
            return { ok: true, dest, skipped: true };
          }
        }
      } catch {
        /* fall through to rewrite */
      }
    }

    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(dest, expected);
    return { ok: true, dest, wrote: true };
  } catch (err) {
    const message = (err && err.message) || String(err);
    try {
      process.stderr.write(`context-mode: grok global hooks install failed (${message})\n`);
    } catch {
      /* ignore */
    }
    return { ok: false, error: message };
  }
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  const result = installGrokGlobalHooks();
  if (!result.ok) {
    process.exit(1);
  }
  if (result.skipped) {
    console.log(`Already installed: ${result.dest}`);
  } else {
    console.log(`Wrote ${result.dest}`);
    console.log("Start a new grok session for hooks to load.");
  }
}
