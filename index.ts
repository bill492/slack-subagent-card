import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { WebClient } from "@slack/web-api";

type Outcome = "ok" | "error" | "timeout" | "killed" | "reset" | "deleted";
type Mode = "run" | "session";

type Logger = {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
};

type SlackRequester = {
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string;
};

type HookContext = {
  requesterSessionKey?: string;
  childSessionKey?: string;
  runId?: string;
};

type SubagentSpawnedEvent = {
  runId?: string;
  childSessionKey?: string;
  agentId?: string;
  label?: string;
  requester?: SlackRequester;
  threadRequested?: boolean;
  mode?: Mode;
};

type SubagentEndedEvent = {
  runId?: string;
  endedAt?: number;
  outcome?: Outcome;
  error?: string;
  reason?: string;
  targetSessionKey?: string;
  targetKind?: string;
  accountId?: string;
};

type SubagentDeliveryTargetEvent = {
  childRunId?: string;
  childSessionKey?: string;
  requesterSessionKey?: string;
  requesterOrigin?: SlackRequester;
  spawnMode?: Mode;
  expectsCompletionMessage?: boolean;
};

type PluginApi = {
  logger: Logger;
  config?: {
    channels?: {
      slack?: {
        botToken?: string;
        accounts?: Record<string, { botToken?: string }>;
      };
    };
  };
  registrationMode?: string;
  on: (
    hookName: string,
    handler: (event: unknown, ctx: HookContext) => void | Promise<void>,
  ) => unknown;
};

type TrackedRun = {
  messageTs: string;
  channelId: string;
  threadTs: string;
  accountId?: string;
  startedAt: number;
  endedAt?: number;
  label: string;
  mode?: Mode;
  deliveryTargetHandled?: boolean;
};

type SharedState = {
  runs: Map<string, TrackedRun>;
  registeredApis: WeakSet<object>;
  webClients: Map<string, WebClient>;
};

type SlackThreadTarget = {
  channelId: string;
  threadTs: string;
};

const SHARED_STATE_KEY = "__slackSubagentCardSharedState";
const STALE_RUN_TTL_MS = 60 * 60 * 1000;
const CARD_TEXT_PREFIX = "Sub-agent ";
const SLACK_THREAD_RE = /^agent:[^:]+:slack:(?:channel|room|direct):([^:]+):thread:(.+)$/;
const SLACK_TOPIC_RE = /^agent:[^:]+:slack:(?:channel|room|direct):([^-]+)-topic-(.+)$/;

export default definePluginEntry({
  id: "slack-subagent-card",
  name: "Slack Subagent Card",
  description:
    "Posts and updates a Slack Block Kit status card for sub-agent work in Slack threads.",

  register(api) {
    const pluginApi = api as unknown as PluginApi;
    const log = pluginApi.logger;
    const shared = getSharedState();

    if (pluginApi.registrationMode !== "full") return;
    if (shared.registeredApis.has(api)) return;
    shared.registeredApis.add(api);

    if (!hasAnySlackBotToken(pluginApi)) {
      shared.registeredApis.delete(api);
      log.warn("slack-subagent-card: no Slack bot token found; plugin disabled");
      return;
    }

    pluginApi.on("subagent_spawned", async (event, ctx) => {
      try {
        await handleSpawned(pluginApi, shared, event as SubagentSpawnedEvent, ctx);
      } catch (error) {
        log.warn(`slack-subagent-card: subagent_spawned failed: ${stringifyError(error)}`);
      }
    });

    pluginApi.on("subagent_ended", async (event, ctx) => {
      try {
        await handleEnded(pluginApi, shared, event as SubagentEndedEvent, ctx);
      } catch (error) {
        log.warn(`slack-subagent-card: subagent_ended failed: ${stringifyError(error)}`);
      }
    });

    pluginApi.on("subagent_delivery_target", async (event, ctx) => {
      try {
        await handleDeliveryTarget(pluginApi, shared, event as SubagentDeliveryTargetEvent, ctx);
      } catch (error) {
        log.warn(`slack-subagent-card: subagent_delivery_target failed: ${stringifyError(error)}`);
      }
    });

    log.info("slack-subagent-card plugin registered");
  },
});

