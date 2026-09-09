/**
 * adapters/grok — Grok Build CLI platform adapter.
 *
 * Extends ClaudeCodeBaseAdapter (shared wire-protocol parse/format) with
 * Grok-specific config, camelCase payload normalization, and session paths
 * under ~/.grok/context-mode/.
 *
 * Differences from Claude Code:
 *   - Config dir: ~/.grok/ (honors $GROK_HOME)
 *   - Env vars: GROK_PLUGIN_ROOT / GROK_PLUGIN_DATA / GROK_HOME (also injects
 *     CLAUDE_PLUGIN_ROOT / CLAUDE_PROJECT_DIR for compat — must detect BEFORE
 *     claude-code)
 *   - Hook stdin: camelCase (toolName, toolInput, sessionId, workspaceRoot)
 *   - Tool names: run_terminal_command, read_file, web_fetch/open_page,
 *     spawn_subagent, grep; MCP as server__tool
 *   - SessionStart/UserPromptSubmit stdout discarded → canInjectSessionContext false
 *   - PreToolUse additionalContext arrives after the tool runs
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

import { ClaudeCodeBaseAdapter, type ClaudeCodeWireInput } from "../claude-code-base.js";
import { resolveContextModeDataRoot } from "../base.js";
import { resolveGrokConfigDir } from "./paths.js";
import {
  PRE_TOOL_USE_MATCHER_PATTERN,
  ROUTING_INSTRUCTIONS_PATH,
} from "./hooks.js";

import {
  buildHookRuntimeCommand,
  type HookAdapter,
  type HookParadigm,
  type PlatformCapabilities,
  type DiagnosticResult,
  type HookRegistration,
  type PreToolUseEvent,
  type PostToolUseEvent,
  type SessionStartEvent,
  type PreCompactEvent,
} from "../types.js";

/** Grok wire input — camelCase fields + Claude snake_case aliases. */
interface GrokWireInput extends ClaudeCodeWireInput {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  isError?: boolean;
  sessionId?: string;
  workspaceRoot?: string;
  cwd?: string;
  hookEventName?: string;
  source?: string;
}

function asRecord(raw: unknown): GrokWireInput {
  return (raw && typeof raw === "object" ? raw : {}) as GrokWireInput;
}

export class GrokAdapter extends ClaudeCodeBaseAdapter implements HookAdapter {
  constructor() {
    super([".grok"]);
  }

  readonly name = "Grok Build";
  readonly paradigm: HookParadigm = "json-stdio";
  protected readonly projectDirEnvVar = "GROK_PROJECT_DIR";

  readonly capabilities: PlatformCapabilities = {
    preToolUse: true,
    postToolUse: true,
    preCompact: true,
    sessionStart: true,
    canModifyArgs: true,
    canModifyOutput: true,
    // SessionStart / UserPromptSubmit stdout discarded on allow
    canInjectSessionContext: false,
  };

  getConfigDir(_projectDir?: string): string {
    return resolveGrokConfigDir();
  }

