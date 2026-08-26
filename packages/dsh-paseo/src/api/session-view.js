// AgentView projection: session.list items -> paseo-aligned agent rows.
//
// session.list item shape (live-verified 2026-08-26):
//   { sessionId, updatedAt, running, blank, parentSessionId?, origin?, cwd,
//     agentPreset, projections: { asOfSeq, values: {
//       sessionStats: { turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens },
//       contextTimeline: { ok, model, provider, contextWindow, current, toolList },
//     } } }
// Session display titles are NOT part of the list item; they arrive through
// the session.title RPC / title projection, so the view falls back to the cwd
// basename (matching DSH's own displayTitle fallback).

import { basename } from "node:path";
import { rpc, unwrap } from "./transport.js";

const SHORT_ID_RE = /^[0-9a-f]{6,8}/;

/**
 * Accept a full session id or its short prefix and resolve it against the live
 * list. Throws when ambiguous or unknown.
 * @param {string} base - resolved DSH Web base URL.
 * @param {string} sessionId - full id or short prefix.
 * @returns {Promise<object>} the matching session.list item.
 */
export async function resolveSessionId(base, sessionId) {
  const list = unwrap(await rpc(base, "session.list", {}), "session.list");
  const items = list.items ?? [];
  const exact = items.find((it) => it.sessionId === sessionId);
  if (exact) return exact;
  const short = String(sessionId)
    .replace(/^session-/, "")
    .match(SHORT_ID_RE)?.[0];
  if (short) {
    const matches = items.filter((it) => it.sessionId.replace(/^session-/, "").startsWith(short));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(
        `session id ${JSON.stringify(sessionId)} is ambiguous: ${matches.length} matches`,
      );
    }
  }
  throw new Error(`session not found: ${sessionId}`);
}

/**
 * Map one session.list item to a paseo `ls`-style agent row.
 * @param {object} item - raw session.list item.
 * @returns {{sessionId, title, status, pendingInteraction, model, provider, cwd, updatedAt, turns, blank, origin, parentSessionId}}
 */
export function toAgentView(item) {
  const values = item.projections?.values ?? {};
  const stats = values.sessionStats;
  const ctx = values.contextTimeline;
  const pending = values.pendingInteraction;

  let status = "idle";
  if (item.running) status = "running";
  else if (pending) status = "pending";

  return {
    sessionId: item.sessionId,
    title: values.title ?? (basename(item.cwd ?? "") || item.sessionId),
    status,
    pendingInteraction: pending ?? null,
    model: ctx?.model ?? null,
    provider: ctx?.provider ?? null,
    cwd: item.cwd ?? null,
    updatedAt: item.updatedAt ?? null,
    turns: stats?.turns ?? 0,
    blank: item.blank ?? false,
    origin: item.origin ?? null,
    parentSessionId: item.parentSessionId ?? null,
  };
}

/**
 * Map a workspace.list item + resolved titles to a row.
 * @param {object} w - raw workspace.list item.
 * @returns {{workspaceId, path, title, sessionCount, createdAt, updatedAt}}
 */
export function toWorkspaceView(w) {
  return {
    workspaceId: w.workspaceId,
    path: w.path,
    title: w.title,
    sessionCount: w.sessionIds?.length ?? 0,
    createdAt: w.createdAt ?? null,
    updatedAt: w.updatedAt ?? null,
  };
}
