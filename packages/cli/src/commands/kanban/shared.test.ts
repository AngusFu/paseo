import { describe, expect, test } from "vitest";

import {
  parseKanbanCardAddInput,
  parseKanbanCardMoveInput,
  parseKanbanCardUpdateInput,
  parseKanbanSourceAddInput,
} from "./shared.js";

describe("parseKanbanCardAddInput", () => {
  test("builds a manual card with only title", () => {
    expect(parseKanbanCardAddInput({ title: "Fix bug" })).toEqual({
      title: "Fix bug",
    });
  });

  test("builds a card with all optional fields", () => {
    expect(
      parseKanbanCardAddInput({
        title: "  Fix bug  ",
        url: "https://example.com/1",
        status: "wip",
        theme: "jira",
        label: ["backend", "urgent"],
        priority: "high",
      }),
    ).toEqual({
      title: "Fix bug",
      url: "https://example.com/1",
      status: "wip",
      theme: "jira",
      labels: ["backend", "urgent"],
      priority: "high",
    });
  });

  test("accepts a hex color theme", () => {
    expect(parseKanbanCardAddInput({ title: "Fix bug", theme: "#FF00AA" })).toEqual({
      title: "Fix bug",
      theme: "#FF00AA",
    });
  });

  test("rejects an empty title", () => {
    expect(() => parseKanbanCardAddInput({ title: "   " })).toThrow(
      expect.objectContaining({ code: "INVALID_TITLE" }),
    );
  });

  test("rejects an invalid status", () => {
    expect(() => parseKanbanCardAddInput({ title: "Fix bug", status: "bogus" })).toThrow(
      expect.objectContaining({ code: "INVALID_STATUS" }),
    );
  });

  test("rejects an invalid theme", () => {
    expect(() => parseKanbanCardAddInput({ title: "Fix bug", theme: "purple" })).toThrow(
      expect.objectContaining({ code: "INVALID_THEME" }),
    );
  });

  test("rejects an invalid priority", () => {
    expect(() => parseKanbanCardAddInput({ title: "Fix bug", priority: "urgent" })).toThrow(
      expect.objectContaining({ code: "INVALID_PRIORITY" }),
    );
  });
});

describe("parseKanbanCardUpdateInput", () => {
  test("builds a partial update", () => {
    expect(parseKanbanCardUpdateInput("abc", { title: "  New title  " })).toEqual({
      id: "abc",
      title: "New title",
    });
  });

  test("rejects an empty card id", () => {
    expect(() => parseKanbanCardUpdateInput("   ", { title: "New title" })).toThrow(
      expect.objectContaining({ code: "INVALID_CARD_ID" }),
    );
  });

  test("rejects calls with no fields to update", () => {
    expect(() => parseKanbanCardUpdateInput("abc", {})).toThrow(
      expect.objectContaining({ code: "NO_UPDATES" }),
    );
  });

  test("rejects an empty title", () => {
    expect(() => parseKanbanCardUpdateInput("abc", { title: "   " })).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
  });
});

describe("parseKanbanCardMoveInput", () => {
  test("builds a move input", () => {
    expect(parseKanbanCardMoveInput("abc", { status: "done" })).toEqual({
      id: "abc",
      status: "done",
    });
  });

  test("builds a move input with an order", () => {
    expect(parseKanbanCardMoveInput("abc", { status: "done", order: "1.5" })).toEqual({
      id: "abc",
      status: "done",
      order: 1.5,
    });
  });

  test("rejects a missing status", () => {
    expect(() => parseKanbanCardMoveInput("abc", {})).toThrow(
      expect.objectContaining({ code: "MISSING_STATUS" }),
    );
  });

  test("rejects a non-numeric order", () => {
    expect(() => parseKanbanCardMoveInput("abc", { status: "done", order: "abc" })).toThrow(
      expect.objectContaining({ code: "INVALID_ORDER" }),
    );
  });
});

describe("parseKanbanSourceAddInput", () => {
  test("builds a jira source", () => {
    expect(
      parseKanbanSourceAddInput({
        kind: "jira",
        name: "My Jira",
        baseUrl: "https://jira.mycompany.com",
        query: "project = FOO",
      }),
    ).toEqual({
      kind: "jira",
      name: "My Jira",
      baseUrl: "https://jira.mycompany.com",
      query: "project = FOO",
    });
  });

  test("builds a gitlab source with poll interval and token ref", () => {
    expect(
      parseKanbanSourceAddInput({
        kind: "gitlab",
        name: "My GitLab",
        baseUrl: "https://gitlab.mycompany.com",
        query: "state=opened",
        pollEverySec: "300",
        tokenRef: "GITLAB_TOKEN",
      }),
    ).toEqual({
      kind: "gitlab",
      name: "My GitLab",
      baseUrl: "https://gitlab.mycompany.com",
      query: "state=opened",
      pollEverySec: 300,
      auth: { method: "token", credentialRef: "GITLAB_TOKEN" },
    });
  });

  test("rejects an invalid kind", () => {
    expect(() =>
      parseKanbanSourceAddInput({
        kind: "bogus",
        name: "x",
        baseUrl: "https://example.com",
        query: "",
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_SOURCE_KIND" }));
  });

  test("rejects an empty base url", () => {
    expect(() =>
      parseKanbanSourceAddInput({ kind: "jira", name: "x", baseUrl: "  ", query: "" }),
    ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  test("rejects a non-numeric poll interval", () => {
    expect(() =>
      parseKanbanSourceAddInput({
        kind: "jira",
        name: "x",
        baseUrl: "https://example.com",
        query: "",
        pollEverySec: "abc",
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_INTEGER" }));
  });
});
