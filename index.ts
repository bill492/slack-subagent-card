import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { WebClient } from "@slack/web-api";
import { createSlackWebClient } from "openclaw/plugin-sdk/slack";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

type Outcome = "ok" | "error" | "timeout" | "killed";
type Mode = "run" | "session";
type TimerHandle = ReturnType<typeof setTimeout>;

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
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
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

type AgentEndEvent = {
  success?: boolean;
  error?: string;
  durationMs?: number;
  messages?: unknown[];
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
    plugins?: {
      entries?: Record<string, { config?: Record<string, unknown> }>;
    };
  };
  pluginConfig?: Record<string, unknown>;
  registrationMode?: string;
  runtime?: {
    system?: {
      requestHeartbeatNow?: (opts?: { reason?: string; sessionKey?: string }) => unknown;
      enqueueSystemEvent?: (text: string, opts?: { sessionKey?: string; contextKey?: string }) => unknown;
    };
    state?: {
      resolveStateDir?: (config?: unknown) => string;
    };
  };
  on: (
    hookName: string,
    handler: (event: unknown, ctx: HookContext) => void | Promise<void>,
  ) => unknown;
};

type TrackedRun = {
  messageTs: string;
  channelId: string;
  threadTs: string;
  startedAt: number;
  endedAt?: number;
  label: string;
  requesterSessionKey: string;
  nudgeTimer?: TimerHandle;
  deliveryTargetHandled?: boolean;
};

type SharedState = {
  runs: Map<string, TrackedRun>;
  registeredApis: WeakSet<object>;
  pluginBotId?: string;
};

type SlackThreadTarget = {
  channelId: string;
  threadTs: string;
};

const SHARED_STATE_KEY = "__slackSubagentCardSharedState";
const DEFAULT_NUDGE_DELAY_SEC = 30;
const MIN_NUDGE_DELAY_SEC = 10;
const MAX_NUDGE_DELAY_SEC = 300;
const STALE_RUN_TTL_MS = 60 * 60 * 1000;
const NUDGE_TEXT_PREFIX = "⏰ Sub-agent ";
const CARD_TEXT_PREFIX = "Sub-agent ";
const SLACK_THREAD_RE = /^agent:[^:]+:slack:(?:channel|room|direct):([^:]+):thread:(.+)$/;
const SLACK_TOPIC_RE = /^agent:[^:]+:slack:(?:channel|room|direct):([^-]+)-topic-(.+)$/;
const SUBAGENT_KEY_RE = /^agent:([^:]+):subagent:([0-9a-f-]+)$/;

export default definePluginEntry({
  id: "slack-subagent-card",
  name: "Slack Subagent Card",
  description:
    "Posts a Block Kit status card for thread-bound sub-agents and nudges the parent session if no follow-up appears.",

  register(api) {
    const pluginApi = api as unknown as PluginApi;
    const log = pluginApi.logger;
    const shared = getSharedState();

    if (pluginApi.registrationMode !== "full") return;
    if (shared.registeredApis.has(api)) return;
    shared.registeredApis.add(api);

    const token = resolveSlackBotToken(pluginApi);
    if (!token) {
      shared.registeredApis.delete(api);
      log.warn("slack-subagent-card: no Slack bot token found; plugin disabled");
      return;
    }

    const web = createSlackWebClient(token);

    log.info(`slack-subagent-card: registering hooks (registrationMode=${pluginApi.registrationMode}, typeof api.on=${typeof pluginApi.on})`);

    pluginApi.on("subagent_spawned", async (event, ctx) => {
      try {
        log.info(`slack-subagent-card: subagent_spawned fired — runId=${(event as SubagentSpawnedEvent).runId ?? ctx.runId} requesterSessionKey=${ctx.requesterSessionKey} threadRequested=${(event as SubagentSpawnedEvent).threadRequested} requester=${JSON.stringify((event as SubagentSpawnedEvent).requester)}`);
        await handleSpawned(pluginApi, web, shared, event as SubagentSpawnedEvent, ctx);
      } catch (error) {
        log.warn(`slack-subagent-card: subagent_spawned failed: ${stringifyError(error)}`);
      }
    });

    pluginApi.on("subagent_ended", async (event, ctx) => {
      try {
        log.info(`slack-subagent-card: subagent_ended fired — runId=${(event as SubagentEndedEvent).runId ?? ctx.runId} outcome=${(event as SubagentEndedEvent).outcome}`);
        await handleEnded(pluginApi, web, shared, event as SubagentEndedEvent, ctx);
      } catch (error) {
        log.warn(`slack-subagent-card: subagent_ended failed: ${stringifyError(error)}`);
      }
    });

    pluginApi.on("subagent_delivery_target", async (event, ctx) => {
      try {
        log.info(`slack-subagent-card: subagent_delivery_target fired — runId=${(event as SubagentDeliveryTargetEvent).childRunId ?? ctx.runId}, updating card early`);
        await handleDeliveryTarget(pluginApi, web, shared, event as SubagentDeliveryTargetEvent, ctx);
      } catch (error) {
        log.warn(`slack-subagent-card: subagent_delivery_target failed: ${stringifyError(error)}`);
      }
    });

    pluginApi.on("agent_end", async (event, ctx) => {
      try {
        await handleAgentEnd(pluginApi, event as AgentEndEvent, ctx);
      } catch (error) {
        log.warn(`slack-subagent-card: agent_end failed: ${stringifyError(error)}`);
      }
    });

    log.info("slack-subagent-card plugin registered");
  },
});

