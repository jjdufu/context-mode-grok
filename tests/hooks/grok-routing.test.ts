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

describe("Grok large-read noisy-path gate", () => {
  let grokLargeReadGate: (
    toolName: string,
    toolInput: Record<string, unknown>,
    projectDir?: string,
    sessionId?: string,
  ) => { action: string; reason?: string } | null;
  let isGrokHardGatePath: (absPath: string) => boolean;
  let GROK_READ_HARD_DENY_BYTES: number;
  let GROK_READ_PAGINATION_DENY_BYTES: number;
  let bigMd: string;
  let bigLog: string;
  let midLog: string;
  let smallLog: string;
  let nmFile: string;

  beforeAll(async () => {
    const gate = await import("../../hooks/grok/large-read-gate.mjs");
    grokLargeReadGate = gate.grokLargeReadGate;
    isGrokHardGatePath = gate.isGrokHardGatePath;
    GROK_READ_HARD_DENY_BYTES = gate.GROK_READ_HARD_DENY_BYTES;
    GROK_READ_PAGINATION_DENY_BYTES = gate.GROK_READ_PAGINATION_DENY_BYTES;

    bigMd = resolve(_sentinelDir, `cm-grok-big-${process.pid}.md`);
    bigLog = resolve(_sentinelDir, `cm-grok-big-${process.pid}.log`);
    midLog = resolve(_sentinelDir, `cm-grok-mid-${process.pid}.log`);
    smallLog = resolve(_sentinelDir, `cm-grok-small-${process.pid}.log`);
    writeFileSync(bigMd, "x".repeat(GROK_READ_HARD_DENY_BYTES + 1));
    writeFileSync(bigLog, "x".repeat(GROK_READ_HARD_DENY_BYTES + 1));
    writeFileSync(midLog, "y".repeat(GROK_READ_PAGINATION_DENY_BYTES + 1));
    writeFileSync(smallLog, "z".repeat(100));
    const nmDir = resolve(_sentinelDir, "node_modules", "pkg");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(nmDir, { recursive: true });
    nmFile = resolve(nmDir, "index.js");
    writeFileSync(nmFile, "n".repeat(GROK_READ_HARD_DENY_BYTES + 1));
  });

  afterAll(() => {
    for (const f of [bigMd, bigLog, midLog, smallLog, nmFile]) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  });

  it("classifies .md as passthrough and .log / node_modules as hard-gate", () => {
    expect(isGrokHardGatePath(bigMd)).toBe(false);
    expect(isGrokHardGatePath(bigLog)).toBe(true);
    expect(isGrokHardGatePath(nmFile)).toBe(true);
  });

  it("allows large .md read_file (human docs / source)", () => {
    expect(grokLargeReadGate("read_file", { target_file: bigMd }, _sentinelDir)).toBeNull();
    expect(
      grokLargeReadGate("read_file", { target_file: bigMd, offset: 0, limit: 50 }, _sentinelDir),
    ).toBeNull();
  });

  it("denies large .log every call; first long, later short", () => {
    const sid = `gate-log-${process.pid}-${Date.now()}`;
    const first = grokLargeReadGate("read_file", { target_file: bigLog }, _sentinelDir, sid);
    const second = grokLargeReadGate("read_file", { target_file: bigLog }, _sentinelDir, sid);
    expect(first?.action).toBe("deny");
    expect(second?.action).toBe("deny");
    expect(first!.reason).toMatch(/use_tool\("context-mode__ctx_execute_file"/);
    expect(first!.reason).toContain(bigLog);
    expect(second!.reason).toMatch(/^use context-mode__ctx_execute_file on /);
    expect(second!.reason!.length).toBeLessThan(first!.reason!.length);
  });

  it("denies paginated noisy mid-size .log when size >4KB", () => {
    const sid = `gate-page-${process.pid}-${Date.now()}`;
    const decision = grokLargeReadGate(
      "read_file",
      { target_file: midLog, offset: 0, limit: 100 },
      _sentinelDir,
      sid,
    );
    expect(decision?.action).toBe("deny");
    expect(decision!.reason).toMatch(/Paginated|noisy|ctx_execute_file/);
  });

  it("allows small noisy files without pagination", () => {
    expect(grokLargeReadGate("read_file", { target_file: smallLog }, _sentinelDir)).toBeNull();
  });

  it("allows mid-size noisy files without pagination when <=8KB", () => {
    const sizeOk =
      GROK_READ_PAGINATION_DENY_BYTES < GROK_READ_HARD_DENY_BYTES;
    expect(sizeOk).toBe(true);
    expect(grokLargeReadGate("read_file", { target_file: midLog }, _sentinelDir)).toBeNull();
  });

  it("denies large file under node_modules even if .js", () => {
    const sid = `gate-nm-${process.pid}-${Date.now()}`;
    const decision = grokLargeReadGate("read_file", { target_file: nmFile }, _sentinelDir, sid);
    expect(decision?.action).toBe("deny");
  });
});
