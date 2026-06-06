# Slack Subagent Card

Slack status cards for OpenClaw sub-agent work.

This plugin posts a Slack Block Kit `plan` card in the originating Slack thread when a sub-agent starts, then updates that card as completion and terminal lifecycle events arrive. It is presentation-only: OpenClaw core remains responsible for sub-agent orchestration, completion routing, session wake/resume behavior, and delivery correctness.

## Version

Current package version: **1.2.13**.

Version `1.2.13` makes compact Slack tool-call task rows opt-in:

- defaults `after_tool_call` Slack task rows off to avoid leaking tool command details into Slack threads
- adds `toolTasks.enabled` plugin config for explicit opt-in
- respects host Slack preview config by keeping tool rows off when `channels.slack.streaming.preview.toolProgress` is `false`
- preserves normal sub-agent spawned, running, delivery, and terminal lifecycle cards

Version `1.2.12` fixes Slack direct-message requester target normalization:

- strips `user:` prefixes from Slack requester targets before resolving DM channels
- preserves existing `channel:`, `room:`, and bare Slack ID target handling

Version `1.2.11` adds Slack Thinking Steps streaming where the host supplies Slack stream recipient metadata:

- starts Slack streams with `plan_update` chunks for live sub-agent cards
- appends compact `task_update` chunks for regular OpenClaw sub-agent tool calls
- finalizes the stream with the completed sub-agent task after observed tools
- updates a finalized stream message if a later terminal lifecycle event overrides delivery
- falls back to the static Block Kit card path when streaming is unavailable, missing required recipient metadata, or stream updates fail
- keeps backfilled completed cards on the static Block Kit path

Version `1.2.10` tightens compact sub-agent tool-call rendering:

- renders completed sub-agent summary tasks after the observed tool-call tasks
- renders tool-call context inline in compact task titles and includes hook-provided elapsed time when available
- sanitizes local user and temporary paths from tool-call task titles without exposing tool output

Version `1.2.9` refines compact sub-agent tool-call visualization:

Version `1.2.8` adds compact sub-agent tool-call visualization:

- registers `after_tool_call` alongside the sub-agent lifecycle hooks
- appends one compact Slack `task_card` per observed regular OpenClaw sub-agent tool call
- preserves tool-call tasks across completion and terminal card updates
- caps rendered tool-call tasks to the latest ten calls

Version `1.2.7` aligns the npm package and OpenClaw plugin manifest release metadata.

Version `1.2.5` fixes typed hook registration with OpenClaw 2026.5.x plugin hosts:

- registers sub-agent hooks whenever the host exposes the typed `api.on` hook surface
- restores `hookCount` reporting for `subagent_spawned`, `subagent_delivery_target`, and `subagent_ended`
- keeps setup-only/plugin API loads safe by no-oping when typed hooks are unavailable

Version `1.2.3` hardened card lifecycle handling for OpenClaw plugin SDK hosts:

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

Compact Slack rows for individual sub-agent tool calls are disabled by default. To opt in:

```json
{
  "toolTasks": {
    "enabled": true
  }
}
```

Host Slack preview config still wins: when `channels.slack.streaming.preview.toolProgress` is `false`, this plugin will not render tool-call rows even if `toolTasks.enabled` is `true`.

## Hook Surface

The plugin registers these OpenClaw hooks:

- `subagent_spawned`
- `subagent_delivery_target`
- `subagent_ended`
- `after_tool_call`

Behavior:

- `subagent_spawned` starts a Slack Thinking Steps stream when stream APIs and required Slack recipient metadata are available; otherwise it posts the initial running Block Kit card when the event or requester session key identifies a Slack thread.
- `after_tool_call` appends compact streamed task updates, or updates the fallback Block Kit card, for tracked regular OpenClaw sub-agent runs only when `toolTasks.enabled` is `true` and host Slack tool-progress preview is not disabled.
- `subagent_delivery_target` finalizes an existing stream or updates an existing fallback card to completed when `expectsCompletionMessage=true`.
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

- Slack streaming requires stream-capable Slack APIs, `recipient_user_id` for DM streams, and both `recipient_user_id` and `recipient_team_id` for channel streams. Current OpenClaw sub-agent hook payloads expose Slack `channel`, `accountId`, `to`, and `threadId`; when required user/team metadata is absent, the plugin uses the static Block Kit fallback.
- When `toolTasks.enabled` is `true`, streamed tool-call tasks are appended up to 50 individual tool calls; longer runs update a stable summary task while the static fallback card keeps the latest ten rendered tool tasks.
- Cards do not currently attach Slack `sources` links.
