import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";

export interface ToolCallDebugInput {
  toolName: string;
  status: string;
  detail: ToolCallDetail | undefined;
  metadata: Record<string, unknown> | undefined;
  error: unknown;
}

// Cap the rendered blob so a huge shell/read detail can't turn the hover card
// into a wall of text. The daemon already caps stored tool output (see
// agent-timeline-content.ts); this is purely about keeping the popover usable.
const MAX_DEBUG_JSON_LENGTH = 4000;

/**
 * Serialize what the client actually received for a tool call. This is the
 * daemon's mapped view (ToolCallDetail), not the provider's raw wire payload —
 * for ACP providers the daemon maps kind/rawInput into a typed detail and only
 * `unknown` details carry the original envelope through.
 */
export function buildToolCallDebugJson(input: ToolCallDebugInput): string {
  const payload = {
    toolName: input.toolName,
    status: input.status,
    detailType: input.detail?.type ?? null,
    detail: input.detail ?? null,
    metadata: input.metadata ?? null,
    error: input.error ?? null,
  };
  let json: string;
  try {
    json = JSON.stringify(payload, replaceUnserializable, 2);
  } catch {
    return "<unserializable tool call>";
  }
  if (json.length <= MAX_DEBUG_JSON_LENGTH) {
    return json;
  }
  return `${json.slice(0, MAX_DEBUG_JSON_LENGTH)}\n… truncated (${json.length} chars)`;
}

function replaceUnserializable(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "function") {
    return "<function>";
  }
  return value;
}
