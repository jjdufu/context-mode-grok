import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

let routePreToolUse: (
  toolName: string,
  toolInput: Record<string, unknown>,
  projectDir?: string,
  platform?: string,
  sessionId?: string,
) => { action: string; reason?: string; updatedInput?: Record<string, unknown>; additionalContext?: string } | null;
let resetGuidanceThrottle: () => void;
let getToolName: (platform: string, bareTool: string) => string;
let detectPlatformFromEnv: (env?: Record<string, string | undefined>) => string;
let normalizeHookPayload: (input: Record<string, unknown>) => Record<string, unknown>;

beforeAll(async () => {
  const routing = await import("../../hooks/core/routing.mjs");
  routePreToolUse = routing.routePreToolUse;
  resetGuidanceThrottle = routing.resetGuidanceThrottle;

  const naming = await import("../../hooks/core/tool-naming.mjs");
  getToolName = naming.getToolName;

  const detect = await import("../../hooks/core/platform-detect.mjs");
  detectPlatformFromEnv = detect.detectPlatformFromEnv;

  const helpers = await import("../../hooks/session-helpers.mjs");
  normalizeHookPayload = helpers.normalizeHookPayload;
});

const _sentinelDir = process.platform === "win32" ? tmpdir() : "/tmp";
const mcpSentinel = resolve(_sentinelDir, `context-mode-mcp-ready-${process.pid}`);

beforeEach(() => {
  if (typeof resetGuidanceThrottle === "function") resetGuidanceThrottle();
  writeFileSync(mcpSentinel, String(process.pid));
});

afterEach(() => {
  try { unlinkSync(mcpSentinel); } catch { /* ignore */ }
});

describe("Grok Build routing", () => {
  it("maps run_terminal_command curl to redirect with context-mode__ names", () => {
    const decision = routePreToolUse(
      "run_terminal_command",
      { command: "curl https://example.com" },
      "/tmp",
      "grok",
      "test-session",
    );
    expect(decision).toBeTruthy();
    expect(["deny", "modify"]).toContain(decision!.action);
    expect(JSON.stringify(decision)).toMatch(/context-mode__ctx_/);
  });

  it("maps spawn_subagent and open_page via aliases without throwing", () => {
    const agent = routePreToolUse("spawn_subagent", { prompt: "hi" }, "/tmp", "grok", "s");
    const page = routePreToolUse("open_page", { url: "https://example.com" }, "/tmp", "grok", "s");
    expect(agent === null || typeof agent === "object").toBe(true);
    expect(page === null || typeof page === "object").toBe(true);
  });

  it("accepts read_file + target_file", () => {
    const decision = routePreToolUse(
      "read_file",
      { target_file: "/tmp/huge.json" },
      "/tmp",
      "grok",
      "s",
    );
    expect(decision === null || typeof decision === "object").toBe(true);
  });

  it("tool-naming uses context-mode__ prefix", () => {
    expect(getToolName("grok", "ctx_execute")).toBe("context-mode__ctx_execute");
  });

  it("platform-detect prefers grok over claude-code", () => {
    expect(
      detectPlatformFromEnv({
        GROK_PLUGIN_ROOT: "/x",
        CLAUDE_PROJECT_DIR: "/y",
        CLAUDE_SESSION_ID: "z",
      }),
    ).toBe("grok");
  });

  it("normalizeHookPayload maps camelCase and target_file", () => {
    const n = normalizeHookPayload({
      toolName: "read_file",
      toolInput: { target_file: "/a/b" },
      sessionId: "s1",
    });
    expect(n.tool_name).toBe("read_file");
    expect((n.tool_input as { file_path: string }).file_path).toBe("/a/b");
    expect(n.session_id).toBe("s1");
  });
});