async function handleSpawned(
  api: PluginApi,
  shared: SharedState,
  event: SubagentSpawnedEvent,
  ctx: HookContext,
): Promise<void> {
  const runId = asNonEmptyString(event.runId ?? ctx.runId);
  if (!runId) return;

  const requesterSessionKey = asNonEmptyString(ctx.requesterSessionKey);
  if (!requesterSessionKey) return;

  const web = resolveSlackWebClient(api, shared, event.requester?.accountId);
  if (!web) return;

  cleanupStaleRuns(shared, api.logger);

  const target = await resolveSlackThreadTarget(requesterSessionKey, event.requester, web, api.logger);
  if (!target) {
    api.logger.debug?.(
      `slack-subagent-card: no Slack thread target for runId=${runId} requesterSessionKey=${requesterSessionKey}`,
    );
    return;
  }

  const label = asNonEmptyString(event.label) ?? asNonEmptyString(event.agentId) ?? runId;

  const cardTitle = truncate(label, 80);

  const sent = await withSlackRetry(
    () =>
      web.chat.postMessage({
        channel: target.channelId,
        thread_ts: target.threadTs,
        text: `${CARD_TEXT_PREFIX}${cardTitle}: SubAgent Running`,
        blocks: buildBlocks({
          label: cardTitle,
          statusText: "⏳ SubAgent Running",
          detail: buildRunningDetail(event.mode),
          outputText: buildRunningOutput(event.mode),
          taskId: runId,
        }) as any,
      }),
    api.logger,
  );

  const messageTs = asNonEmptyString((sent as any)?.ts) ?? asNonEmptyString((sent as any)?.message?.ts);
  if (!messageTs) {
    api.logger.warn(`slack-subagent-card: postMessage returned no ts for runId=${runId}; skipping tracking`);
    return;
  }

  shared.runs.set(runId, {
    messageTs,
    channelId: target.channelId,
    threadTs: target.threadTs,
    accountId: asNonEmptyString(event.requester?.accountId),
    startedAt: Date.now(),
    label: cardTitle,
    mode: event.mode,
  });

  api.logger.debug?.(
    `slack-subagent-card: posted card for runId=${runId} channel=${target.channelId} thread=${target.threadTs}`,
  );
}

async function handleDeliveryTarget(
  api: PluginApi,
  shared: SharedState,
  event: SubagentDeliveryTargetEvent,
  ctx: HookContext,
): Promise<void> {
  if (!event.expectsCompletionMessage) return;

  const runId = asNonEmptyString(event.childRunId ?? ctx.runId);
  if (!runId) return;

  const tracked = shared.runs.get(runId);
  if (!tracked) return;

  const web = resolveSlackWebClient(
    api,
    shared,
    asNonEmptyString(event.requesterOrigin?.accountId) ?? tracked.accountId,
  );
  if (!web) return;

  tracked.endedAt = Date.now();
  tracked.deliveryTargetHandled = true;

  const elapsedText = formatElapsed(Math.max(0, tracked.endedAt - tracked.startedAt));

  try {
    await withSlackRetry(
      () =>
        web.chat.update({
          channel: tracked.channelId,
          ts: tracked.messageTs,
          text: `${CARD_TEXT_PREFIX}${tracked.label}: ✅ Completed`,
          blocks: buildBlocks({
            label: tracked.label,
            statusText: "✅ Completed",
            elapsedText,
            detail: buildCompletionDetail(elapsedText),
            outputText: buildCompletionOutput(tracked.mode),
            outcome: "ok",
            taskId: runId,
          }) as any,
        }),
      api.logger,
    );
  } catch (error) {
    api.logger.warn(
      `slack-subagent-card: early completion update failed for runId=${runId}: ${stringifyError(error)}`,
    );
  }
}

async function handleEnded(
  api: PluginApi,
  shared: SharedState,
  event: SubagentEndedEvent,
  ctx: HookContext,
): Promise<void> {
  const runId = asNonEmptyString(event.runId ?? ctx.runId);
  if (!runId) return;

  const tracked = shared.runs.get(runId);
  if (!tracked) {
    api.logger.debug?.(`slack-subagent-card: handleEnded missing tracked runId=${runId}`);
    return;
  }

  const web = resolveSlackWebClient(api, shared, asNonEmptyString(event.accountId) ?? tracked.accountId);
  if (!web) {
    cleanupTrackedRun(shared, runId);
    return;
  }

  const outcome = normalizeOutcome(event.outcome);
  if (tracked.deliveryTargetHandled && outcome === "ok") {
    cleanupTrackedRun(shared, runId);
    return;
  }

  tracked.endedAt = asFiniteNumber(event.endedAt) ?? Date.now();

  const elapsedText = formatElapsed(Math.max(0, tracked.endedAt - tracked.startedAt));
  const statusText = outcomeToStatus(outcome);
  const detail =
    outcome === "error"
      ? asNonEmptyString(event.error)
      : outcome === "reset" || outcome === "deleted"
        ? asNonEmptyString(event.reason)
        : undefined;
  const outputText = buildTerminalOutput({
    outcome,
    elapsedText,
    detail,
    mode: tracked.mode,
  });

  try {
    await withSlackRetry(
      () =>
        web.chat.update({
          channel: tracked.channelId,
          ts: tracked.messageTs,
          text: `${CARD_TEXT_PREFIX}${tracked.label}: ${statusText}`,
          blocks: buildBlocks({
            label: tracked.label,
            statusText,
            elapsedText,
            detail: buildTerminalDetail({ outcome, detail, elapsedText }),
            outputText,
            outcome,
            taskId: runId,
          }) as any,
        }),
      api.logger,
    );
  } catch (error) {
    api.logger.warn(
      `slack-subagent-card: terminal card update failed for runId=${runId}: ${stringifyError(error)}`,
    );
  } finally {
    cleanupTrackedRun(shared, runId);
  }
}

