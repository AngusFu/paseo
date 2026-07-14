import type { TurnTiming } from "@/timeline/turn-time";
import type { StreamItem } from "@/types/stream";
import { getAssistantBlockSpacing, getGapBetweenStreamItems } from "./spacing";
import type { StreamFrameChildOrder, StreamStrategy } from "./strategy";

export type StreamToolSequence = "single" | "first" | "middle" | "last" | "none";

export interface TurnFooterHost {
  itemId: string;
  items: StreamItem[];
  timing?: TurnTiming;
  startIndex: number;
}

// A run of >= 2 consecutive tool-sequence items (tool_call/thought/todo_list),
// bounded by non-tool items. Attached only to the run's first layout item; the
// remaining members are flagged `isToolRunMember` so the view renders them once,
// collapsed under a single summary row.
export interface StreamToolRunGroup {
  runId: string;
  items: StreamLayoutItem[];
  isActive: boolean;
}

export interface StreamLayoutItem {
  item: StreamItem;
  index: number;
  items: StreamItem[];
  aboveItem: StreamItem | null;
  belowItem: StreamItem | null;
  gapBelow: number;
  assistantSpacing: "default" | "compactTop" | "compactBottom" | "compactBoth";
  completedFooter: TurnFooterHost | null;
  toolSequence: StreamToolSequence;
  isFirstInUserGroup: boolean;
  isLastInUserGroup: boolean;
  isLastInToolSequence: boolean;
  frameOrder: StreamFrameChildOrder;
  // Set on the first item of a >= 2-length tool run; null otherwise.
  toolRunGroup: StreamToolRunGroup | null;
  // True for the non-first members of a tool run (rendered inside the group).
  isToolRunMember: boolean;
}

export interface StreamLayout {
  history: StreamLayoutItem[];
  liveHead: StreamLayoutItem[];
  auxiliaryTurnFooter: TurnFooterHost | null;
}

export interface StreamLayoutInput {
  strategy: StreamStrategy;
  agentStatus: string;
  history: StreamItem[];
  liveHead: StreamItem[];
  timingByAssistantId: Map<string, TurnTiming>;
  // Collapse consecutive tool runs into a single ToolRunSummary. Disabled when the
  // tool-call detail level compacts runs upstream (view.tsx feeds the compacted
  // stream to ToolCallGroup instead), so the two grouping layers never stack.
  groupToolRuns?: boolean;
}

interface LayoutSegmentInput {
  strategy: StreamStrategy;
  items: StreamItem[];
  timingByAssistantId: Map<string, TurnTiming>;
  auxiliaryTurnFooter: TurnFooterHost | null;
  frameOrder: StreamFrameChildOrder;
  boundaryIndex: number | null;
  boundaryAboveItem: StreamItem | null;
  boundaryBelowItem: StreamItem | null;
  boundaryAboveItems: StreamItem[] | null;
  boundaryAboveIndex: number | null;
  groupToolRuns: boolean;
}

interface AssistantFooterSource {
  item: Extract<StreamItem, { kind: "assistant_message" }>;
  items: StreamItem[];
  index: number;
}

function createTurnFooterHost(input: {
  item: StreamItem;
  items: StreamItem[];
  index: number;
  timingByAssistantId: Map<string, TurnTiming>;
}): TurnFooterHost {
  return {
    itemId: input.item.id,
    items: input.items,
    timing: input.timingByAssistantId.get(input.item.id),
    startIndex: input.index,
  };
}

