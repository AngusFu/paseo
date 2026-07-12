import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { KanbanStore } from "./store.js";
import { KanbanSyncService } from "./sync.js";
import { KanbanSecretsStore } from "./secrets-store.js";

describe("KanbanSyncService", () => {
  let tempDir: string;
  let store: KanbanStore;
  let secrets: KanbanSecretsStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kanban-sync-test-"));
    store = new KanbanStore(tempDir);
    secrets = new KanbanSecretsStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("syncs a Jira source: upserts cards, is idempotent, and preserves pinned status", async () => {
    const jiraResponse = {
      issues: [
        {
          key: "PROJ-1",
          fields: {
            summary: "Fix the thing",
            status: { name: "In Progress" },
            assignee: { displayName: "Ada Lovelace" },
            labels: ["bug"],
          },
        },
        {
          key: "PROJ-2",
          fields: {
            summary: "Ship the feature",
            status: { name: "To Do" },
            assignee: null,
            labels: [],
          },
        },
      ],
    };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => jiraResponse,
    })) as unknown as typeof fetch;

    const syncService = new KanbanSyncService({ store, secrets, fetchImpl });
    const source = await store.createSource({
      kind: "jira",
      name: "Jira",
      baseUrl: "https://jira.example.com",
      query: "project = PROJ",
    });

    const firstSync = await syncService.sync(source);
    expect(firstSync.error).toBeNull();
    expect(firstSync.cards).toHaveLength(2);
    expect(firstSync.source?.lastSyncAt).not.toBeNull();
    expect(firstSync.source?.lastSyncError).toBeNull();

    const wipCard = firstSync.cards.find((card) => card.externalId === "jira:PROJ-1");
    expect(wipCard).toMatchObject({
      title: "Fix the thing",
      status: "wip",
      theme: "jira",
      url: "https://jira.example.com/browse/PROJ-1",
      assignee: "Ada Lovelace",
      statusPinnedByUser: false,
    });

    // Second sync of the same data is idempotent: still 2 cards on disk.
    const secondSync = await syncService.sync(source);
    expect(secondSync.cards).toHaveLength(2);
    expect(await store.listCards()).toHaveLength(2);

    // User drags the PROJ-1 card; a later sync must not move it back.
    await store.moveCard({ id: wipCard!.id, status: "done" });
    const thirdSync = await syncService.sync(source);
    const pinnedCard = thirdSync.cards.find((card) => card.externalId === "jira:PROJ-1");
    expect(pinnedCard?.status).toBe("done");
    expect(pinnedCard?.statusPinnedByUser).toBe(true);
    // Title still refreshes even though status is pinned.
    expect(pinnedCard?.title).toBe("Fix the thing");
    expect(await store.listCards()).toHaveLength(2);
  });

  test("records lastSyncError and does not throw when the request fails", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => ({}),
    })) as unknown as typeof fetch;

    const syncService = new KanbanSyncService({ store, secrets, fetchImpl });
    const source = await store.createSource({
      kind: "gitlab",
      name: "GitLab",
      baseUrl: "https://gitlab.example.com",
      query: "state=opened",
    });

    const result = await syncService.sync(source);
    expect(result.error).toContain("500");
    expect(result.cards).toEqual([]);
    expect(result.source?.lastSyncError).toContain("500");
  });

  test("syncs a GitLab source and maps default statuses", async () => {
    const gitlabResponse = [
      {
        iid: 5,
        project_id: 42,
        title: "Add feature",
        web_url: "https://gitlab.example.com/group/project/-/merge_requests/5",
        state: "opened",
        draft: false,
      },
      {
        iid: 6,
        project_id: 42,
        title: "WIP draft",
        state: "opened",
        draft: true,
      },
      {
        iid: 7,
        project_id: 42,
        title: "Shipped",
        state: "merged",
      },
    ];
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => gitlabResponse,
    })) as unknown as typeof fetch;

    const syncService = new KanbanSyncService({ store, secrets, fetchImpl });
    const source = await store.createSource({
      kind: "gitlab",
      name: "GitLab",
      baseUrl: "https://gitlab.example.com",
      query: "state=opened",
    });

    const result = await syncService.sync(source);
    expect(result.error).toBeNull();
    expect(result.cards).toHaveLength(3);

    const byExternalId = new Map(result.cards.map((card) => [card.externalId, card]));
    expect(byExternalId.get("gitlab:42!5")?.status).toBe("wip");
    expect(byExternalId.get("gitlab:42!6")?.status).toBe("pending");
    expect(byExternalId.get("gitlab:42!7")?.status).toBe("done");
  });

  test("resolves a token secret via source.auth (legacy, no connection) and sends it as a bearer/PAT header", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => [],
    })) as unknown as typeof fetch;

    const syncService = new KanbanSyncService({ store, secrets, fetchImpl });
    const created = await store.createSource({
      kind: "gitlab",
      name: "GitLab",
      baseUrl: "https://gitlab.example.com",
      query: "state=opened",
    });
    const connected = await store.updateSource({
      id: created.id,
      auth: { method: "token", credentialRef: "kbs_secret_x" },
    });
    await secrets.set("kbs_secret_x", { method: "token", token: "glpat-secret" });

    await syncService.sync(connected!);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ "PRIVATE-TOKEN": "glpat-secret" });
  });

  test("resolves a token secret from a connection and sends it as a bearer/PAT header", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => [],
    })) as unknown as typeof fetch;

    const { credentialRefForConnection } = await import("./oauth.js");
    const syncService = new KanbanSyncService({ store, secrets, fetchImpl });
    const connection = await store.createConnection({
      kind: "gitlab",
      name: "GitLab",
      baseUrl: "https://gitlab.example.com",
    });
    await secrets.set(credentialRefForConnection(connection.id), {
      method: "token",
      token: "glpat-secret",
    });
    const source = await store.createSource({
      kind: "gitlab",
      name: "GitLab MRs",
      connectionId: connection.id,
      query: "state=opened",
    });

    await syncService.sync(source);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("https://gitlab.example.com/api/v4/merge_requests");
    expect((init as RequestInit).headers).toMatchObject({ "PRIVATE-TOKEN": "glpat-secret" });
  });

  test("uses HTTP Basic auth for a Jira connection that has an email (Jira Cloud)", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ issues: [] }),
    })) as unknown as typeof fetch;

    const { credentialRefForConnection } = await import("./oauth.js");
    const syncService = new KanbanSyncService({ store, secrets, fetchImpl });
    const connection = await store.createConnection({
      kind: "jira",
      name: "Jira Cloud",
      baseUrl: "https://x.atlassian.net",
      email: "me@corp.com",
    });
    await secrets.set(credentialRefForConnection(connection.id), {
      method: "token",
      token: "jira-api-token",
    });
    const source = await store.createSource({
      kind: "jira",
      name: "My todos",
      connectionId: connection.id,
      query: "assignee = currentUser()",
    });

    await syncService.sync(source);

    const [url, init] = fetchImpl.mock.calls[0];
    const expected = `Basic ${Buffer.from("me@corp.com:jira-api-token").toString("base64")}`;
    expect((init as RequestInit).headers).toMatchObject({ Authorization: expected });
    // Jira Cloud uses the enhanced-JQL endpoint; the old /search returns 410 Gone.
    expect(url).toContain("/rest/api/3/search/jql");
    expect(url).toContain("fields=");
  });

  test("uses Bearer for a Jira connection without an email (Jira Server/DC PAT)", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ issues: [] }),
    })) as unknown as typeof fetch;

    const { credentialRefForConnection } = await import("./oauth.js");
    const syncService = new KanbanSyncService({ store, secrets, fetchImpl });
    const connection = await store.createConnection({
      kind: "jira",
      name: "Jira Server",
      baseUrl: "https://jira.corp.com",
    });
    await secrets.set(credentialRefForConnection(connection.id), {
      method: "token",
      token: "jira-pat",
    });
    const source = await store.createSource({
      kind: "jira",
      name: "My todos",
      connectionId: connection.id,
      query: "assignee = currentUser()",
    });

    await syncService.sync(source);

    const [url, init] = fetchImpl.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer jira-pat" });
    // Jira Server/DC keeps the classic search endpoint.
    expect(url).toContain("/rest/api/2/search");
  });

  test("refreshes an expiring OAuth access token before syncing", async () => {
    const fetchCalls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      fetchCalls.push(url);
      if (url.endsWith("/oauth/token")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            access_token: "fresh-token",
            refresh_token: "refresh-2",
            expires_in: 3600,
          }),
        };
      }
      expect((init?.headers as Record<string, string>)?.["PRIVATE-TOKEN"]).toBe("fresh-token");
      return { ok: true, status: 200, statusText: "OK", json: async () => [] };
    }) as unknown as typeof fetch;

    const { KanbanOauthService, credentialRefForConnection } = await import("./oauth.js");
    const oauthService = new KanbanOauthService({ store, secrets, fetchImpl });
    const syncService = new KanbanSyncService({ store, secrets, fetchImpl, oauthService });

    const connection = await store.createConnection({
      kind: "gitlab",
      name: "GitLab",
      baseUrl: "https://gitlab.example.com",
      oauthClientId: "client-id",
    });
    const credentialRef = credentialRefForConnection(connection.id);
    await secrets.set(credentialRef, {
      method: "oauth",
      clientId: "client-id",
      clientSecret: "client-secret",
      accessToken: "stale-token",
      refreshToken: "refresh-1",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    const source = await store.createSource({
      kind: "gitlab",
      name: "GitLab MRs",
      connectionId: connection.id,
      query: "state=opened",
    });

    await syncService.sync(source);

    expect(fetchCalls[0]).toContain("/oauth/token");
    const refreshed = await secrets.get(credentialRef);
    expect(refreshed).toMatchObject({ accessToken: "fresh-token", refreshToken: "refresh-2" });
  });
});
