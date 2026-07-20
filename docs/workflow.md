# Workflow engine

Deterministic multi-agent workflows powered by `@getpaseo/agents-workflow`
(Claude-Code-Workflow superset). Definitions are `*.flow.js` scripts; the daemon
queues and runs them with product-level concurrency control.

## Packages

| Package / path                                           | Role                                              |
| -------------------------------------------------------- | ------------------------------------------------- |
| `packages/agents-workflow` (`@getpaseo/agents-workflow`) | Engine SDK + `aw` CLI + builtin flows             |
| `skills/paseo-create-workflow`                           | Authoring skill for `*.flow.js`                   |
| `packages/protocol/src/workflow/`                        | Wire types + RPCs                                 |
| `packages/server/src/server/workflow/`                   | Store, FIFO queue, service                        |
| App `/workflows`                                         | List/create/dispatch definitions and inspect runs |

## Data model

File-based JSON under `$PASEO_HOME/workflows/`:

- `definitions/{id}.json` — metadata (`WorkflowDefinitionSchema`)
- `definitions/{id}.flow.js` — script body
- `runs/{runId}.json` — run record (`WorkflowRunSchema`)
- `runs/{runId}/` — run workspace (artifacts / journal); sibling of the `.json` file
- `runs/{runId}/events.jsonl` — per-run workflow event log (ops + lifecycle)
- `runs/{runId}/journal.jsonl` — optional engine journal
- `events.jsonl` — global append-only workflow event log (all definitions + runs)
- `rules.json` — Kanban source → workflow auto-trigger rules

Workflow events are separate from `$PASEO_HOME/daemon.log`. The service appends
compact one-line JSON for definition CRUD, queue/start/end, workspace mint,
backend selection, and host agent create/wait/fail. Clients read a run’s stream
via `workflow.run.logs` (forward pagination: `afterSeq` + `limit` → `entries`,
`nextSeq`, `hasMore`). The run detail sheet drains pages on open, polls every
1s while the run is live, and keeps “Load more” for very large finished logs.

`WorkflowEventLog` keeps an in-memory per-run cache (parsed entries + byte
offset + a trailing partial-line buffer) so a live run's 1s poll only reads and
parses the bytes appended since the last call, not the whole file again — a
file that shrinks (truncated/rebuilt) resets the cache and re-reads in full.
The cache is bounded to `MAX_RUN_LOG_CACHES` (16) runs with LRU eviction so a
long-lived daemon watching many runs over its lifetime doesn't leak memory.
`.flow.js` definition source writes go through the same `writeFileAtomic`
helper the `.json` metadata sidecar already used (temp file + rename), so a
definition save can't leave a half-written script on disk.

If a run has no `events.jsonl` yet (older daemons / pre-event-log runs),
`workflow.run.logs` reconstructs a timeline from the run record +
`journal.jsonl` so finished/failed runs still show history.

Journal semantics (2026-07-18 review): only **successful** `agent()` results
are recorded — a failed call is retried on resume, never replayed as a
permanent `null`. The cache key hashes the **resolved** opts (phase falls back
to the active `phase()`, isolation/labels included). Replay serves entries
recorded **before** the current run only — within one live run, repeated
identical `agent()` calls (judge panels, refuter votes) each hit the backend
instead of collapsing into one cached answer, matching Claude Code's
resume-only cache. `maxRetries` is clamped to 10; the engine also applies a
default 30s vm timeout to the script's _synchronous head_ only (a post-`await`
busy loop still needs process isolation — see `sandbox.ts`).

Builtin flows are read-only from the package
(`packages/agents-workflow/workflows/builtin/`, ids `builtin:<name>`). They can be
**dispatched directly** as templates, or forked into a user definition to edit.

## Project workflows (read-through)

