import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  createSharedState,
  handleAfterToolCall,
  handleDeliveryTarget,
  handleEnded,
  handleSpawned,
  registerSlackSubagentCardHandlers,
} from "./dist/plugin-handlers.js";

const THREAD_SESSION_KEY = "agent:test:slack:channel:C123:thread:1700000000.000100";
const TOKEN = "xoxb-test-token";

describe("plugin manifest", () => {
  it("declares startup activation for Slack hook registration", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    );

    assert.deepEqual(manifest.activation, {
      onStartup: true,
      onChannels: ["slack"],
      onCapabilities: ["hook"],
    });
  });
});

describe("slack subagent card handlers", () => {
  it("uses the tracked requester session key and escapes Slack fallback text", async () => {
    const { api, bindSessionKeys, shared, web } = makeHarness({
      task: {
        id: "task-1234567890",
        runId: "run-1234567890",
        title: "Investigate",
        label: "<!channel>",
        status: "succeeded",
        publicTerminalSummary: "Done",
      },
    });

    await handleSpawned(
      api,
      shared,
      { runId: "run-1234567890", requester: { to: "C123", threadId: "1700000000.000100" } },
      { requesterSessionKey: THREAD_SESSION_KEY },
    );

    await handleDeliveryTarget(
      api,
      shared,
      {
        childRunId: "run-1234567890",
        expectsCompletionMessage: true,
        requesterSessionKey: "agent:test:slack:channel:C999:thread:999",
      },
      { requesterSessionKey: "agent:test:slack:channel:C888:thread:888" },
    );

    assert.deepEqual(bindSessionKeys, [THREAD_SESSION_KEY, THREAD_SESSION_KEY]);
    assert.equal(web.posts[0].text, "Sub-agent &lt;!channel&gt;: SubAgent Running");
    assert.equal(web.posts[0].parse, "none");
    assert.equal(web.updates[0].text, "Sub-agent &lt;!channel&gt;: ✅ Completed");
    assert.equal(web.updates[0].parse, "none");
  });

  it("does not let progress-only delivery suppress the final ok update", async () => {
    const harness = makeHarness({
      task: {
        id: "task-1234567890",
        runId: "run-1234567890",
        title: "Gather context",
        status: "running",
        publicProgressSummary: "Still gathering",
      },
    });

    await handleSpawned(
      harness.api,
      harness.shared,
      { runId: "run-1234567890", requester: { to: "C123", threadId: "1700000000.000100" } },
      { requesterSessionKey: THREAD_SESSION_KEY },
    );

    await handleDeliveryTarget(
      harness.api,
      harness.shared,
      { childRunId: "run-1234567890", expectsCompletionMessage: true },
      { requesterSessionKey: THREAD_SESSION_KEY },
    );

    harness.currentTask = {
      id: "task-1234567890",
      runId: "run-1234567890",
      title: "Gather context",
      status: "succeeded",
      publicTerminalSummary: "Final answer is ready",
    };

    await handleEnded(
      harness.api,
      harness.shared,
      { runId: "run-1234567890", outcome: "ok" },
      { requesterSessionKey: THREAD_SESSION_KEY },
    );

    assert.equal(harness.web.updates.length, 2);
    assert.equal(getTask(harness.web.updates[0]).status, "complete");
    assert.equal(getTask(harness.web.updates[0]).details.elements[0].elements[0].text, "Still gathering");
    assert.equal(getTask(harness.web.updates[1]).status, "complete");
    assert.equal(getTask(harness.web.updates[1]).details.elements[0].elements[0].text, "Final answer is ready");
  });

  it("appends compact tool-call tasks for tracked regular subagent runs", async () => {
    const harness = makeHarness({
      task: {
        id: "task-1234567890",
        runId: "run-1234567890",
        title: "Gather context",
        status: "running",
      },
    });

    await handleSpawned(
      harness.api,
      harness.shared,
      { runId: "run-1234567890", requester: { to: "C123", threadId: "1700000000.000100" } },
      { requesterSessionKey: THREAD_SESSION_KEY },
    );

    await handleAfterToolCall(
      harness.api,
      harness.shared,
      { runId: "run-1234567890", toolName: "read", toolCallId: "call-read-1" },
      {},
    );
    await handleAfterToolCall(
      harness.api,
      harness.shared,
      { runId: "run-1234567890", toolName: "rg", toolCallId: "call-rg-1" },
      {},
    );

    const tasks = getTasks(harness.web.updates.at(-1));
    assert.equal(tasks.length, 3);
    assert.equal(tasks[0].title, "Gather context");
    assert.deepEqual(
      tasks.slice(1).map((task) => ({ title: task.title, status: task.status })),
      [
        { title: "Tool: read", status: "complete" },
        { title: "Tool: rg", status: "complete" },
      ],
    );
  });

  it("marks tool-call tasks as error when after_tool_call reports an error", async () => {
    const harness = makeHarness({
      task: {
        id: "task-1234567890",
        runId: "run-1234567890",
        title: "Run command",
        status: "running",
      },
    });

    await handleSpawned(
      harness.api,
      harness.shared,
      { runId: "run-1234567890", requester: { to: "C123", threadId: "1700000000.000100" } },
      { requesterSessionKey: THREAD_SESSION_KEY },
    );

    await handleAfterToolCall(
      harness.api,
      harness.shared,
      { runId: "run-1234567890", toolName: "exec", toolCallId: "call-exec-1", error: "failed" },
      {},
    );

    const tasks = getTasks(harness.web.updates.at(-1));
    assert.equal(tasks[1].title, "Tool: exec");
    assert.equal(tasks[1].status, "error");
    assert.equal(tasks[1].details, undefined);
    assert.equal(tasks[1].output, undefined);
  });

  it("ignores after_tool_call events without a tracked non-Codex run", async () => {
    const harness = makeHarness({
      task: {
        id: "task-1234567890",
        runId: "run-1234567890",
        title: "Ignored tools",
        status: "running",
      },
    });

    await handleAfterToolCall(
      harness.api,
      harness.shared,
      { runId: "run-missing", toolName: "read", toolCallId: "call-read-1" },
      {},
    );
    await handleAfterToolCall(
      harness.api,
      harness.shared,
      { toolName: "read", toolCallId: "call-read-2" },
      {},
    );

    await handleSpawned(
      harness.api,
      harness.shared,
      { runId: "codex-thread:child", requester: { to: "C123", threadId: "1700000000.000100" } },
      { requesterSessionKey: THREAD_SESSION_KEY },
    );
    await handleAfterToolCall(
      harness.api,
      harness.shared,
      { runId: "codex-thread:child", toolName: "exec", toolCallId: "call-exec-1" },
      {},
    );

    assert.equal(harness.web.updates.length, 0);
    assert.equal(getTasks(harness.web.posts[0]).length, 1);
  });

  it("preserves tool-call tasks across terminal updates", async () => {
    const harness = makeHarness({
      task: {
        id: "task-1234567890",
        runId: "run-1234567890",
        title: "Preserve tools",
        status: "running",
      },
    });

    await handleSpawned(
      harness.api,
      harness.shared,
      { runId: "run-1234567890", requester: { to: "C123", threadId: "1700000000.000100" } },
      { requesterSessionKey: THREAD_SESSION_KEY },
    );
    await handleAfterToolCall(
      harness.api,
      harness.shared,
      { runId: "run-1234567890", toolName: "read", toolCallId: "call-read-1" },
      {},
    );

    harness.currentTask = {
      id: "task-1234567890",
      runId: "run-1234567890",
      title: "Preserve tools",
      status: "succeeded",
      publicTerminalSummary: "Done",
    };
    await handleEnded(
      harness.api,
      harness.shared,
      { runId: "run-1234567890", outcome: "ok" },
      { requesterSessionKey: THREAD_SESSION_KEY },
    );

    const tasks = getTasks(harness.web.updates.at(-1));
    assert.equal(tasks[0].status, "complete");
    assert.equal(tasks[1].title, "Tool: read");
    assert.equal(tasks[1].status, "complete");
  });

  it("caps rendered tool-call tasks to the latest ten", async () => {
    const harness = makeHarness({
      task: {
        id: "task-1234567890",
        runId: "run-1234567890",
        title: "Many tools",
        status: "running",
      },
    });

    await handleSpawned(
      harness.api,
      harness.shared,
      { runId: "run-1234567890", requester: { to: "C123", threadId: "1700000000.000100" } },
      { requesterSessionKey: THREAD_SESSION_KEY },
    );

    for (let index = 1; index <= 12; index += 1) {
      await handleAfterToolCall(
        harness.api,
        harness.shared,
        { runId: "run-1234567890", toolName: `tool_${index}`, toolCallId: `call-${index}` },
        {},
      );
    }

    const tasks = getTasks(harness.web.updates.at(-1));
    assert.equal(tasks.length, 11);
    assert.equal(tasks[1].title, "Tool: tool_3");
    assert.equal(tasks.at(-1).title, "Tool: tool_12");
  });

  it("keeps fallback tool task ids unique after capped calls without toolCallId", async () => {
    const harness = makeHarness({
      task: {
        id: "task-1234567890",
        runId: "run-1234567890",
        title: "Fallback ids",
        status: "running",
      },
    });

    await handleSpawned(
      harness.api,
      harness.shared,
      { runId: "run-1234567890", requester: { to: "C123", threadId: "1700000000.000100" } },
      { requesterSessionKey: THREAD_SESSION_KEY },
    );

    for (let index = 1; index <= 12; index += 1) {
      await handleAfterToolCall(
        harness.api,
        harness.shared,
        { runId: "run-1234567890", toolName: "exec" },
        {},
      );
    }

    const tasks = getTasks(harness.web.updates.at(-1));
    assert.equal(tasks.length, 11);
    assert.deepEqual(
      tasks.slice(1).map((task) => task.task_id),
      [
        "tool-exec-3",
        "tool-exec-4",
        "tool-exec-5",
        "tool-exec-6",
        "tool-exec-7",
        "tool-exec-8",
        "tool-exec-9",
        "tool-exec-10",
        "tool-exec-11",
        "tool-exec-12",
      ],
    );
  });

  it("normalizes legacy tracked runs before recording tool-call tasks", async () => {
    const harness = makeHarness({
      task: {
        id: "task-1234567890",
        runId: "run-1234567890",
        title: "Legacy run",
        status: "running",
      },
    });
    const handlers = new Map();
    harness.api.on = (hookName, handler) => {
      handlers.set(hookName, handler);
    };
    const legacyShared = {
      runs: new Map([
        [
          "run-legacy",
          {
            messageTs: "1700000000.000200",
            channelId: "C123",
            threadTs: "1700000000.000100",
            startedAt: Date.now(),
            label: "Legacy run",
            requesterSessionKey: THREAD_SESSION_KEY,
          },
        ],
      ]),
      registeredApis: new WeakSet(),
      webClients: new Map(),
      stateVersion: 1,
    };
    globalThis.__slackSubagentCardSharedState = legacyShared;

    try {
      registerSlackSubagentCardHandlers(harness.api);
      await handlers.get("after_tool_call")(
        { runId: "run-legacy", toolName: "read" },
        {},
      );

      const tasks = getTasks(harness.web.updates.at(-1));
      assert.equal(tasks[1].title, "Tool: read");
      assert.equal(tasks[1].task_id, "tool-read-1");
    } finally {
      delete globalThis.__slackSubagentCardSharedState;
    }
  });

  it("backfills a completed card when delivery target arrives without spawned tracking", async () => {
    const harness = makeHarness({
      task: {
        id: "task-1234567890",
        runId: "run-1234567890",
        title: "Investigate delivery",
        status: "succeeded",
        publicTerminalSummary: "Delivered through announce",
      },
    });

    await handleDeliveryTarget(
      harness.api,
      harness.shared,
      {
        childRunId: "run-1234567890",
        childSessionKey: "agent:test:acp:child",
        expectsCompletionMessage: true,
        requesterSessionKey: "agent:test:main",
        requesterOrigin: {
          channel: "slack",
          to: "channel:C123",
          threadId: "1700000000.000100",
        },
        spawnMode: "run",
      },
      { requesterSessionKey: "agent:test:main" },
    );

    assert.equal(harness.web.posts.length, 1);
    assert.equal(harness.web.posts[0].channel, "C123");
    assert.equal(harness.web.posts[0].thread_ts, "1700000000.000100");
    assert.equal(harness.web.posts[0].text, "Sub-agent Investigate delivery: ✅ Completed");
    assert.equal(getTask(harness.web.posts[0]).status, "complete");
    assert.equal(
      getTask(harness.web.posts[0]).details.elements[0].elements[0].text,
      "Delivered through announce",
    );
  });

  it("cleans up an untracked delivery reservation when backfill posting fails", async () => {
    const harness = makeHarness({
      task: {
        id: "task-1234567890",
        runId: "run-1234567890",
        title: "Post failure",
        status: "succeeded",
        publicTerminalSummary: "Delivered through announce",
      },
    });
    harness.web.onPost = async () => {
      throw new Error("slack unavailable");
    };

    await assert.rejects(
      () =>
        handleDeliveryTarget(
          harness.api,
          harness.shared,
          {
            childRunId: "run-1234567890",
            expectsCompletionMessage: true,
            requesterSessionKey: "agent:test:main",
            requesterOrigin: {
              channel: "slack",
              to: "channel:C123",
              threadId: "1700000000.000100",
            },
          },
          { requesterSessionKey: "agent:test:main" },
        ),
      /slack unavailable/,
    );

    assert.equal(harness.shared.runs.has("run-1234567890"), false);
  });

  it("allows delivery update queued before terminal ok to complete", async () => {
    const harness = makeHarness({
      task: {
        id: "task-1234567890",
        runId: "run-1234567890",
        title: "Race",
        status: "running",
        publicProgressSummary: "Queued delivery",
      },
    });
    const deliveryUpdate = deferred();
    harness.web.onUpdate = (payload) => {
      if (harness.web.updates.length === 1) return deliveryUpdate.promise;
      return Promise.resolve({ ok: true, payload });
    };

    await handleSpawned(
      harness.api,
      harness.shared,
      { runId: "run-1234567890", requester: { to: "C123", threadId: "1700000000.000100" } },
      { requesterSessionKey: THREAD_SESSION_KEY },
    );

    const delivery = handleDeliveryTarget(
      harness.api,
      harness.shared,
      { childRunId: "run-1234567890", expectsCompletionMessage: true },
      { requesterSessionKey: THREAD_SESSION_KEY },
    );
    await waitFor(() => harness.web.updates.length === 1);

    harness.currentTask = {
      id: "task-1234567890",
      runId: "run-1234567890",
      title: "Race",
      status: "succeeded",
      publicTerminalSummary: "Final ok",
    };
    const ended = handleEnded(
      harness.api,
      harness.shared,
      { runId: "run-1234567890", outcome: "ok" },
      { requesterSessionKey: THREAD_SESSION_KEY },
    );

    deliveryUpdate.resolve({ ok: true });
    await Promise.all([delivery, ended]);

    assert.equal(harness.web.updates.length, 2);
    assert.equal(getTask(harness.web.updates[0]).details.elements[0].elements[0].text, "Queued delivery");
    assert.equal(getTask(harness.web.updates[1]).details.elements[0].elements[0].text, "Final ok");
  });

  it("normalizes legacy shared state left by older plugin versions", async () => {
    try {
      const harness = makeHarness({
        task: {
          id: "task-1234567890",
          runId: "run-1234567890",
          title: "Legacy state",
          status: "running",
        },
      });
      const legacyRegisteredApis = new WeakSet();
      legacyRegisteredApis.add(harness.api);
      globalThis.__slackSubagentCardSharedState = {
        runs: new Map(),
        registeredApis: legacyRegisteredApis,
        pluginBotId: "B123",
      };
      harness.api.registrationMode = "full";
      harness.api.createSlackWebClient = () => harness.web;
      const handlers = new Map();
      harness.api.on = (hookName, handler) => {
        handlers.set(hookName, handler);
      };

      registerSlackSubagentCardHandlers(harness.api);
      await handlers.get("subagent_spawned")(
        { runId: "run-1234567890", requester: { to: "C123", threadId: "1700000000.000100" } },
        { requesterSessionKey: THREAD_SESSION_KEY },
      );

      assert.ok(globalThis.__slackSubagentCardSharedState.webClients instanceof Map);
      assert.equal(harness.web.posts.length, 1);
    } finally {
      delete globalThis.__slackSubagentCardSharedState;
    }
  });

  it("registers typed hooks whenever the host exposes api.on", () => {
    const harness = makeHarness({
      task: {
        id: "task-1234567890",
        runId: "run-1234567890",
        title: "Discovery registration",
        status: "running",
      },
    });
    const handlers = new Map();
    harness.api.registrationMode = "discovery";
    harness.api.on = (hookName, handler) => {
      handlers.set(hookName, handler);
    };

    registerSlackSubagentCardHandlers(harness.api);

    assert.deepEqual([...handlers.keys()], [
      "subagent_spawned",
      "subagent_ended",
      "subagent_delivery_target",
      "after_tool_call",
    ]);
  });

  it("skips registration when the host does not expose typed hooks", () => {
    const harness = makeHarness({
      task: {
        id: "task-1234567890",
        runId: "run-1234567890",
        title: "Setup only",
        status: "running",
      },
    });
    delete harness.api.on;
    harness.api.registrationMode = "setup-only";

    assert.doesNotThrow(() => registerSlackSubagentCardHandlers(harness.api));
  });

  it("posts when Slack thread id is numeric", async () => {
    const harness = makeHarness({
      task: {
        id: "task-1234567890",
        runId: "run-1234567890",
        title: "Numeric thread",
        status: "running",
      },
    });

    await handleSpawned(
      harness.api,
      harness.shared,
      { runId: "run-1234567890", requester: { to: "C123", threadId: 1700000000.0001 } },
      { requesterSessionKey: "agent:test:main" },
    );

    assert.equal(harness.web.posts.length, 1);
    assert.equal(harness.web.posts[0].thread_ts, "1700000000.0001");
  });

  it("does not backfill a duplicate card while spawn posting is in flight", async () => {
    const harness = makeHarness({
      task: {
        id: "task-1234567890",
        runId: "run-1234567890",
        title: "Race",
        status: "succeeded",
        publicTerminalSummary: "Done",
      },
    });
    const spawnPost = deferred();
    harness.web.onPost = (payload) => {
      if (harness.web.posts.length === 1) return spawnPost.promise;
      return Promise.resolve({ ts: "1700000000.000300", payload });
    };

    const spawned = handleSpawned(
      harness.api,
      harness.shared,
      { runId: "run-1234567890", requester: { to: "C123", threadId: "1700000000.000100" } },
      { requesterSessionKey: THREAD_SESSION_KEY },
    );
    await waitFor(() => harness.web.posts.length === 1);

    const delivery = handleDeliveryTarget(
      harness.api,
      harness.shared,
      {
        childRunId: "run-1234567890",
        expectsCompletionMessage: true,
        requesterSessionKey: THREAD_SESSION_KEY,
        requesterOrigin: { channel: "slack", to: "channel:C123", threadId: "1700000000.000100" },
      },
      { requesterSessionKey: THREAD_SESSION_KEY },
    );

    await assertRemainsPending(delivery);
    assert.equal(harness.web.posts.length, 1);
    spawnPost.resolve({ ts: "1700000000.000200" });
    await Promise.all([spawned, delivery]);

    assert.equal(harness.web.posts.length, 1);
    assert.equal(harness.web.updates.length, 1);
    assert.equal(getTask(harness.web.updates[0]).status, "complete");
  });

  it("treats an empty secret resolver result as unresolved instead of throwing", async () => {
    const harness = makeHarness({
      task: {
        id: "task-1234567890",
        runId: "run-1234567890",
        title: "Investigate",
        status: "running",
      },
    });
    harness.api.config = { channels: { slack: { botToken: undefined } } };
    harness.api.resolveConfiguredSecretInputWithFallback = async () => ({ secretRefConfigured: false });
    delete process.env.SLACK_BOT_TOKEN;

    await handleSpawned(
      harness.api,
      harness.shared,
      { runId: "run-1234567890", requester: { to: "C123", threadId: "1700000000.000100" } },
      { requesterSessionKey: THREAD_SESSION_KEY },
    );

    assert.equal(harness.web.posts.length, 0);
  });

  it("uses a plaintext configured Slack bot token even if the resolver returns empty", async () => {
    const harness = makeHarness({
      task: {
        id: "task-1234567890",
        runId: "run-1234567890",
        title: "Configured token",
        status: "running",
      },
    });
    harness.api.config = { channels: { slack: { botToken: TOKEN } } };
    harness.api.resolveConfiguredSecretInputWithFallback = async () => ({ secretRefConfigured: false });
    delete process.env.SLACK_BOT_TOKEN;

    await handleSpawned(
      harness.api,
      harness.shared,
      { runId: "run-1234567890", requester: { to: "C123", threadId: "1700000000.000100" } },
      { requesterSessionKey: THREAD_SESSION_KEY },
    );

    assert.equal(harness.web.posts.length, 1);
  });

  it("uses the fallback Slack client factory when the host client factory is missing", async () => {
    const harness = makeHarness({
      task: {
        id: "task-1234567890",
        runId: "run-1234567890",
        title: "Fallback client",
        status: "running",
      },
    });
    harness.shared.webClients.clear();
    harness.api.createSlackWebClient = undefined;
    harness.api.fallbackSlackWebClientFactory = () => harness.web;
    harness.api.config = { channels: { slack: { botToken: TOKEN } } };
    delete process.env.SLACK_BOT_TOKEN;

    await handleSpawned(
      harness.api,
      harness.shared,
      { runId: "run-1234567890", requester: { to: "C123", threadId: "1700000000.000100" } },
      { requesterSessionKey: THREAD_SESSION_KEY },
    );

    assert.equal(harness.web.posts.length, 1);
  });

  it("serializes delivery and terminal updates so terminal outcome wins", async () => {
    const harness = makeHarness({
      task: {
        id: "task-1234567890",
        runId: "run-1234567890",
        title: "Investigate",
        status: "succeeded",
        publicTerminalSummary: "Delivery summary",
      },
    });
    const firstUpdate = deferred();
    harness.web.onUpdate = (payload) => {
      if (harness.web.updates.length === 1) return firstUpdate.promise;
      return Promise.resolve({ ok: true, payload });
    };

    await handleSpawned(
      harness.api,
      harness.shared,
      { runId: "run-1234567890", requester: { to: "C123", threadId: "1700000000.000100" } },
      { requesterSessionKey: THREAD_SESSION_KEY },
    );

    const delivery = handleDeliveryTarget(
      harness.api,
      harness.shared,
      { childRunId: "run-1234567890", expectsCompletionMessage: true },
      { requesterSessionKey: THREAD_SESSION_KEY },
    );
    await waitFor(() => harness.web.updates.length === 1);

    harness.currentTask = {
      id: "task-1234567890",
      runId: "run-1234567890",
      title: "Investigate",
      status: "failed",
      publicError: "Boom",
    };
    const ended = handleEnded(
      harness.api,
      harness.shared,
      { runId: "run-1234567890", outcome: "error", error: "Boom" },
      { requesterSessionKey: THREAD_SESSION_KEY },
    );

    firstUpdate.resolve({ ok: true });
    await Promise.all([delivery, ended]);

    assert.equal(harness.web.updates.length, 2);
    assert.equal(getTask(harness.web.updates[0]).status, "complete");
    assert.equal(getTask(harness.web.updates[1]).status, "error");
    assert.equal(getTask(harness.web.updates[1]).details.elements[0].elements[0].text, "Boom");
  });
});

