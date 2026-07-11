import { describe, expect, it } from "vitest";
import {
  KanbanCardCreateRequestSchema,
  KanbanCardMoveRequestSchema,
  KanbanSourceCreateRequestSchema,
  KanbanSourceSyncResponseSchema,
} from "./rpc-schemas.js";

describe("kanban RPC schemas", () => {
  it("round-trips a manual card create request with minimal fields", () => {
    expect(
      KanbanCardCreateRequestSchema.parse({
        type: "kanban.card.create.request",
        requestId: "req-1",
        title: "Ship the thing",
      }),
    ).toEqual({
      type: "kanban.card.create.request",
      requestId: "req-1",
      title: "Ship the thing",
    });
  });

  it("carries a jira source and theme on create", () => {
    const parsed = KanbanCardCreateRequestSchema.parse({
      type: "kanban.card.create.request",
      requestId: "req-2",
      title: "PROJ-1",
      url: "https://x.atlassian.net/browse/PROJ-1",
      status: "wip",
      theme: "jira",
      source: { kind: "jira", externalId: "jira:PROJ-1", issueKey: "PROJ-1" },
      externalId: "jira:PROJ-1",
    });
    expect(parsed.source).toEqual({
      kind: "jira",
      externalId: "jira:PROJ-1",
      issueKey: "PROJ-1",
    });
  });

  it("accepts a move request with status and order", () => {
    expect(
      KanbanCardMoveRequestSchema.parse({
        type: "kanban.card.move.request",
        requestId: "req-3",
        cardId: "kbc_abc",
        status: "done",
        order: 1.5,
      }).status,
    ).toBe("done");
  });

  it("requires baseUrl on a source create request (never hardcodes host)", () => {
    expect(
      KanbanSourceCreateRequestSchema.parse({
        type: "kanban.source.create.request",
        requestId: "req-4",
        kind: "gitlab",
        name: "Corp GitLab",
        baseUrl: "https://gitlab.mycorp.com",
        query: "state=opened",
      }).baseUrl,
    ).toBe("https://gitlab.mycorp.com");
  });

  it("reports upsertedCount on sync responses for idempotency checks", () => {
    const parsed = KanbanSourceSyncResponseSchema.parse({
      type: "kanban.source.sync.response",
      payload: {
        requestId: "req-5",
        source: null,
        cards: [],
        upsertedCount: 0,
        error: null,
      },
    });
    expect(parsed.payload.upsertedCount).toBe(0);
  });
});
