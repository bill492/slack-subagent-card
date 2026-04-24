import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSharedState,
  handleDeliveryTarget,
  handleEnded,
  handleSpawned,
} from "./dist/plugin-handlers.js";

const THREAD_SESSION_KEY = "agent:test:slack:channel:C123:thread:1700000000.000100";
const TOKEN = "xoxb-test-token";

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
  return harness;
}

function makeFakeWeb() {
  const web = {
    posts: [],
    updates: [],
    onUpdate: undefined,
    chat: {
      async postMessage(payload) {
        web.posts.push(payload);
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
