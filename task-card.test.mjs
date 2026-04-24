import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildTerminalContent, sanitizeTaskText } from "./dist/task-card.js";

describe("task-aware Slack card rendering", () => {
  it("prefers task errors over stale progress summaries for failed tasks", () => {
    const content = buildTerminalContent({
      task: {
        id: "task-1234567890",
        runId: "run-1234567890",
        title: "Investigate issue",
        status: "failed",
        publicProgressSummary: "Still checking files",
        publicError: "Permission denied",
      },
      runId: "run-1234567890",
      outcome: "error",
      elapsedText: "12s",
    });

    assert.equal(content.statusText, "❌ Failed");
    assert.equal(content.detail, "Permission denied");
    assert.equal(content.slackTaskStatus, "error");
    assert.equal(content.usedTerminalTaskSignal, true);
  });

  it("does not let a stale running task status override a terminal hook outcome", () => {
    const content = buildTerminalContent({
      task: {
        id: "task-1234567890",
        runId: "run-1234567890",
        title: "Gather context",
        status: "running",
        publicProgressSummary: "Collected current state",
      },
      runId: "run-1234567890",
      outcome: "ok",
      elapsedText: "8s",
    });

    assert.equal(content.statusText, "✅ Completed");
    assert.equal(content.detail, "Collected current state");
    assert.equal(content.slackTaskStatus, "complete");
    assert.equal(content.usedTerminalTaskSignal, false);
  });

  it("does not treat non-terminal task errors as successful terminal signals", () => {
    const content = buildTerminalContent({
      task: {
        id: "task-1234567890",
        runId: "run-1234567890",
        title: "Retrying task",
        status: "running",
        publicError: "Earlier attempt failed",
      },
      runId: "run-1234567890",
      outcome: "ok",
      elapsedText: "8s",
    });

    assert.equal(content.statusText, "✅ Completed");
    assert.equal(content.detail, "Finished background work in 8s and handed the result back to the parent agent.");
    assert.equal(content.usedTerminalTaskSignal, false);
  });

  it("does not render raw task summaries unless they are explicitly public or redacted", () => {
    const content = buildTerminalContent({
      task: {
        id: "task-1234567890",
        runId: "run-1234567890",
        title: "Sensitive task",
        status: "succeeded",
        terminalSummary: "Raw summary with password: hunter2",
      },
      runId: "run-1234567890",
      outcome: "ok",
      elapsedText: "5s",
    });

    assert.equal(content.detail, "Finished background work in 5s and handed the result back to the parent agent.");
    assert.equal(content.usedTerminalTaskSignal, true);
  });

  it("strips internal task context and stack lines from error text", () => {
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

  it("falls back to a generic terminal detail when raw detail is only internal text", () => {
    const content = buildTerminalContent({
      runId: "run-1234567890",
      outcome: "error",
      elapsedText: "3s",
      detail: [
        "OpenClaw runtime context (internal):",
        "Keep internal details private.",
        "sessionKey: agent:main:secret",
        "at file:///repo/private.ts:12:3",
      ].join("\n"),
    });

    assert.equal(content.detail, "The sub-agent failed after 3s.");
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
