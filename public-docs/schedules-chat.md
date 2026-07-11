---
title: Schedules from chat
description: Ask an agent in chat to set up and manage a schedule for you.
nav: Chat
order: 26
category: Schedules
---

# Schedules from chat

You don't have to fill in a form. In any agent chat, just ask, and the agent sets up the schedule for you through [Paseo MCP](/docs/mcp).

Example prompts:

- "Every weekday at 9am, triage new GitHub issues and PRs and summarize what needs attention."
- "Check the release build every 5 minutes until it passes, and fix the cause if it fails."
- "Keep working on this refactor — wake yourself every 20 minutes and continue where you left off."
- "Run `npm test` every hour and let me know if it starts failing — just run the command, don't spin up an agent."

The agent picks the cadence, target, and prompt from what you asked, creates the schedule, and reports back. Ask for a plain shell command and it can set up a command schedule instead of an agent run. You can manage it the same way — "pause the triage schedule", "make the build check run every 2 minutes instead", "delete it" — or from the [Schedules view](/docs/schedules) and the [CLI](/docs/schedules-cli).

An agent scheduling itself to wake up later is a **heartbeat**. See [Paseo MCP](/docs/mcp) for the underlying tools.
