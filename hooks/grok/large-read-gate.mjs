/**
 * Grok-specific hard gate for large / paginated read_file.
 *
 * Claude soft-nudge uses guidanceOnce (first call only). On Grok that becomes
 * a one-shot deny; later reads ALLOW — and offset/limit pagination bypasses
 * the gate for mid-size files (e.g. 31KB < 50KB shared threshold).
 *
 * This helper always denies (every call) when:
 *   - file size > 8192 bytes, OR
 *   - tool_input has offset/limit AND size > 4096 bytes
 * with a filled use_tool("context-mode__ctx_execute_file", …) example.
 */

import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const GROK_READ_HARD_DENY_BYTES = 8192;
export const GROK_READ_PAGINATION_DENY_BYTES = 4096;

const READ_TOOL_NAMES = new Set([
  "read_file",
  "Read",
  "read_many_files",
  "view_file",
  "view",
  "read",
  "fs_read",
]);

/**
 * @param {Record<string, unknown> | null | undefined} toolInput
 * @returns {string}
 */
export function getGrokReadPath(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";
  for (const key of ["target_file", "file_path", "path", "AbsolutePath", "FilePath"]) {
    const v = toolInput[key];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return "";
}

/**
 * @param {string} rawPath
 * @param {string} [projectDir]
 * @returns {string}
 */
export function resolveGrokReadPath(rawPath, projectDir) {
  if (!rawPath) return "";
  if (isAbsolute(rawPath)) return rawPath;
  if (projectDir && typeof projectDir === "string" && projectDir.trim() !== "") {
    return resolve(projectDir, rawPath);
  }
  return resolve(rawPath);
}

/**
 * @param {Record<string, unknown> | null | undefined} toolInput
 * @returns {boolean}
 */
export function hasReadPagination(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return false;
  return (
    toolInput.offset != null ||
    toolInput.limit != null ||
    toolInput.Offset != null ||
    toolInput.Limit != null ||
    toolInput.start_line != null ||
    toolInput.end_line != null
  );
}

/**
 * Starter JS for ctx_execute_file — prints line count, first/last lines, awkward-pattern hits.
 * Returned as a single string suitable for the `code` argument.
 * @returns {string}
 */
export function grokExecuteFileStarterCode() {
  return [
    "const lines = String(FILE_CONTENT).split(/\\r?\\n/);",
    "const N = 15;",
    "const awkward = /(生造|蹩脚|之乎者也|盖闻|夫惟|文言|故夫|焉哉乎也)/g;",
    "const hits = [];",
    "for (let i = 0; i < lines.length; i++) {",
    "  const m = lines[i].match(awkward);",
    "  if (m) hits.push({ line: i + 1, sample: lines[i].slice(0, 120), matches: m });",
    "}",
    "console.log(JSON.stringify({",
    "  lineCount: lines.length,",
    "  byteHint: String(FILE_CONTENT).length,",
    "  first: lines.slice(0, N),",
    "  last: lines.slice(-N),",
    "  awkwardHits: hits.slice(0, 50)",
    "}, null, 2));",
  ].join("\n");
}

/**
 * Filled deny reason with a runnable use_tool example (no schema invention needed).
 * @param {string} absPath
 * @param {{ size: number, paginated?: boolean }} meta
 * @returns {string}
 */
export function buildGrokLargeReadDenyReason(absPath, meta) {
  const size = meta?.size ?? 0;
  const paginated = Boolean(meta?.paginated);
  const why = paginated
    ? `Paginated read_file (offset/limit) is blocked for files > ${GROK_READ_PAGINATION_DENY_BYTES} bytes (this file is ${size} bytes). Do NOT chunk the same path with another read_file.`
    : `Large read_file is blocked for files > ${GROK_READ_HARD_DENY_BYTES} bytes (this file is ${size} bytes). Do NOT retry read_file or paginate with offset/limit.`;

  const example = {
    path: absPath,
    language: "javascript",
    code: grokExecuteFileStarterCode(),
  };

  return [
    `context-mode (Grok): ${why}`,
    "",
    "You MUST call use_tool next (NOT another read_file):",
    "1) search_tool(\"ctx_execute_file\")",
    "2) Then immediately:",
    "",
    `use_tool("context-mode__ctx_execute_file", ${JSON.stringify(example)})`,
    "",
    "FILE_CONTENT is pre-loaded in the sandbox; only console.log output enters context.",
  ].join("\n");
}

/**
 * Decide whether to hard-deny a Grok read_file / Read.
 * Returns { action:"deny", reason } or null (passthrough).
 *
 * @param {string} toolName
 * @param {Record<string, unknown>} toolInput
 * @param {string} [projectDir]
 * @returns {{ action: "deny", reason: string } | null}
 */
export function grokLargeReadGate(toolName, toolInput, projectDir) {
  if (!READ_TOOL_NAMES.has(toolName)) return null;

  const raw = getGrokReadPath(toolInput);
  if (!raw) return null;

  const absPath = resolveGrokReadPath(raw, projectDir);
  let size;
  try {
    const st = statSync(absPath);
    if (!st.isFile()) return null;
    size = st.size;
  } catch {
    return null;
  }

  const paginated = hasReadPagination(toolInput);
  const hardLarge = size > GROK_READ_HARD_DENY_BYTES;
  const hardPaginated = paginated && size > GROK_READ_PAGINATION_DENY_BYTES;

  if (!hardLarge && !hardPaginated) return null;

  return {
    action: "deny",
    reason: buildGrokLargeReadDenyReason(absPath, {
      size,
      // Prefer pagination-specific wording whenever pagination was used past the chunk gate.
      paginated: hardPaginated,
    }),
  };
}
