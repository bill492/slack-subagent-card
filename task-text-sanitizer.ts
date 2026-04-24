const DEFAULT_MAX_CHARS = 300;
const INTERNAL_TASK_MARKERS = [
  "<openclaw_runtime_context",
  "</openclaw_runtime_context>",
  "OpenClaw runtime context (internal):",
  "OpenClaw internal task context:",
  "[Internal task completion event]",
  "Keep internal details private.",
];

export function sanitizeTaskText(
  value: unknown,
  opts: { errorContext?: boolean; maxChars?: number } = {},
): string | undefined {
  const raw = asNonEmptyString(value);
  if (!raw) return undefined;

  let text = stripInlineInternalTaskContext(raw);
  for (const marker of INTERNAL_TASK_MARKERS) {
    const markerIndex = text.indexOf(marker);
    if (markerIndex >= 0) {
      text = text.slice(0, markerIndex);
    }
  }

  text = text
    .split(/\r?\n/)
    .filter((line) => !isInternalTaskLine(line, opts.errorContext ?? false))
    .join(" ")
    .replace(/\bAuthorization\s*:\s*(?:Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "Authorization: [redacted]")
    .replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/gi, "https://[redacted]@")
    .replace(/\b(?:[A-Za-z]:)?(?:\/[\w .@-]+){2,}(?::\d+:\d+|:\d+)?/g, "[path]")
    .replace(
      /\b[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|API_KEY|ACCESS_KEY|PRIVATE_KEY|PASSWORD)[A-Za-z0-9_]*\s*=\s*["']?[^"',}\s]+["']?/gi,
      "[redacted]",
    )
    .replace(
      /(["']?(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^"',}\s]+)/gi,
      "$1[redacted]",
    )
    .replace(/\b(?:Bearer|token|api[_-]?key|secret)\s*[:=]?\s+[A-Za-z0-9._~+/=-]{12,}/gi, "[redacted]")
    .replace(/\b(?:xox[baprs]-|sk-[A-Za-z0-9_-]*|ghp_|github_pat_|glpat-)[A-Za-z0-9._~+/=-]{8,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();

  return text ? truncate(text, opts.maxChars ?? DEFAULT_MAX_CHARS) : undefined;
}

function stripInlineInternalTaskContext(value: string): string {
  const beginMarkers = ["<openclaw_runtime_context", "OpenClaw runtime context (internal):"];
  for (const marker of beginMarkers) {
    const beginIndex = value.indexOf(marker);
    if (
      beginIndex !== -1 &&
      (value.includes("</openclaw_runtime_context>") ||
        value.includes("Keep internal details private.") ||
        value.includes("[Internal task completion event]"))
    ) {
      return value.slice(0, beginIndex);
    }
  }
  return value;
}

function isInternalTaskLine(line: string, errorContext: boolean): boolean {
  const trimmed = line.trim();
  if (/^source:\s*(subagent|task|cron)\b/i.test(trimmed)) return true;
  if (/^(sessionKey|requesterSessionKey|childSessionKey|runId|taskId|ownerKey):/i.test(trimmed)) return true;
  if (errorContext && /^(at\s+\S+\s+\(|at\s+file:\/\/|Caused by:)/.test(trimmed)) return true;
  return false;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