function findLatestAssistantInTurn(input: {
  strategy: StreamStrategy;
  items: StreamItem[];
  startIndex: number;
  boundaryAboveItems?: StreamItem[] | null;
  boundaryAboveIndex?: number | null;
}): AssistantFooterSource | null {
  let items = input.items;
  let index = input.startIndex;
  let canCrossBoundary = true;

  while (true) {
    for (
      ;
      index >= 0 && index < items.length;
      index = input.strategy.getNeighborIndex(index, "above")
    ) {
      const item = items[index];
      if (!item || item.kind === "user_message") {
        return null;
      }
      if (item.kind === "assistant_message") {
        return { item, items, index };
      }
    }

    if (
      !canCrossBoundary ||
      !input.boundaryAboveItems ||
      input.boundaryAboveIndex === null ||
      input.boundaryAboveIndex === undefined
    ) {
      return null;
    }

    items = input.boundaryAboveItems;
    index = input.boundaryAboveIndex;
    canCrossBoundary = false;
  }
}

function resolveAuxiliaryTurnFooter(input: StreamLayoutInput): TurnFooterHost | null {
  if (input.agentStatus === "running") {
    return null;
  }

  const footerItems = input.liveHead.length > 0 ? input.liveHead : input.history;
  const latestIndex = input.strategy.getLatestItemIndex(footerItems);
  if (latestIndex === null) {
    return null;
  }

  const assistant = findLatestAssistantInTurn({
    strategy: input.strategy,
    items: footerItems,
    startIndex: latestIndex,
  });
  if (!assistant) {
    return null;
  }

  return createTurnFooterHost({
    item: assistant.item,
    items: assistant.items,
    index: assistant.index,
    timingByAssistantId: input.timingByAssistantId,
  });
}

function resolveCompletedFooter(input: {
  strategy: StreamStrategy;
  items: StreamItem[];
  index: number;
  item: StreamItem;
  belowItem: StreamItem | null;
  timingByAssistantId: Map<string, TurnTiming>;
  auxiliaryTurnFooter: TurnFooterHost | null;
  boundaryAboveItems: StreamItem[] | null;
  boundaryAboveIndex: number | null;
}): TurnFooterHost | null {
  if (input.item.kind === "user_message" || input.belowItem?.kind !== "user_message") {
    return null;
  }

  const assistant = findLatestAssistantInTurn({
    strategy: input.strategy,
    items: input.items,
    startIndex: input.index,
    boundaryAboveItems: input.boundaryAboveItems,
    boundaryAboveIndex: input.boundaryAboveIndex,
  });
  if (!assistant || input.auxiliaryTurnFooter?.itemId === assistant.item.id) {
    return null;
  }
  return createTurnFooterHost({
    item: assistant.item,
    items: assistant.items,
    index: assistant.index,
    timingByAssistantId: input.timingByAssistantId,
  });
}

function isToolSequenceItem(
  item: StreamItem | null,
): item is Extract<StreamItem, { kind: "tool_call" | "thought" | "todo_list" }> {
  return item?.kind === "tool_call" || item?.kind === "thought" || item?.kind === "todo_list";
}

// Grouping-only predicate: which items collapse into a tool-run summary. Narrower
// than isToolSequenceItem — todo_list is deliberately excluded so plan/todo cards
// stay visible (a todo mid-run splits the run in two). Do NOT swap this for
// isToolSequenceItem, which also drives spacing/gap adjacency and must keep
// todo_list tool-adjacent.
function isGroupableToolItem(
  item: StreamItem | null,
): item is Extract<StreamItem, { kind: "tool_call" | "thought" }> {
  return item?.kind === "tool_call" || item?.kind === "thought";
}

function getToolSequence(input: {
  item: StreamItem;
  aboveItem: StreamItem | null;
  belowItem: StreamItem | null;
}): StreamToolSequence {
  if (!isToolSequenceItem(input.item)) {
    return "none";
  }

  const hasAbove = isToolSequenceItem(input.aboveItem);
  const hasBelow = isToolSequenceItem(input.belowItem);
  if (hasAbove && hasBelow) {
    return "middle";
  }
  if (hasAbove) {
    return "last";
  }
  if (hasBelow) {
    return "first";
  }
  return "single";
}

