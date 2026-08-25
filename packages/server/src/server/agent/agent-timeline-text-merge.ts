import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

type TimelineTextItem = Extract<AgentTimelineItem, { type: "assistant_message" | "reasoning" }>;

function isTimelineTextItem(item: AgentTimelineItem): item is TimelineTextItem {
  return item.type === "assistant_message" || item.type === "reasoning";
}

export function isSamePersistedTextStream(
  previous: AgentTimelineItem,
  next: AgentTimelineItem,
): boolean {
  if (!isTimelineTextItem(previous) || !isTimelineTextItem(next)) {
    return false;
  }
  if (previous.type !== next.type) {
    return false;
  }
  if (previous.type === "assistant_message" && next.type === "assistant_message") {
    return Boolean(previous.messageId) && previous.messageId === next.messageId;
  }
  return true;
}

export function mergeTimelineTextItems(
  previous: AgentTimelineItem,
  next: AgentTimelineItem,
): AgentTimelineItem {
  if (!isTimelineTextItem(previous) || !isTimelineTextItem(next) || previous.type !== next.type) {
    return next;
  }
  return {
    ...previous,
    text: `${previous.text}${next.text}`,
  };
}

export function collapseConsecutiveTextRows(rows: readonly AgentTimelineRow[]): AgentTimelineRow[] {
  const collapsed: AgentTimelineRow[] = [];
  for (const row of rows) {
    const previous = collapsed.at(-1);
    if (previous && isSamePersistedTextStream(previous.item, row.item)) {
      collapsed[collapsed.length - 1] = {
        seq: row.seq,
        timestamp: previous.timestamp,
        item: mergeTimelineTextItems(previous.item, row.item),
      };
      continue;
    }
    collapsed.push({
      seq: row.seq,
      timestamp: row.timestamp,
      item: row.item,
    });
  }
  return collapsed;
}
