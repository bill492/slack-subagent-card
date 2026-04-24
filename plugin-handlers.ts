import {
  BLOCK_TEXT_MAX_CHARS,
  buildRunningContent,
  buildTerminalContent,
  hasTerminalTaskSignal,
  type Mode,
  type Outcome,
  type SlackTaskStatus,
  type TaskRunDetail,
} from "./task-card.js";

export type OpenClawConfig = {
  channels?: {
    slack?: {
      botToken?: unknown;
      accounts?: Record<string, { botToken?: unknown }>;
    };
  };
};

type SecretResolver = (params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  value: unknown;
  path: string;
}) => Promise<{ value?: string; unresolvedRefReason?: string }>;

type SlackWebClient = {
  chat: {
    postMessage: (params: Record<string, unknown>) => Promise<unknown>;
    update: (params: Record<string, unknown>) => Promise<unknown>;
  };
  conversations: {
    open: (params: Record<string, unknown>) => Promise<unknown>;
  };
};

export type Logger = {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
};

type SlackRequester = {
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string | number;
};

export type HookContext = {
  requesterSessionKey?: string;
  childSessionKey?: string;
  runId?: string;
};

export type SubagentSpawnedEvent = {
  runId?: string;
  childSessionKey?: string;
  agentId?: string;
  label?: string;
  requester?: SlackRequester;
  threadRequested?: boolean;
  mode?: Mode;
};

export type SubagentEndedEvent = {
  runId?: string;
  endedAt?: number;
  outcome?: Outcome;
  error?: string;
  reason?: string;
  targetSessionKey?: string;
  targetKind?: string;
  accountId?: string;
};

export type SubagentDeliveryTargetEvent = {
  childRunId?: string;
  childSessionKey?: string;
  requesterSessionKey?: string;
  requesterOrigin?: SlackRequester;
  spawnMode?: Mode;
  expectsCompletionMessage?: boolean;
};

type BoundTaskRunsRuntime = {
  resolve: (token: string) => TaskRunDetail | undefined;
};

type PluginRuntimeTasks = {
  runs?: {
    bindSession?: (params: { sessionKey: string }) => BoundTaskRunsRuntime;
  };
};

export type PluginApi = {
  logger: Logger;
  config?: OpenClawConfig;
  createSlackWebClient?: (token: string) => SlackWebClient;
  resolveConfiguredSecretInputWithFallback?: SecretResolver;
  runtime?: {
    tasks?: PluginRuntimeTasks;
  };
  registrationMode?: string;
  on: (
    hookName: string,
    handler: (event: unknown, ctx: HookContext) => void | Promise<void>,
  ) => unknown;
};

type TrackedRun = {
  messageTs?: string;
  channelId?: string;
  threadTs?: string;
  accountId?: string;
  startedAt: number;
  endedAt?: number;
  label: string;
  mode?: Mode;
  requesterSessionKey?: string;
  deliveryRenderedTerminalTaskSignal?: boolean;
  deliveryUpdateSucceeded?: boolean;
  terminalUpdateQueued?: boolean;
  updateChain?: Promise<void>;
  initializing?: Promise<void>;
};

export type SharedState = {
  runs: Map<string, TrackedRun>;
  registeredApis: WeakSet<object>;
  webClients: Map<string, SlackWebClient>;
  stateVersion: number;
};

type SlackThreadTarget = {
  channelId: string;
  threadTs: string;
};

const SHARED_STATE_KEY = "__slackSubagentCardSharedState";
const STALE_RUN_TTL_MS = 60 * 60 * 1000;
const TASK_LOOKUP_RETRY_MS = 250;
const CARD_TEXT_PREFIX = "Sub-agent ";
const SHARED_STATE_VERSION = 2;
const SLACK_THREAD_RE = /^agent:[^:]+:slack:(?:channel|room|direct):([^:]+):thread:(.+)$/;
const SLACK_TOPIC_RE = /^agent:[^:]+:slack:(?:channel|room|direct):([^-]+)-topic-(.+)$/;

