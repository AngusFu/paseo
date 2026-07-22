/**
 * Identity and clipboard text for a single workflow run event-log line.
 *
 * The daemon already stamps every entry with a monotonic `seq` and writes it to
 * `$PASEO_HOME/workflows/runs/{runId}/events.jsonl`, so `{runId}#{seq}` is an
 * identifier that already exists on disk — no new id is minted. Pasted into a
 * chat it is enough for an agent to grep the exact line back out of the log.
 *
 * Copy text carries the raw ISO timestamp rather than the rendered clock time:
 * the on-screen time is locale- and timezone-dependent, which makes it useless
 * for matching against the log file.
 */
import type { WorkflowLogEntry } from "@getpaseo/protocol/workflow/types";

/** Stable, greppable identifier for one event-log line. */
export function formatWorkflowLogEntryId(runId: string, seq: number): string {
  return `${runId}#${seq}`;
}

/** Short form shown in the gutter — the run is already named by the sheet. */
export function formatWorkflowLogEntrySeq(seq: number): string {
  return `#${seq}`;
}

function formatLevel(level: string): string {
  return level.toUpperCase();
}

/** One clipboard line: identifier, then the entry's own content. */
export function buildWorkflowLogEntryCopyText(runId: string, entry: WorkflowLogEntry): string {
  const head = `[${formatWorkflowLogEntryId(runId, entry.seq)}] ${entry.ts} ${formatLevel(
    entry.level,
  )} ${entry.event} ${entry.message}`.trimEnd();
  // `data` holds the structured payload behind the message (agent ids, exit
  // codes) — the part an agent actually needs and the UI never renders.
  if (entry.data && Object.keys(entry.data).length > 0) {
    return `${head}\n  data: ${JSON.stringify(entry.data)}`;
  }
  return head;
}

/** Copy-all uses the same per-line shape so bulk-pasted logs stay addressable. */
export function buildWorkflowLogCopyText(
  runId: string,
  entries: readonly WorkflowLogEntry[],
): string {
  return entries.map((entry) => buildWorkflowLogEntryCopyText(runId, entry)).join("\n");
}
