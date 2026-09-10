import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
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

describe("Grok large-read always-deny gate", () => {
  let grokLargeReadGate: (
    toolName: string,
    toolInput: Record<string, unknown>,
    projectDir?: string,
  ) => { action: string; reason?: string } | null;
  let GROK_READ_HARD_DENY_BYTES: number;
  let GROK_READ_PAGINATION_DENY_BYTES: number;
  let bigFile: string;
  let midFile: string;
  let smallFile: string;

  beforeAll(async () => {
    const gate = await import("../../hooks/grok/large-read-gate.mjs");
    grokLargeReadGate = gate.grokLargeReadGate;
    GROK_READ_HARD_DENY_BYTES = gate.GROK_READ_HARD_DENY_BYTES;
    GROK_READ_PAGINATION_DENY_BYTES = gate.GROK_READ_PAGINATION_DENY_BYTES;

    bigFile = resolve(_sentinelDir, `cm-grok-big-${process.pid}.md`);
    midFile = resolve(_sentinelDir, `cm-grok-mid-${process.pid}.md`);
    smallFile = resolve(_sentinelDir, `cm-grok-small-${process.pid}.md`);
    writeFileSync(bigFile, "x".repeat(GROK_READ_HARD_DENY_BYTES + 1));
    writeFileSync(midFile, "y".repeat(GROK_READ_PAGINATION_DENY_BYTES + 1));
    writeFileSync(smallFile, "z".repeat(100));
  });

  afterAll(() => {
    for (const f of [bigFile, midFile, smallFile]) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  });

  it("denies read_file of >8KB file on every call (not once)", () => {
    const first = grokLargeReadGate("read_file", { target_file: bigFile }, _sentinelDir);
    const second = grokLargeReadGate("read_file", { target_file: bigFile }, _sentinelDir);
    expect(first?.action).toBe("deny");
    expect(second?.action).toBe("deny");
    expect(first!.reason).toMatch(/use_tool\("context-mode__ctx_execute_file"/);
    expect(first!.reason).toContain(bigFile);
    expect(second!.reason).toMatch(/use_tool\("context-mode__ctx_execute_file"/);
  });

  it("denies paginated read_file (offset/limit) when size >4KB", () => {
    const decision = grokLargeReadGate(
      "read_file",
      { target_file: midFile, offset: 0, limit: 100 },
      _sentinelDir,
    );
    expect(decision?.action).toBe("deny");
    expect(decision!.reason).toMatch(/Paginated read_file|offset\/limit/);
    expect(decision!.reason).toMatch(/use_tool\("context-mode__ctx_execute_file"/);
  });

  it("allows small files without pagination", () => {
    expect(grokLargeReadGate("read_file", { target_file: smallFile }, _sentinelDir)).toBeNull();
  });

  it("allows mid-size files without pagination when <=8KB", () => {
    // midFile is >4KB but <=8KB if PAGINATION < HARD; deny only when paginated
    const sizeOk =
      GROK_READ_PAGINATION_DENY_BYTES < GROK_READ_HARD_DENY_BYTES;
    expect(sizeOk).toBe(true);
    expect(grokLargeReadGate("read_file", { target_file: midFile }, _sentinelDir)).toBeNull();
  });
});