export function registerSlackSubagentCardHandlers(api: PluginApi, shared: SharedState = getSharedState()): void {
  const log = api.logger;

  if (api.registrationMode !== "full") return;
  if (shared.registeredApis.has(api)) return;
  shared.registeredApis.add(api);

  api.on("subagent_spawned", async (event, ctx) => {
    try {
      await handleSpawned(api, shared, event as SubagentSpawnedEvent, ctx);
    } catch (error) {
      log.warn(`slack-subagent-card: subagent_spawned failed: ${stringifyError(error)}`);
    }
  });

  api.on("subagent_ended", async (event, ctx) => {
    try {
      await handleEnded(api, shared, event as SubagentEndedEvent, ctx);
    } catch (error) {
      log.warn(`slack-subagent-card: subagent_ended failed: ${stringifyError(error)}`);
    }
  });

  api.on("subagent_delivery_target", (event, ctx) => {
    void handleDeliveryTarget(api, shared, event as SubagentDeliveryTargetEvent, ctx).catch((error) => {
      log.warn(`slack-subagent-card: subagent_delivery_target failed: ${stringifyError(error)}`);
    });
  });

  log.info("slack-subagent-card plugin registered");
}

export async function handleSpawned(
  api: PluginApi,
  shared: SharedState,
  event: SubagentSpawnedEvent,
  ctx: HookContext,
): Promise<void> {
  const runId = asNonEmptyString(event.runId ?? ctx.runId);
  if (!runId) return;

  const requesterSessionKey = asNonEmptyString(ctx.requesterSessionKey);
  if (!requesterSessionKey) return;

  if (!hasSlackThreadTargetHint(requesterSessionKey, event.requester)) return;

  const web = await resolveSlackWebClient(api, shared, event.requester?.accountId);
  if (!web) return;

  cleanupStaleRuns(shared, api.logger);

  const target = await resolveSlackThreadTarget(requesterSessionKey, event.requester, web, api.logger);
  if (!target) {
    api.logger.debug?.(
      `slack-subagent-card: no Slack thread target for runId=${runId} requesterSessionKey=${requesterSessionKey}`,
    );
    return;
  }

  const task = resolveTaskRun(api, requesterSessionKey, runId);
  const label =
    asNonEmptyString(task?.label) ??
    asNonEmptyString(event.label) ??
    asNonEmptyString(event.agentId) ??
    asNonEmptyString(task?.title) ??
    runId;

  const cardTitle = truncate(label, 80);
  const runningContent = buildRunningContent({
    task,
    runId,
    mode: event.mode,
  });

  const tracked = createTrackedRun({
    accountId: asNonEmptyString(event.requester?.accountId),
    label: cardTitle,
    mode: event.mode,
    requesterSessionKey,
  });
  const existing = shared.runs.get(runId);
  if (existing?.initializing) await existing.initializing.catch(() => undefined);
  if (!reserveTrackedRun(shared, runId, tracked)) return;
  tracked.initializing = postSlackTaskCard({
    web,
    logger: api.logger,
    target,
    label: cardTitle,
    statusText: runningContent.statusText,
    fallbackStatusText: "SubAgent Running",
    content: runningContent,
  })
    .then((messageTs) => {
      if (!messageTs) {
        api.logger.warn(`slack-subagent-card: postMessage returned no ts for runId=${runId}; skipping tracking`);
        cleanupTrackedRun(shared, runId, tracked);
        return;
      }
      tracked.messageTs = messageTs;
      tracked.channelId = target.channelId;
      tracked.threadTs = target.threadTs;
    })
    .catch((error) => {
      cleanupTrackedRun(shared, runId, tracked);
      throw error;
    })
    .finally(() => {
      delete tracked.initializing;
    });
  await tracked.initializing;

  api.logger.debug?.(
    `slack-subagent-card: posted card for runId=${runId} channel=${target.channelId} thread=${target.threadTs}`,
  );
}

