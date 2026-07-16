# agents-workflow

a Claude-Code-Workflow engine + CLI + a set of generic built-in flows. a flow is
a plain TS/JS body (`export const meta` + a function using the 8 globals); the
engine runs it deterministically against an injected backend. no yaml dag.

agents-workflow has NO runtime ordering belt: there is no artifact gate and no
FlowPolicy (runtime role ordering). agents-workflow adds NOTHING over vanilla
Claude Workflow — a faithful superset. ordering is just the order the `agent()`
calls are written; the `node:vm` sandbox + the static validator are the only
safety layers left.

## what's here

- `src/engine.ts` - `createEngine()`. owns the 8 workflow globals
  (`agent`/`parallel`/`pipeline`/`phase`/`log`/`budget`/`args`/`meta`), persona
  assembly (prompt library prepended to every prompt), structured-output
  validate+retry, concurrency limiting (p-limit), agent caps, per-batch caps,
  token budget, and the Journal resume cache. `agent()` is the only primitive
  that consumes a backend slot; `parallel()`/`pipeline()` just fan leaves out.
- `src/backend.ts` - `AgentBackend` interface. a backend only RUNS a prompt and
  hands back final text; structured output is the ENGINE's job, not the
  backend's.
- `src/backends/mock.ts` - `MockBackend`, the reference backend (default). zero
  infra, virtual-time latency, deterministic for tests. the engine can't tell it
  apart from a real one.
- `src/backends/paseo-host.ts` - `PaseoHostBackend` + `PaseoAgentHost` seam for
  in-daemon / protocol-backed runs (preferred for Paseo workflows). Forwards
  `effort`/`mode`/`featureValues` (thinking, mode, features) to the host.
- `src/backends/paseo.ts` - `PaseoBackend`, runs each agent via the `paseo run`
  CLI against a local paseo daemon (`--thinking`/`--mode`/`--feature`).
  RESOLVES (never rejects) with `{ error }` on any failure so the engine maps
  it to `agent()===null` uniformly.
- `src/journal.ts` - `Journal` + `agentKey()`. resume cache: every completed
  `agent()` call is recorded under a deterministic key of (prompt, opts incl.
  schema/model/effort/label/phase). in-memory by default, optionally
  mirrored to a JSONL file.
- `src/sandbox.ts` - `runInSandbox()`. runs a workflow body in a fresh
  `node:vm` ECMAScript realm behind a MARSHALLING boundary (see below). real
  containment, not just codegen-off.
- `src/schema-normalize.ts` - the schema seam. accepts a zod schema OR an inline
  JSON-Schema object, `z.fromJSONSchema`->zod, canonical fingerprint. no
  hand-written validator, no ajv.
- `src/validator.ts` - `validateScript()`, the static-parse BELT (advisory) —
  flags dangerous tokens. there is no runtime ordering belt any more; ordering is
  just the order the `agent()` calls are written in the flow body.
- `src/registry.ts` - `resolveWorkflow()` / `listWorkflows()` over the built-in
  flow dirs.
- `src/cli.ts` + `src/cli-args.ts` - the `aw` CLI (`run` / `validate` /
  list), `--backend mock|paseo`.
- `src/prompt-library.ts` - persona assembly + the workflow-error SUBCLASSES
  (`WorkflowAgentCapError`, `WorkflowBudgetExceededError`) — base lives in `errors.ts`.
- `src/errors.ts` - `WorkflowError`, the base of the workflow-error tribe.
  re-exported by `index.ts` as the shared `catch (e instanceof WorkflowError)`
  root; the `prompt-library.ts` cap/budget errors extend it.
- `src/limit.ts` - `defaultConcurrency(cpuCount)`, the p-limit concurrency seam
  the engine's fan-out uses (exported by `index.ts`).
- `test/*.test.ts` - engine, backends (mock + paseo, incl. a `.live` suite),
  sandbox escape vectors, schema-normalize, journal resume,
  registry, validator, cli-args, and an end-to-end workflow run. all against the
  MockBackend — no real paseo, no tokens burned.
- `workflow.d.ts` - ambient TS types for authoring `*.flow.js`. A flow references
  it (`/// <reference path="…/workflow.d.ts" />`) to get editor IntelliSense +
  type-checking on the 8 injected globals, `AgentCallOpts`, and the `meta` shape.
  Self-contained (no imports), hand-mirrored from `src/engine.ts`; it's a comment,
  invisible to the engine. Documents the Claude Code `args`-as-string convention
  (do not invent `args.task` in builtin-style flows).
- `PaseoHostBackend` — daemon workflow path: injected `PaseoAgentHost`
  (createAgent + wait). Prefer this over shelling `paseo` on PATH.

