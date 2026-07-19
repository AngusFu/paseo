/**
 * Rebuild the workflow engine's live progress tree (phase → agent calls)
 * from a run's event log entries. Entries stream in seq order and the logs
 * hook polls every second while the run is live, so the tree tracks the
 * engine in near real time — and survives refresh/reconnect because the log
 * is persisted. Older daemons never emit callId-tagged entries, so the tree
 * is simply empty there and the UI section hides itself.
 */
import type { WorkflowLogEntry } from "@getpaseo/protocol/workflow/types";

export type PhaseAgentStatus = "running" | "retrying" | "done" | "error";

export interface PhaseTreeAgent {
  callId: number;
  label: string | null;
  model: string | null;
  cached: boolean;
  status: PhaseAgentStatus;
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

function phaseAgentStatusForEvent(event: string, isNew: boolean): PhaseAgentStatus | null {
  if (event === "agent.complete") return "done";
  if (event === "agent.error") return "error";
  if (event === "agent.retry") return "retrying";
  if (event === "agent.start" && isNew) return "running";
  return null;
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
  const phase = typeof data?.phase === "string" ? data.phase : null;
  notePhase(phase);
  const existing = agents.get(callId);
  const agent = existing ?? {
    callId,
    phase,
    label: typeof data?.label === "string" ? data.label : null,
    model: typeof data?.model === "string" ? data.model : null,
    cached: false,
    status: "running" as PhaseAgentStatus,
  };
  const status = phaseAgentStatusForEvent(entry.event, !existing);
  if (status) {
    agent.status = status;
  }
  if (data?.cached === true) {
    agent.cached = true;
  }
  agents.set(callId, agent);
}