async function handleAgentEnd(api: PluginApi, event: AgentEndEvent, ctx: HookContext): Promise<void> {
  const sessionKey = asNonEmptyString(ctx.sessionKey);
  if (!sessionKey) return;

  const match = sessionKey.match(SUBAGENT_KEY_RE);
  if (!match) return;

  const workspaceDir = asNonEmptyString(ctx.workspaceDir);
  if (!workspaceDir) return;

  const agentId = match[1];
  const fallbackLabel = match[2];
  const label = resolveSubagentLabel(api, agentId, sessionKey) ?? fallbackLabel;
  const marker = {
    label,
    sessionKey,
    sessionId: asNonEmptyString(ctx.sessionId) ?? "",
    agentId,
    completedAt: new Date().toISOString(),
    success: Boolean(event.success),
    error: event.error,
    durationMs: asFiniteNumber(event.durationMs),
    messageCount: Array.isArray(event.messages) ? event.messages.length : 0,
  };

  const resultsDir = join(workspaceDir, ".sub-agent-results");
  const filename = `${sanitizeFilenameSegment(label)}-${Date.now()}.json`;

  try {
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, filename), JSON.stringify(marker, null, 2));
    api.logger.info(`slack-subagent-card: wrote completion marker ${filename}`);
  } catch (err) {
    api.logger.warn(`slack-subagent-card: failed to write completion marker ${filename}: ${stringifyError(err)}`);
  }
}

async function handleSpawned(
  api: PluginApi,
  web: WebClient,
  shared: SharedState,
  event: SubagentSpawnedEvent,
  ctx: HookContext,
): Promise<void> {
  const runId = asNonEmptyString(event.runId ?? ctx.runId);
  if (!runId) return;

  const requesterSessionKey = asNonEmptyString(ctx.requesterSessionKey);
  if (!requesterSessionKey) return;

  cleanupStaleRuns(shared, api.logger);

  const target = await resolveSlackThreadTarget(requesterSessionKey, event.requester, web, api.logger);
  if (!target) {
    api.logger.debug?.(
      `slack-subagent-card: no Slack thread target for runId=${runId} requesterSessionKey=${requesterSessionKey}`,
    );
    return;
  }

  const label = asNonEmptyString(event.label) ?? asNonEmptyString(event.agentId) ?? runId;
  const existing = shared.runs.get(runId);
  if (existing?.nudgeTimer) clearTimeout(existing.nudgeTimer);

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
          taskId: runId,
        }) as any,
      }),
    api.logger,
  );

  capturePluginBotId(shared, sent);

  const messageTs = asNonEmptyString((sent as any)?.ts) ?? asNonEmptyString((sent as any)?.message?.ts);
  if (!messageTs) {
    api.logger.warn(`slack-subagent-card: postMessage returned no ts for runId=${runId}; skipping tracking`);
    return;
  }

  shared.runs.set(runId, {
    messageTs,
    channelId: target.channelId,
    threadTs: target.threadTs,
    startedAt: Date.now(),
    label: cardTitle,
    requesterSessionKey,
  });

  api.logger.debug?.(
    `slack-subagent-card: posted card for runId=${runId} channel=${target.channelId} thread=${target.threadTs}`,
  );
}