## run it

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm test:coverage
```

## observability — live per-agent events (`onAgentEvent`)

For a live UI that renders each agent's state, pass `onAgentEvent` to `createEngine`. It
fires a per-agent lifecycle event IN THE ENGINE (not the backend — so resume cache
hits, which never touch the backend, are covered too). Every `agent()` call gets a
monotonic `id` (a stable UI node id):

```ts
createEngine({
  backend,
  onPhase: (p) => ui.setPhase(p), // phase transitions
  onLog: (m) => ui.pushLog(m), // narrator lines
  onAgentEvent: (ev) => ui.update(ev), // per-agent lifecycle
});
```

`AgentEvent` — state machine per `id`: `queued → start → (retry*) → complete | error`:

| `ev.type`  | when                                                               | UI                             |
| ---------- | ------------------------------------------------------------------ | ------------------------------ |
| `queued`   | created, waiting for a concurrency slot                            | node appears, grey / "pending" |
| `start`    | slot acquired, backend dispatched                                  | spinner / "running"            |
| `retry`    | structured-output validation failed, re-dispatching (`ev.attempt`) | "running (retry N)"            |
| `complete` | succeeded (`ev.usage` when reported; `ev.cached` on a resume hit)  | ✓                              |
| `error`    | backend errored / threw / retries exhausted (`ev.error`)           | ✗                              |

Every event carries `id`, `label`, `phase` (`opts.phase ?? active phase()`), and `model`
(the `opts.model` OVERRIDE; undefined = the session/backend default). A resume cache hit
emits `start`+`complete` back-to-back with `cached: true`. Post-run totals are in
`RunResult.stats` + `RunResult.budget`.

Not (yet) in the event: per-agent **tool-call count** and **live token usage while running**
(usage lands once on `complete` — the paseo backend recovers it post-hoc via one `paseo
inspect`; there is no mid-run stream). Per-agent **duration** is consumer-side: stamp the
`start`→`complete` event arrival. Total **elapsed** + the phase LIST/order come from the
consumer's clock + `meta.phases`.

### progress data model (headless) — `createProgressModel`

Raw events are a firehose. `createProgressModel(meta)` is the projection: it REDUCES the
raw `onPhase`/`onLog`/`onAgentEvent` stream into a render-ready snapshot (phases with
status + counts, agents with status/model/tokens/duration, stats, elapsed) and — on ANY
update — emits a deep-frozen **readonly clone** of the whole snapshot. View-agnostic: it
imports no UI; a renderer is a pure `(snapshot) => whatever` you own.

```ts
const model = createProgressModel(meta); // meta = extractMeta(source).meta
const engine = createEngine({ backend, ...model.hooks }); // wires onPhase/onLog/onAgentEvent
model.subscribe((snap) => render(snap)); // snap: frozen WorkflowSnapshot
await engine.run(source, { args });
```

`WorkflowSnapshot` maps 1:1 to a progress dashboard: `phases[]` (`pending`/`active`/`done`

- `done`/`total` + **`agents[]` grouped into each phase** so a TAB UI renders
  `phases[selected].agents` directly — phase selection is a pure VIEW choice the consumer
  owns, the model tracks none), a flat `agents[]` (`queued`/`running`/`retrying`/`done`/
  `failed`, `model`/`tokens`/`durationMs`/`cached`), `stats`, `elapsedMs`. Duration is stamped
  consumer-side (`now()` injectable for tests). A worked demo — a 3-phase migration flow
  driving a plain-text dashboard with switchable phase tabs (`renderDashboard(snap,
selectedPhase)`) — is in `examples/dashboard-demo.ts` (exercised + printed by
  `test/progress-model.test.ts`).

## sandbox containment (node:vm)

`runInSandbox()` runs the untrusted workflow body in a fresh realm. `node:vm`'s
`codeGeneration:{strings:false}` alone only blocks eval / `new Function` /
`x.constructor.constructor("...")()` for REALM-native objects; a host-native
object handed to the script leaks the HOST `Function` (host codegen, unaffected
by the realm flag), so `agent.constructor.constructor("return process")()` on a
host-injected `agent` really did read host files.

the fix is a MARSHALLING boundary — NOTHING host-native is ever named by, or
handed to, the script:

- ONE host object (`__aw_bridge__`) is injected; an in-context bootstrap
  captures it in a realm closure then DELETES it from the realm global.
- the 8 globals the script sees are all realm-native (defined by the bootstrap),
  so their `.constructor` is the realm's `Function` -> codegen off -> throws.
- DATA crossing host->realm (args, meta, every agent()/backend RESULT) is
  re-materialized realm-native (JSON string -> realm `JSON.parse`).
- OPAQUE host values passing THROUGH the realm (e.g. a zod schema in via args,
  back out via `agent()` opts) become numeric HANDLES; the real value stays in a
  host table.
- bridge errors come back as `{err:{name,message}}` and the realm rethrows a
  realm-native Error.

net: the reviewer's exact exploit
`agent.constructor.constructor("return process")()` (and via args / budget /
result / computed-access) THROWS inside the realm and can't reach host
process/require/fs. genuine containment for the workflow body.

## resume (Journal replay)

resume is the engine's Journal, NOT a checkpoint/gate model. every completed
`agent()` call is recorded under `agentKey(prompt, opts)` — a sha256 of the
prompt plus (schema fingerprint, model, effort, mode, fast, featureValues,
provider, agentType, label, phase). on resume, a call whose key already has a
cached result returns instantly WITHOUT hitting the backend, mirroring Claude's
"unchanged (prompt, opts) prefix returns cached" protocol.

- idempotent replay: cached results come back verbatim; no gates, no sentinels,
  no artifact re-stat.
- in-memory by default; pass a `path` to mirror the cache to a JSONL file so it
  survives across process runs (corrupt lines are skipped on load).
- conditional skip (e.g. "trivial bugs skip plan") is NOT an engine feature —
  it's just an `if`/ternary in the flow body deciding whether to call `agent()`.

> outputs: agents still write `outputs/*.md` for later phases to READ, but
> nothing stat-gates them — a missing/empty output surfaces when the downstream
> phase reads it, not via an engine gate.

## ordering: no runtime belt

agents-workflow has NO runtime ordering belt: there is no FlowPolicy (a
role-ordering state machine) and no artifact gate.

for hand-written flows the delivery order (e.g. verify-before-deliver,
scan-before-publish) is already the literal ORDER the `agent()` calls are
written in the flow body, so a runtime enforcement belt added little. ordering
is now just code order.

load-bearing outputs (e.g. a delivered MR) are covered à-la-carte by an in-flow
verifier `agent()` (a deterministic external check), NOT by an engine gate. the
`node:vm` marshalling sandbox + the static `validateScript()` belt are the only
safety layers left; agents-workflow now adds NOTHING over vanilla Claude Workflow.
