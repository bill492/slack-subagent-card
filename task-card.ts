import { sanitizeTaskText } from "./task-text-sanitizer.js";

export type Outcome = "ok" | "error" | "timeout" | "killed" | "reset" | "deleted";
export type Mode = "run" | "session";
export type TaskRunStatus = "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "lost";
export type SlackTaskStatus = "pending" | "in_progress" | "complete" | "error";

export type TaskRunDetail = {
  id: string;
  runId?: string;
  title: string;
  label?: string;
  status: TaskRunStatus;
  deliveryStatus?: string;
  notifyPolicy?: string;
  progressSummary?: string;
  terminalSummary?: string;
  error?: string;
  publicProgressSummary?: string;
  publicTerminalSummary?: string;
  publicError?: string;
  redactedProgressSummary?: string;
  redactedTerminalSummary?: string;
  redactedError?: string;
  terminalOutcome?: string;
};

export const BLOCK_TEXT_MAX_CHARS = 300;
export { sanitizeTaskText };

const TERMINAL_TASK_STATUSES = new Set<TaskRunStatus>([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "lost",
]);
const FAILURE_TASK_STATUSES = new Set<TaskRunStatus>(["failed", "timed_out", "cancelled", "lost"]);
const TASK_STATUS_TEXT: Partial<Record<TaskRunStatus, string>> = {
  queued: "🟡 Queued",
  running: "⏳ SubAgent Running",
  succeeded: "✅ Completed",
  failed: "❌ Failed",
  timed_out: "⏱️ Timed out",
  cancelled: "⚪ Cancelled",
  lost: "⚠️ Lost",
};
const TASK_STATUS_TO_SLACK_STATUS: Partial<Record<TaskRunStatus, SlackTaskStatus>> = {
  queued: "pending",
  running: "in_progress",
  succeeded: "complete",
  failed: "error",
  timed_out: "error",
  cancelled: "error",
  lost: "error",
};
const TASK_STATUS_TO_OUTCOME: Partial<Record<TaskRunStatus, Outcome>> = {
  succeeded: "ok",
  failed: "error",
  timed_out: "timeout",
  cancelled: "error",
  lost: "error",
};

export function buildRunningContent(params: {
  task?: TaskRunDetail;
  runId: string;
  mode?: Mode;
}): {
  statusText: string;
  detail: string;
  outputText: string;
  taskId: string;
  slackTaskStatus: SlackTaskStatus;
} {
  const progressSummary = publicTaskText(params.task, "progressSummary");
  return {
    statusText: taskStatusToStatusText(params.task?.status) ?? "⏳ SubAgent Running",
    detail: progressSummary ?? buildRunningDetail(params.mode),
    outputText:
      buildTaskMetadata(params.task, params.runId, { status: params.task?.status }) ??
      buildRunningOutput(params.mode),
    taskId: params.task?.id ?? params.runId,
    slackTaskStatus: taskStatusToSlackTaskStatus(params.task?.status) ?? "in_progress",
  };
}

