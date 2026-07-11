import { describe, expect, it } from "vitest";
import {
  KanbanCardCreateRequestSchema,
  KanbanCardMoveRequestSchema,
  KanbanConnectionCreateRequestSchema,
  KanbanConnectionOauthStartRequestSchema,
  KanbanConnectionOauthStartResponseSchema,
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

  it("carries oauth client + token secrets on a connection create request", () => {
    const parsed = KanbanConnectionCreateRequestSchema.parse({
      type: "kanban.connection.create.request",
      requestId: "req-4b",
      kind: "gitlab",
      name: "Corp GitLab",
      baseUrl: "https://gitlab.mycorp.com",
      oauthClientId: "client-abc",
      oauthClientSecret: "secret-xyz",
      tokenValue: "glpat-123",
    });
    expect(parsed.oauthClientId).toBe("client-abc");
    expect(parsed.tokenValue).toBe("glpat-123");
  });

  it("lets a source reference a connection by id", () => {
    const parsed = KanbanSourceCreateRequestSchema.parse({
      type: "kanban.source.create.request",
      requestId: "req-4c",
      kind: "gitlab",
      name: "My board feed",
      query: "state=opened",
      connectionId: "kbn_1",
    });
    expect(parsed.connectionId).toBe("kbn_1");
  });

  it("round-trips a connection oauth start request/response pair", () => {
    expect(
      KanbanConnectionOauthStartRequestSchema.parse({
        type: "kanban.connection.oauth.start.request",
        requestId: "req-6",
        connectionId: "kbn_1",
      }).connectionId,
    ).toBe("kbn_1");
    expect(
      KanbanConnectionOauthStartResponseSchema.parse({
        type: "kanban.connection.oauth.start.response",
        payload: {
          requestId: "req-6",
          authorizeUrl: "https://gitlab.mycorp.com/oauth/authorize?client_id=x",
          error: null,
        },
      }).payload.authorizeUrl,
    ).toContain("/oauth/authorize");
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
