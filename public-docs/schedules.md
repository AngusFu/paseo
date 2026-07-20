---
title: Schedules
description: Run fresh agents on cron schedules or wake an existing agent with a heartbeat.
nav: Overview
order: 25
category: Schedules
---

# Schedules

A schedule starts a new agent for you on a cron cadence: at this time, run this prompt, in this repo, with these agent settings.

Paseo also has **heartbeats**. A heartbeat sends a recurring prompt back into one existing agent so it can reassess and continue the same conversation.

- A new agent each run — fresh daily jobs and long-running watchers.
- An existing agent — when you want continuity.
- The agent that created the schedule — heartbeats from inside an agent.
- A shell command — run a build, test, or script directly, with no agent involved.
  Both concepts use the same cron engine, but their product surfaces stay separate:

- **Schedules** create a new agent each run. You can inspect, pause, resume, run once, update, or delete them.
- **Heartbeats** target one existing agent. They are intentionally lightweight: create or delete them over MCP; from the CLI you can also update only their cron period.

Cron is the canonical cadence. The CLI accepts simple presets such as `5m` or `1h`, but compiles them to cron rather than storing a separate interval type.

## What it's for

- **Fresh recurring jobs:** start a clean agent for daily triage, reports, or maintenance.
- **Heartbeats:** have the current agent periodically reassess state and keep moving.
- **Build babysitting:** keep one agent checking CI, EAS, Docker, or release builds until they pass.
- **Daily triage:** scan issues, PRs, and failing checks every morning.
- **Maintenance sweeps:** refresh dependencies, audit docs, or clean stale branches.

## Ways to create one

- **In the app** — open the Schedules view and create one with a cadence, a repo, and either an agent + prompt or a shell command. This is the main way to create and manage schedules.
- **[From chat](/docs/schedules-chat)** — ask the agent in a chat and it sets the schedule up for you.
- **[From the CLI](/docs/schedules-cli)** — `paseo schedule create`, for headless boxes and scripts.
- **[Over MCP](/docs/mcp)** — agents create and manage schedules programmatically.