function getSegmentNeighbor(input: {
  strategy: StreamStrategy;
  items: StreamItem[];
  index: number;
  relation: "above" | "below";
  boundaryIndex: number | null;
  boundaryItem: StreamItem | null;
}): StreamItem | null {
  const neighbor = input.strategy.getNeighborItem(input.items, input.index, input.relation);
  if (neighbor) {
    return neighbor;
  }
  if (input.index === input.boundaryIndex) {
    return input.boundaryItem;
  }
  return null;
}

function isActiveToolRunItem(item: StreamItem): boolean {
  if (item.kind === "thought") {
    return item.status === "loading";
  }
  if (item.kind === "tool_call") {
    const status = item.payload.data.status;
    return status === "running" || status === "executing";
  }
  return false;
}

// Collapses maximal runs of >= 2 consecutive groupable tool items into a single
// group anchored on the run's chronologically-first item. Runs never cross the
// history/liveHead segment boundary (grouping is segment-local), which keeps the
// active turn's live run self-contained.
//
// `reversed` is true for the native inverted stream, where the segment array is
// in reverse-chronological order. The group must render chronologically (summary
// on top, earliest tool first) inside its upright cell, so the anchor and child
// order are derived from chronology, not raw array position. The trailing gap and
// completed-turn footer are hoisted from the run's chronologically-last item onto
// the anchor so the group renders as one unit while its members render null.
function groupToolRuns(items: StreamLayoutItem[], reversed: boolean): void {
  let start = 0;
  while (start < items.length) {
    if (!isGroupableToolItem(items[start].item)) {
      start += 1;
      continue;
    }
    let end = start;
    while (end + 1 < items.length && isGroupableToolItem(items[end + 1].item)) {
      end += 1;
    }
    if (end > start) {
      const run = items.slice(start, end + 1);
      const chronological = reversed ? run.toReversed() : run;
      const anchor = chronological[0];
      const chronoLast = chronological[chronological.length - 1];
      anchor.toolRunGroup = {
        runId: anchor.item.id,
        items: chronological,
        isActive: chronological.some((li) => isActiveToolRunItem(li.item)),
      };
      anchor.gapBelow = chronoLast.gapBelow;
      anchor.completedFooter = chronoLast.completedFooter;
      for (const layoutItem of run) {
        if (layoutItem !== anchor) {
          layoutItem.isToolRunMember = true;
          layoutItem.completedFooter = null;
        }
      }
    }
    start = end + 1;
  }
}

function layoutSegment(input: LayoutSegmentInput): StreamLayoutItem[] {
  const result = input.items.map((item, index) => {
    const aboveItem = getSegmentNeighbor({
      strategy: input.strategy,
      items: input.items,
      index,
      relation: "above",
      boundaryIndex: input.boundaryIndex,
      boundaryItem: input.boundaryAboveItem,
    });
    const belowItem = getSegmentNeighbor({
      strategy: input.strategy,
      items: input.items,
      index,
      relation: "below",
      boundaryIndex: input.boundaryIndex,
      boundaryItem: input.boundaryBelowItem,
    });
    const assistantSpacing = getAssistantBlockSpacing({
      item,
      aboveItem,
      belowItem,
    });
    const completedFooter = resolveCompletedFooter({
      strategy: input.strategy,
      items: input.items,
      index,
      item,
      belowItem,
      timingByAssistantId: input.timingByAssistantId,
      auxiliaryTurnFooter: input.auxiliaryTurnFooter,
      boundaryAboveItems: input.boundaryAboveItems,
      boundaryAboveIndex: input.boundaryAboveIndex,
    });

    return {
      item,
      index,
      items: input.items,
      aboveItem,
      belowItem,
      gapBelow: completedFooter ? 0 : getGapBetweenStreamItems(item, belowItem),
      assistantSpacing,
      completedFooter,
      toolSequence: getToolSequence({ item, aboveItem, belowItem }),
      isFirstInUserGroup: item.kind === "user_message" && aboveItem?.kind !== "user_message",
      isLastInUserGroup: item.kind === "user_message" && belowItem?.kind !== "user_message",
      isLastInToolSequence: isToolSequenceItem(item) && !isToolSequenceItem(belowItem),
      frameOrder: input.frameOrder,
      toolRunGroup: null,
      isToolRunMember: false,
    };
  });
  // Native inverted streams order the segment array reverse-chronologically:
  // there the "above" (earlier) neighbor sits at a higher index.
  const reversed = input.strategy.getNeighborIndex(0, "above") > 0;
  if (input.groupToolRuns) {
    groupToolRuns(result, reversed);
  }
  return result;
}