function makeHarness({ task }) {
  const web = makeFakeWeb();
  const shared = createSharedState();
  shared.webClients.set(TOKEN, web);

  const bindSessionKeys = [];
  const harness = {
    bindSessionKeys,
    currentTask: task,
    shared,
    web,
  };

  harness.api = {
    logger: {
      info() {},
      warn() {},
      debug() {},
    },
    fallbackSlackWebClientFactory() {
      return web;
    },
    runtime: {
      tasks: {
        runs: {
          bindSession({ sessionKey }) {
            bindSessionKeys.push(sessionKey);
            return {
              resolve() {
                return harness.currentTask;
              },
            };
          },
        },
      },
    },
    on() {},
  };

  process.env.SLACK_BOT_TOKEN = TOKEN;
  process.env.OPENCLAW_SLACK_SUBAGENT_CARD_DISABLE_LOCAL_CONFIG_FALLBACK = "1";
  return harness;
}

function makeFakeWeb() {
  const web = {
    posts: [],
    updates: [],
    onPost: undefined,
    onUpdate: undefined,
    chat: {
      async postMessage(payload) {
        web.posts.push(payload);
        if (web.onPost) return web.onPost(payload);
        return { ts: "1700000000.000200" };
      },
      async update(payload) {
        web.updates.push(payload);
        if (web.onUpdate) return web.onUpdate(payload);
        return { ok: true };
      },
    },
  };
  return web;
}

function getTask(payload) {
  return payload.blocks[0].tasks[0];
}

function getTasks(payload) {
  return payload.blocks[0].tasks;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition was not met before timeout");
}

async function assertRemainsPending(promise) {
  const marker = Symbol("pending");
  const result = await Promise.race([
    promise.then(
      () => "resolved",
      () => "rejected",
    ),
    Promise.resolve(marker),
  ]);
  assert.equal(result, marker);
}
