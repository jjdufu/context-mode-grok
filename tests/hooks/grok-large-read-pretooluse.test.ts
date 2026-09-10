import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pretooluse = resolve(__dirname, "../../hooks/grok/pretooluse.mjs");

describe("Grok pretooluse stdin large-read gate", () => {
  let dir: string;
  let bigFile: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cm-grok-ptu-"));
    bigFile = join(dir, "big.md");
    writeFileSync(bigFile, "文档内容\n".repeat(2000)); // ~20KB+
  });

  afterAll(() => {
    try { unlinkSync(bigFile); } catch { /* ignore */ }
  });

  function runHook(payload: Record<string, unknown>) {
    const r = spawnSync(process.execPath, [pretooluse], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, CONTEXT_MODE_PLATFORM: "grok" },
      timeout: 30_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const line = (r.stdout || "").trim().split("\n").filter(Boolean).pop() || "{}";
    return JSON.parse(line);
  }

  it("denies large read_file twice with filled use_tool example", () => {
    const payload = {
      tool_name: "read_file",
      tool_input: { target_file: bigFile },
      cwd: dir,
      session_id: `grok-ptu-${process.pid}`,
    };
    const a = runHook(payload);
    const b = runHook(payload);
    const reasonA =
      a?.hookSpecificOutput?.permissionDecisionReason ||
      a?.hookSpecificOutput?.additionalContext ||
      a?.reason ||
      JSON.stringify(a);
    const reasonB =
      b?.hookSpecificOutput?.permissionDecisionReason ||
      b?.hookSpecificOutput?.additionalContext ||
      b?.reason ||
      JSON.stringify(b);
    const decisionA = a?.hookSpecificOutput?.permissionDecision || a?.permissionDecision;
    const decisionB = b?.hookSpecificOutput?.permissionDecision || b?.permissionDecision;
    expect(decisionA).toBe("deny");
    expect(decisionB).toBe("deny");
    expect(String(reasonA)).toMatch(/context-mode__ctx_execute_file/);
    expect(String(reasonB)).toMatch(/context-mode__ctx_execute_file/);
    expect(String(reasonA)).toContain(bigFile);
  });

  it("denies paginated read_file of large file", () => {
    const out = runHook({
      tool_name: "read_file",
      tool_input: { target_file: bigFile, offset: 1, limit: 50 },
      cwd: dir,
      session_id: `grok-ptu-page-${process.pid}`,
    });
    const decision = out?.hookSpecificOutput?.permissionDecision || out?.permissionDecision;
    const reason =
      out?.hookSpecificOutput?.permissionDecisionReason ||
      out?.reason ||
      JSON.stringify(out);
    expect(decision).toBe("deny");
    expect(String(reason)).toMatch(/Paginated|offset\/limit|ctx_execute_file/);
  });
});