A repo can keep its own `*.flow.js` scripts in `.paseo/workflows/` or
`.claude/workflows/` (Claude Code named workflows — same dialect, runs
unchanged; on a name collision `.paseo` wins). Nothing is imported: the daemon
lists them per-request (`workflow.definition.list.request` with a `cwd`) and
resolves their ids (`project:<abs file path>`) by reading the repo file
**fresh at dispatch time** — edit in the repo, dispatch runs the new source.
Feature flag `server_info.features.projectWorkflows`; wire fields
`origin: "project"` + `sourcePath` on the definition. Project definitions are
read-only over the wire (update/delete RPCs don't apply) — the app shows them
per-project with Fork; the CLI accepts a script path directly:

```bash
paseo workflow ls --cwd /path/to/repo          # includes project workflows
paseo workflow run .paseo/workflows/review.flow.js --cwd . --arg task="..."
```

The daemon only reads files whose parent is a `.paseo/workflows` /
`.claude/workflows` directory (absolute, normalized; `..` rejected) — see
`packages/server/src/server/workflow/project-definitions.ts`.

## Run isolation

Each run gets a dedicated directory under `runs/{runId}/` used as
`workspacePath` (artifacts / journal). Dispatch may override agent `cwd` with a
project repo path.

Agent `cwd` is separate: before the engine starts, the daemon mints **one**
directory-backed Paseo workspace for that cwd (title `⚙️ <name>`, emoji fixed), stores
it on `run.workspaceId`, and runs every `agent()` through **`PaseoHostBackend`**
(in-daemon `createAgent` + `AgentManager` — same path as the WebSocket protocol).
Do **not** shell out to a PATH `paseo` CLI for daemon workflow runs; that ignored
dispatch `provider`/`model` and minted a workspace per retry.

`isolation: "worktree"` still asks the host to mint a worktree-backed agent.
Creating a full Paseo worktree from a repo path at dispatch time remains a
follow-up. The CLI `aw` tool may still use the shell `PaseoBackend` for local
smoke tests.

Dispatch args conventionally include:

- `task` / `prompt` — task text collected by the UI / CLI (stored on the run record)
- `provider` / `model` — defaults for `agent()` calls that omit them
  (`PaseoHostBackend` `defaultProvider` / `defaultModel`)
- `effort` (alias `thinking`) — default thinking option id for `agent()` that
  omit `effort` (`defaultEffort` → createAgent `thinking` / `paseo run --thinking`)
- `mode` — default provider mode id (`defaultMode` → createAgent `mode` /
  `paseo run --mode`)
- `fast` — boolean convenience for Claude/Codex-style `fast_mode`
  (`defaultFeatureValues.fast_mode`)
- `featureValues` — provider features from dispatch UI / CLI, merged into
  `agent()` defaults. Dispatch reuses composer `DraftAgentControls` (same chip
  row as chat) and loads options via `listProviderFeatures` — every returned
  toggle/select (Claude `fast_mode`, Codex `fast_mode` + `plan_mode`, Cursor
  ACP `fast`, Copilot `agent`, OpenCode auto-accept, …). Keys are
  provider-specific — e.g. Cursor uses `{ fast: "true" }`, not `fast_mode`.
- `workspaceTitle` — optional sidebar title for the one Paseo workspace minted
  for the run (dispatch field or args; always prefixed with `⚙️ `; default body
  is the definition name)

Scripts can override per call:

```js
await agent(prompt, { effort: "high", mode: "agent", fast: true, label: "impl" });
```

**In the sandbox, `args` is the prompt** — usually a bare string (e.g.
`typeof args === "string" ? args : ""`). Do not invent `args.task` inside those
scripts; the string _is_ the task text. The run record may still store
`{ task, provider, model, effort, mode, fast }` for the UI; when the engine
starts, if the payload is only task-like plus those host defaults, the daemon
passes the **task string** into the sandbox (`buildWorkflowEngineArgs`).
Multi-field dispatches (Kanban card fields, custom objects) stay as objects
(plus `runtimeDir` / `key`).

CLI:

```bash
paseo workflow run <id> --cwd /path/to/repo \
  --arg task="fix login" --provider cursor --model grok-4.5 \
  --thinking high --mode agent --fast
```

`paseo run` also accepts `--thinking`, `--mode`, and `--feature key=value`
(e.g. `--feature fast_mode=true`).

Discover valid ids on the live daemon (do not invent them):

```bash
paseo provider inspect --cwd . --json                    # enabled providers → modes → models → thinking
paseo provider inspect --cwd . --all --json              # include disabled providers
paseo provider features <provider> --cwd . --model <id>  # draft features (separate probe)
# or piece by piece:
paseo provider ls
paseo provider models <provider> --thinking
```

Inside a Paseo agent (MCP): prefer `inspect_providers` for modes/models/thinking;
use `inspect_provider` for features.
See `skills/paseo-create-workflow/SKILL.md` (“Discover what you can pass”) and
[public-docs/cli.md](../public-docs/cli.md) / [public-docs/mcp.md](../public-docs/mcp.md).

## Concurrency (two layers)

1. **Product queue** (`WorkflowQueue`): global max concurrent **runs** (default 2),
   FIFO. Excess stays `queued` until a slot frees (success/fail/cancel).
2. **Engine `p-limit`**: limits concurrent `agent()` calls **inside** one run.
   Does not replace the product queue.

## Cancel & daemon restart recovery

`workflow.run.cancel` on a `queued` run is a same-as-ever store-only
transition. Cancelling a `running` run is different: the engine
(`@getpaseo/agents-workflow`) has no `AbortSignal`, so a running run can't be
truly aborted mid-script. `WorkflowService.cancel` instead: (1) flags the run
in-memory so the host wrapper refuses any **further** `agent()` call the
script tries to make, (2) best-effort interrupts whichever host agent is
currently in flight via `AgentManager.cancelAgentRun` (falling back to
`archiveAgent` if that's refused), matched by the run's workspace + the
`paseo.workflow-run-id` label every spawned agent carries. The run's status
stays `running` until the (now agent()-starved) script actually finishes, at
which point `execute()` forces the terminal status to `cancelled` regardless
of what the script itself returned. The UI shows an optimistic "Cancelling…"
state for this window rather than an immediate `cancelled`.

The queue itself is pure in-memory, so a daemon restart loses it.
`WorkflowService.recoverAfterRestart()` (called once at bootstrap, after
`ensureAgentWorkspace`/`agentHost`/`cancelWorkflowAgents` are wired) re-enqueues
every `queued` run found in the store, and marks every `running` run `failed`
with `"Interrupted by daemon restart"` — the process that was executing it is
gone, so there is nothing left to wait on. A `queued` run whose definition was
since deleted fails out immediately instead of looping forever unenqueued.

## Protocol

Dotted RPCs (`docs/rpc-namespacing.md`):

- `workflow.definition.{list,get,create,update,delete,list_builtins}`
- `workflow.run.{list,get,dispatch,cancel,logs}`
- `kanban.rule.{list,create,update,delete}`

Gated behind `server_info.features.workflow` —
`COMPAT(workflow)` marks the cleanup site. No degraded path on old daemons.

## Kanban auto-trigger

Source-level rules in `rules.json`:

```ts
{
  id, sourceId, enabled, workflowDefinitionId,
  filter: { labelsAny?, titleRegex?, projectKey? }
}
```

When Kanban sync **creates** a new card (`upsertCardBySource` first insert),
enabled rules for that source are matched (AND of provided filter fields;
empty filter = all cards from the source). Matching rules enqueue a run with
args: `{ cardId, title, url, externalId, labels, metadata, runtimeDir, key }`.

Re-sync of an existing card does **not** re-trigger.

## CLI

`paseo workflow` talks to the daemon over the same RPCs as the app (requires
`server_info.features.workflow`):

```bash
paseo workflow ls
paseo workflow inspect <definitionId>
paseo workflow create --name "Bug sweep" --source-file ./bug-sweep.flow.js
paseo workflow update <definitionId> --name "Renamed"
paseo workflow rm <definitionId>
paseo workflow builtins
paseo workflow run <definitionId> --cwd /path/to/repo \
  --arg task="fix login" --provider claude --thinking high --mode agent --fast
paseo workflow runs ls
paseo workflow runs inspect <runId>
paseo workflow runs cancel <runId>
```

Convenience flags on `workflow run` (`--provider` / `--model` / `--thinking` /
`--mode` / `--fast`) are folded into `args` the same way as `--arg effort=…`.
`paseo run` accepts the matching agent flags (`--thinking` / `--mode` /
`--feature key=value`).

For local script validation without the daemon, use `aw` from
`@getpaseo/agents-workflow` (`aw list` / `aw validate` / `aw run`).

## Agent-facing MCP tools + resume

Agents dispatch workflows first-class via three MCP tools: `list_workflows`
(includes project read-through definitions for the cwd), `dispatch_workflow`
(accepts a definition id or a `*.flow.js` path; `task` merges into
`args.task`; `resumeFromRunId` resumes a failed run), and `get_workflow_run`
(status + event log, poll with `nextSeq`→`afterSeq`). Usage rules live in
`skills/paseo/SKILL.md`.

Resume (`resumeFromRunId` on dispatch, feature flag
`server_info.features.workflowRunResume`): the daemon copies the prior run's
`journal.jsonl` into the new run before the engine starts, so successful
agent calls replay cached (event log shows `agent.start` with
`data.cached: true`) and only failed/unrun stages execute. cwd/args default
to the prior run's; the event log records `run.resumed`. Surfaces: the run
detail sheet's Resume button, `paseo workflow runs resume <runId>`,
`paseo workflow run <id> --resume-from <runId>`, and the MCP tool.

## Run UI (progress tree, agents, run tab)

The daemon writes every engine progress event into the run's event log
(`onPhase` → `phase`, script `log()` → `log`, and `onAgentEvent` →
`agent.start` / `agent.complete` at debug level plus `agent.error` /
`agent.retry`). Each agent entry carries `data.callId` (the engine's
monotonic per-`agent()` id), `label`, `phase`, `model`, `cached`. Clients
rebuild the live progress tree purely from these entries
(`packages/app/src/screens/workflow-run-phase-tree.ts`) — the logs hook
polls 1s while the run is live, and the tree survives refresh because the
log is persisted. Older daemons emit no `callId` entries, so the tree
section hides itself (data-driven capability gate, no fallback path).

Agents a run spawns carry `paseo.workflow-run-id` (accessor in
`@getpaseo/protocol/agent-labels`). The app folds them into one synthetic
`{ kind: "workflow_run", runId }` workspace tab per run instead of a tab
per agent (`agent-visibility.ts`), rendered by
`packages/app/src/panels/workflow-run-panel.tsx` reusing the shared run
detail body (`workflow-run-detail.tsx`, also used by the /workflows run
sheet). Tapping an agent opens its full timeline as a pinned tab; closing
such a tab is layout-only (never archives a run agent). The run tab prunes
once every agent of the run is archived, and a manually closed run tab is
remembered per session (`hiddenWorkflowRunIdsByWorkspace`) so reconcile does
not reopen it. Agents also carry `paseo.workflow-run-workspace` (the run's
home workspace): folding only happens there, so a worktree-isolated agent
surfaces as a normal tab (archive-on-close) in its own workspace while still
listing under the home run panel.

## Authoring

Use `skills/paseo-create-workflow` (or the Workflow page: Fork builtin / blank
template / Start agent). The skill documents `agent()` opts including
`effort` / `mode` / `fast`. Validate with `aw validate` from
`packages/agents-workflow`. Types: `packages/agents-workflow/workflow.d.ts`.

The sandbox realm bans `Date.now()` / `new Date()` / `Math.random()`
(determinism) — it also simply has no `setTimeout`/`setInterval`
(`ReferenceError`, not a ban): there is no delay/poll primitive in a flow
script.

## Lint note

`packages/agents-workflow` is currently ignored by root oxlint (faithful
migration of the upstream engine). Package-local `npm test` / `tsc` are the
gates; a style pass to match Paseo oxlint rules is a follow-up.
