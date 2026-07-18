---
name: paseo-create-workflow
description: Author a Paseo agents-workflow script — a Claude-Code-Workflow-compatible deterministic *.flow.js orchestration for @getpaseo/agents-workflow. Use when the user wants to write, generate, or edit a *.flow.js workflow — a bug/feature/review pipeline, a bug-sweep, a research/review fan-out, or any multi-agent orchestration run on the agents-workflow engine (mock or paseo backend). Also use for "create workflow", "paseo workflow", or editing flows under $PASEO_HOME/workflows.
---

# Authoring a Paseo workflow

`@getpaseo/agents-workflow` (`packages/agents-workflow`) runs **Claude-Code-Workflow scripts**: `export const meta = {...}` literal + a body using 8 globals. It is a faithful SUPERSET — a vanilla Claude Workflow script runs unchanged, and agents-workflow adds NO engine belts: no artifact gate, no role-ordering policy (both retired). Schema is authored the vanilla way (inline JSON Schema). The only extras are authoring conventions + an à-la-carte output-verifier pattern (see below).

User-authored definitions live under `$PASEO_HOME/workflows/definitions/` (daemon-managed). Builtin examples ship with the package at `packages/agents-workflow/workflows/builtin/*.flow.js`.

## STEP 0 — reuse the authoritative Workflow prompt

The methodology (primitives, patterns, when-to-fan-out, pipeline vs parallel, judge-panel, loop-until-dry, no-silent-caps) IS Claude Code's own Workflow tool prompt. Read it FIRST — do not reinvent:

- `references/G0s.final.txt` — the full Workflow tool prompt (19k, verbatim from cli.js).
- `references/workflow-full-report_2.1.207.md` — primitive contract + all built-in sources.
- Working examples, ALL inline JSON Schema:
  - Generic built-ins → `packages/agents-workflow/workflows/builtin/*.flow.js` (10 Anthropic flows). The package bakes in ONLY these — no host-domain data.

agents-workflow is a faithful superset — the notes below are authoring conventions + the à-la-carte verifier pattern, not new engine features.

## The 8 primitives (globals, no import)

`agent(prompt, opts?)` · `parallel(thunks)` · `pipeline(items, ...stages)` · `phase(name)` · `log(msg)` · `budget` · `args` · `meta`.

- `agent` without schema → returns final text (string) or `null`. With schema → returns validated object or `null`.
- `parallel(fns)` — concurrent; a throwing thunk → `null` slot, call NEVER rejects → `.filter(Boolean)`.
- `pipeline(items, ...stages)` — NO barrier, per-item independent chains; stage sig `(prev, originalItem, index)`; a stage throw drops THAT item to `null`, skips its rest.
- `budget` — `{ total, spent(), remaining() }`.
- `args` — see next section. **Default mental model: `args` is the user prompt** (a string), not a config bag.

## `agent()` opts — what each field is

Paseo forwards these into `createAgent` / `paseo run`. Prefer **omitting** them so the run inherits dispatch defaults (UI / CLI). Set them only when a phase truly needs a different tier — and only with ids you discovered on **this** host (next section).

| `agent(prompt, opts)` field                                                        | What value to put                                                         | Comes from discovery                                                           | Same as CLI / dispatch                |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------- |
| `provider`                                                                         | Provider id string, e.g. `"claude"`, `"codex"`, `"cursor"`                | `providers[].id`                                                               | `--provider`                          |
| `model`                                                                            | Model id for that provider, e.g. `"claude-opus-4-8"`, `"gpt-5.4"`         | `providers[].models[].id`                                                      | `--model`                             |
| `effort`                                                                           | Thinking / reasoning **option id** for that model (not a free-form label) | `models[].thinkingOptions[].id` (or `thinkingOptionIds[]` in CLI inspect JSON) | `--thinking`                          |
| `mode`                                                                             | Provider mode id, e.g. `"agent"`, `"plan"`, `"default"`                   | `providers[].modes[].id` (or `modeIds[]`)                                      | `--mode`                              |
| `fast`                                                                             | `true` / omit — convenience **only** for Claude/Codex boolean `fast_mode` | feature probe: toggle `id: "fast_mode"`                                        | `--fast` / `--feature fast_mode=true` |
| `featureValues`                                                                    | `{ [featureId]: boolean \| string }` — other toggles/selects              | `paseo provider features` / MCP `inspect_provider` → `features[]`              | `--feature key=value`                 |
| `label` / `phase` / `schema` / `isolation` / `agentType` / `labels` / `maxRetries` | Unchanged Claude-Workflow opts                                            | —                                                                              | as before                             |

