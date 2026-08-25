import { describe, expect, it } from "vitest";

import {
  collapseConsecutiveTextRows,
  isSamePersistedTextStream,
  mergeTimelineTextItems,
} from "./agent-timeline-text-merge.js";

describe("agent timeline text merge", () => {
  it("merges assistant chunks only when they share a messageId", () => {
    expect(
      isSamePersistedTextStream(
        { type: "assistant_message", text: "Hel", messageId: "a" },
        { type: "assistant_message", text: "lo", messageId: "a" },
      ),
    ).toBe(true);
    expect(
      isSamePersistedTextStream(
        { type: "assistant_message", text: "Hel" },
        { type: "assistant_message", text: "lo" },
      ),
    ).toBe(false);
    expect(
      isSamePersistedTextStream(
        { type: "assistant_message", text: "Hel", messageId: "a" },
        { type: "assistant_message", text: "lo", messageId: "b" },
      ),
    ).toBe(false);
  });

  it("merges consecutive reasoning and refuses to cross types", () => {
    expect(
      isSamePersistedTextStream(
        { type: "reasoning", text: "thin" },
        { type: "reasoning", text: "k" },
      ),
    ).toBe(true);
    expect(
      isSamePersistedTextStream(
        { type: "reasoning", text: "thin" },
        { type: "assistant_message", text: "k", messageId: "a" },
      ),
    ).toBe(false);
  });

  it("collapses fragmented rows onto the last seq of the group", () => {
    const collapsed = collapseConsecutiveTextRows([
      {
        seq: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        item: { type: "user_message", text: "hi" },
      },
      {
        seq: 2,
        timestamp: "2026-01-01T00:00:01.000Z",
        item: { type: "assistant_message", text: "Hel", messageId: "a" },
      },
      {
        seq: 3,
        timestamp: "2026-01-01T00:00:02.000Z",
        item: { type: "assistant_message", text: "lo", messageId: "a" },
      },
      {
        seq: 4,
        timestamp: "2026-01-01T00:00:03.000Z",
        item: { type: "reasoning", text: "why" },
      },
    ]);

    expect(collapsed).toEqual([
      {
        seq: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        item: { type: "user_message", text: "hi" },
      },
      {
        seq: 3,
        timestamp: "2026-01-01T00:00:01.000Z",
        item: { type: "assistant_message", text: "Hello", messageId: "a" },
      },
      {
        seq: 4,
        timestamp: "2026-01-01T00:00:03.000Z",
        item: { type: "reasoning", text: "why" },
      },
    ]);
    expect(
      mergeTimelineTextItems({ type: "reasoning", text: "a" }, { type: "reasoning", text: "b" }),
    ).toEqual({
      type: "reasoning",
      text: "ab",
    });
  });
});
