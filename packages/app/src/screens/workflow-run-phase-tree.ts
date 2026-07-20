/**
 * Rebuild the workflow engine's live progress tree (phase → agent calls)
 * from a run's event log entries. Entries stream in seq order and the logs
 * hook polls every second while the run is live, so the tree tracks the
 * engine in near real time — and survives refresh/reconnect because the log
 * is persisted. Older daemons never emit callId-tagged entries, so the tree
 * is simply empty there and the UI section hides itself.
 */
import type { WorkflowLogEntry } from "@getpaseo/protocol/workflow/types";

export type PhaseAgentStatus = "queued" | "running" | "retrying" | "done" | "error";

export interface PhaseTreeAgent {
  callId: number;
  label: string | null;
  model: string | null;
  cached: boolean;
  status: PhaseAgentStatus;
  /** ISO ts of `agent.start`; null while the call is still queued. */
  startedAt: string | null;
  /** ISO ts of `agent.complete` / `agent.error`; null while in flight. */
  endedAt: string | null;
  /**
   * The Paseo agent this call spawned, from the host's `agent.done` /
   * `agent.failed` entry — so it only lands once the call finished. Live rows
   * resolve their agent from the `paseo.workflow-call-id` agent label instead.
   */
  agentId: string | null;
}

export interface PhaseTreeGroup {
  // null = agent() calls made outside any phase().
  title: string | null;
  agents: PhaseTreeAgent[];
}

export function buildWorkflowPhaseTree(entries: WorkflowLogEntry[]): PhaseTreeGroup[] {
  const agents = new Map<number, PhaseTreeAgent & { phase: string | null }>();
  const phaseOrder: Array<string | null> = [];
  const seenPhases = new Set<string | null>();
  const notePhase = (phase: string | null): void => {
    if (!seenPhases.has(phase)) {
      seenPhases.add(phase);
      phaseOrder.push(phase);
    }
  };

  for (const entry of entries) {
    if (entry.event === "phase") {
      notePhase(entry.message);
      continue;
    }
    if (entry.event.startsWith("agent.")) {
      applyAgentLogEntry(agents, notePhase, entry);
    }
  }

  if (agents.size === 0) {
    return [];
  }
  const groups: PhaseTreeGroup[] = [];
  for (const title of phaseOrder) {
    const members = [...agents.values()]
      .filter((agent) => agent.phase === title)
      .sort((left, right) => left.callId - right.callId);
    if (title === null && members.length === 0) {
      continue;
    }
    groups.push({ title, agents: members });
  }
  return groups;
}

// Engine events per callId are strictly ordered (queued → start → retry* →
// complete | error), so each event maps directly to the current status.
function phaseAgentStatusForEvent(event: string): PhaseAgentStatus | null {
  if (event === "agent.queued") return "queued";
  if (event === "agent.start") return "running";
  if (event === "agent.retry") return "retrying";
  if (event === "agent.complete") return "done";
  if (event === "agent.error") return "error";
  return null;
}

