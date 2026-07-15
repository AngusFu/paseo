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
- `runs/{runId}/journal.jsonl` — optional engine journal
- `rules.json` — Kanban source → workflow auto-trigger rules

Builtin flows are read-only from the package
(`packages/agents-workflow/workflows/builtin/`). Creating “from builtin” copies
source into a user definition.

## Run isolation

Each run gets a dedicated directory under `runs/{runId}/` used as `cwd` /
`workspacePath` (v1). Optional `cwd` / `repoPath` on dispatch can override.
Creating a full Paseo worktree from a repo path is a follow-up; the per-run
directory already isolates artifacts (`runtimeDir` + `key` = run id).

## Concurrency (two layers)

1. **Product queue** (`WorkflowQueue`): global max concurrent **runs** (default 2),
   FIFO. Excess stays `queued` until a slot frees (success/fail/cancel).
2. **Engine `p-limit`**: limits concurrent `agent()` calls **inside** one run.
   Does not replace the product queue.

## Protocol

Dotted RPCs (`docs/rpc-namespacing.md`):

- `workflow.definition.{list,get,create,update,delete,list_builtins}`
- `workflow.run.{list,get,dispatch,cancel}`
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

## Authoring

Use `skills/paseo-create-workflow` or the Workflow page (copy builtin / blank
template). Validate with `aw validate` from `packages/agents-workflow`.

## Lint note

`packages/agents-workflow` is currently ignored by root oxlint (faithful
migration of the upstream engine). Package-local `npm test` / `tsc` are the
gates; a style pass to match Paseo oxlint rules is a follow-up.
