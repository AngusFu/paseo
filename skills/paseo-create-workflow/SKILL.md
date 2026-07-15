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

## Editor types (IntelliSense on the globals)

The globals are injected — an editor sees bare `agent`/`phase`/`args` as `any`. Reference
the ambient types file at the TOP of a flow to get autocomplete + type-checking on the
primitives, `AgentCallOpts`, and the `meta` shape (`packages/agents-workflow/workflow.d.ts`):

```js
/// <reference path="../../packages/agents-workflow/workflow.d.ts" />   // path is relative to THE FLOW
/** @type {WorkflowMeta} */
export const meta = { name: 'my-flow', description: '...', phases: [{ title: 'Scan' }] }

phase('Scan')
const r = await agent('find X', { schema: {...}, phase: 'Scan', effort: 'high' })  // opts typed
```

Reference path is relative to the flow file: builtin flows (`packages/agents-workflow/workflows/builtin/*.flow.js`)
use `../../workflow.d.ts`. The `.d.ts` is self-contained (hand-mirrored from
`src/engine.ts`); it is a comment, invisible to the engine/sandbox/validator.

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

## Run · validate · test

```
cd packages/agents-workflow && npm run build
node dist/cli.js validate <name|path>                 # static belt — MUST pass
node dist/cli.js run <name> --backend mock            # dry-run (free)
node dist/cli.js run <name> --backend paseo --args '{"ticketId":"PROJ-1","runtimeDir":"/tmp/r","key":"k"}' --wait-timeout 5m
```

Or via the Paseo Workflow page / `workflow.run.dispatch` RPC (daemon creates an isolated workspace per run).

## Authoring checklist

1. `meta` pure literal + `phases`.
2. Read `args`; guard missing inputs → `return { error }`.
3. Each phase = `phase('X')` + `agent(prompt, opts)`; null-guard every result (`if (!x) return {...}`).
4. Schema: inline JSON Schema (DRY it with an in-file `S` map). File-producing phase → build a DISTINCT absolute path from `args.runtimeDir`/`args.key`; never a bare dir, never a shared filename across parallel producers.
5. Ordering (STR before deliver, secret-scan before egress) = just the order you write the `agent()` calls; no policy enforces it. Add an à-la-carte verifier for load-bearing outputs.
6. Conditional skip / early exit = plain `if`/`return`.
7. `aw validate` clean → `run --backend mock` smoke → real backend / daemon dispatch.
8. No banned tokens, no `Date`/`Math.random`, no imports.
