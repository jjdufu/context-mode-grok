import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CLIENT_NAME_TO_PLATFORM } from "../../src/adapters/client-map.js";
import {
  detectPlatform,
  getSessionDirSegments,
  PLATFORM_ENV_VARS,
  getAdapter,
  __resetClaudeCodePluginCacheForTests,
} from "../../src/adapters/detect.js";

describe("Grok Build adapter wiring", () => {
  const saved: Record<string, string | undefined> = {};

  function clearPlatformEnv() {
    for (const [, entries] of PLATFORM_ENV_VARS) {
      for (const e of entries) {
        if (!(e.name in saved)) saved[e.name] = process.env[e.name];
        delete process.env[e.name];
      }
    }
  }

  function restoreEnv() {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  beforeEach(() => {
    __resetClaudeCodePluginCacheForTests();
    clearPlatformEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  it("maps grok clientInfo names", () => {
    for (const name of [
      "grok-cli",
      "grok-build",
      "xai-grok-cli",
      "xai-grok-shell",
      "xai-grok-build",
      "Grok Build",
      "grok",
    ]) {
      expect(CLIENT_NAME_TO_PLATFORM[name]).toBe("grok");
    }
  });

  it("detects grok from GROK_PLUGIN_ROOT even when CLAUDE_PROJECT_DIR is set", () => {
    process.env.GROK_PLUGIN_ROOT = "/tmp/fake-grok-plugin";
    process.env.CLAUDE_PROJECT_DIR = "/tmp/proj";
    process.env.CLAUDE_PLUGIN_ROOT = "/tmp/fake-claude-plugin";
    const signal = detectPlatform();
    expect(signal.platform).toBe("grok");
    expect(signal.confidence).toBe("high");
  });

  it("detects grok from GROK_HOME", () => {
    process.env.GROK_HOME = "/tmp/custom-grok-home";
    const signal = detectPlatform();
    expect(signal.platform).toBe("grok");
  });

  it("session dir segments resolve under .grok", () => {
    expect(getSessionDirSegments("grok")).toEqual([".grok"]);
  });

  it("getAdapter('grok') returns Grok Build adapter with correct capabilities", async () => {
    const adapter = await getAdapter("grok");
    expect(adapter.name).toBe("Grok Build");
    expect(adapter.capabilities.preToolUse).toBe(true);
    expect(adapter.capabilities.postToolUse).toBe(true);
    expect(adapter.capabilities.canModifyArgs).toBe(true);
    expect(adapter.capabilities.canModifyOutput).toBe(true);
    expect(adapter.capabilities.canInjectSessionContext).toBe(false);
  });

  it("parses camelCase PreToolUse payloads and target_file", async () => {
    const adapter = await getAdapter("grok");
    const event = adapter.parsePreToolUseInput({
      toolName: "read_file",
      toolInput: { target_file: "/tmp/big.log" },
      sessionId: "sess-1",
      cwd: "/tmp/proj",
    });
    expect(event.toolName).toBe("read_file");
    expect(event.toolInput.target_file).toBe("/tmp/big.log");
    expect(event.sessionId).toBe("sess-1");
    expect(event.projectDir).toBe("/tmp/proj");
  });
});