async function handleDeliveryTarget(
  api: PluginApi,
  web: WebClient,
  shared: SharedState,
  event: SubagentDeliveryTargetEvent,
  ctx: HookContext,
): Promise<void> {
  const runId = asNonEmptyString(event.childRunId ?? ctx.runId);
  if (!runId) return;

  const tracked = shared.runs.get(runId);
  if (!tracked) return;

  tracked.endedAt = Date.now();
  tracked.deliveryTargetHandled = true;
  startOrResetNudgeTimer(api, web, shared, tracked, runId, "ok");

  const elapsedText = formatElapsed(Math.max(0, tracked.endedAt - tracked.startedAt));

  try {
    const updated = await withSlackRetry(
      () =>
        web.chat.update({
          channel: tracked.channelId,
          ts: tracked.messageTs,
          text: `${CARD_TEXT_PREFIX}${tracked.label}: ✅ Completed`,
          blocks: buildBlocks({
            label: tracked.label,
            statusText: "✅ Completed",
            elapsedText,
            detail: `Finished in ${elapsedText}`,
            outcome: "ok",
            taskId: runId,
          }) as any,
        }),
      api.logger,
    );
    capturePluginBotId(shared, updated);
  } catch (error) {
    api.logger.warn(
      `slack-subagent-card: early completion update failed for runId=${runId}: ${stringifyError(error)}`,
    );
  }
}

async function handleEnded(
  api: PluginApi,
  web: WebClient,
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

  const outcome = normalizeOutcome(event.outcome);
  if (tracked.deliveryTargetHandled && outcome === "ok") return;

  tracked.endedAt = asFiniteNumber(event.endedAt) ?? Date.now();
  startOrResetNudgeTimer(api, web, shared, tracked, runId, outcome);

  const elapsedText = formatElapsed(Math.max(0, tracked.endedAt - tracked.startedAt));
  const statusText = outcomeToStatus(outcome);
  const detail = outcome === "error" ? asNonEmptyString(event.error) : undefined;

  try {
    const updated = await withSlackRetry(
      () =>
        web.chat.update({
          channel: tracked.channelId,
          ts: tracked.messageTs,
          text: `${CARD_TEXT_PREFIX}${tracked.label}: ${statusText}`,
          blocks: buildBlocks({
            label: tracked.label,
            statusText,
            elapsedText,
            detail,
            outcome,
            taskId: runId,
          }) as any,
        }),
      api.logger,
    );
    capturePluginBotId(shared, updated);
  } catch (error) {
    api.logger.warn(
      `slack-subagent-card: terminal card update failed for runId=${runId}: ${stringifyError(error)}`,
    );
  }
}

function startOrResetNudgeTimer(
  api: PluginApi,
  web: WebClient,
  shared: SharedState,
  tracked: TrackedRun,
  runId: string,
  outcome: Outcome,
): void {
  if (tracked.nudgeTimer) clearTimeout(tracked.nudgeTimer);

  const delayMs = resolveNudgeDelayMs(api);
  tracked.nudgeTimer = setTimeout(() => {
    void maybeSendNudge(api, web, shared, runId, outcome).catch((error) => {
      api.logger.warn(`slack-subagent-card: maybeSendNudge failed for runId=${runId}: ${stringifyError(error)}`);
    });
  }, delayMs);
  tracked.nudgeTimer.unref?.();
}

