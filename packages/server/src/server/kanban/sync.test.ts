import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { KanbanStore } from "./store.js";
import { KanbanSyncService } from "./sync.js";

describe("KanbanSyncService", () => {
  let tempDir: string;
  let store: KanbanStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kanban-sync-test-"));
    store = new KanbanStore(tempDir);
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

    const syncService = new KanbanSyncService({ store, fetchImpl });
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

    const syncService = new KanbanSyncService({ store, fetchImpl });
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

    const syncService = new KanbanSyncService({ store, fetchImpl });
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
});
