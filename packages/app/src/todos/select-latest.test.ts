import { describe, expect, it } from "vitest";
import type { StreamItem, TodoEntry } from "@/types/stream";
import { deriveTodoListPresentation } from "./presentation";
import { selectLatestTodoListForTrack, selectLatestTodoListIdForHide } from "./select-latest";

const TIMESTAMP = new Date("2026-07-31T00:00:00.000Z");

function todo(id: string, items: TodoEntry[]): Extract<StreamItem, { kind: "todo_list" }> {
  return {
    kind: "todo_list",
    id,
    timestamp: TIMESTAMP,
    provider: "claude",
    items,
  };
}

function message(id: string): Extract<StreamItem, { kind: "assistant_message" }> {
  return {
    kind: "assistant_message",
    id,
    timestamp: TIMESTAMP,
    text: id,
  };
}

function entry(text: string, status: TodoEntry["status"] = "pending"): TodoEntry {
  return {
    text,
    completed: status === "completed",
    status,
  };
}

describe("selectLatestTodoListForTrack", () => {
  it("returns null for an empty stream", () => {
    expect(selectLatestTodoListForTrack([])).toBeNull();
  });

  it("returns null when there is no todo_list", () => {
    expect(selectLatestTodoListForTrack([message("m1")])).toBeNull();
  });

  it("returns the latest non-empty todo_list, ignoring older history", () => {
    const older = todo("todo-1", [entry("a")]);
    const newer = todo("todo-2", [entry("b"), entry("c", "in_progress")]);
    const result = selectLatestTodoListForTrack([older, message("m1"), newer]);
    expect(result).toEqual({ id: "todo-2", items: newer.items });
  });

  it("returns the trailing in-place-updated todo_list", () => {
    const items = [entry("a", "completed"), entry("b", "in_progress")];
    const list = todo("todo-1", items);
    expect(selectLatestTodoListForTrack([message("m1"), list])).toEqual({
      id: "todo-1",
      items,
    });
  });

  it("falls back to the nearest older non-empty when the latest is empty", () => {
    const history = todo("todo-1", [entry("a"), entry("b", "in_progress")]);
    const emptyLatest = todo("todo-2", []);
    expect(selectLatestTodoListForTrack([history, message("m1"), emptyLatest])).toEqual({
      id: "todo-1",
      items: history.items,
    });
  });

  it("returns null when every todo_list is empty", () => {
    expect(selectLatestTodoListForTrack([todo("todo-1", []), todo("todo-2", [])])).toBeNull();
  });
});

describe("selectLatestTodoListIdForHide", () => {
  it("returns null for an empty stream", () => {
    expect(selectLatestTodoListIdForHide([])).toBeNull();
  });

  it("returns the last todo_list id including empty items", () => {
    const history = todo("todo-1", [entry("a")]);
    const emptyLatest = todo("todo-2", []);
    expect(selectLatestTodoListIdForHide([history, message("m1"), emptyLatest])).toBe("todo-2");
  });

  it("returns the trailing non-empty todo_list id", () => {
    expect(
      selectLatestTodoListIdForHide([todo("todo-1", [entry("a")]), todo("todo-2", [entry("b")])]),
    ).toBe("todo-2");
  });
});

describe("deriveTodoListPresentation", () => {
  it("returns empty presentation for no items", () => {
    expect(deriveTodoListPresentation([])).toEqual({
      currentIndex: -1,
      secondaryLabel: undefined,
      completedCount: 0,
      total: 0,
    });
  });

  it("prefers the in_progress row as current", () => {
    const presentation = deriveTodoListPresentation([
      entry("a", "completed"),
      entry("b", "in_progress"),
      entry("c"),
    ]);
    expect(presentation).toEqual({
      currentIndex: 1,
      secondaryLabel: "1/3 · b",
      completedCount: 1,
      total: 3,
    });
  });

  it("falls back to the first incomplete row when nothing is in progress", () => {
    const presentation = deriveTodoListPresentation([
      entry("a", "completed"),
      entry("b"),
      entry("c"),
    ]);
    expect(presentation.currentIndex).toBe(1);
    expect(presentation.secondaryLabel).toBe("1/3 · b");
  });

  it("keeps a completed-only list visible with progress only", () => {
    const presentation = deriveTodoListPresentation([
      entry("a", "completed"),
      entry("b", "completed"),
    ]);
    expect(presentation).toEqual({
      currentIndex: -1,
      secondaryLabel: "2/2",
      completedCount: 2,
      total: 2,
    });
  });
});
