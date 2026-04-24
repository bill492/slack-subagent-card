# Slack Subagent Card

Slack status cards for OpenClaw sub-agent work.

This plugin posts a Slack Block Kit `plan` card in the originating Slack thread when a sub-agent starts, then updates that card as completion and terminal lifecycle events arrive. It is presentation-only: OpenClaw core remains responsible for sub-agent orchestration, completion routing, session wake/resume behavior, and delivery correctness.

## Version

Current package version: **1.2.3**.

Version `1.2.3` hardens card lifecycle handling for OpenClaw plugin SDK hosts:

- backfills a completed Slack card when completion delivery has a valid Slack thread but spawn-time card tracking was missed
- avoids duplicate cards when delivery arrives while the initial card post is still in flight
- cleans up failed backfill reservations so future lifecycle events do not get stuck behind an unposted run
- preserves hot-reload/upgrade compatibility with older in-memory plugin state
- accepts numeric Slack thread IDs from OpenClaw hook payloads

## Requirements

- Node.js `>=22`
- OpenClaw plugin SDK `>=2026.4.22`
- A Slack bot token available through OpenClaw config or `SLACK_BOT_TOKEN`

## Configuration

The plugin reads Slack bot tokens from these locations, in order:

1. `channels.slack.accounts.<accountId>.botToken`
2. `channels.slack.botToken`
3. `channels.slack.accounts.default.botToken`
4. `SLACK_BOT_TOKEN`

Configured secret references are resolved through OpenClaw's plugin SDK config runtime. If no token can be resolved, the plugin logs a warning and skips Slack card posting.

`openclaw.plugin.json` intentionally declares an empty config schema because the plugin currently uses the host Slack channel configuration instead of plugin-local settings.

## Hook Surface

The plugin registers these OpenClaw hooks:

- `subagent_spawned`
- `subagent_delivery_target`
- `subagent_ended`

Behavior:

- `subagent_spawned` posts the initial running card when the event or requester session key identifies a Slack thread.
- `subagent_delivery_target` updates an existing card to completed when `expectsCompletionMessage=true`.
- `subagent_delivery_target` can also backfill a completed card if no card was tracked yet but the delivery origin contains a Slack target and thread ID.
- `subagent_ended` applies terminal outcomes such as `ok`, `error`, `timeout`, `killed`, `reset`, and `deleted`, then cleans up tracked run state.

## Slack Target Resolution

The plugin can identify the Slack thread from either:

- a Slack thread session key such as `agent:main:slack:channel:C123:thread:1777005219.760149`
- a hook requester object with `to` and `threadId`, for example `to: "channel:C123"` and `threadId: "1777005219.760149"`

For direct-message sessions that contain a Slack user ID, the plugin resolves the user to a DM channel with `conversations.open` before posting.

## Lifecycle Reliability

The plugin keeps in-memory tracking by OpenClaw run ID. It reserves a run before posting the initial Slack card so concurrent completion delivery cannot create duplicate cards. Updates are serialized per run so terminal outcomes do not get overwritten by slower in-flight delivery updates.

When older plugin state is present in the host process, the plugin normalizes that state on registration. This keeps upgrades from older releases from skipping handler registration or failing because newer caches are missing.

## Task Summary Safety

Slack cards may include task progress and terminal summaries only when OpenClaw provides explicit public or redacted fields:

- `publicProgressSummary`
- `publicTerminalSummary`
- `publicError`
- `redactedProgressSummary`
- `redactedTerminalSummary`
- `redactedError`

Raw runtime fields such as `progressSummary`, `terminalSummary`, and `error` are not rendered directly into Slack cards. The plugin also applies local redaction and internal-context stripping before placing text in Slack blocks.

## Package Layout

- `openclaw.plugin.json`: OpenClaw plugin manifest
- `package.json`: package metadata, OpenClaw SDK compatibility, build scripts
- `index.ts`: plugin entrypoint
- `plugin-handlers.ts`: hook registration, Slack target resolution, card lifecycle handling
- `task-card.ts`: card status/detail content generation
- `task-text-sanitizer.ts`: public/redacted task text sanitization
- `dist/`: built runtime output

## Validation

Run the local validation suite:

```sh
npm run check
npm test
```

The test suite builds the TypeScript output and runs handler-level lifecycle tests plus task-card rendering tests.

## Releasing

Use the scripted release flow:

```sh
npm run release -- X.Y.Z
```

Release guidance and guardrails live in [RELEASING.md](./RELEASING.md).

## Limitations

- Cards do not stream intermediate sub-agent progress beyond lifecycle/task summaries exposed by OpenClaw.
- Cards do not currently attach Slack `sources` links.
- The plugin has no user-facing config flags beyond Slack token resolution through host configuration.
