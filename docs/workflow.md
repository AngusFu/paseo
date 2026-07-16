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

If a run has no `events.jsonl` yet (older daemons / pre-event-log runs),
`workflow.run.logs` reconstructs a timeline from the run record +
`journal.jsonl` so finished/failed runs still show history.

Builtin flows are read-only from the package
(`packages/agents-workflow/workflows/builtin/`, ids `builtin:<name>`). They can be
**dispatched directly** as templates, or forked into a user definition to edit.

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
- `fast` — boolean convenience for Claude-style `fast_mode`
  (`defaultFeatureValues.fast_mode`)
- `featureValues` — optional object of provider features merged into defaults
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

## Concurrency (two layers)

1. **Product queue** (`WorkflowQueue`): global max concurrent **runs** (default 2),
   FIFO. Excess stays `queued` until a slot frees (success/fail/cancel).
2. **Engine `p-limit`**: limits concurrent `agent()` calls **inside** one run.
   Does not replace the product queue.

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

## Authoring

Use `skills/paseo-create-workflow` (or the Workflow page: Fork builtin / blank
template / Start agent). The skill documents `agent()` opts including
`effort` / `mode` / `fast`. Validate with `aw validate` from
`packages/agents-workflow`. Types: `packages/agents-workflow/workflow.d.ts`.

## Lint note

`packages/agents-workflow` is currently ignored by root oxlint (faithful
migration of the upstream engine). Package-local `npm test` / `tsc` are the
gates; a style pass to match Paseo oxlint rules is a follow-up.