// Keyed by history array identity; inner key encodes the inputs that affect history layout.
// History layout is stable across text-chunk flushes because the liveHead boundary item's
// kind and id don't change when only its text grows.
const historyLayoutCache = new WeakMap<StreamItem[], Map<string, StreamLayoutItem[]>>();

export function layoutStream(input: StreamLayoutInput): StreamLayout {
  const auxiliaryTurnFooter = resolveAuxiliaryTurnFooter(input);
  const historyBoundaryIndex = input.strategy.getHistoryLiveBoundaryIndex(input.history);
  const liveHeadBoundaryIndex = input.strategy.getLiveHeadHistoryBoundaryIndex(input.liveHead);
  const historyBoundaryItem =
    historyBoundaryIndex === null ? null : (input.history[historyBoundaryIndex] ?? null);
  const liveHeadBoundaryItem =
    liveHeadBoundaryIndex === null ? null : (input.liveHead[liveHeadBoundaryIndex] ?? null);
  const frameOrder = input.strategy.getFrameChildOrder();
  const groupToolRunsEnabled = input.groupToolRuns ?? true;

  let history: StreamLayoutItem[];
  if (input.history.length > 0) {
    // The cache key encodes every input that can change history layout. liveHeadBoundaryItem.id
    // and .kind are stable across text-only flushes (text growth doesn't change what kind of
    // item borders history), so cached layout stays valid between flushes.
    const historyCacheKey = [
      frameOrder,
      historyBoundaryIndex ?? "null",
      liveHeadBoundaryItem?.id ?? "null",
      liveHeadBoundaryItem?.kind ?? "null",
      auxiliaryTurnFooter?.itemId ?? "null",
      groupToolRunsEnabled ? "grouped" : "flat",
    ].join(":");
    let byKey = historyLayoutCache.get(input.history);
    if (!byKey) {
      byKey = new Map();
      historyLayoutCache.set(input.history, byKey);
    }
    const cached = byKey.get(historyCacheKey);
    if (cached) {
      history = cached;
    } else {
      history = layoutSegment({
        strategy: input.strategy,
        items: input.history,
        timingByAssistantId: input.timingByAssistantId,
        auxiliaryTurnFooter,
        frameOrder,
        boundaryIndex: historyBoundaryIndex,
        boundaryAboveItem: null,
        boundaryBelowItem: liveHeadBoundaryItem,
        boundaryAboveItems: null,
        boundaryAboveIndex: null,
        groupToolRuns: groupToolRunsEnabled,
      });
      byKey.set(historyCacheKey, history);
    }
  } else {
    history = [];
  }

  const liveHead = layoutSegment({
    strategy: input.strategy,
    items: input.liveHead,
    timingByAssistantId: input.timingByAssistantId,
    auxiliaryTurnFooter,
    frameOrder,
    boundaryIndex: liveHeadBoundaryIndex,
    boundaryAboveItem: historyBoundaryItem,
    boundaryBelowItem: null,
    boundaryAboveItems: input.history,
    boundaryAboveIndex: historyBoundaryIndex,
    groupToolRuns: groupToolRunsEnabled,
  });

  return {
    history,
    liveHead,
    auxiliaryTurnFooter,
  };
}