```js
// Usual: inherit dispatch defaults (UI sheet / workflow run flags)
await agent(`Fix:\n\n${TASK}`, { phase: "Implement", label: "impl" });

// Per-call override — every id below must have been discovered first:
await agent(prompt, {
  phase: "Plan",
  provider: "claude", // providers[].id
  model: "claude-opus-4-8", // models[].id
  effort: "high", // thinkingOptions[].id  ← NOT invented
  mode: "plan", // modes[].id
  fast: true, // Claude/Codex only; else use featureValues
  // featureValues: { plan_mode: true },           // other toggles
  // featureValues: { fast: "true" },              // Cursor select (string option id)
});
```

**Dispatch defaults** (UI “执行” sheet / `paseo workflow run`): `provider`, `model`, `effort` (CLI `--thinking`), `mode`, `fast`. Stored on the run; applied as `PaseoHostBackend` defaults for every `agent()` that omits them. See `docs/workflow.md`.

```bash
paseo workflow run <id> --cwd /repo --arg task="fix login" \
  --provider claude --model claude-opus-4-8 --thinking high --mode agent --fast

paseo run --provider claude --thinking high --mode agent \
  --feature fast_mode=true -- "fix login"
```

## Discover ids before hard-coding (cascaded)

**Do not invent** provider / model / effort / mode / feature ids. They differ by host install and selected model. Always query the **running daemon** with the installed `paseo` binary (not a checkout `npm run cli`). Inside a Paseo agent, use MCP instead (needs Inject Paseo tools).

### Cascade (always this order)

```
1) Snapshot  → pick provider + mode + model + effort
2) Features  → only after you know provider + model (+ mode/thinking if gated)
3) Write     → agent() / dispatch flags using those exact ids
```

| Step | CLI                                                                           | MCP                                                                                     | You get                                              |
| ---- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1    | `paseo provider inspect --cwd <path> --json`                                  | `inspect_providers` `{ cwd }`                                                           | enabled providers → modes → models → thinkingOptions |
| 1b   | `paseo provider inspect --provider <p> --cwd <path> --json`                   | `inspect_providers` `{ cwd, provider }`                                                 | same, one provider                                   |
| 1c   | `paseo provider inspect --cwd <path> --all --json`                            | `inspect_providers` `{ cwd, all: true }`                                                | include disabled                                     |
| 2    | `paseo provider features <p> --cwd <path> --model <id> [--mode] [--thinking]` | `inspect_provider` `{ provider, cwd, settings: { model, modeId?, thinkingOptionId? } }` | `features[]` toggles/selects                         |

Piecewise equivalents of step 1: `provider ls` → `provider models <p> --thinking` (or MCP `list_providers` → `list_models`). Prefer `inspect` / `inspect_providers` so you do not chain three calls for the snapshot.

### Demo — CLI cascade → `agent()` opts

```bash
# Step 1 — snapshot (cheap; no feature probes)
paseo provider inspect --cwd "$PWD" --json
```

Example shape (abbreviated):

```json
{
  "providers": [
    {
      "id": "claude",
      "modeIds": ["default", "bypassPermissions"],
      "modes": [{ "id": "default", "label": "Default" }],
      "models": [
        {
          "id": "claude-opus-4-8",
          "thinkingOptionIds": ["low", "medium", "high", "max"],
          "defaultThinkingOptionId": "high"
        }
      ]
    }
  ]
}
```

```bash
# Step 2 — features for the chosen provider+model (draft probe)
paseo provider features claude --cwd "$PWD" --model claude-opus-4-8 --json
```

```json
[
  { "id": "fast_mode", "type": "toggle", "value": "false" },
  { "id": "plan_mode", "type": "toggle", "value": "false" }
]
```

```js
// Step 3 — map 1:1 into agent() (or omit and set the same ids on workflow run)
await agent(`Investigate and fix:\n\n${TASK}`, {
  phase: "Implement",
  provider: "claude", // providers[].id
  model: "claude-opus-4-8", // models[].id
  effort: "high", // thinkingOptionIds / thinkingOptions[].id
  mode: "default", // modeIds / modes[].id
  fast: true, // because features has toggle fast_mode
  // featureValues: { plan_mode: true },
});
```

Cursor example (select feature, **not** `fast_mode`):

```bash
paseo provider inspect --provider cursor --cwd "$PWD" --json
paseo provider features cursor --cwd "$PWD" --model composer-2 --mode agent --json
# → feature { id: "fast", type: "select", options: "false …, true …" }
```

```js
await agent(prompt, {
  provider: "cursor",
  model: "composer-2",
  mode: "agent",
  featureValues: { fast: "true" }, // select option id — string, not boolean fast_mode
});
```

### Demo — MCP cascade (when you are already a Paseo agent)

