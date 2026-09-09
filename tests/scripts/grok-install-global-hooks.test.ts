/**
 * scripts/grok-install-global-hooks.mjs — idempotent global hooks bridge.
 *
 * Uses an isolated HOME so installs never touch the real ~/.grok.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = resolve(__dirname, "..", "..");
const INSTALLER = resolve(REPO, "scripts", "grok-install-global-hooks.mjs");

async function loadInstaller() {
  // Bust import cache so each suite gets a fresh module if needed.
  const url = `${pathToFileURL(INSTALLER).href}?t=${Date.now()}`;
  return import(url);
}

describe("installGrokGlobalHooks", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function isolateHome() {
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    home = mkdtempSync(join(tmpdir(), "ctx-grok-hooks-home-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    return home;
  }

  it("writes ~/.grok/hooks/context-mode.json targeting pluginRoot scripts", async () => {
    isolateHome();
    const { installGrokGlobalHooks } = await loadInstaller();
    const result = installGrokGlobalHooks({ pluginRoot: REPO });
    expect(result.ok).toBe(true);
    expect(result.wrote).toBe(true);
    const dest = join(home, ".grok", "hooks", "context-mode.json");
    expect(result.dest).toBe(dest);
    expect(existsSync(dest)).toBe(true);
    const raw = readFileSync(dest, "utf8");
    const json = JSON.parse(raw);
    expect(json.hooks.PreToolUse.length).toBeGreaterThan(5);
    expect(raw).toContain(join(REPO, "hooks/grok/pretooluse.mjs"));
    expect(raw).toContain(join(REPO, "hooks/grok/posttooluse.mjs"));
    expect(raw).toContain("CONTEXT_MODE_PLATFORM=grok");
    expect(raw).toContain(`GROK_PLUGIN_ROOT=\\"${REPO}\\"`);
    expect(raw).toContain("run_terminal_command");
    expect(raw).toContain("context-mode__");
    expect(raw).toContain("mcp__");
  });

  it("second call is idempotent (no rewrite)", async () => {
    isolateHome();
    const { installGrokGlobalHooks } = await loadInstaller();
    const first = installGrokGlobalHooks({ pluginRoot: REPO });
    expect(first.wrote).toBe(true);
    const dest = join(home, ".grok", "hooks", "context-mode.json");
    const before = readFileSync(dest, "utf8");
    // Touch mtime baseline via content check — second call should skip.
    const second = installGrokGlobalHooks({ pluginRoot: REPO });
    expect(second.ok).toBe(true);
    expect(second.skipped).toBe(true);
    expect(second.wrote).toBeUndefined();
    expect(readFileSync(dest, "utf8")).toBe(before);
  });

  it("refreshes when pluginRoot changes", async () => {
    isolateHome();
    const { installGrokGlobalHooks } = await loadInstaller();
    // Fake alternate plugin root with the required hook scripts.
    const otherRoot = mkdtempSync(join(tmpdir(), "ctx-grok-other-root-"));
    mkdirSync(join(otherRoot, "hooks", "grok"), { recursive: true });
    writeFileSync(join(otherRoot, "hooks/grok/pretooluse.mjs"), "// stub\n");
    writeFileSync(join(otherRoot, "hooks/grok/posttooluse.mjs"), "// stub\n");
    try {
      const first = installGrokGlobalHooks({ pluginRoot: REPO });
      expect(first.wrote).toBe(true);
      const dest = join(home, ".grok", "hooks", "context-mode.json");
      expect(readFileSync(dest, "utf8")).toContain(REPO);

      const refreshed = installGrokGlobalHooks({ pluginRoot: otherRoot });
      expect(refreshed.ok).toBe(true);
      expect(refreshed.wrote).toBe(true);
      const after = readFileSync(dest, "utf8");
      expect(after).toContain(otherRoot);
      expect(after).toContain(join(otherRoot, "hooks/grok/pretooluse.mjs"));
      expect(after).not.toContain(join(REPO, "hooks/grok/pretooluse.mjs"));
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it("force=true rewrites even when already targeting same root", async () => {
    isolateHome();
    const { installGrokGlobalHooks } = await loadInstaller();
    installGrokGlobalHooks({ pluginRoot: REPO });
    const dest = join(home, ".grok", "hooks", "context-mode.json");
    // Corrupt content but keep same pluginRoot paths so skip would apply.
    const corrupted = JSON.stringify({ hooks: { PreToolUse: [] } }, null, 2) + "\n";
    // Keep paths so targetsPluginRoot still true — use a partial that includes paths.
    const withPaths =
      corrupted.trimEnd() +
      `\n/* ${join(REPO, "hooks/grok/pretooluse.mjs")} ${join(REPO, "hooks/grok/posttooluse.mjs")} */\n`;
    // Actually JSON file — write invalid-for-equality content that still includes paths:
    writeFileSync(
      dest,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: "read_file",
                hooks: [
                  {
                    type: "command",
                    command: `node "${join(REPO, "hooks/grok/pretooluse.mjs")}"`,
                  },
                ],
              },
            ],
            PostToolUse: [
              {
                matcher: "x",
                hooks: [
                  {
                    type: "command",
                    command: `node "${join(REPO, "hooks/grok/posttooluse.mjs")}"`,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ) + "\n",
    );
    const skipped = installGrokGlobalHooks({ pluginRoot: REPO });
    expect(skipped.skipped).toBe(true);
    const forced = installGrokGlobalHooks({ pluginRoot: REPO, force: true });
    expect(forced.wrote).toBe(true);
    expect(readFileSync(dest, "utf8")).toContain("CONTEXT_MODE_PLATFORM=grok");
  });
});