function buildBlocks(params: {
  label: string;
  statusText: string;
  elapsedText?: string;
  detail?: string;
  outputText?: string;
  outcome?: Outcome;
  taskId?: string;
}): Array<Record<string, unknown>> {
  let taskStatus = "in_progress";
  if (params.outcome === "ok") taskStatus = "complete";
  else if (params.outcome === "error" || params.outcome === "timeout" || params.outcome === "killed") {
    taskStatus = "failed";
  } else if (params.outcome === "reset" || params.outcome === "deleted") {
    taskStatus = "failed";
  }

  const titleParts = [params.label];
  if (params.elapsedText) titleParts.push(`(${params.elapsedText})`);

  const task: Record<string, unknown> = {
    task_id: params.taskId ?? "subagent_1",
    title: titleParts.join(" "),
    status: taskStatus,
  };

  if (params.detail) {
    task.details = toRichText(truncate(params.detail, 300));
  }

  if (params.outputText) {
    task.output = toRichText(truncate(params.outputText, 300));
  }

  return [
    {
      type: "plan",
      title: params.statusText,
      tasks: [task],
    },
  ];
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
  detail?: string;
  elapsedText: string;
}): string {
  if (params.detail) return params.detail;

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
  elapsedText: string;
  detail?: string;
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

function toRichText(text: string): Record<string, unknown> {
  return {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_section",
        elements: [{ type: "text", text }],
      },
    ],
  };
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

function normalizeOutcome(value: unknown): Outcome {
  return value === "error" ||
    value === "timeout" ||
    value === "killed" ||
    value === "reset" ||
    value === "deleted"
    ? value
    : "ok";
}

async function resolveSlackThreadTarget(
  requesterSessionKey: string,
  requester: SlackRequester | undefined,
  web: WebClient,
  log: Logger,
): Promise<SlackThreadTarget | null> {
  const fromSession = parseSlackThreadSessionKey(requesterSessionKey);
  if (fromSession) {
    // For DM sessions the captured ID is a user ID (U...), not a DM channel (D...).
    // Slack's chat.postMessage needs the D-prefixed channel ID for thread replies.
    if (/^U/i.test(fromSession.channelId)) {
      const resolved = await resolveUserToDmChannel(web, fromSession.channelId, log);
      if (!resolved) return null;
      return { channelId: resolved, threadTs: fromSession.threadTs };
    }
    return fromSession;
  }

  const rawTarget = asNonEmptyString(requester?.to);
  const threadTs = asNonEmptyString(requester?.threadId);
  if (!rawTarget || !threadTs) return null;

  let channelId = normalizeSlackChannelId(stripSlackTargetPrefix(rawTarget));
  if (/^U/i.test(channelId)) {
    const resolved = await resolveUserToDmChannel(web, channelId, log);
    if (!resolved) return null;
    channelId = resolved;
  }

  return { channelId, threadTs };
}

function parseSlackThreadSessionKey(sessionKey: string): SlackThreadTarget | null {
  const threadMatch = sessionKey.match(SLACK_THREAD_RE);
  if (threadMatch) {
    return {
      channelId: normalizeSlackChannelId(threadMatch[1]),
      threadTs: threadMatch[2],
    };
  }

  const topicMatch = sessionKey.match(SLACK_TOPIC_RE);
  if (topicMatch) {
    return {
      channelId: normalizeSlackChannelId(topicMatch[1]),
      threadTs: topicMatch[2],
    };
  }

  return null;
}

function stripSlackTargetPrefix(value: string): string {
  return value.replace(/^(channel:|room:)/i, "");
}