```
# Step 1
inspect_providers { cwd: "/path/to/repo" }
  → pick providers[i].id
  → pick providers[i].modes[j].id          → agent mode
  → pick providers[i].models[k].id         → agent model
  → pick models[k].thinkingOptions[n].id   → agent effort

# Step 2 (only if you need features)
inspect_provider {
  provider: "claude",
  cwd: "/path/to/repo",
  settings: { model: "claude-opus-4-8", modeId: "default", thinkingOptionId: "high" }
}
  → features[].id + value / option ids     → fast / featureValues
```

### Rules

- Prefer omitting `provider`/`model`/`effort`/`mode`/`fast` so **dispatch defaults** apply; hard-code only after lookup for this host.
- Feature **ids are provider-specific** — Claude/Codex: boolean `fast_mode` (or `fast: true`). Cursor: select `fast` with string option ids. Never assume Cursor accepts `fast_mode`.
- Empty `features` is normal (no knobs for that combo) — not a tool failure.
- Live daemon required for models/features. `provider ls` without a daemon falls back to a static mode list only.

## `args` — it's the prompt (read this)

For almost every Claude Code / Paseo builtin-style flow, **`args` is the task text the user typed** — the research question, bug description, `"high src/foo.ts"` review spec, etc. Treat it like the workflow's prompt input, not like `opts` or a typed API.

```js
// Canonical (matches Claude Code builtins):
const TASK = typeof args === "string" && args.trim() ? args.trim() : "";
if (!TASK) return { error: "No task provided. Pass the task description as args." };

// Then weave TASK into agent() prompts:
await agent(`Investigate and fix:\n\n${TASK}`, { phase: "Implement", effort: "high" });
```

**Hard rules**

- Do **not** invent `args.task` / `args.prompt` / `args.query`. The string _is_ the prompt.
- Do **not** require callers to pass `{ task: "..." }` for a simple run. If the script only needs a task, it reads a string.
- Paseo UI may _store_ `{ task, provider, model, effort, mode, fast }` on the run record (those are host defaults for the backend). The daemon converts task-only dispatches into a **bare string** before the sandbox — your script still sees `args === "fix the flaky test"`. Per-call overrides: `agent(prompt, { effort: "high", mode: "agent", fast: true })`.

**When `args` is not a string** (exception, not the default): the caller/CLI may pass a real JSON object or array — file lists, Kanban card fields, etc. Object args from a host may also carry `runtimeDir` / `key` for run-scoped artifact paths. Only then is `args.runtimeDir` meaningful; a task-string dispatch has neither field. Prefer designing task-like flows around the string prompt; reach for object args only when you truly need structured inputs.

## Editor types (IntelliSense on the globals)

The globals are injected — an editor sees bare `agent`/`phase`/`args` as `any`. Reference
the ambient types file at the TOP of a flow to get autocomplete + type-checking on the
primitives, `AgentCallOpts`, and the `meta` shape (`packages/agents-workflow/workflow.d.ts`):

```js
/// <reference path="../../packages/agents-workflow/workflow.d.ts" />   // path is relative to THE FLOW
/** @type {WorkflowMeta} */
export const meta = { name: 'my-flow', description: '...', phases: [{ title: 'Scan' }] }

phase('Scan')
const r = await agent('find X', {
  schema: {...},
  phase: 'Scan',
  effort: 'high',
  mode: 'agent',
  fast: true,
})  // opts typed — see AgentCallOpts in workflow.d.ts
```

Reference path is relative to the flow file: builtin flows (`packages/agents-workflow/workflows/builtin/*.flow.js`)
use `../../workflow.d.ts`. The `.d.ts` is self-contained (hand-mirrored from
`src/engine.ts`); it is a comment, invisible to the engine/sandbox/validator. It documents
the same `args`-as-prompt convention above, plus `effort` / `mode` / `fast` / `featureValues`.

## `meta` — MUST be a pure literal

```js
export const meta = {
  name: "my-flow",
  description: "one line, shown in list",
  phases: [{ title: "Scan", detail: "..." }, { title: "Fix" }],
};
```

No variables, no function calls, no spreads, no template interpolation. `aw list` reads it (evaluated in a locked empty realm — a getter/IIFE that loops or touches host is bounded/blocked).

## Schema — inline JSON Schema (zod-validated)

- Every structured `agent()` call carries an INLINE JSON Schema object — the vanilla Claude-Workflow way: `agent(prompt, { schema: { type:'object', required:[...], properties:{...} } })`. The engine converts it via `z.fromJSONSchema` → zod → `safeParse`; there is no ajv. There is NO `schemaRef` / host-side registry — a `.flow.js` cannot `import zod`, so it authors the JSON Schema literal directly.
- **DRY the schemas.** Define a tiny `S` map at the top of the flow via a helper, then `schema: S['triage']`. Keeps ONE shape per phase IN-FILE — no external registry:
  ```js
  const obj = (properties, required) => ({ type: "object", properties, required: required || [] });
  const S = {
    triage: obj({ tier: { type: "string", enum: ["standard", "trivial", "complex"] } }, ["tier"]),
  };
  ```