export async function handleDeliveryTarget(
  api: PluginApi,
  shared: SharedState,
  event: SubagentDeliveryTargetEvent,
  ctx: HookContext,
): Promise<void> {
  if (!event.expectsCompletionMessage) return;

  const runId = asNonEmptyString(event.childRunId ?? ctx.runId);
  if (!runId) return;

  const tracked = shared.runs.get(runId);
  if (!tracked) {
    await postBackfilledDeliveryCard(api, shared, event, ctx, runId);
    return;
  }
  await tracked.initializing?.catch(() => undefined);
  if (!isPostedTrackedRun(tracked)) return;

  const web = await resolveSlackWebClient(
    api,
    shared,
    asNonEmptyString(event.requesterOrigin?.accountId) ?? tracked.accountId,
  );
  if (!web) return;

  tracked.endedAt = Date.now();

  const elapsedText = formatElapsed(Math.max(0, tracked.endedAt - tracked.startedAt));
  const requesterSessionKey =
    validateTrackedRequesterSessionKey(api.logger, tracked, event.requesterSessionKey, ctx.requesterSessionKey) ??
    tracked.requesterSessionKey;
  const task = await resolveTaskRunWithRetry(api, requesterSessionKey, runId);
  const completionContent = buildTerminalContent({
    task,
    runId,
    outcome: "ok",
    elapsedText,
    mode: tracked.mode,
  });

  try {
    await enqueueRunUpdate(tracked, async () => {
      if (!canApplyDeliveryUpdate(shared.runs.get(runId), tracked)) return;

      await updateSlackTaskCard({
        web,
        logger: api.logger,
        tracked,
        content: completionContent,
        elapsedText,
      });
      tracked.deliveryUpdateSucceeded = true;
      tracked.deliveryRenderedTerminalTaskSignal = completionContent.usedTerminalTaskSignal;
    });
  } catch (error) {
    api.logger.warn(
      `slack-subagent-card: early completion update failed for runId=${runId}: ${stringifyError(error)}`,
    );
  }
}

async function postBackfilledDeliveryCard(
  api: PluginApi,
  shared: SharedState,
  event: SubagentDeliveryTargetEvent,
  ctx: HookContext,
  runId: string,
): Promise<void> {
  const requesterSessionKey =
    asNonEmptyString(event.requesterSessionKey) ?? asNonEmptyString(ctx.requesterSessionKey);
  if (!requesterSessionKey) return;

  if (!hasSlackThreadTargetHint(requesterSessionKey, event.requesterOrigin)) {
    api.logger.debug?.(`slack-subagent-card: delivery target has no Slack thread for untracked runId=${runId}`);
    return;
  }

  const web = await resolveSlackWebClient(api, shared, event.requesterOrigin?.accountId);
  if (!web) return;

  const target = await resolveSlackThreadTarget(requesterSessionKey, event.requesterOrigin, web, api.logger);
  if (!target) {
    api.logger.debug?.(
      `slack-subagent-card: no Slack delivery target for untracked runId=${runId} requesterSessionKey=${requesterSessionKey}`,
    );
    return;
  }

  const task = await resolveTaskRunWithRetry(api, requesterSessionKey, runId);
  const label =
    asNonEmptyString(task?.label) ??
    asNonEmptyString(task?.title) ??
    asNonEmptyString(event.childSessionKey) ??
    runId;
  const cardTitle = truncate(label, 80);
  const completionContent = buildTerminalContent({
    task,
    runId,
    outcome: "ok",
    elapsedText: formatElapsed(0),
    mode: event.spawnMode,
  });

  const tracked = createTrackedRun({
    accountId: asNonEmptyString(event.requesterOrigin?.accountId),
    endedAt: Date.now(),
    label: cardTitle,
    mode: event.spawnMode,
    requesterSessionKey,
    deliveryUpdateSucceeded: true,
    deliveryRenderedTerminalTaskSignal: completionContent.usedTerminalTaskSignal,
  });
  if (!reserveTrackedRun(shared, runId, tracked)) return;

  let messageTs: string | undefined;
  try {
    messageTs = await postSlackTaskCard({
      web,
      logger: api.logger,
      target,
      label: cardTitle,
      statusText: completionContent.statusText,
      content: completionContent,
    });
  } catch (error) {
    cleanupTrackedRun(shared, runId, tracked);
    throw error;
  }
  if (!messageTs) {
    api.logger.warn(`slack-subagent-card: backfilled postMessage returned no ts for runId=${runId}`);
    cleanupTrackedRun(shared, runId, tracked);
    return;
  }

  tracked.messageTs = messageTs;
  tracked.channelId = target.channelId;
  tracked.threadTs = target.threadTs;

  api.logger.debug?.(
    `slack-subagent-card: backfilled delivery card for runId=${runId} channel=${target.channelId} thread=${target.threadTs}`,
  );
}