function hasAnySlackBotToken(api: PluginApi): boolean {
  return Boolean(
    asNonEmptyString(api.config?.channels?.slack?.botToken) ??
      asNonEmptyString(api.config?.channels?.slack?.accounts?.default?.botToken) ??
      Object.values(api.config?.channels?.slack?.accounts ?? {}).find((account) =>
        asNonEmptyString(account?.botToken),
      )?.botToken ??
      asNonEmptyString(process.env.SLACK_BOT_TOKEN),
  );
}

function resolveSlackBotToken(api: PluginApi, accountId?: string): string | undefined {
  const normalizedAccountId = asNonEmptyString(accountId);
  return (
    (normalizedAccountId
      ? asNonEmptyString(api.config?.channels?.slack?.accounts?.[normalizedAccountId]?.botToken)
      : undefined) ??
    asNonEmptyString(api.config?.channels?.slack?.botToken) ??
    asNonEmptyString(api.config?.channels?.slack?.accounts?.default?.botToken) ??
    asNonEmptyString(process.env.SLACK_BOT_TOKEN)
  );
}

function resolveSlackWebClient(
  api: PluginApi,
  shared: SharedState,
  accountId?: string,
): WebClient | undefined {
  const token = resolveSlackBotToken(api, accountId);
  if (!token) {
    api.logger.warn(
      `slack-subagent-card: no Slack bot token found for accountId=${accountId ?? "default"}; skipping`,
    );
    return undefined;
  }
  const cached = shared.webClients.get(token);
  if (cached) return cached;
  const client = new WebClient(token);
  shared.webClients.set(token, client);
  return client;
}

async function withSlackRetry<T>(
  fn: () => Promise<T>,
  log: Pick<Logger, "warn">,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const retryAfterSec = getRetryAfterSeconds(error);
    if (!retryAfterSec) throw error;

    log.warn(`slack-subagent-card: hit Slack rate limit, retrying in ${retryAfterSec}s`);
    await sleep(retryAfterSec * 1000);
    return fn();
  }
}

function getRetryAfterSeconds(error: unknown): number | undefined {
  const record = asRecord(error);
  const data = asRecord(record?.data);
  const headers = asRecord(data?.headers);
  const retryAfter =
    asFiniteNumber(data?.retryAfter) ??
    asFiniteNumber(data?.retry_after) ??
    asFiniteNumber(headers?.["retry-after"]) ??
    asFiniteNumber(record?.retryAfter);

  return retryAfter && retryAfter > 0 ? retryAfter : undefined;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return "just now";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function normalizeSlackChannelId(channelId: string): string {
  return /^[cgdu]/i.test(channelId) ? channelId.toUpperCase() : channelId;
}

/** Cache of userId → DM channelId to avoid repeated conversations.open calls */
const dmChannelCache = new Map<string, string>();

async function resolveUserToDmChannel(
  web: WebClient,
  userId: string,
  log: Logger,
): Promise<string | undefined> {
  const normalized = userId.toUpperCase();
  const cached = dmChannelCache.get(normalized);
  if (cached) return cached;

  try {
    const result = await withSlackRetry(
      () => web.conversations.open({ users: normalized, return_im: true }),
      log,
    );
    const channelId = asNonEmptyString((result as any)?.channel?.id);
    if (channelId) {
      dmChannelCache.set(normalized, channelId);
      log.info(`slack-subagent-card: resolved DM channel for ${normalized} → ${channelId}`);
      return channelId;
    }
    log.warn(`slack-subagent-card: conversations.open returned no channel for ${normalized}`);
    return undefined;
  } catch (error) {
    log.warn(`slack-subagent-card: failed to resolve DM channel for ${normalized}: ${stringifyError(error)}`);
    return undefined;
  }
}

function cleanupStaleRuns(shared: SharedState, log: Logger): void {
  const cutoff = Date.now() - STALE_RUN_TTL_MS;
  for (const [runId, tracked] of shared.runs.entries()) {
    if (tracked.startedAt >= cutoff) continue;
    shared.runs.delete(runId);
    log.debug?.(`slack-subagent-card: swept stale tracked runId=${runId}`);
  }
}

function cleanupTrackedRun(shared: SharedState, runId: string): void {
  shared.runs.delete(runId);
}

function getSharedState(): SharedState {
  const scope = globalThis as typeof globalThis & {
    [SHARED_STATE_KEY]?: SharedState;
  };

  if (!scope[SHARED_STATE_KEY]) {
    scope[SHARED_STATE_KEY] = {
      runs: new Map(),
      registeredApis: new WeakSet(),
      webClients: new Map(),
    };
  }

  return scope[SHARED_STATE_KEY]!;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