- Author ONLY the domain fields a phase actually reads, then drive control flow off them (`if (!result.passed) return ...`). There is NO envelope base — the old `{ phase, status, artifact }` shape died with the artifact gate; nothing reads or enforces it now.

## Verifying critical outputs — à-la-carte (NOT a blanket gate)

agents-workflow has NO engine artifact gate. For the 1–2 outputs you genuinely must trust (a delivered MR, a final report), add a POINT verifier — a plain `agent()` that runs a DETERMINISTIC command and returns a boolean. Advisory by default (a false only warns); escalate to a `return`/hold if that output is load-bearing.

## Artifact file paths — DISTINCT, absolute, run-scoped (hard rule)

Every file-PRODUCING phase MUST declare its own absolute, run-scoped artifact FILE path, built from `args.runtimeDir` + `args.key` — e.g. `const RCA_OUT = args.runtimeDir + '/' + args.key + '/rca-a.md'`. Then inject that EXACT path into the producer's prompt ("write to <path>") AND into each downstream consumer's prompt ("read <path>") — path-passing via an `artifact` schema field, not a "look for a file" hope.

- NEVER a bare directory (an unnamed dir = artifacts unlocatable downstream).
- NEVER a shared filename across two producers in the SAME `parallel()`/`pipeline()` batch — two parallel producers writing the same path CLOBBER each other. Give each a distinct file (`rca-a.md`, `rca-b.md`, or suffix by index).

## Ordering = just code order

agents-workflow has NO role-ordering policy (FlowPolicy retired). A delivery pipeline's order — STR before commit, secret-scan before push — is simply the ORDER you write the `agent()` calls in. If a step must not be skipped, don't write a path that skips it (and for the load-bearing outputs, add an à-la-carte verifier above).

## Control flow = plain JS

Conditional skip = a plain `if`/ternary. Attribution/early exit = a plain `return`. That is the whole point over a yaml DAG.

## Sandbox / validator — what gets REJECTED

The script runs in a `node:vm` realm and is static-checked by `aw validate`. FORBIDDEN (validator + sandbox both bite):

- `import` / `require` / `process` / `globalThis` / `Buffer` / `child_process` / `fs`/`net`/`http` / `fetch(` / `eval` / `new Function` / `.constructor` / `\u`-escaped identifiers.
- `Date.now()` / `new Date()` / `Math.random()` (determinism ban — pass timestamps via `args`, vary by index for "randomness").
- No Node API, no filesystem, no network. Only the 8 globals + standard JS built-ins (JSON/Math/Array/…).
- `setTimeout`/`setInterval` are not defined in the sandbox realm (`ReferenceError: setTimeout is not defined`) — there is no delay/poll primitive; don't reach for one.

## Run · validate · test

```bash
# Static check (agents-workflow CLI — install @getpaseo/agents-workflow or use npx)
aw validate <name|path>                 # MUST pass
# or: npx --package=@getpaseo/agents-workflow aw validate <name|path>

aw run <name> --backend mock            # dry-run (free)

# Real dispatch via the user's Paseo daemon
paseo workflow run <id> --cwd /path/to/repo --arg task="…" \
  --provider claude --thinking high --mode agent
```

Or via the Paseo Workflow page / `workflow.run.dispatch` RPC (daemon creates an isolated workspace per run). Dispatch can set default `provider` / `model` / `effort` / `mode` / `fast` for the whole run.

## Authoring checklist

1. `meta` pure literal + `phases`.
2. **`args` = the prompt.** For task-like flows: string-guard
   (`typeof args === "string" && args.trim()`) → weave that string into `agent()` prompts.
   Missing → `return { error }`. Never invent `args.task` / `args.prompt`.
3. Each phase = `phase('X')` + `agent(prompt, opts)`; null-guard every result (`if (!x) return {...}`). Prefer omitting `provider`/`model`/`effort`/`mode`/`fast` so dispatch defaults apply. If you hard-code them: cascade discover first (`inspect` → `features`) and map ids 1:1 (`provider`/`model`/`effort`/`mode`/`featureValues`).
4. Schema: inline JSON Schema (DRY it with an in-file `S` map). File-producing phase → build a DISTINCT absolute path from `args.runtimeDir`/`args.key` (only when the caller passed an **object** args — not present for a bare task-string dispatch); never a bare dir, never a shared filename across parallel producers.
5. Ordering (STR before deliver, secret-scan before egress) = just the order you write the `agent()` calls; no policy enforces it. Add an à-la-carte verifier for load-bearing outputs.
6. Conditional skip / early exit = plain `if`/`return`.
7. `aw validate` clean → `run --backend mock` smoke → real backend / daemon dispatch.
8. No banned tokens, no `Date`/`Math.random`, no imports.
