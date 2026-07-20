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
      sourceId: source.id,
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

  test("moves a card to Done once its MR merges and drops out of the state=opened query", async () => {
    const openMr = {
      iid: 5,
      project_id: 42,
      title: "Add feature",
      web_url: "https://gitlab.example.com/group/project/-/merge_requests/5",
      state: "opened",
      draft: false,
    };
    const mergedMr = { ...openMr, state: "merged" };
    let listCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      // List endpoint: the first sync returns the open MR; later syncs no
      // longer return it, mirroring how a merged MR drops out of a
      // `state=opened` query.
      if (url.includes("/api/v4/merge_requests")) {
        listCalls += 1;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => (listCalls === 1 ? [openMr] : []),
        };
      }
      // Single-MR endpoint used by terminal-state reconciliation: now merged.
      if (url.includes("/api/v4/projects/42/merge_requests/5")) {
        return { ok: true, status: 200, statusText: "OK", json: async () => mergedMr };
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const syncService = new KanbanSyncService({ store, secrets, fetchImpl });
    const source = await store.createSource({
      kind: "gitlab",
      name: "GitLab",
      baseUrl: "https://gitlab.example.com",
      query: "state=opened",
    });

    const first = await syncService.sync(source);
    expect(first.cards.find((card) => card.externalId === "gitlab:42!5")?.status).toBe("wip");

    // Second sync: the MR is gone from the list query, but reconciliation
    // re-fetches it, sees it merged, and moves the card to Done.
    const second = await syncService.sync(source);
    expect(second.cards.find((card) => card.externalId === "gitlab:42!5")?.status).toBe("done");
    const storedAfter = (await store.listCards()).find((card) => card.externalId === "gitlab:42!5");
    expect(storedAfter?.status).toBe("done");

    // Third sync: the card's stored metadata is already terminal, so it is not
    // re-fetched again — each merged MR costs exactly one reconciliation request.
    const singleFetchCount = () =>
      fetchImpl.mock.calls.filter((call: unknown[]) =>
        String(call[0]).includes("/api/v4/projects/42/merge_requests/5"),
      ).length;
    const before = singleFetchCount();
    await syncService.sync(source);
    expect(singleFetchCount()).toBe(before);
  });

  test("re-fetches and flags a Jira card whose issue no longer matches the query", async () => {
    const backlogIssue = {
      key: "PROJ-9",
      fields: {
        summary: "Migrated profile cannot be shown correctly",
        status: { name: "Backlog", statusCategory: { key: "new" } },
        assignee: { displayName: "Ada Lovelace" },
      },
    };
    // Same issue after being closed AND reassigned away — it stops matching an
    // `assignee = currentUser()` query, so the search endpoint drops it.
    const closedIssue = {
      key: "PROJ-9",
      fields: {
        summary: "Migrated profile cannot be shown correctly",
        status: { name: "Closed", statusCategory: { key: "done" } },
        assignee: { displayName: "Grace Hopper" },
      },
    };
    let searchCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/rest/api/2/search")) {
        searchCalls += 1;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ issues: searchCalls === 1 ? [backlogIssue] : [], total: 0 }),
        };
      }
      if (url.includes("/rest/api/2/issue/PROJ-9")) {
        return { ok: true, status: 200, statusText: "OK", json: async () => closedIssue };
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const syncService = new KanbanSyncService({ store, secrets, fetchImpl });
    const source = await store.createSource({
      kind: "jira",
      name: "Jira",
      baseUrl: "https://jira.example.com",
      query: "assignee = currentUser()",
    });

    const first = await syncService.sync(source);
    expect(first.cards.find((card) => card.externalId === "jira:PROJ-9")).toMatchObject({
      status: "pending",
      detachedFromSource: undefined,
    });

    // Second sync: the issue is gone from the search results, so reconciliation
    // re-fetches it by key, writes back the real (closed) status, and flags it.
    await syncService.sync(source);
    const stored = (await store.listCards()).find((card) => card.externalId === "jira:PROJ-9");
    expect(stored).toMatchObject({
      status: "done",
      detachedFromSource: true,
      assignee: "Grace Hopper",
    });
    // Never deleted — a detached card stays on the board.
    expect(stored).toBeDefined();

    // Third sync: already flagged and already terminal, so it costs no further
    // requests.
    const issueFetchCount = () =>
      fetchImpl.mock.calls.filter((call: unknown[]) =>
        String(call[0]).includes("/rest/api/2/issue/PROJ-9"),
      ).length;
    const before = issueFetchCount();
    await syncService.sync(source);
    expect(issueFetchCount()).toBe(before);
  });

  test("clears the detached flag once the query returns the card again", async () => {
    const issue = {
      key: "PROJ-4",
      fields: {
        summary: "Reassigned, then handed back",
        status: { name: "Backlog", statusCategory: { key: "new" } },
      },
    };
    let searchCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      // Present, gone (reassigned away), then present again (handed back).
      if (url.includes("/rest/api/2/search")) {
        searchCalls += 1;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ issues: searchCalls === 2 ? [] : [issue], total: 0 }),
        };
      }
      if (url.includes("/rest/api/2/issue/PROJ-4")) {
        return { ok: true, status: 200, statusText: "OK", json: async () => issue };
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const syncService = new KanbanSyncService({ store, secrets, fetchImpl });
    const source = await store.createSource({
      kind: "jira",
      name: "Jira",
      baseUrl: "https://jira.example.com",
      query: "assignee = currentUser()",
    });

    await syncService.sync(source);
    await syncService.sync(source);
    const detached = (await store.listCards()).find((card) => card.externalId === "jira:PROJ-4");
    expect(detached?.detachedFromSource).toBe(true);

    await syncService.sync(source);
    const reattached = (await store.listCards()).find((card) => card.externalId === "jira:PROJ-4");
    expect(reattached?.detachedFromSource).toBeUndefined();
  });

  test("does not flag cards as detached when the page walk hit the safety cap", async () => {
    const issue = {
      key: "PROJ-3",
      fields: {
        summary: "Still assigned to me",
        status: { name: "Backlog", statusCategory: { key: "new" } },
      },
    };
    let searchCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      // Cloud enhanced-JQL search (the connection carries an email). The first
      // sync returns the issue and ends cleanly; every later sync hands back a
      // nextPageToken forever, so the walk stops at MAX_SYNC_PAGES with the
      // card never appearing — exactly the case that must NOT be read as
      // "no longer matches the query".
      if (url.includes("/rest/api/3/search/jql")) {
        searchCalls += 1;
        return searchCalls === 1
          ? { ok: true, status: 200, statusText: "OK", json: async () => ({ issues: [issue] }) }
          : {
              ok: true,
              status: 200,
              statusText: "OK",
              json: async () => ({ issues: [], nextPageToken: "more", isLast: false }),
            };
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const syncService = new KanbanSyncService({ store, secrets, fetchImpl });
    const connection = await store.createConnection({
      kind: "jira",
      name: "Jira",
      baseUrl: "https://jira.example.com",
      email: "user@example.com",
    });
    const source = await store.createSource({
      kind: "jira",
      name: "Jira",
      connectionId: connection.id,
      query: "assignee = currentUser()",
    });

    await syncService.sync(source);
    const truncatedSync = await syncService.sync(source);
    // The truncation warning still lands on the source, but the card is left
    // exactly as it was — no flag, and no single-issue re-fetch was attempted.
    expect(truncatedSync.source?.lastSyncError).toContain("page cap");
    const stored = (await store.listCards()).find((card) => card.externalId === "jira:PROJ-3");
    expect(stored?.detachedFromSource).toBeUndefined();
    expect(stored?.status).toBe("pending");
    expect(
      fetchImpl.mock.calls.filter((call: unknown[]) => String(call[0]).includes("/issue/PROJ-3")),
    ).toHaveLength(0);
  });

  test("flags a deleted Jira issue as detached without failing the sync", async () => {
    const issue = {
      key: "PROJ-7",
      fields: {
        summary: "Since deleted",
        status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      },
    };
    let searchCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/rest/api/2/search")) {
        searchCalls += 1;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ issues: searchCalls === 1 ? [issue] : [], total: 0 }),
        };
      }
      // The issue is gone: Jira answers the single-issue lookup with 404.
      if (url.includes("/rest/api/2/issue/PROJ-7")) {
        return {
          ok: false,
          status: 404,
          statusText: "Not Found",
          json: async () => ({}),
        };
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const syncService = new KanbanSyncService({ store, secrets, fetchImpl });
    const source = await store.createSource({
      kind: "jira",
      name: "Jira",
      baseUrl: "https://jira.example.com",
      query: "assignee = currentUser()",
    });

    await syncService.sync(source);
    const second = await syncService.sync(source);
    // A 404 on the re-fetch is an expected outcome, not a sync failure.
    expect(second.error).toBeNull();
    expect(second.source?.lastSyncError).toBeNull();
    const stored = (await store.listCards()).find((card) => card.externalId === "jira:PROJ-7");
    // Flagged, but the last known status is kept — there is nothing better to show.
    expect(stored).toMatchObject({ detachedFromSource: true, status: "wip" });
  });

  test("removes a Jira card once its issue is reassigned to another user (Cloud accountId)", async () => {
    const mineIssue = {
      key: "SCIF-5080",
      fields: {
        summary: "Investigate profile rendering",
        status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
        assignee: { accountId: "me-123", displayName: "Jun Fu" },
      },
    };
    // Same issue after being reassigned to Dusan — it drops out of the
    // `assignee = currentUser()` query, and the re-fetch shows a different
    // accountId, so the card is no longer the user's work and must disappear.
    const reassignedIssue = {
      key: "SCIF-5080",
      fields: {
        summary: "Investigate profile rendering",
        status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
        assignee: { accountId: "dusan-456", displayName: "Dusan Stankovic" },
      },
    };
    let searchCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/rest/api/3/search/jql")) {
        searchCalls += 1;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ issues: searchCalls === 1 ? [mineIssue] : [] }),
        };
      }
      if (url.includes("/rest/api/3/myself")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ accountId: "me-123" }),
        };
      }
      if (url.includes("/rest/api/3/issue/SCIF-5080")) {
        return { ok: true, status: 200, statusText: "OK", json: async () => reassignedIssue };
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const syncService = new KanbanSyncService({ store, secrets, fetchImpl });
    const connection = await store.createConnection({
      kind: "jira",
      name: "Jira",
      baseUrl: "https://jira.example.com",
      email: "jun@example.com",
    });
    const source = await store.createSource({
      kind: "jira",
      name: "Jira",
      connectionId: connection.id,
      query: "assignee = currentUser()",
    });

    await syncService.sync(source);
    expect(
      (await store.listCards()).find((card) => card.externalId === "jira:SCIF-5080"),
    ).toBeDefined();

    // Second sync: reconcile re-fetches, sees a different accountId, and drops the card.
    const second = await syncService.sync(source);
    expect(second.error).toBeNull();
    expect(
      (await store.listCards()).find((card) => card.externalId === "jira:SCIF-5080"),
    ).toBeUndefined();
  });

  test("removes a Jira card reassigned to another user (Server/DC name)", async () => {
    const mineIssue = {
      key: "PROJ-20",
      fields: {
        summary: "Server-side task",
        status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
        assignee: { name: "junfu", displayName: "Jun Fu" },
      },
    };
    const reassignedIssue = {
      key: "PROJ-20",
      fields: {
        summary: "Server-side task",
        status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
        assignee: { name: "dusan", displayName: "Dusan Stankovic" },
      },
    };
    let searchCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/rest/api/2/search")) {
        searchCalls += 1;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ issues: searchCalls === 1 ? [mineIssue] : [], total: 0 }),
        };
      }
      if (url.includes("/rest/api/2/myself")) {
        return { ok: true, status: 200, statusText: "OK", json: async () => ({ name: "junfu" }) };
      }
      if (url.includes("/rest/api/2/issue/PROJ-20")) {
        return { ok: true, status: 200, statusText: "OK", json: async () => reassignedIssue };
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const syncService = new KanbanSyncService({ store, secrets, fetchImpl });
    const source = await store.createSource({
      kind: "jira",
      name: "Jira",
      baseUrl: "https://jira.example.com",
      query: "assignee = currentUser()",
    });

    await syncService.sync(source);
    await syncService.sync(source);
    expect(
      (await store.listCards()).find((card) => card.externalId === "jira:PROJ-20"),
    ).toBeUndefined();
  });

  test("keeps a Jira card still assigned to the user that only changed status", async () => {
    const issue = {
      key: "PROJ-21",
      fields: {
        summary: "Closed, still mine",
        status: { name: "Closed", statusCategory: { key: "done" } },
        assignee: { name: "junfu", displayName: "Jun Fu" },
      },
    };
    let searchCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/rest/api/2/search")) {
        searchCalls += 1;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          // Query is `assignee = currentUser() AND status != Done`, so a close
          // drops it out even though it's still assigned to the user.
          json: async () => ({ issues: searchCalls === 1 ? [issue] : [], total: 0 }),
        };
      }
      if (url.includes("/rest/api/2/myself")) {
        return { ok: true, status: 200, statusText: "OK", json: async () => ({ name: "junfu" }) };
      }
      if (url.includes("/rest/api/2/issue/PROJ-21")) {
        return { ok: true, status: 200, statusText: "OK", json: async () => issue };
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const syncService = new KanbanSyncService({ store, secrets, fetchImpl });
    const source = await store.createSource({
      kind: "jira",
      name: "Jira",
      baseUrl: "https://jira.example.com",
      query: "assignee = currentUser() AND status != Done",
    });

    await syncService.sync(source);
    await syncService.sync(source);
    const stored = (await store.listCards()).find((card) => card.externalId === "jira:PROJ-21");
    // Still the user's work — kept, flagged detached, real status written back.
    expect(stored).toMatchObject({ detachedFromSource: true, status: "done" });
  });

  test("keeps a Jira card that became unassigned (no assignee is not reassigned-away)", async () => {
    const assignedIssue = {
      key: "PROJ-22",
      fields: {
        summary: "Handed back to the pool",
        status: { name: "Backlog", statusCategory: { key: "new" } },
        assignee: { name: "junfu", displayName: "Jun Fu" },
      },
    };
    const unassignedIssue = {
      key: "PROJ-22",
      fields: {
        summary: "Handed back to the pool",
        status: { name: "Backlog", statusCategory: { key: "new" } },
        assignee: null,
      },
    };
    let searchCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/rest/api/2/search")) {
        searchCalls += 1;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ issues: searchCalls === 1 ? [assignedIssue] : [], total: 0 }),
        };
      }
      if (url.includes("/rest/api/2/myself")) {
        return { ok: true, status: 200, statusText: "OK", json: async () => ({ name: "junfu" }) };
      }
      if (url.includes("/rest/api/2/issue/PROJ-22")) {
        return { ok: true, status: 200, statusText: "OK", json: async () => unassignedIssue };
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const syncService = new KanbanSyncService({ store, secrets, fetchImpl });
    const source = await store.createSource({
      kind: "jira",
      name: "Jira",
      baseUrl: "https://jira.example.com",
      query: "assignee = currentUser()",
    });

    await syncService.sync(source);
    await syncService.sync(source);
    const stored = (await store.listCards()).find((card) => card.externalId === "jira:PROJ-22");
    expect(stored).toMatchObject({ detachedFromSource: true });
    expect(stored).toBeDefined();
  });

  test("does not remove a reassigned Jira card when the /myself lookup fails", async () => {
    const mineIssue = {
      key: "PROJ-23",
      fields: {
        summary: "Reassigned, but self unknown",
        status: { name: "Backlog", statusCategory: { key: "new" } },
        assignee: { name: "junfu", displayName: "Jun Fu" },
      },
    };
    const reassignedIssue = {
      key: "PROJ-23",
      fields: {
        summary: "Reassigned, but self unknown",
        status: { name: "Backlog", statusCategory: { key: "new" } },
        assignee: { name: "dusan", displayName: "Dusan Stankovic" },
      },
    };
    let searchCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/rest/api/2/search")) {
        searchCalls += 1;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ issues: searchCalls === 1 ? [mineIssue] : [], total: 0 }),
        };
      }
      // /myself is down — the reconcile pass cannot prove reassignment, so it
      // must keep the card rather than risk dropping the user's own work.
      if (url.includes("/rest/api/2/myself")) {
        return { ok: false, status: 500, statusText: "Server Error", json: async () => ({}) };
      }
      if (url.includes("/rest/api/2/issue/PROJ-23")) {
        return { ok: true, status: 200, statusText: "OK", json: async () => reassignedIssue };
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const syncService = new KanbanSyncService({ store, secrets, fetchImpl });
    const source = await store.createSource({
      kind: "jira",
      name: "Jira",
      baseUrl: "https://jira.example.com",
      query: "assignee = currentUser()",
    });

    await syncService.sync(source);
    await syncService.sync(source);
    const stored = (await store.listCards()).find((card) => card.externalId === "jira:PROJ-23");
    // Conservative fallback: kept and flagged, never dropped on an unproven guess.
    expect(stored).toMatchObject({ detachedFromSource: true });
    expect(stored).toBeDefined();
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

  test("Jira Cloud pagination hitting the safety cap records a truncation warning", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        // Always claims more pages exist — a runaway query that never ends.
        json: async () => ({
          issues: [{ key: `PROJ-${call}`, fields: { summary: `Issue ${call}` } }],
          nextPageToken: `page-${call + 1}`,
        }),
      };
    }) as unknown as typeof fetch;

    const syncService = new KanbanSyncService({ store, secrets, fetchImpl });
    const connection = await store.createConnection({
      kind: "jira",
      name: "Jira Cloud",
      baseUrl: "https://x.atlassian.net",
      email: "me@corp.com",
    });
    const source = await store.createSource({
      kind: "jira",
      name: "Runaway query",
      connectionId: connection.id,
      query: "project = HUGE",
    });

    const result = await syncService.sync(source);

    // Capped at MAX_SYNC_PAGES (20) requests, not one per every claimed page.
    expect(fetchImpl).toHaveBeenCalledTimes(20);
    // The 20 issues it DID fetch are still upserted — truncation isn't a hard failure.
    expect(result.cards).toHaveLength(20);
    expect(result.error).toContain("page cap");
    expect(result.source?.lastSyncError).toContain("page cap");
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
    expect(withThreads?.sourceId).toBe(source.id);

    const clean = byId.get("gitlab:42!2");
    expect(clean?.hasUnresolvedThreads).toBe(false);
  });

  test("GitLab sync fetches approval state for open MRs (never for merged/closed ones) and stores it on metadata", async () => {
    const gitlabResponse = [
      { iid: 1, project_id: 42, title: "Needs review", state: "opened" },
      { iid: 2, project_id: 42, title: "Already merged", state: "merged" },
    ];
    const approvalsCalls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/merge_requests/1/approvals")) {
        approvalsCalls.push(url);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ approved: false, approvals_left: 2 }),
        };
      }
      if (url.includes("/api/v4/merge_requests")) {
        return { ok: true, status: 200, statusText: "OK", json: async () => gitlabResponse };
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const syncService = new KanbanSyncService({ store, secrets, fetchImpl });
    const source = await store.createSource({
      kind: "gitlab",
      name: "GitLab",
      baseUrl: "https://gitlab.example.com",
      query: "state=all",
    });

    const result = await syncService.sync(source);
    const byId = new Map(result.cards.map((card) => [card.externalId, card]));

    // Only the still-open MR gets an approvals lookup.
    expect(approvalsCalls).toHaveLength(1);
    expect(byId.get("gitlab:42!1")?.metadata?.approvals).toEqual({
      approved: false,
      approvalsLeft: 2,
    });
    // Merged MR never triggers the approvals request — it's a moot concept
    // once terminal — and its metadata carries approvals: null instead.
    expect(byId.get("gitlab:42!2")?.metadata?.approvals).toBeNull();
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

  test("Jira Cloud sync requests the issuetype field and stores it on card metadata", async () => {
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
              summary: "Typed issue",
              status: { name: "To Do", statusCategory: { key: "new" } },
              issuetype: { name: "Bug", iconUrl: "https://x.atlassian.net/bug.svg" },
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
    expect(url).toContain("issuetype");
    const card = result.cards[0];
    expect(card.metadata?.issuetype).toEqual({
      name: "Bug",
      iconUrl: "https://x.atlassian.net/bug.svg",
    });
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