export async function handleEnded(
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

  await tracked.initializing?.catch(() => undefined);
  if (!isPostedTrackedRun(tracked)) {
    cleanupTrackedRun(shared, runId, tracked);
    return;
  }

  const web = await resolveSlackWebClient(
    api,
    shared,
    asNonEmptyString(event.accountId) ?? tracked.accountId,
  );
  if (!web) {
    cleanupTrackedRun(shared, runId);
    return;
  }

  const outcome = normalizeOutcome(event.outcome);
  tracked.terminalUpdateQueued = true;
  if (canSkipTerminalUpdateAfterDelivery(tracked, outcome)) {
    cleanupTrackedRun(shared, runId);
    return;
  }

  tracked.endedAt = asFiniteNumber(event.endedAt) ?? Date.now();

  const elapsedText = formatElapsed(Math.max(0, tracked.endedAt - tracked.startedAt));
  const eventDetail =
    outcome === "error"
      ? asNonEmptyString(event.error)
      : outcome === "reset" || outcome === "deleted"
        ? asNonEmptyString(event.reason)
        : undefined;
  const requesterSessionKey =
    validateTrackedRequesterSessionKey(api.logger, tracked, undefined, ctx.requesterSessionKey) ??
    tracked.requesterSessionKey;
  const task = await resolveTaskRunWithRetry(api, requesterSessionKey, runId);
  const terminalContent = buildTerminalContent({
    task,
    runId,
    outcome,
    elapsedText,
    detail: eventDetail,
    mode: tracked.mode,
  });

  try {
    await enqueueRunUpdate(tracked, async () => {
      await updateSlackTaskCard({
        web,
        logger: api.logger,
        tracked,
        content: terminalContent,
        elapsedText,
      });
    });
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
  taskId: string;
  slackTaskStatus: SlackTaskStatus;
}): Array<Record<string, unknown>> {
  const titleParts = [params.label];
  if (params.elapsedText) titleParts.push(`(${params.elapsedText})`);

  const task: Record<string, unknown> = {
    type: "task_card",
    task_id: params.taskId,
    title: titleParts.join(" "),
    status: params.slackTaskStatus,
  };

  if (params.detail) {
    task.details = toRichText(truncate(params.detail, BLOCK_TEXT_MAX_CHARS));
  }

  if (params.outputText) {
    task.output = toRichText(truncate(params.outputText, BLOCK_TEXT_MAX_CHARS));
  }

  return [
    {
      type: "plan",
      title: params.statusText,
      tasks: [task],
    },
  ];
}

async function postSlackTaskCard(params: {
  web: SlackWebClient;
  logger: Logger;
  target: SlackThreadTarget;
  label: string;
  statusText: string;
  fallbackStatusText?: string;
  content: {
    detail: string;
    outputText?: string;
    taskId: string;
    slackTaskStatus: SlackTaskStatus;
  };
}): Promise<string | undefined> {
  const sent = await withSlackRetry(
    () =>
      params.web.chat.postMessage({
        channel: params.target.channelId,
        thread_ts: params.target.threadTs,
        text: buildFallbackText(params.label, params.fallbackStatusText ?? params.statusText),
        parse: "none",
        blocks: buildBlocks({
          label: params.label,
          statusText: params.statusText,
          detail: params.content.detail,
          outputText: params.content.outputText,
          taskId: params.content.taskId,
          slackTaskStatus: params.content.slackTaskStatus,
        }) as any,
      }),
    params.logger,
  );

  return asNonEmptyString((sent as any)?.ts) ?? asNonEmptyString((sent as any)?.message?.ts);
}

async function updateSlackTaskCard(params: {
  web: SlackWebClient;
  logger: Logger;
  tracked: TrackedRun & { messageTs: string; channelId: string };
  content: {
    statusText: string;
    detail: string;
    outputText?: string;
    taskId: string;
    slackTaskStatus: SlackTaskStatus;
  };
  elapsedText?: string;
}): Promise<void> {
  await withSlackRetry(
    () =>
      params.web.chat.update({
        channel: params.tracked.channelId,
        ts: params.tracked.messageTs,
        text: buildFallbackText(params.tracked.label, params.content.statusText),
        parse: "none",
        blocks: buildBlocks({
          label: params.tracked.label,
          statusText: params.content.statusText,
          elapsedText: params.elapsedText,
          detail: params.content.detail,
          outputText: params.content.outputText,
          taskId: params.content.taskId,
          slackTaskStatus: params.content.slackTaskStatus,
        }) as any,
      }),
    params.logger,
  );
}

