// Headless progress DATA MODEL — a view-agnostic projection of the engine's raw
// events (onPhase / onLog / onAgentEvent) into a render-ready snapshot.
//
// Wire its `hooks` into createEngine, then `subscribe` — on ANY update it emits a
// deep-frozen READONLY clone of the whole snapshot (phases + agents + stats), so a
// UI just re-renders the latest snapshot. The model NEVER imports a view; a renderer
// is a pure `(snapshot) => whatever` the consumer owns (see examples/dashboard-demo.ts).
//
//   const model = createProgressModel(meta);
//   const engine = createEngine({ backend, ...model.hooks });
//   model.subscribe((snap) => render(snap));   // snap is a frozen readonly clone
//   await engine.run(source, { args });
import type { AgentEvent, WorkflowMeta } from "./engine.js";

export type AgentStatus = "queued" | "running" | "retrying" | "done" | "failed";
export type PhaseStatus = "pending" | "active" | "done";

export interface AgentView {
  /** stable node id (the engine's per agent() call). */
  id: number;
  label?: string;
  phase?: string;
  /** model override; undefined = session/backend default. */
  model?: string;
  status: AgentStatus;
  /** true when served from the resume journal (never ran the backend). */
  cached: boolean;
  /** structured-output retry attempt (0 until the first retry). */
  attempt: number;
  /** output tokens, once done + the backend reported usage. */
  tokens?: number;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
}

export interface PhaseView {
  title: string;
  detail?: string;
  status: PhaseStatus;
  /** agents SEEN in this phase so far. */
  total: number;
  /** agents in this phase that reached a terminal state (done | failed). */
  done: number;
  /** this phase's agents — so a tab UI renders `phases[selected].agents` directly
   *  (no filtering). Same AgentView objects as the top-level `agents[]`. */
  agents: AgentView[];
}

export interface WorkflowSnapshot {
  name?: string;
  description?: string;
  activePhase?: string;
  phases: PhaseView[];
  /** every agent seen, in creation order. */
  agents: AgentView[];
  stats: {
    total: number;
    queued: number;
    running: number;
    retrying: number;
    done: number;
    failed: number;
  };
  /** wall-clock since the model was created (host-side; the engine bans clocks in the sandbox, not here). */
  elapsedMs: number;
  /** bounded tail of log() lines. */
  logs: string[];
}

export interface ProgressModel {
  /** wire these into createEngine({ backend, ...model.hooks }). */
  hooks: {
    onPhase: (name: string) => void;
    onLog: (msg: string) => void;
    onAgentEvent: (ev: AgentEvent) => void;
  };
  /** subscribe to snapshots (fired on every update); returns an unsubscribe fn. */
  subscribe: (fn: (snap: WorkflowSnapshot) => void) => () => void;
  /** pull the current snapshot (a fresh frozen clone). */
  snapshot: () => WorkflowSnapshot;
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

export function createProgressModel(
  meta: WorkflowMeta,
  opts: { now?: () => number; maxLogs?: number } = {},
): ProgressModel {
  const now = opts.now ?? ((): number => Date.now());
  const maxLogs = opts.maxLogs ?? 50;
  const start = now();
  const metaPhases = (Array.isArray(meta.phases) ? meta.phases : []) as Array<{
    title: string;
    detail?: string;
  }>;
  const order = metaPhases.map((p) => p.title);
  const detailOf = new Map(metaPhases.map((p) => [p.title, p.detail]));
  let activePhase: string | undefined;
  const agents = new Map<number, AgentView>(); // insertion-ordered = creation order
  const logs: string[] = [];
  const subs = new Set<(s: WorkflowSnapshot) => void>();

  function build(): WorkflowSnapshot {
    // clone every agent ONCE; the same clone objects are shared by the flat
    // `agents[]` and each `phases[].agents[]` (both frozen, so sharing is safe).
    const arr = [...agents.values()].map((a) => ({ ...a }));
    const activeIdx = activePhase ? order.indexOf(activePhase) : -1;
    // phases seen on agents but NOT declared in meta -> append, keep it robust.
    const extra = [
      ...new Set(arr.map((a) => a.phase).filter((p): p is string => !!p && !order.includes(p))),
    ];
    const phases: PhaseView[] = [...order, ...extra].map((title) => {
      const inMeta = order.includes(title);
      const idx = inMeta ? order.indexOf(title) : -1;
      let status: PhaseStatus = "pending";
      if (title === activePhase) status = "active";
      else if (inMeta && activeIdx >= 0 && idx < activeIdx) status = "done";
      const mine = arr.filter((a) => a.phase === title);
      const done = mine.filter((a) => a.status === "done" || a.status === "failed").length;
      return { title, detail: detailOf.get(title), status, total: mine.length, done, agents: mine };
    });
    const count = (s: AgentStatus): number => arr.filter((a) => a.status === s).length;
    return deepFreeze({
      name: meta.name,
      description: meta.description,
      activePhase,
      phases,
      agents: arr,
      stats: {
        total: arr.length,
        queued: count("queued"),
        running: count("running"),
        retrying: count("retrying"),
        done: count("done"),
        failed: count("failed"),
      },
      elapsedMs: now() - start,
      logs: [...logs],
    });
  }

  function emit(): void {
    const s = build();
    for (const fn of subs) fn(s);
  }

  function upsert(ev: AgentEvent): AgentView {
    let a = agents.get(ev.id);
    if (!a) {
      a = {
        id: ev.id,
        label: ev.label,
        phase: ev.phase,
        model: ev.model,
        status: "queued",
        cached: false,
        attempt: 0,
      };
      agents.set(ev.id, a);
    }
    if (ev.label !== undefined) a.label = ev.label;
    if (ev.phase !== undefined) a.phase = ev.phase;
    if (ev.model !== undefined) a.model = ev.model;
    if (ev.cached) a.cached = true;
    return a;
  }

  return {
    hooks: {
      onPhase(name): void {
        activePhase = name;
        emit();
      },
      onLog(msg): void {
        logs.push(msg);
        if (logs.length > maxLogs) logs.shift();
        emit();
      },
      onAgentEvent(ev): void {
        const a = upsert(ev);
        switch (ev.type) {
          case "queued":
            a.status = "queued";
            break;
          case "start":
            a.status = "running";
            a.startedAt = now();
            break;
          case "retry":
            a.status = "retrying";
            a.attempt = ev.attempt ?? a.attempt;
            break;
          case "complete":
            a.status = "done";
            a.tokens = ev.usage?.outputTokens;
            a.finishedAt = now();
            if (a.startedAt !== undefined) a.durationMs = a.finishedAt - a.startedAt;
            break;
          case "error":
            a.status = "failed";
            a.error = ev.error;
            a.finishedAt = now();
            if (a.startedAt !== undefined) a.durationMs = a.finishedAt - a.startedAt;
            break;
        }
        emit();
      },
    },
    subscribe(fn): () => void {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    snapshot(): WorkflowSnapshot {
      return build();
    },
  };
}