export function buildTerminalContent(params: {
  task?: TaskRunDetail;
  runId: string;
  outcome: Outcome;
  elapsedText: string;
  detail?: string;
  mode?: Mode;
}): {
  statusText: string;
  detail: string;
  outputText?: string;
  outcome: Outcome;
  taskId: string;
  slackTaskStatus: SlackTaskStatus;
  usedTerminalTaskSignal: boolean;
} {
  const terminalTaskStatus = isTerminalTaskStatus(params.task?.status) ? params.task?.status : undefined;
  const sanitizedDetail = sanitizeTaskText(params.detail, { errorContext: params.outcome !== "ok" });
  const resolvedSummary = resolveTaskSummary(params.task, {
    preferError: isFailureTaskStatus(terminalTaskStatus) || params.outcome === "error" || params.outcome === "timeout",
    outcome: params.outcome,
  });
  const summary = resolvedSummary?.text ?? sanitizedDetail;
  const detail =
    summary ??
    buildTerminalDetail({
      outcome: params.outcome,
      elapsedText: params.elapsedText,
    });
  const metadata = buildTaskMetadata(params.task, params.runId, { status: terminalTaskStatus });
  const outputText = summary
    ? metadata
    : buildTerminalOutput({
        outcome: params.outcome,
        mode: params.mode,
      });

  return {
    statusText: taskStatusToStatusText(terminalTaskStatus) ?? outcomeToStatus(params.outcome),
    detail,
    outputText,
    outcome: taskStatusToOutcome(terminalTaskStatus) ?? params.outcome,
    taskId: params.task?.id ?? params.runId,
    slackTaskStatus: taskStatusToSlackTaskStatus(terminalTaskStatus) ?? outcomeToSlackTaskStatus(params.outcome),
    usedTerminalTaskSignal:
      Boolean(terminalTaskStatus) ||
      resolvedSummary?.source === "terminalSummary" ||
      (resolvedSummary?.source === "error" &&
        (isFailureTaskStatus(terminalTaskStatus) || params.outcome === "error" || params.outcome === "timeout")) ||
      Boolean(sanitizedDetail),
  };
}

export function hasTerminalTaskSignal(task: TaskRunDetail | undefined): boolean {
  return (
    isTerminalTaskStatus(task?.status) ||
    Boolean(publicTaskText(task, "terminalSummary")) ||
    Boolean(publicTaskText(task, "error", { errorContext: true, requireTerminalFailure: true }))
  );
}

function outcomeToSlackTaskStatus(outcome: Outcome | undefined): SlackTaskStatus {
  switch (outcome) {
    case "ok":
      return "complete";
    case "error":
    case "timeout":
    case "killed":
    case "reset":
    case "deleted":
      return "error";
    default:
      return "in_progress";
  }
}

function resolveTaskSummary(
  task: TaskRunDetail | undefined,
  opts: { preferError?: boolean; outcome?: Outcome } = {},
): { text: string; source: "terminalSummary" | "progressSummary" | "error" } | undefined {
  const error = publicTaskText(task, "error", {
    errorContext: true,
    requireTerminalFailure: !(opts.outcome === "error" || opts.outcome === "timeout"),
  });
  const terminalSummary = publicTaskText(task, "terminalSummary", {
    errorContext: isFailureTaskStatus(task?.status),
  });
  const progressSummary = publicTaskText(task, "progressSummary");

  if (opts.preferError) {
    if (error) return { text: error, source: "error" };
    if (terminalSummary) return { text: terminalSummary, source: "terminalSummary" };
    if (progressSummary) return { text: progressSummary, source: "progressSummary" };
    return undefined;
  }

  if (terminalSummary) return { text: terminalSummary, source: "terminalSummary" };
  if (progressSummary) return { text: progressSummary, source: "progressSummary" };
  if (error) return { text: error, source: "error" };
  return undefined;
}

function publicTaskText(
  task: TaskRunDetail | undefined,
  field: "progressSummary" | "terminalSummary" | "error",
  opts: { errorContext?: boolean; requireTerminalFailure?: boolean } = {},
): string | undefined {
  if (!task) return undefined;
  if (opts.requireTerminalFailure && !isFailureTaskStatus(task.status)) return undefined;

  const prefix = field === "progressSummary" ? "ProgressSummary" : field === "terminalSummary" ? "TerminalSummary" : "Error";
  const value =
    task[`public${prefix}` as keyof TaskRunDetail] ??
    task[`redacted${prefix}` as keyof TaskRunDetail];
  return sanitizeTaskText(value, { errorContext: opts.errorContext, maxChars: BLOCK_TEXT_MAX_CHARS });
}

