# Slack Subagent Card

Slack status cards for OpenClaw sub-agent work.

This plugin posts a Block Kit `plan` card into the originating Slack thread when a sub-agent is spawned, then updates that card as the work completes or fails.

## Current Phase

This repo is currently at **Phase 1: richer sub-agent lifecycle cards**.

What Phase 1 includes:

- Posts a thread-scoped card when a sub-agent starts.
- Shows a clearer running state with both `details` and `output`.
- Updates to a completed state when a completion delivery target is reached.
- Updates to terminal states for `error`, `timeout`, `killed`, `reset`, and `deleted`.
- Preserves per-account Slack client selection for multi-account setups.
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
- Full compile/build validation requires the plugin dependencies to be installed locally.

## Package Notes

- Manifest: `openclaw.plugin.json`
- Entrypoint: `index.ts`
- Package metadata includes `openclaw.extensions`, `openclaw.compat`, and `openclaw.build`.

## Suggested Next Step

If continuing the roadmap, the next high-value improvement is:

1. add optional richer completion/output text for sub-agents
2. then add a config flag for broader activity-card usage