  getSessionDir(): string {
    const override = resolveContextModeDataRoot();
    const dir = override
      ? join(override, "context-mode", "sessions")
      : join(this.getConfigDir(), "context-mode", "sessions");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  getSettingsPath(): string {
    return join(this.getConfigDir(), "config.toml");
  }

  getInstructionFiles(): string[] {
    return ["AGENTS.md"];
  }

  // ── camelCase-aware parsing ────────────────────────────

  parsePreToolUseInput(raw: unknown): PreToolUseEvent {
    const input = asRecord(raw);
    return {
      toolName: input.toolName ?? input.tool_name ?? "",
      toolInput: input.toolInput ?? input.tool_input ?? {},
      sessionId: this.extractSessionId(input),
      projectDir: this.resolveProjectDir(input),
      raw,
    };
  }

  parsePostToolUseInput(raw: unknown): PostToolUseEvent {
    const input = asRecord(raw);
    return {
      toolName: input.toolName ?? input.tool_name ?? "",
      toolInput: input.toolInput ?? input.tool_input ?? {},
      toolOutput: input.toolOutput ?? input.tool_output,
      isError: input.isError ?? input.is_error,
      sessionId: this.extractSessionId(input),
      projectDir: this.resolveProjectDir(input),
      raw,
    };
  }

  parsePreCompactInput(raw: unknown): PreCompactEvent {
    const input = asRecord(raw);
    return {
      sessionId: this.extractSessionId(input),
      projectDir: this.resolveProjectDir(input),
      raw,
    };
  }

  parseSessionStartInput(raw: unknown): SessionStartEvent {
    const input = asRecord(raw);
    const rawSource = input.source ?? "startup";
    let source: SessionStartEvent["source"];
    switch (rawSource) {
      case "compact":
        source = "compact";
        break;
      case "resume":
        source = "resume";
        break;
      case "clear":
        source = "clear";
        break;
      default:
        source = "startup";
    }
    return {
      sessionId: this.extractSessionId(input),
      source,
      projectDir: this.resolveProjectDir(input),
      raw,
    };
  }

  generateHookConfig(pluginRoot: string): HookRegistration {
    const cmd = (script: string) =>
      buildHookRuntimeCommand(`${pluginRoot}/hooks/grok/${script}`);

    return {
      PreToolUse: [
        {
          matcher: PRE_TOOL_USE_MATCHER_PATTERN,
          hooks: [{ type: "command", command: cmd("pretooluse.mjs") }],
        },
      ],
      PostToolUse: [
        {
          matcher:
            "run_terminal_command|read_file|web_fetch|open_page|grep|spawn_subagent|Bash|Read|WebFetch|Grep|Agent|Task|context-mode__|mcp__",
          hooks: [{ type: "command", command: cmd("posttooluse.mjs") }],
        },
      ],
      SessionStart: [
        {
          matcher: "",
          hooks: [{ type: "command", command: cmd("sessionstart.mjs") }],
        },
      ],
      PreCompact: [
        {
          matcher: "",
          hooks: [{ type: "command", command: cmd("precompact.mjs") }],
        },
      ],
      UserPromptSubmit: [
        {
          matcher: "",
          hooks: [{ type: "command", command: cmd("userpromptsubmit.mjs") }],
        },
      ],
      Stop: [
        {
          matcher: "",
          hooks: [{ type: "command", command: cmd("stop.mjs") }],
        },
      ],
    };
  }

  readSettings(): Record<string, unknown> | null {
    // Grok primary config is TOML; hooks may also live in ~/.grok/hooks/*.json
    // or ~/.grok/settings.json (Claude-compat). Prefer JSON settings when present.
    const jsonPath = join(this.getConfigDir(), "settings.json");
    try {
      if (existsSync(jsonPath)) {
        return JSON.parse(readFileSync(jsonPath, "utf-8")) as Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
    return null;
  }

  writeSettings(settings: Record<string, unknown>): void {
    const configDir = this.getConfigDir();
    mkdirSync(configDir, { recursive: true });
    const jsonPath = join(configDir, "settings.json");
    writeFileSync(jsonPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  }

  validateHooks(_pluginRoot: string): DiagnosticResult[] {
    const results: DiagnosticResult[] = [];
    const hooksDir = join(this.getConfigDir(), "hooks");
    const pluginHooks = existsSync(join(_pluginRoot, "hooks", "grok", "pretooluse.mjs"))
      || existsSync(join(_pluginRoot, "hooks", "hooks.json"));

    results.push({
      check: "Grok hook scripts",
      status: pluginHooks ? "pass" : "warn",
      message: pluginHooks
        ? "Grok-specific or root hooks present in plugin"
        : "No grok hook scripts found — install plugin or run context-mode upgrade",
      fix: pluginHooks ? undefined : "context-mode upgrade",
    });

    if (existsSync(hooksDir)) {
      results.push({
        check: "User hooks dir",
        status: "pass",
        message: `Found ${hooksDir}`,
      });
    }

    results.push({
      check: "SessionStart context injection",
      status: "warn",
      message:
        "Grok discards SessionStart/UserPromptSubmit stdout — routing lives in skills + configs/grok/AGENTS.md + PreToolUse deny reasons",
    });

    return results;
  }

  checkPluginRegistration(): DiagnosticResult {
    // MCP may be in config.toml [mcp_servers.context-mode] or plugin manifest
    const configToml = join(this.getConfigDir(), "config.toml");
    try {
      if (existsSync(configToml)) {
        const raw = readFileSync(configToml, "utf-8");
        if (/mcp_servers\.context-mode|context-mode/.test(raw)) {
          return {
            check: "MCP registration",
            status: "pass",
            message: `context-mode referenced in ${configToml}`,
          };
        }
      }
    } catch {
      /* continue */
    }

    const pluginsRoot = join(this.getConfigDir(), "plugins");
    if (existsSync(pluginsRoot)) {
      return {
        check: "MCP registration",
        status: "pass",
        message: `Grok plugins directory present at ${pluginsRoot} (plugin install may register MCP)`,
      };
    }

    return {
      check: "MCP registration",
      status: "warn",
      message: "context-mode not found in ~/.grok/config.toml — run: grok mcp add context-mode -- context-mode",
      fix: "grok mcp add context-mode -- context-mode",
    };
  }

  getInstalledVersion(): string {
    try {
      const out = execSync("grok --version", {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      }).trim();
      return out.split(/\r?\n/)[0] || "unknown";
    } catch {
      return "not installed";
    }
  }

  configureAllHooks(pluginRoot: string): string[] {
    // Prefer writing a dedicated hooks JSON under ~/.grok/hooks/
    const hooksDir = join(this.getConfigDir(), "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const registration = this.generateHookConfig(pluginRoot);
    const outPath = join(hooksDir, "context-mode.json");
    writeFileSync(
      outPath,
      JSON.stringify({ description: "context-mode Grok Build hooks", hooks: registration }, null, 2) + "\n",
      "utf-8",
    );
    return [`Wrote Grok hooks to ${outPath}`];
  }

  setHookPermissions(_pluginRoot: string): string[] {
    return [];
  }

  updatePluginRegistry(_pluginRoot: string, _version: string): void {
    // Grok manages plugins via its own registry
  }

  getRoutingInstructionsConfig() {
    return {
      instructionsPath: join(homedir(), ".grok", "AGENTS.md"),
      sourcePath: ROUTING_INSTRUCTIONS_PATH,
      targetPath: "AGENTS.md",
      platformName: "Grok Build",
    };
  }

  protected extractSessionId(input: ClaudeCodeWireInput): string {
    const g = input as GrokWireInput;
    if (g.sessionId) return g.sessionId;
    if (g.session_id) return g.session_id;
    if (g.transcript_path) {
      const match = g.transcript_path.match(/([a-f0-9-]{36})\.jsonl$/);
      if (match) return match[1];
    }
    if (process.env.GROK_SESSION_ID) return process.env.GROK_SESSION_ID;
    return `pid-${process.ppid}`;
  }

  private resolveProjectDir(input: GrokWireInput): string {
    if (typeof input.cwd === "string" && input.cwd.length > 0) return input.cwd;
    if (typeof input.workspaceRoot === "string" && input.workspaceRoot.length > 0) {
      return input.workspaceRoot;
    }
    return (
      process.env[this.projectDirEnvVar]
      || process.env.CLAUDE_PROJECT_DIR
      || process.cwd()
    );
  }
}
