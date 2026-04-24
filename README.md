# Slack Subagent Card

Slack status cards for OpenClaw sub-agent work.

This plugin posts a Block Kit `plan` card into the originating Slack thread when a sub-agent is spawned, then updates that card as the work completes or fails.

## Version

Current release candidate: **1.2.2**.

Version `1.2.2` adds safer task-summary rendering, stronger lifecycle ordering, handler-level regression tests, and cleaner packaging for OpenClaw plugin distribution.

## Current Phase

This repo is currently at **Phase 1: richer sub-agent lifecycle cards**.

What Phase 1 includes:

- Posts a thread-scoped card when a sub-agent starts.
- Shows a clearer running state with both `details` and `output`.
- Updates to a completed state when a completion delivery target is reached.
- Updates to terminal states for `error`, `timeout`, `killed`, `reset`, and `deleted`.
- Preserves per-account Slack client selection for multi-account setups.
- Uses the original requester session for task-detail lookup after spawn.
- Serializes Slack card updates so terminal outcomes win over in-flight delivery updates.
- Renders task summaries only from explicit public/redacted task fields.
- Stays presentation-only: it does **not** wake parent sessions, enqueue system events, or perform orchestration logic.

## Hook Surface

The plugin currently uses these OpenClaw hooks:

- `subagent_spawned`
- `subagent_delivery_target`
- `subagent_ended`

The intended behavior is:

- `subagent_spawned` posts the initial card.
- `subagent_delivery_target` marks completion early only for runs with `expectsCompletionMessage=true`.
- `subagent_ended` finalizes the card for terminal outcomes and cleans up tracked state.

## Task Summary Safety

Slack cards can include task progress and terminal summaries when OpenClaw provides explicit public or redacted fields:

- `publicProgressSummary`
- `publicTerminalSummary`
- `publicError`
- `redactedProgressSummary`
- `redactedTerminalSummary`
- `redactedError`

Raw runtime fields such as `progressSummary`, `terminalSummary`, and `error` are not rendered directly into Slack cards. This keeps tool output, stack traces, prompts, and secrets out of Slack unless OpenClaw has explicitly prepared a public/redacted value.

The plugin still applies local redaction and internal-context stripping as a defense-in-depth step before placing text into Slack blocks.

## Why This Stays A Plugin

This plugin is meant to be a **Slack UI enhancement**, not a core orchestration feature.

Core OpenClaw should own:

- sub-agent completion routing
- `sessions_yield` semantics
- wake / resume behavior
- thread preservation and delivery correctness

This plugin should only own:

- posting a Slack status card
- updating that card as lifecycle events arrive
- presenting useful, user-facing progress context in-thread

## Roadmap

### Phase 1

Richer sub-agent cards.

- Better running copy
- Better completion copy
- Better error/timeout/reset/deleted copy
- Cleaner packaging / manifest alignment

### Phase 2

Optional richer sub-agent detail payloads.

Possible additions:

- high-level tool/activity summaries in `output`
- optional `sources` when sub-agents produce web/doc results
- more structured terminal summaries

### Phase 3

Optional main-agent activity cards.

Potential direction:

- expand from `subagents_only` into a broader agent activity card
- show long-running tool work in the same Slack thread
- surface “what the agent is doing” while a turn is in progress

### Phase 4

Multi-task plans.

Potential direction:

- render several concurrent sub-agents or agent steps inside one `plan`
- show multiple tasks for one thread instead of a single status line

## Current Limitations

- This plugin does not yet stream intermediate sub-agent progress.
- It does not currently attach Slack `sources` links to cards.
- It does not yet provide a config flag to expand beyond sub-agent usage.
- Full compile/build validation requires OpenClaw plugin SDK dependencies to be installed locally.
- npm publication may require an npm OTP when the publishing account has two-factor authentication enabled for writes.

## Package Notes

- Manifest: `openclaw.plugin.json`
- Entrypoint: `index.ts`
- Handler module: `plugin-handlers.ts`
- Card content module: `task-card.ts`
- Text sanitization module: `task-text-sanitizer.ts`
- Package metadata includes `openclaw.extensions`, `openclaw.compat`, and `openclaw.build`.
- `package.json` and `openclaw.plugin.json` should use the same release version.

## Validation

Local validation:

```sh
npm test
```

When the published `openclaw` package lags the required plugin SDK version, this repo can be tested against a local OpenClaw checkout by installing that checkout as the `openclaw` dependency.

## Suggested Next Step

If continuing the roadmap, the next high-value improvement is:

1. add `sources` support for public task outputs
2. add optional richer completion/output text for sub-agents
3. then add a config flag for broader activity-card usage
