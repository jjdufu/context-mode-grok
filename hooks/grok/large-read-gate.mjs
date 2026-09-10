/**
 * Grok-specific hard gate for large / paginated read_file on *noisy* paths.
 *
 * Session 85875e… showed blanket >8KB deny of human docs (e.g. ~31KB 方案.md)
 * forced ctx_execute_file → model dumped FILE_CONTENT via console.log →
 * 0 tokens saved + deny/search_tool/MCP tax made context *worse* than native read.
 *
 * Policy (1.0.171+):
 *   - Hard-deny ONLY compressible/noisy paths (logs, locks, jsonl, fixtures,
 *     node_modules, minified, large data). Keep size / pagination thresholds
 *     for those.
 *   - Allow native read_file (and offset/limit) for prose/source even if >8KB
 *     (style review, editing need full text).
 *   - First deny for a path: short filled use_tool example; subsequent denies
 *     for the same path in-session: one short line (marker under /tmp).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";

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

/** Human docs / typical source — never hard-gated (native read OK). */
export const GROK_READ_PASSTHROUGH_EXTS = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".rs",
  ".go",
  ".py",
  ".vue",
  ".svelte",
  ".java",
  ".kt",
  ".kts",
  ".swift",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".scala",
  ".sh",
  ".bash",
  ".zsh",
  ".toml",
  ".css",
  ".scss",
  ".less",
  ".html",
  ".htm",
  ".sql",
]);

/** Extensions that are noisy/compressible when large. */
const NOISY_EXTS = new Set([
  ".log",
  ".jsonl",
  ".ndjson",
  ".lock",
  ".map",
  ".csv",
  ".tsv",
  ".json",
  ".xml",
  ".yaml",
  ".yml",
  ".bin",
  ".dat",
  ".sqlite",
  ".db",
  ".parquet",
  ".arrow",
]);

const NOISY_BASENAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "gemfile.lock",
  "poetry.lock",
  "pipfile.lock",
]);

const NOISY_DIR_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "fixtures",
  "__fixtures__",
  ".git",
  ".next",
  "out",
  "vendor",
  "target",
  "__pycache__",
  ".turbo",
  ".cache",
]);

const DENY_MARKER_ROOT = "/tmp/context-mode-grok-deny";

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
 * True when path looks like compressible/noisy data (hard-gate candidate).
 * Passthrough prose/source extensions win over noisy basename heuristics
 * except when under a noisy directory (node_modules, dist, …).
 *
 * @param {string} absPath
 * @returns {boolean}
 */
export function isGrokHardGatePath(absPath) {
  if (!absPath) return false;
  const normalized = absPath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  const underNoisyDir = parts.some((p) => NOISY_DIR_SEGMENTS.has(p.toLowerCase()));

  const base = basename(absPath);
  const baseLower = base.toLowerCase();
  const ext = extname(base).toLowerCase();

  // Minified assets always gate
  if (baseLower.endsWith(".min.js") || baseLower.endsWith(".min.css")) return true;
  if (NOISY_BASENAMES.has(baseLower)) return true;
  if (underNoisyDir) return true;

  // Explicit passthrough for human docs / source (even if large)
  if (GROK_READ_PASSTHROUGH_EXTS.has(ext)) return false;

  if (NOISY_EXTS.has(ext)) return true;
  return false;
}

/**
 * Starter JS for ctx_execute_file — summary-only (never dump full FILE_CONTENT).
 * @returns {string}
 */
export function grokExecuteFileStarterCode() {
  return [
    "// SUMMARY ONLY — never console.log(FILE_CONTENT) or the whole file.",
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
 * @param {string} sessionId
 * @param {string} absPath
 * @returns {boolean} true if this path was already denied in this session
 */
export function wasGrokDenySeen(sessionId, absPath) {
  const sid = sanitizeSessionId(sessionId);
  const marker = denyMarkerPath(sid, absPath);
  return existsSync(marker);
}

/**
 * Mark path as denied once for this session (best-effort).
 * @param {string} sessionId
 * @param {string} absPath
 */
export function markGrokDenySeen(sessionId, absPath) {
  const sid = sanitizeSessionId(sessionId);
  const dir = `${DENY_MARKER_ROOT}/${sid}`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(denyMarkerPath(sid, absPath), absPath, "utf8");
  } catch {
    // ignore — fall back to always-long reason if /tmp unwritable
  }
}

/**
 * @param {string | undefined} sessionId
 * @returns {string}
 */
function sanitizeSessionId(sessionId) {
  const raw = (sessionId && String(sessionId).trim()) || "default";
  return raw.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "default";
}

/**
 * @param {string} sid
 * @param {string} absPath
 * @returns {string}
 */
function denyMarkerPath(sid, absPath) {
  const hash = createHash("sha256").update(absPath).digest("hex").slice(0, 24);
  return `${DENY_MARKER_ROOT}/${sid}/${hash}`;
}

/**
 * Filled deny reason. First deny for a path includes a short use_tool example;
 * subsequent denies for the same path are one short line.
 *
 * @param {string} absPath
 * @param {{ size: number, paginated?: boolean, short?: boolean }} meta
 * @returns {string}
 */
export function buildGrokLargeReadDenyReason(absPath, meta) {
  const size = meta?.size ?? 0;
  const paginated = Boolean(meta?.paginated);
  const short = Boolean(meta?.short);

  if (short) {
    return `use context-mode__ctx_execute_file on ${absPath}`;
  }

  const why = paginated
    ? `Paginated read_file blocked for noisy/large data > ${GROK_READ_PAGINATION_DENY_BYTES}B (this file ${size}B). Do not chunk with another read_file.`
    : `Large read_file blocked for noisy/compressible path > ${GROK_READ_HARD_DENY_BYTES}B (this file ${size}B). Do not retry read_file.`;

  const example = {
    path: absPath,
    language: "javascript",
    code: grokExecuteFileStarterCode(),
  };

  return [
    `context-mode (Grok): ${why}`,
    `use_tool("context-mode__ctx_execute_file", ${JSON.stringify(example)})`,
    "FILE_CONTENT is pre-loaded; console.log summary only — never dump the full file.",
  ].join("\n");
}

/**
 * Decide whether to hard-deny a Grok read_file / Read.
 * Returns { action:"deny", reason } or null (passthrough).
 *
 * @param {string} toolName
 * @param {Record<string, unknown>} toolInput
 * @param {string} [projectDir]
 * @param {string} [sessionId]
 * @returns {{ action: "deny", reason: string } | null}
 */
export function grokLargeReadGate(toolName, toolInput, projectDir, sessionId) {
  if (!READ_TOOL_NAMES.has(toolName)) return null;

  const raw = getGrokReadPath(toolInput);
  if (!raw) return null;

  const absPath = resolveGrokReadPath(raw, projectDir);
  if (!isGrokHardGatePath(absPath)) return null;

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

  const short = wasGrokDenySeen(sessionId, absPath);
  if (!short) markGrokDenySeen(sessionId, absPath);

  return {
    action: "deny",
    reason: buildGrokLargeReadDenyReason(absPath, {
      size,
      paginated: hardPaginated,
      short,
    }),
  };
}