function createTrackedRun(params: {
  accountId?: string;
  endedAt?: number;
  label: string;
  mode?: Mode;
  requesterSessionKey: string;
  deliveryRenderedTerminalTaskSignal?: boolean;
  deliveryUpdateSucceeded?: boolean;
}): TrackedRun {
  return {
    accountId: params.accountId,
    startedAt: Date.now(),
    endedAt: params.endedAt,
    label: params.label,
    mode: params.mode,
    requesterSessionKey: params.requesterSessionKey,
    deliveryRenderedTerminalTaskSignal: params.deliveryRenderedTerminalTaskSignal,
    deliveryUpdateSucceeded: params.deliveryUpdateSucceeded,
  };
}

function isPostedTrackedRun(
  tracked: TrackedRun,
): tracked is TrackedRun & { messageTs: string; channelId: string; threadTs: string } {
  return Boolean(tracked.messageTs && tracked.channelId && tracked.threadTs);
}

function reserveTrackedRun(shared: SharedState, runId: string, tracked: TrackedRun): boolean {
  if (shared.runs.has(runId)) return false;
  shared.runs.set(runId, tracked);
  return true;
}

function resolveTaskRun(api: PluginApi, requesterSessionKey: string | undefined, runId: string): TaskRunDetail | undefined {
  if (!requesterSessionKey) return undefined;

  try {
    return api.runtime?.tasks?.runs?.bindSession?.({ sessionKey: requesterSessionKey })?.resolve(runId);
  } catch (error) {
    api.logger.debug?.(`slack-subagent-card: task lookup failed for runId=${runId}: ${stringifyError(error)}`);
    return undefined;
  }
}

async function resolveTaskRunWithRetry(
  api: PluginApi,
  requesterSessionKey: string | undefined,
  runId: string,
): Promise<TaskRunDetail | undefined> {
  const initial = resolveTaskRun(api, requesterSessionKey, runId);
  if (hasTerminalTaskSignal(initial) || !requesterSessionKey) return initial;

  await sleep(TASK_LOOKUP_RETRY_MS);
  return resolveTaskRun(api, requesterSessionKey, runId) ?? initial;
}

function validateTrackedRequesterSessionKey(
  log: Logger,
  tracked: TrackedRun,
  ...candidates: Array<string | undefined>
): string | undefined {
  const trackedSessionKey = asNonEmptyString(tracked.requesterSessionKey);
  if (!trackedSessionKey) return undefined;

  for (const candidate of candidates) {
    const normalized = asNonEmptyString(candidate);
    if (normalized && normalized !== trackedSessionKey) {
      log.warn("slack-subagent-card: ignoring mismatched requester session key for tracked run");
    }
  }

  return trackedSessionKey;
}

function canApplyDeliveryUpdate(current: TrackedRun | undefined, tracked: TrackedRun): boolean {
  return current === tracked && !tracked.terminalUpdateQueued;
}

function canSkipTerminalUpdateAfterDelivery(tracked: TrackedRun, outcome: string | undefined): boolean {
  return (
    outcome === "ok" &&
    tracked.deliveryUpdateSucceeded === true &&
    tracked.deliveryRenderedTerminalTaskSignal === true
  );
}

async function enqueueRunUpdate(tracked: TrackedRun, update: () => Promise<void>): Promise<void> {
  const previous = tracked.updateChain ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(update);
  tracked.updateChain = next.catch(() => undefined);
  await next;
}

function buildFallbackText(label: string, statusText: string): string {
  return `${CARD_TEXT_PREFIX}${escapeSlackText(label)}: ${escapeSlackText(statusText)}`;
}

function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  web: SlackWebClient,
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
  const threadTs = asNonEmptyIdString(requester?.threadId);
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

function hasSlackThreadTargetHint(
  requesterSessionKey: string,
  requester: SlackRequester | undefined,
): boolean {
  if (parseSlackThreadSessionKey(requesterSessionKey)) return true;
  const requesterChannel = asNonEmptyString(requester?.channel)?.toLowerCase();
  if (requesterChannel && requesterChannel !== "slack") return false;
  return Boolean(asNonEmptyString(requester?.to) && asNonEmptyIdString(requester?.threadId));
}

type SlackTokenResolution = {
  token?: string;
  unresolvedReasons: string[];
};

