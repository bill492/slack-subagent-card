import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildRunningContent,
  buildTerminalContent,
  sanitizeTaskText,
} from "./dist/task-card.js";

function createTaskRunDetail(overrides = {}) {
  const runId = overrides.runId ?? "run-1234567890";
  const createdAt = overrides.createdAt ?? 1_700_000_000_000;
  return {
    id: `task-${runId}`,
    runtime: "subagent",
    sessionKey: "agent:test:slack:channel:C123:thread:1700000000.000100",
    ownerKey: "agent:test:slack:channel:C123:thread:1700000000.000100",
    scope: "session",
    childSessionKey: "agent:test:subagent:child",
    agentId: "research-agent",
    runId,
    title: "Gather context",
    status: "running",
    deliveryStatus: "pending",
    notifyPolicy: "done_only",
    createdAt,
    startedAt: createdAt + 10,
    lastEventAt: createdAt + 20,
    ...overrides,
  };
}

describe("task-aware Slack card rendering", () => {
  it("renders fixed generic copy instead of raw task progress, summaries, or errors", () => {
    const secrets = [
      "raw progress: workspace path /private/repo",
      "raw terminal summary: copied user content",
      "raw task error: SLACK_BOT_TOKEN=xoxb-private",
    ];
    const task = createTaskRunDetail({
      id: "task-1234567890",
      runId: "run-1234567890",
      title: "Investigate issue",
      status: "failed",
      deliveryStatus: "failed",
      endedAt: 1_700_000_010_000,
      progressSummary: secrets[0],
      terminalSummary: secrets[1],
      error: secrets[2],
    });

    const running = buildRunningContent({ task, runId: task.runId });
    const terminal = buildTerminalContent({
      task,
      runId: task.runId,
      outcome: "error",
      elapsedText: "12s",
    });
    const rendered = JSON.stringify({ running, terminal });

    assert.equal(running.detail, "A background worker is actively gathering results for this task.");
    assert.equal(terminal.statusText, "❌ Failed");
    assert.equal(terminal.detail, "The sub-agent failed after 12s.");
    assert.equal(terminal.slackTaskStatus, "error");
    assert.equal(terminal.usedTerminalTaskSignal, true);
    for (const secret of secrets) assert.equal(rendered.includes(secret), false);
  });

  it("does not let a stale running task status override a terminal hook outcome", () => {
    const content = buildTerminalContent({
      task: createTaskRunDetail({
        id: "task-1234567890",
        runId: "run-1234567890",
        title: "Gather context",
        status: "running",
        progressSummary: "Collected sensitive current state",
      }),
      runId: "run-1234567890",
      outcome: "ok",
      elapsedText: "8s",
    });

    assert.equal(content.statusText, "✅ Completed");
    assert.equal(content.detail, "Finished background work in 8s and handed the result back to the parent agent.");
    assert.equal(content.slackTaskStatus, "complete");
    assert.equal(content.usedTerminalTaskSignal, false);
    assert.equal(JSON.stringify(content).includes("Collected sensitive current state"), false);
  });

  it("uses an official terminal task status as the authoritative generic outcome", () => {
    const content = buildTerminalContent({
      task: createTaskRunDetail({
        id: "task-1234567890",
        runId: "run-1234567890",
        title: "Completed task",
        status: "succeeded",
        deliveryStatus: "delivered",
        endedAt: 1_700_000_010_000,
        terminalOutcome: "succeeded",
      }),
      runId: "run-1234567890",
      outcome: "error",
      elapsedText: "5s",
    });

    assert.equal(content.statusText, "✅ Completed");
    assert.equal(content.outcome, "ok");
    assert.equal(content.detail, "Finished background work in 5s and handed the result back to the parent agent.");
    assert.equal(content.slackTaskStatus, "complete");
    assert.equal(content.usedTerminalTaskSignal, true);
  });

  it("robustness: ignores unsupported raw hook error and reason properties at runtime", () => {
    const content = buildTerminalContent({
      runId: "run-1234567890",
      outcome: "error",
      elapsedText: "3s",
      error: "private hook error",
      reason: "private hook reason",
      detail: "private unsupported detail",
    });

    assert.equal(content.detail, "The sub-agent failed after 3s.");
    const rendered = JSON.stringify(content);
    assert.equal(rendered.includes("private hook error"), false);
    assert.equal(rendered.includes("private hook reason"), false);
    assert.equal(rendered.includes("private unsupported detail"), false);
  });

  it("keeps the standalone sanitizer available for explicitly trusted future inputs", () => {
    const sanitized = sanitizeTaskText(
      [
        "User-facing failure.",
        "OpenClaw runtime context (internal):",
        "Keep internal details private.",
        "sessionKey: agent:main:secret",
        "at file:///repo/private.ts:12:3",
      ].join("\n"),
      { errorContext: true },
    );

    assert.equal(sanitized, "User-facing failure.");
  });

  it("redacts common direct token formats and env assignments", () => {
    const sanitized = sanitizeTaskText(
      [
        "Failed with SLACK_BOT_TOKEN=xoxb-123456789012-secretvalue",
        "OPENAI_API_KEY=sk-proj-12345678901234567890",
        "github token ghp_1234567890abcdef1234567890abcdef123456",
        "password: hunter2",
        '"secret": "abc123"',
        "Authorization: Basic dXNlcjpwYXNz",
        "https://user:pass@example.com/private",
      ].join(" "),
      { errorContext: true },
    );

    assert.equal(
      sanitized,
      'Failed with [redacted] [redacted] github [redacted] password: [redacted] "secret": [redacted] Authorization: [redacted] https://[redacted]@example.com/private',
    );
  });
});