function buildTaskMetadata(
  task: TaskRunDetail | undefined,
  runId: string,
  overrides: { status?: TaskRunStatus } = {},
): string | undefined {
  if (!task) return undefined;

  const parts = [
    `Task ${shortId(task.id)}`,
    `run ${shortId(task.runId ?? runId)}`,
    overrides.status ? `status ${overrides.status}` : undefined,
    task.deliveryStatus ? `delivery ${task.deliveryStatus}` : undefined,
    task.notifyPolicy ? `notify ${task.notifyPolicy}` : undefined,
  ].filter((part): part is string => Boolean(part));

  return truncate(parts.join(" · "), BLOCK_TEXT_MAX_CHARS);
}

function buildRunningDetail(mode?: Mode): string {
  return mode === "session"
    ? "A persistent background worker session is active for this task."
    : "A background worker is actively gathering results for this task.";
}

function buildRunningOutput(mode?: Mode): string {
  return mode === "session"
    ? "You can keep chatting here while the worker session continues in the background."
    : "The main agent can keep helping here while this background run works in parallel.";
}

function buildCompletionDetail(elapsedText: string): string {
  return `Finished background work in ${elapsedText} and handed the result back to the parent agent.`;
}

function buildCompletionOutput(mode?: Mode): string {
  return mode === "session"
    ? "The parent agent can now review the result, continue the workflow, or reply in this thread."
    : "The parent agent can now review the finished run, continue the workflow, or reply in this thread.";
}

function buildTerminalDetail(params: {
  outcome: Outcome;
  elapsedText: string;
}): string {
  switch (params.outcome) {
    case "timeout":
      return `The sub-agent stopped after ${params.elapsedText} because it hit its time limit.`;
    case "killed":
      return `The sub-agent was stopped after ${params.elapsedText}.`;
    case "reset":
      return `The sub-agent session was reset after ${params.elapsedText}.`;
    case "deleted":
      return `The sub-agent session was deleted after ${params.elapsedText}.`;
    case "error":
      return `The sub-agent failed after ${params.elapsedText}.`;
    case "ok":
      return buildCompletionDetail(params.elapsedText);
  }
}

function buildTerminalOutput(params: {
  outcome: Outcome;
  mode?: Mode;
}): string | undefined {
  switch (params.outcome) {
    case "ok":
      return buildCompletionOutput(params.mode);
    case "error":
      return "The parent agent can inspect the failure, retry, or choose a different next step.";
    case "timeout":
      return "The parent agent can retry the task, break it into smaller steps, or continue with another approach.";
    case "killed":
      return "The parent agent can decide whether to restart the work or continue without it.";
    case "reset":
      return "The parent agent can recreate the worker session if this task still needs to continue.";
    case "deleted":
      return "The parent agent can start a new worker if the task still needs background processing.";
  }
}

function outcomeToStatus(outcome: Outcome): string {
  switch (outcome) {
    case "ok":
      return "✅ Completed";
    case "error":
      return "❌ Error";
    case "timeout":
      return "⏱️ Timed out";
    case "killed":
      return "🔪 Killed";
    case "reset":
      return "↩️ Reset";
    case "deleted":
      return "🗑️ Deleted";
  }
}

function taskStatusToStatusText(status: TaskRunStatus | undefined): string | undefined {
  return status ? TASK_STATUS_TEXT[status] : undefined;
}

function taskStatusToSlackTaskStatus(status: TaskRunStatus | undefined): SlackTaskStatus | undefined {
  return status ? TASK_STATUS_TO_SLACK_STATUS[status] : undefined;
}

function taskStatusToOutcome(status: TaskRunStatus | undefined): Outcome | undefined {
  return status ? TASK_STATUS_TO_OUTCOME[status] : undefined;
}

function isTerminalTaskStatus(status: TaskRunStatus | undefined): status is TaskRunStatus {
  return Boolean(status && TERMINAL_TASK_STATUSES.has(status));
}

function isFailureTaskStatus(status: TaskRunStatus | undefined): boolean {
  return Boolean(status && FAILURE_TASK_STATUSES.has(status));
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function shortId(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 12);
}
