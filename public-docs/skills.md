---
title: Orchestration skills
description: "Paseo orchestration skills: teach coding agents to spawn, coordinate, and manage other agents using slash commands."
nav: Skills
order: 32
category: Orchestration
---

# Orchestration skills

Paseo ships orchestration skills that teach coding agents how to use Paseo tools and the CLI to spawn, coordinate, and manage other agents. Skills package common workflows as slash commands, so agents know how to orchestrate without you writing the briefing and safety rails each time.

Start with [Orchestration](/docs/orchestration) if you want the mental model, or [Common workflows](/docs/orchestration-workflows) for prompts you can use without installing skills.

## Installation

Two ways to install:

- **Desktop app:** Settings → Integrations → Install
- **Manual:** `npx skills add getpaseo/paseo`, this installs to `~/.agents/skills/` and sets up symlinks for each agent.

When the desktop app finds installed Paseo skills, it keeps the bundled skills up to date on startup. If automatic update fails, use Settings → Integrations → Update or the manual command above.

## `/paseo`, Paseo Reference

The foundational skill. Paseo reference for managing agents and workspaces. Load it when an agent needs to create agents, send them prompts, or manage workspace isolation.

Not typically invoked directly by users, it's a reference that other skills depend on.

```
/paseo show me the Paseo CLI surface for creating an agent in a worktree-isolated workspace
```

## `/paseo-handoff`, Task Handoff

Hands off the current task to another agent with full context. Use it when you say "handoff", "hand off", "hand this to", or want to pass work to another agent.

The receiving agent gets a self-contained briefing with the task, context, relevant files, current state, what's been tried, decisions, acceptance criteria, and constraints. Provider comes from orchestration preferences unless you name one. Supports worktree-isolated workspaces when you ask for one.

```
/paseo-handoff hand off the auth fix to codex in a worktree-isolated workspace
/paseo-handoff hand this to claude opus for review
```

## `/paseo-loop`, Iterative Loops

Runs an agent loop until an exit condition is met. Use it when you say "loop", "babysit", "keep trying until", "check every X", "watch", or want iterative autonomous execution.

A loop is a worker/verifier cycle: launch a worker, check verification, repeat until done or limits hit. It can use a shell check, a verifier prompt, or both. Set a sensible `--max-iterations` or `--max-time`.

```
/paseo-loop keep trying until the changed test file passes, max 5 iterations
/paseo-loop babysit PR 123 until checks are green, check every 2m, max-time 1h
```

## `/paseo-goal`, Goal Until Done

Cross-provider goal workflow: clarify fuzzy intent, then run until a verifiable condition holds. Use when you say "goal", "keep going until", "一直做到", or want a completion condition rather than a one-shot prompt.

- **`--clarify`** — interview (via Paseo questions), write a goal doc under `$PASEO_HOME/goals/docs/`, **stop without coding**.
- **Execute** — the agent picks orchestration: Codex native **`/goal`** (same thread), **paseo-loop** (isolated workers; default when unsure), or **in-thread continuation** on non-Codex when you want this tab continuously (daemon MCP **`set_paseo_goal`** / **`clear_paseo_goal`**).
- **`clear`** — stop the active goal on this tab (MCP **`clear_paseo_goal`**, Codex **`/goal clear`**, or **`paseo loop stop`** when on a loop).
- **`status`** — read-only snapshot of the active goal (MCP **`get_paseo_goal`**, loop inspect, or goal doc).

```
/paseo-goal --clarify migrate auth module to the new session API
/paseo-goal all tests in packages/server pass and lint is clean
/paseo-goal clear
/paseo-goal status
```

See **paseo-loop** for explicit babysit/loop phrasing; this skill may route there automatically.

## `/paseo-committee`, Committee Planning

Forms a committee of two high-reasoning agents to step back, do root cause analysis, and produce a plan. Use it when stuck, looping, tunnel-visioning, or facing a hard planning problem.

Committee members do analysis only. They do not edit, create, or delete files. The orchestrating agent synthesizes their plans, implements, then sends the diff back for review.

```
/paseo-committee why are the websocket connections dropping under load?
/paseo-committee plan the auth system migration
```

## `/paseo-advisor`, Advisor

Spins up a single agent as an advisor, a second opinion on the current task. Use it when you say "advisor", "second opinion", "what does X think", or want an outside take without delegating the work itself.

The advisor gives a judgment. You decide what to do. The advisor prompt is analysis-only and ends with a no-edits instruction.

On ACP providers, plan mode disables auto-approve even when `auto_accept` is on — orchestrators should explain that tradeoff and ask which mode to use before creating the advisor (see the **paseo-advisor** skill).

```
/paseo-advisor did I miss anything in this migration plan?
/paseo-advisor --provider claude/opus what is the UX risk in this flow?
```