function readStringField(data: Record<string, unknown> | undefined, key: string): string | null {
  const value = data?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function applyAgentLogEntry(
  agents: Map<number, PhaseTreeAgent & { phase: string | null }>,
  notePhase: (phase: string | null) => void,
  entry: WorkflowLogEntry,
): void {
  const data = entry.data;
  const callId = typeof data?.callId === "number" ? data.callId : null;
  if (callId === null) {
    return;
  }
  const phase = readStringField(data, "phase");
  notePhase(phase);
  const existing = agents.get(callId);
  const agent = existing ?? {
    callId,
    phase,
    label: readStringField(data, "label"),
    model: readStringField(data, "model"),
    cached: false,
    status: "running" as PhaseAgentStatus,
    startedAt: null,
    endedAt: null,
    agentId: null,
  };
  const status = phaseAgentStatusForEvent(entry.event);
  if (status) {
    agent.status = status;
  }
  // Keep the event timestamps so the UI can time each call. A retry restarts
  // the clock and clears the previous terminal stamp.
  if (entry.event === "agent.start" || entry.event === "agent.retry") {
    agent.startedAt = entry.ts;
    agent.endedAt = null;
  }
  if (entry.event === "agent.complete" || entry.event === "agent.error") {
    agent.endedAt = entry.ts;
  }
  if (data?.cached === true) {
    agent.cached = true;
  }
  // `agent.done` / `agent.failed` come from the host wrapper and are the only
  // entries that name the spawned agent. A retry re-emits with the new agent,
  // and entries arrive in seq order, so last write is the current attempt.
  const agentId = readStringField(data, "agentId");
  if (agentId) {
    agent.agentId = agentId;
  }
  agents.set(callId, agent);
}

const TERMINAL_PHASE_AGENT_STATUSES = new Set<PhaseAgentStatus>(["done", "error"]);

export interface PhaseSummary {
  title: string | null;
  /** Agent calls in this phase. */
  total: number;
  /** Calls that reached a terminal status (done or error). */
  done: number;
  /** True while any call here is queued, running or retrying. */
  hasActive: boolean;
}

/** done/total counts per phase, for the phase list. Derived, never persisted. */
export function summarizeWorkflowPhases(groups: readonly PhaseTreeGroup[]): PhaseSummary[] {
  return groups.map((group) => {
    const done = group.agents.filter((agent) =>
      TERMINAL_PHASE_AGENT_STATUSES.has(agent.status),
    ).length;
    return {
      title: group.title,
      total: group.agents.length,
      done,
      hasActive: group.agents.some((agent) => !TERMINAL_PHASE_AGENT_STATUSES.has(agent.status)),
    };
  });
}

/**
 * The phase to highlight: the first one still doing work, else the last one
 * that ran anything (a finished run rests on its final phase). -1 when there
 * is nothing to show.
 */
export function resolveCurrentPhaseIndex(groups: readonly PhaseTreeGroup[]): number {
  const summaries = summarizeWorkflowPhases(groups);
  const active = summaries.findIndex((summary) => summary.hasActive);
  if (active !== -1) {
    return active;
  }
  for (let index = summaries.length - 1; index >= 0; index -= 1) {
    if ((summaries[index]?.total ?? 0) > 0) {
      return index;
    }
  }
  return groups.length > 0 ? 0 : -1;
}

/**
 * Milliseconds a call has been running: start→end once it finished, start→now
 * while in flight. Null when it has not started (queued) or the stamps are
 * unusable, so the UI can show a dash instead of a fake zero.
 */
export function resolveAgentElapsedMs(
  agent: Pick<PhaseTreeAgent, "startedAt" | "endedAt">,
  nowMs: number,
): number | null {
  if (!agent.startedAt) {
    return null;
  }
  const start = Date.parse(agent.startedAt);
  if (!Number.isFinite(start)) {
    return null;
  }
  const end = agent.endedAt ? Date.parse(agent.endedAt) : nowMs;
  if (!Number.isFinite(end)) {
    return null;
  }
  return Math.max(0, end - start);
}

/** Same shape for the whole run: startedAt→endedAt, or →now while live. */
export function resolveRunElapsedMs(
  run: { startedAt: string | null; endedAt: string | null },
  nowMs: number,
): number | null {
  return resolveAgentElapsedMs({ startedAt: run.startedAt, endedAt: run.endedAt }, nowMs);
}

/**
 * Wireframe timer format: `48s`, `1m 02s`, `12m 30s`, `1h 04m`. Seconds are
 * zero-padded past the first minute so the right-aligned column stays steady.
 */
export function formatWorkflowElapsed(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) {
    return "—";
  }
  const totalSeconds = Math.floor(durationMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${String(totalMinutes % 60).padStart(2, "0")}m`;
}
