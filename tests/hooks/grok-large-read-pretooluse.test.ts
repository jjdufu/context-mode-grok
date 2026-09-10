import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, unlinkSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pretooluse = resolve(__dirname, "../../hooks/grok/pretooluse.mjs");

describe("Grok pretooluse stdin large-read gate", () => {
  let dir: string;
  let bigMd: string;
  let bigLog: string;
  let nmFile: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cm-grok-ptu-"));
    bigMd = join(dir, "big.md");
    bigLog = join(dir, "big.log");
    writeFileSync(bigMd, "文档内容\n".repeat(2000)); // ~20KB+
    writeFileSync(bigLog, "ERROR line\n".repeat(2000));
    const nmDir = join(dir, "node_modules", "pkg");
    mkdirSync(nmDir, { recursive: true });
    nmFile = join(nmDir, "index.js");
    writeFileSync(nmFile, "x".repeat(10_000));
  });

  afterAll(() => {
    for (const f of [bigMd, bigLog, nmFile]) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
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

  function decisionOf(out: Record<string, unknown>) {
    return (
      (out?.hookSpecificOutput as Record<string, unknown>)?.permissionDecision ||
      out?.permissionDecision
    );
  }

  function reasonOf(out: Record<string, unknown>) {
    return (
      (out?.hookSpecificOutput as Record<string, unknown>)?.permissionDecisionReason ||
      (out?.hookSpecificOutput as Record<string, unknown>)?.additionalContext ||
      out?.reason ||
      JSON.stringify(out)
    );
  }

  it("allows large .md read_file (prose passthrough)", () => {
    const out = runHook({
      tool_name: "read_file",
      tool_input: { target_file: bigMd },
      cwd: dir,
      session_id: `grok-ptu-md-${process.pid}`,
    });
    // null/allow — no deny decision
    const decision = decisionOf(out);
    expect(decision).not.toBe("deny");
  });

  it("allows paginated large .md", () => {
    const out = runHook({
      tool_name: "read_file",
      tool_input: { target_file: bigMd, offset: 1, limit: 50 },
      cwd: dir,
      session_id: `grok-ptu-md-page-${process.pid}`,
    });
    expect(decisionOf(out)).not.toBe("deny");
  });

  it("denies large .log with long then short reason", () => {
    const sid = `grok-ptu-log-${process.pid}-${Date.now()}`;
    const payload = {
      tool_name: "read_file",
      tool_input: { target_file: bigLog },
      cwd: dir,
      session_id: sid,
    };
    const a = runHook(payload);
    const b = runHook(payload);
    expect(decisionOf(a)).toBe("deny");
    expect(decisionOf(b)).toBe("deny");
    const reasonA = String(reasonOf(a));
    const reasonB = String(reasonOf(b));
    expect(reasonA).toMatch(/context-mode__ctx_execute_file/);
    expect(reasonA).toContain(bigLog);
    expect(reasonA.length).toBeGreaterThan(reasonB.length);
    expect(reasonB).toMatch(/^use context-mode__ctx_execute_file on /);
  });

  it("denies large file under node_modules", () => {
    const out = runHook({
      tool_name: "read_file",
      tool_input: { target_file: nmFile },
      cwd: dir,
      session_id: `grok-ptu-nm-${process.pid}-${Date.now()}`,
    });
    expect(decisionOf(out)).toBe("deny");
    expect(String(reasonOf(out))).toMatch(/ctx_execute_file/);
  });
});