async function maybeSendNudge(
  api: PluginApi,
  web: WebClient,
  shared: SharedState,
  runId: string,
  outcome: Outcome,
): Promise<void> {
  const tracked = shared.runs.get(runId);
  if (!tracked) return;

  try {
    const endedAt = tracked.endedAt ?? Date.now();
    const replies = await withSlackRetry(
      () =>
        web.conversations.replies({
          channel: tracked.channelId,
          ts: tracked.threadTs,
          inclusive: true,
          oldest: String(endedAt / 1000),
          limit: 200,
        }),
      api.logger,
    );

    const messages = Array.isArray((replies as any)?.messages) ? ((replies as any).messages as unknown[]) : [];
    const hasFollowUp = messages.some((message) => {
      const tsMs = slackTsToMs((message as SlackMessage)?.ts);
      if (tsMs === undefined || tsMs <= endedAt) return false;
      return !isOwnPluginMessage(message as SlackMessage, tracked, shared);
    });

    if (hasFollowUp) return;

    const ageText = formatElapsed(Math.max(0, Date.now() - endedAt));
    const nudgeText = `${NUDGE_TEXT_PREFIX}*${escapeMrkdwn(tracked.label)}* finished with outcome *${outcome}* ${ageText} ago, but no response has been posted yet.`;

    const posted = await withSlackRetry(
      () =>
        web.chat.postMessage({
          channel: tracked.channelId,
          thread_ts: tracked.threadTs,
          text: nudgeText,
        }),
      api.logger,
    );

    capturePluginBotId(shared, posted);
    wakeParentSession(api, tracked, runId, outcome);
    api.logger.info(`slack-subagent-card: nudge posted for runId=${runId}`);
  } finally {
    cleanupTrackedRun(shared, runId);
  }
}

type SlackMessage = {
  ts?: string;
  text?: string;
  bot_id?: string;
  app_id?: string;
  subtype?: string;
  is_bot?: boolean;
  blocks?: Array<{ type?: string }>;
};

function isOwnPluginMessage(message: SlackMessage, tracked: TrackedRun, _shared: SharedState): boolean {
  if (asNonEmptyString(message.ts) === tracked.messageTs) return true;

  const text = asNonEmptyString(message.text) ?? "";
  if (text.startsWith(NUDGE_TEXT_PREFIX)) return true;

  const hasPlanBlock = Array.isArray(message.blocks) && message.blocks.some((block) => block?.type === "plan");
  if (hasPlanBlock && text.startsWith(`${CARD_TEXT_PREFIX}${tracked.label}:`)) return true;

  return false;
}

function wakeParentSession(api: PluginApi, tracked: TrackedRun, runId: string, outcome: Outcome): void {
  const sessionKey = tracked.requesterSessionKey;
  const contextKey = `slack-subagent-card:${runId}:pending-result`;
  const eventText =
    `WAKE UP — sub-agent "${tracked.label}" finished (outcome: ${outcome}). ` +
    `This is NOT a heartbeat. Do NOT reply HEARTBEAT_OK. ` +
    `You have a pending sub-agent result that needs to be delivered to the user. ` +
    `Your normal reply will NOT reach Slack because this wake has no inbound delivery context. ` +
    `You MUST use the message tool to post your response: ` +
    `message(action="send", channel="slack", target="${tracked.channelId}", ` +
    `threadId="${tracked.threadTs}", message="<your response>"). ` +
    `Check sessions_history or .sub-agent-results for the sub-agent output first.`;

  try {
    api.runtime?.system?.enqueueSystemEvent?.(eventText, { sessionKey, contextKey });
  } catch (error) {
    api.logger.warn(`slack-subagent-card: enqueueSystemEvent failed: ${stringifyError(error)}`);
  }

  try {
    api.runtime?.system?.requestHeartbeatNow?.({ sessionKey, reason: contextKey });
  } catch (error) {
    api.logger.debug?.(`slack-subagent-card: requestHeartbeatNow failed: ${stringifyError(error)}`);
  }
}

function buildBlocks(params: {
  label: string;
  statusText: string;
  elapsedText?: string;
  detail?: string;
  outcome?: Outcome;
  taskId?: string;
}): Array<Record<string, unknown>> {
  let taskStatus = "in_progress";
  if (params.outcome === "ok") taskStatus = "complete";
  else if (params.outcome === "error" || params.outcome === "timeout" || params.outcome === "killed") {
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
    task.output = {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_section",
          elements: [{ type: "text", text: truncate(params.detail, 300) }],
        },
      ],
    };
  }

  return [
    {
      type: "plan",
      title: params.statusText,
      tasks: [task],
    },
  ];
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
  }
}

