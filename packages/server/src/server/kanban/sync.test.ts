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
            status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
            assignee: { displayName: "Ada Lovelace" },
            labels: ["bug"],
          },
        },
        {
          key: "PROJ-2",
          fields: {
            summary: "Ship the feature",
            status: { name: "To Do", statusCategory: { key: "new" } },
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

  test("maps Jira priority.name onto KanbanPriority, falling back to null for unknown names", async () => {
    const jiraResponse = {
      issues: [
        {
          key: "PROJ-10",
          fields: {
            summary: "Fix outage",
            status: { name: "To Do", statusCategory: { key: "new" } },
            priority: { name: "Highest" },
          },
        },
        {
          key: "PROJ-11",
          fields: {
            summary: "Polish copy",
            status: { name: "To Do", statusCategory: { key: "new" } },
            priority: { name: "Medium" },
          },
        },
        {
          key: "PROJ-12",
          fields: {
            summary: "Someday",
            status: { name: "To Do", statusCategory: { key: "new" } },
            priority: { name: "Lowest" },
          },
        },
        {
          key: "PROJ-13",
          fields: {
            summary: "No priority set",
            status: { name: "To Do", statusCategory: { key: "new" } },
          },
        },
        {
          key: "PROJ-14",
          fields: {
            summary: "Custom scheme",
            status: { name: "To Do", statusCategory: { key: "new" } },
            priority: { name: "Blocker" },
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

    const result = await syncService.sync(source);
    const byKey = (key: string) => result.cards.find((card) => card.externalId === `jira:${key}`);

    expect(byKey("PROJ-10")?.priority).toBe("high");
    expect(byKey("PROJ-11")?.priority).toBe("med");
    expect(byKey("PROJ-12")?.priority).toBe("low");
    expect(byKey("PROJ-13")?.priority).toBeNull();
    expect(byKey("PROJ-14")?.priority).toBeNull();
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

  test("syncs a GitLab source and maps statuses by category (opened incl. draft -> wip, merged -> done)", async () => {
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
    expect(byExternalId.get("gitlab:42!6")?.status).toBe("wip");
    expect(byExternalId.get("gitlab:42!7")?.status).toBe("done");
  });

  test("does not auto-create a column for an unmapped Jira status name — never more than the default 3 columns", async () => {
    const jiraResponse = {
      issues: Array.from({ length: 5 }, (_, i) => ({
        key: `PROJ-${i + 1}`,
        fields: {
          summary: `Issue ${i + 1}`,
          status: { name: `Custom Status ${i + 1}`, statusCategory: { key: "indeterminate" } },
        },
      })),
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

    const result = await syncService.sync(source);
    expect(result.error).toBeNull();
    expect(result.cards).toHaveLength(5);
    expect(result.cards.every((card) => card.status === "wip")).toBe(true);

    const columns = await store.listColumns();
    expect(columns).toHaveLength(3);
  });

  test("source.columnMap targets a specific column, overriding the statusCategory bucket", async () => {
    const jiraResponse = {
      issues: [
        {
          key: "PROJ-1",
          fields: {
            summary: "Needs review",
            status: { name: "In Review", statusCategory: { key: "indeterminate" } },
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
    const doneColumn = (await store.listColumns()).find(
      (column) => column.legacyStatus === "done",
    )!;
    const source = await store.createSource({
      kind: "jira",
      name: "Jira",
      baseUrl: "https://jira.example.com",
      query: "project = PROJ",
      columnMap: { "In Review": doneColumn.id },
    });

    const result = await syncService.sync(source);
    const card = result.cards[0];
    expect(card.columnId).toBe(doneColumn.id);
    expect(card.status).toBe("done");
  });

  test("source.statusMap (legacy) picks a column by legacyStatus when columnMap has no entry", async () => {
    const jiraResponse = {
      issues: [
        {
          key: "PROJ-1",
          fields: {
            summary: "Blocked ticket",
            status: { name: "Blocked", statusCategory: { key: "indeterminate" } },
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
      // statusMap still uses the old KanbanStatus value type; "Blocked" would
      // otherwise land in In Progress via statusCategory "indeterminate".
      statusMap: { Blocked: "pending" },
    });

    const result = await syncService.sync(source);
    const card = result.cards[0];
    expect(card.status).toBe("pending");
  });

  test("falls back to the first non-hidden column when nothing matches the statusCategory bucket", async () => {
    const columns = await store.listColumns();
    const wipColumn = columns.find((column) => column.legacyStatus === "wip")!;
    // Simulate a user deleting the "In Progress" column, moving its cards to
    // "Done" and hiding "To Do" — nothing left has legacyStatus "wip".
    const doneColumn = columns.find((column) => column.legacyStatus === "done")!;
    await store.deleteColumn({ id: wipColumn.id, moveCardsToColumnId: doneColumn.id });
    const toDoColumn = columns.find((column) => column.legacyStatus === "pending")!;
    await store.updateColumn({ id: toDoColumn.id, hidden: true });

    const jiraResponse = {
      issues: [
        {
          key: "PROJ-1",
          fields: {
            summary: "In flight",
            status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
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

    const result = await syncService.sync(source);
    const card = result.cards[0];
    // Falls back to the first non-hidden column rather than throwing —
    // Done is the only remaining non-hidden column.
    expect(card.columnId).toBe(doneColumn.id);
  });

  test("does not move a statusPinnedByUser card's columnId or status on sync", async () => {
    const source = { kind: "jira" as const, externalId: "jira:PROJ-5", issueKey: "PROJ-5" };
    const pendingColumnId = (await store.listColumns()).find(
      (c) => c.legacyStatus === "pending",
    )!.id;
    const created = await store.upsertCardBySource(source, {
      title: "Pinned",
      url: null,
      status: "pending",
      columnId: pendingColumnId,
      theme: "jira",
    });
    const moved = await store.moveCard({ id: created.id, status: "done" });
    expect(moved?.statusPinnedByUser).toBe(true);
    const doneColumnId = moved!.columnId!;

    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        issues: [
          {
            key: "PROJ-5",
            fields: {
              summary: "Pinned",
              status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
            },
          },
        ],
      }),
    })) as unknown as typeof fetch;
    const syncService = new KanbanSyncService({ store, secrets, fetchImpl });
    const syncSource = await store.createSource({
      kind: "jira",
      name: "Jira",
      baseUrl: "https://jira.example.com",
      query: "project = PROJ",
    });

    await syncService.sync({ ...syncSource, id: syncSource.id });
    const card = await store.getCard(created.id);
    expect(card?.status).toBe("done");
    expect(card?.columnId).toBe(doneColumnId);
  });

  test("listExternalStatuses returns GitLab's fixed status vocabulary without a fetch", async () => {
    const fetchImpl = vi.fn();
    const syncService = new KanbanSyncService({
      store,
      secrets,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const source = await store.createSource({
      kind: "gitlab",
      name: "GitLab",
      baseUrl: "https://gitlab.example.com",
      query: "state=opened",
    });

    const statuses = await syncService.listExternalStatuses(source);
    expect(statuses).toEqual([
      { name: "opened", category: "opened" },
      { name: "merged", category: "merged" },
      { name: "closed", category: "closed" },
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("listExternalStatuses queries the global Jira status list and dedupes by name", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => [
        { name: "To Do", statusCategory: { key: "new" } },
        { name: "In Progress", statusCategory: { key: "indeterminate" } },
        { name: "To Do", statusCategory: { key: "new" } },
      ],
    })) as unknown as typeof fetch;
    const syncService = new KanbanSyncService({ store, secrets, fetchImpl });
    const source = await store.createSource({
      kind: "jira",
      name: "Jira",
      baseUrl: "https://jira.example.com",
      query: "project = PROJ",
    });

    const statuses = await syncService.listExternalStatuses(source);
    expect(statuses).toEqual([
      { name: "To Do", category: "new" },
      { name: "In Progress", category: "indeterminate" },
    ]);
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain("/rest/api/3/status");
  });

  test("listExternalStatuses queries the project workflow when projectKey is given, flattening grouped statuses", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => [
        {
          statuses: [
            { name: "Backlog", statusCategory: { key: "new" } },
            { name: "In Progress", statusCategory: { key: "indeterminate" } },
          ],
        },
      ],
    })) as unknown as typeof fetch;
    const syncService = new KanbanSyncService({ store, secrets, fetchImpl });
    const source = await store.createSource({
      kind: "jira",
      name: "Jira",
      baseUrl: "https://jira.example.com",
      query: "project = PROJ",
    });

    const statuses = await syncService.listExternalStatuses(source, "PROJ");
    expect(statuses).toEqual([
      { name: "Backlog", category: "new" },
      { name: "In Progress", category: "indeterminate" },
    ]);
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain("/rest/api/3/project/PROJ/statuses");
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

  test("paginates Jira Cloud enhanced-JQL search via nextPageToken until the last page", async () => {
    const { credentialRefForConnection } = await import("./oauth.js");
    const pages = [
      { issues: [{ key: "PROJ-1", fields: { summary: "One" } }], nextPageToken: "page-2" },
      { issues: [{ key: "PROJ-2", fields: { summary: "Two" } }], isLast: true },
    ];
    let call = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      const response = pages[call];
      call += 1;
      if (call === 2) {
        expect(url).toContain("nextPageToken=page-2");
      }
      return { ok: true, status: 200, statusText: "OK", json: async () => response };
    }) as unknown as typeof fetch;

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

    const result = await syncService.sync(source);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.cards.map((card) => card.externalId).sort()).toEqual([
      "jira:PROJ-1",
      "jira:PROJ-2",
    ]);
  });

  test("GitLab sync captures tracker timestamps and the unresolved-thread flag", async () => {
    const gitlabResponse = [
      {
        iid: 1,
        project_id: 42,
        title: "Has open threads",
        state: "opened",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-02-01T00:00:00.000Z",
        blocking_discussions_resolved: false,
      },
      {
        iid: 2,
        project_id: 42,
        title: "All resolved",
        state: "opened",
        created_at: "2026-01-03T00:00:00.000Z",
        updated_at: "2026-02-03T00:00:00.000Z",
        blocking_discussions_resolved: true,
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
    const byId = new Map(result.cards.map((card) => [card.externalId, card]));

    const withThreads = byId.get("gitlab:42!1");
    expect(withThreads?.sourceCreatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(withThreads?.sourceUpdatedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(withThreads?.hasUnresolvedThreads).toBe(true);

    const clean = byId.get("gitlab:42!2");
    expect(clean?.hasUnresolvedThreads).toBe(false);
  });

  test("a merged MR forces a user-pinned card to done, overriding the manual drag", async () => {
    const cardSource = {
      kind: "gitlab" as const,
      externalId: "gitlab:42!9",
      projectId: "42",
      mrIid: "9",
    };
    const columns = await store.listColumns();
    const wipColumnId = columns.find((c) => c.legacyStatus === "wip")!.id;
    const created = await store.upsertCardBySource(cardSource, {
      title: "Open MR",
      url: null,
      status: "wip",
      columnId: wipColumnId,
      theme: "gitlab-mr",
    });
    // User drags the still-open MR into Pending, pinning it.
    const moved = await store.moveCard({ id: created.id, status: "pending" });
    expect(moved?.statusPinnedByUser).toBe(true);
    expect(moved?.status).toBe("pending");

    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => [{ iid: 9, project_id: 42, title: "Open MR", state: "merged" }],
    })) as unknown as typeof fetch;
    const syncService = new KanbanSyncService({ store, secrets, fetchImpl });
    const source = await store.createSource({
      kind: "gitlab",
      name: "GitLab",
      baseUrl: "https://gitlab.example.com",
      query: "state=all",
    });

    await syncService.sync(source);
    const card = await store.getCard(created.id);
    // Terminal merge wins over the pin: the card lands in done.
    expect(card?.status).toBe("done");
  });

  test("Jira Cloud sync requests created/updated fields and stores them on the card", async () => {
    const { credentialRefForConnection } = await import("./oauth.js");
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        issues: [
          {
            key: "PROJ-1",
            fields: {
              summary: "Dated issue",
              status: { name: "To Do", statusCategory: { key: "new" } },
              created: "2026-01-01T00:00:00.000Z",
              updated: "2026-02-01T00:00:00.000Z",
            },
          },
        ],
      }),
    })) as unknown as typeof fetch;

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

    const result = await syncService.sync(source);
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain("created");
    expect(url).toContain("updated");
    const card = result.cards[0];
    expect(card.sourceCreatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(card.sourceUpdatedAt).toBe("2026-02-01T00:00:00.000Z");
  });

  test("paginates Jira Server/DC search via startAt until a short page ends it", async () => {
    const { credentialRefForConnection } = await import("./oauth.js");
    const firstPage = {
      issues: Array.from({ length: 100 }, (_, i) => ({
        key: `PROJ-${i + 1}`,
        fields: { summary: `Issue ${i + 1}` },
      })),
      startAt: 0,
      total: 101,
    };
    const secondPage = {
      issues: [{ key: "PROJ-101", fields: { summary: "Issue 101" } }],
      startAt: 100,
      total: 101,
    };
    let call = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      const response = call === 0 ? firstPage : secondPage;
      if (call === 1) {
        expect(url).toContain("startAt=100");
      }
      call += 1;
      return { ok: true, status: 200, statusText: "OK", json: async () => response };
    }) as unknown as typeof fetch;

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

    const result = await syncService.sync(source);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.cards).toHaveLength(101);
  });
});