async function resolveSlackBotToken(
  api: PluginApi,
  accountId?: string,
): Promise<SlackTokenResolution> {
  const normalizedAccountId = asNonEmptyString(accountId);
  const config = api.config;
  const unresolvedReasons: string[] = [];

  for (const candidate of buildSlackBotTokenCandidates(config, normalizedAccountId)) {
    const resolved = await resolveSlackBotTokenCandidate(api, candidate.value, candidate.path);
    if (resolved.token) {
      return { token: resolved.token, unresolvedReasons };
    }
    if (resolved.unresolvedReason) {
      unresolvedReasons.push(resolved.unresolvedReason);
    }
  }

  return {
    token: asNonEmptyString(process.env.SLACK_BOT_TOKEN),
    unresolvedReasons,
  };
}

function buildSlackBotTokenCandidates(config: OpenClawConfig | undefined, accountId?: string) {
  const candidates: Array<{ path: string; value: unknown }> = [];
  if (accountId) {
    candidates.push({
      path: `channels.slack.accounts.${accountId}.botToken`,
      value: config?.channels?.slack?.accounts?.[accountId]?.botToken,
    });
  }
  candidates.push(
    {
      path: "channels.slack.botToken",
      value: config?.channels?.slack?.botToken,
    },
    {
      path: "channels.slack.accounts.default.botToken",
      value: config?.channels?.slack?.accounts?.default?.botToken,
    },
  );
  return candidates;
}

async function resolveSlackBotTokenCandidate(
  api: PluginApi,
  value: unknown,
  path: string,
): Promise<{ token?: string; unresolvedReason?: string }> {
  if (!api.config) {
    return { token: asNonEmptyString(value) };
  }

  if (!api.resolveConfiguredSecretInputWithFallback) {
    return { token: asNonEmptyString(value) };
  }

  const resolved = await api.resolveConfiguredSecretInputWithFallback({
    config: api.config,
    env: process.env,
    value,
    path,
  });

  return {
    token: asNonEmptyString(resolved?.value),
    unresolvedReason: asNonEmptyString(resolved?.unresolvedRefReason),
  };
}

async function resolveSlackWebClient(
  api: PluginApi,
  shared: SharedState,
  accountId?: string,
): Promise<SlackWebClient | undefined> {
  const { token, unresolvedReasons } = await resolveSlackBotToken(api, accountId);
  if (!token) {
    const unresolvedSuffix =
      unresolvedReasons.length > 0 ? ` unresolvedRefs=${unresolvedReasons.join(" | ")}` : "";
    api.logger.warn(
      `slack-subagent-card: no Slack bot token found for accountId=${accountId ?? "default"}; skipping${unresolvedSuffix}`,
    );
    return undefined;
  }
  const cached = shared.webClients.get(token);
  if (cached) return cached;
  const client = api.createSlackWebClient?.(token);
  if (!client) {
    api.logger.warn("slack-subagent-card: no Slack client factory available; skipping");
    return undefined;
  }
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
  web: SlackWebClient,
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

function cleanupTrackedRun(shared: SharedState, runId: string, tracked?: TrackedRun): void {
  if (!tracked || shared.runs.get(runId) === tracked) {
    shared.runs.delete(runId);
  }
}

export function createSharedState(): SharedState {
  return {
    runs: new Map(),
    registeredApis: new WeakSet(),
    webClients: new Map(),
    stateVersion: SHARED_STATE_VERSION,
  };
}

function getSharedState(): SharedState {
  const scope = globalThis as typeof globalThis & {
    [SHARED_STATE_KEY]?: SharedState;
  };

  if (!scope[SHARED_STATE_KEY]) {
    scope[SHARED_STATE_KEY] = createSharedState();
  }

  normalizeSharedState(scope[SHARED_STATE_KEY]!);
  return scope[SHARED_STATE_KEY]!;
}

function normalizeSharedState(shared: Partial<SharedState>): asserts shared is SharedState {
  if (!(shared.runs instanceof Map)) shared.runs = new Map();
  if (shared.stateVersion !== SHARED_STATE_VERSION || !(shared.registeredApis instanceof WeakSet)) {
    shared.registeredApis = new WeakSet();
  }
  if (!(shared.webClients instanceof Map)) shared.webClients = new Map();
  shared.stateVersion = SHARED_STATE_VERSION;
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

function asNonEmptyIdString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
  return undefined;
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

export { buildFallbackText };