function normalizeOutcome(value: unknown): Outcome {
  return value === "error" || value === "timeout" || value === "killed" ? value : "ok";
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

function resolveSlackBotToken(api: PluginApi): string | undefined {
  return (
    asNonEmptyString(api.config?.channels?.slack?.botToken) ??
    asNonEmptyString(api.config?.channels?.slack?.accounts?.default?.botToken) ??
    asNonEmptyString(process.env.SLACK_BOT_TOKEN)
  );
}

function resolveSubagentLabel(api: PluginApi, agentId: string, sessionKey: string): string | undefined {
  try {
    const stateDir = api.runtime?.state?.resolveStateDir?.(api.config);
    if (!stateDir) return undefined;

    const sessionsPath = join(stateDir, "agents", agentId, "sessions", "sessions.json");
    const sessions = JSON.parse(readFileSync(sessionsPath, "utf-8")) as Record<string, { label?: unknown }>;
    return asNonEmptyString(sessions?.[sessionKey]?.label);
  } catch {
    return undefined;
  }
}

function resolveNudgeDelayMs(api: PluginApi): number {
  // Check plugin config (api.pluginConfig.nudgeDelaySec)
  const fromPluginConfig = asFiniteNumber((api.pluginConfig as any)?.nudgeDelaySec);
  if (fromPluginConfig !== undefined) {
    const clamped = Math.max(MIN_NUDGE_DELAY_SEC, Math.min(MAX_NUDGE_DELAY_SEC, fromPluginConfig));
    return clamped * 1000;
  }

  // Legacy: check plugins.entries.slack-subagent-card.config.nudgeDelaySec
  const fromEntries = asFiniteNumber(
    api.config?.plugins?.entries?.["slack-subagent-card"]?.config?.nudgeDelaySec
  );
  if (fromEntries !== undefined) {
    const clamped = Math.max(MIN_NUDGE_DELAY_SEC, Math.min(MAX_NUDGE_DELAY_SEC, fromEntries));
    return clamped * 1000;
  }

  // Env var fallback
  const fromEnv = asFiniteNumber(process.env.SUBAGENT_NUDGE_DELAY_SEC);
  if (fromEnv !== undefined) {
    const clamped = Math.max(MIN_NUDGE_DELAY_SEC, Math.min(MAX_NUDGE_DELAY_SEC, fromEnv));
    return clamped * 1000;
  }

  return DEFAULT_NUDGE_DELAY_SEC * 1000;
}

function sanitizeFilenameSegment(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return cleaned || "subagent";
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

function slackTsToMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value * 1000;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed * 1000 : undefined;
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

function escapeMrkdwn(value: string): string {
  return value.replace(/[&<>]/g, (ch) => {
    if (ch === "&") return "&amp;";
    if (ch === "<") return "&lt;";
    return "&gt;";
  });
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
    if (tracked.nudgeTimer) clearTimeout(tracked.nudgeTimer);
    shared.runs.delete(runId);
    log.debug?.(`slack-subagent-card: swept stale tracked runId=${runId}`);
  }
}

function cleanupTrackedRun(shared: SharedState, runId: string): void {
  const tracked = shared.runs.get(runId);
  if (tracked?.nudgeTimer) clearTimeout(tracked.nudgeTimer);
  shared.runs.delete(runId);
}

function capturePluginBotId(shared: SharedState, response: unknown): void {
  const record = asRecord(response);
  const message = asRecord(record?.message);
  const botId =
    asNonEmptyString(record?.bot_id) ??
    asNonEmptyString(message?.bot_id) ??
    asNonEmptyString(message?.botId) ??
    asNonEmptyString(record?.botId);

  if (botId) shared.pluginBotId = botId;
}

function getSharedState(): SharedState {
  const scope = globalThis as typeof globalThis & {
    [SHARED_STATE_KEY]?: SharedState;
  };

  if (!scope[SHARED_STATE_KEY]) {
    scope[SHARED_STATE_KEY] = {
      runs: new Map(),
      registeredApis: new WeakSet(),
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
