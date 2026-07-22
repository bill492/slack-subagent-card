import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export { sanitizeTaskText } from "./task-text-sanitizer.js";

export type Outcome = "ok" | "error" | "timeout" | "killed" | "reset" | "deleted";
export type Mode = "run" | "session";
export type SlackTaskStatus = "pending" | "in_progress" | "complete" | "error";

type BoundTaskRunsRuntime = ReturnType<
  OpenClawPluginApi["runtime"]["tasks"]["runs"]["bindSession"]
>;

/** Host-owned task detail returned by the supported plugin runtime API. */
export type TaskRunDetail = NonNullable<ReturnType<BoundTaskRunsRuntime["resolve"]>>;
export type TaskRunStatus = TaskRunDetail["status"];

export const BLOCK_TEXT_MAX_CHARS = 300;
const TERMINAL_TASK_STATUSES = new Set<TaskRunStatus>([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "lost",
]);
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
  return {
    statusText: taskStatusToStatusText(params.task?.status) ?? "⏳ SubAgent Running",
    detail: buildRunningDetail(params.mode),
    outputText: buildRunningOutput(params.mode),
    taskId: params.task?.id ?? params.runId,
    slackTaskStatus: taskStatusToSlackTaskStatus(params.task?.status) ?? "in_progress",
  };
}

export function buildTerminalContent(params: {
  task?: TaskRunDetail;
  runId: string;
  outcome: Outcome;
  elapsedText: string;
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
  const effectiveOutcome = taskStatusToOutcome(terminalTaskStatus) ?? params.outcome;
  const detail = buildTerminalDetail({
    outcome: effectiveOutcome,
    elapsedText: params.elapsedText,
  });
  const outputText = buildTerminalOutput({
    outcome: effectiveOutcome,
    mode: params.mode,
  });

  return {
    statusText: taskStatusToStatusText(terminalTaskStatus) ?? outcomeToStatus(effectiveOutcome),
    detail,
    outputText,
    outcome: effectiveOutcome,
    taskId: params.task?.id ?? params.runId,
    slackTaskStatus: taskStatusToSlackTaskStatus(terminalTaskStatus) ?? outcomeToSlackTaskStatus(effectiveOutcome),
    usedTerminalTaskSignal: Boolean(terminalTaskStatus),
  };
}

export function hasTerminalTaskSignal(task: TaskRunDetail | undefined): boolean {
  return isTerminalTaskStatus(task?.status);
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

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
