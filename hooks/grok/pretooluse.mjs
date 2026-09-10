#!/usr/bin/env node
import "./platform.mjs";
import "../suppress-stderr.mjs";
/**
 * Grok Build PreToolUse hook for context-mode.
 *
 * Prefers deny-with-reason over additionalContext: Grok delivers PreToolUse
 * additionalContext AFTER the tool has already run, so soft guidance cannot
 * prevent the first large Read/Bash from entering context.
 *
 * After routePreToolUse, applies grokLargeReadGate for noisy/compressible
 * paths only (logs, locks, node_modules, large data). Prose/source (.md, .ts, …)
 * pass through to native read_file even when large.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readStdin,
  parseStdin,
  getInputProjectDir,
  getSessionId,
  normalizeHookPayload,
  GROK_OPTS,
} from "../session-helpers.mjs";
import { routePreToolUse, initSecurity } from "../core/routing.mjs";
import { formatDecision } from "../core/formatters.mjs";
import {
  grokLargeReadGate,
  getGrokReadPath,
  resolveGrokReadPath,
  isGrokHardGatePath,
} from "./large-read-gate.mjs";

const __hookDir = dirname(fileURLToPath(import.meta.url));
await initSecurity(resolve(__hookDir, "..", "..", "build"));

const raw = await readStdin();
const input = normalizeHookPayload(parseStdin(raw));
const tool = input.tool_name ?? "";
const toolInput = input.tool_input ?? {};
const projectDir = getInputProjectDir(input, GROK_OPTS);
const isSubagentContext = input.agent_id != null || input.agent_type != null || input.agentId != null;

const sessionId = getSessionId(input, GROK_OPTS);
const decision = routePreToolUse(
  tool,
  toolInput,
  projectDir,
  "grok",
  sessionId,
  { mcpToolsAvailable: !isSubagentContext },
);

// Prefer deny over soft context on Grok — additionalContext is post-hoc only.
// Exception: prose/source reads (isGrokHardGatePath=false) — allow native
// read_file; denying forced ctx_execute_file dumps that erase token savings.
let effective = decision;
if (decision && decision.action === "context" && decision.additionalContext) {
  const rawRead = getGrokReadPath(toolInput);
  const absRead = rawRead ? resolveGrokReadPath(rawRead, projectDir) : "";
  const proseOrSourceRead = Boolean(rawRead) && !isGrokHardGatePath(absRead);
  if (proseOrSourceRead) {
    effective = null;
  } else {
    effective = {
      action: "deny",
      reason:
        decision.additionalContext +
        "\n\nGrok tip: discover tools with search_tool(\"ctx_execute\"), then call use_tool(\"context-mode__ctx_execute\", …).",
    };
  }
}

// Noisy-path large / paginated read gate (every call, not guidanceOnce).
// Prose/source allowlisted; only logs/locks/node_modules/data hard-deny.
const largeRead = grokLargeReadGate(tool, toolInput, projectDir, sessionId);
if (largeRead) {
  effective = largeRead;
}

const response = formatDecision("grok", effective);
const output = response ?? {
  hookSpecificOutput: { hookEventName: "PreToolUse" },
};
process.stdout.write(JSON.stringify(output) + "\n");
