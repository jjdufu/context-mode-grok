#!/usr/bin/env node
import "./platform.mjs";
/**
 * Grok Build PostToolUse — session capture + optional additionalContext.
 * Grok honors PostToolUse additionalContext and updatedMCPToolOutput.
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const hookDir = dirname(fileURLToPath(import.meta.url));
const shared = resolve(hookDir, "..", "posttooluse.mjs");

// Delegate to shared posttooluse (now platform-aware via detectPlatformFromEnv).
const child = spawn(process.execPath, [shared], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 0));
