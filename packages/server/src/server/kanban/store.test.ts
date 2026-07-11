import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { KanbanStore } from "./store.js";

const numericAsc = (x: number, y: number): number => x - y;

describe("KanbanStore", () => {
  let tempDir: string;
  let store: KanbanStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kanban-store-test-"));
    store = new KanbanStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("cards", () => {
    test("creates and reloads cards from disk", async () => {
      const created = await store.createCard({ title: "Write tests" });

      expect(created.id).toMatch(/^kbc_[0-9a-f]{8}$/);
      expect(created.status).toBe("pending");
      expect(created.source).toEqual({ kind: "manual" });
      expect(created.statusPinnedByUser).toBe(false);

      const reloaded = new KanbanStore(tempDir);
      expect(await reloaded.listCards()).toEqual([created]);
      expect(await reloaded.getCard(created.id)).toEqual(created);
    });

    test("getCard returns null for missing card", async () => {
      expect(await store.getCard("kbc_deadbeef")).toBeNull();
    });

    test("assigns increasing order within the same status column", async () => {
      const first = await store.createCard({ title: "First" });
      const second = await store.createCard({ title: "Second" });
      const third = await store.createCard({ title: "Third", status: "wip" });

      expect(first.order).toBe(0);
      expect(second.order).toBe(1);
      expect(third.order).toBe(0);
    });

    test("updateCard merges fields and bumps updatedAt", async () => {
      const created = await store.createCard({ title: "Before" });
      const updated = await store.updateCard({
        id: created.id,
        title: "After",
        url: "https://example.com",
      });

      expect(updated).toMatchObject({ id: created.id, title: "After", url: "https://example.com" });
      expect(updated?.updatedAt).toBeDefined();

      const reloaded = await store.getCard(created.id);
      expect(reloaded?.title).toBe("After");
    });

    test("updateCard returns null for a missing card", async () => {
      expect(await store.updateCard({ id: "kbc_deadbeef", title: "x" })).toBeNull();
    });

    test("moveCard sets status, pins statusPinnedByUser, and appends order", async () => {
      const created = await store.createCard({ title: "Card" });
      expect(created.statusPinnedByUser).toBe(false);

      const moved = await store.moveCard({ id: created.id, status: "wip" });

      expect(moved).toMatchObject({ id: created.id, status: "wip", statusPinnedByUser: true });
    });

    test("deleteCard removes the card from disk", async () => {
      const created = await store.createCard({ title: "Doomed" });
      expect(await store.deleteCard(created.id)).toBe(true);
      expect(await store.getCard(created.id)).toBeNull();
      expect(await store.deleteCard(created.id)).toBe(false);
    });

    test("upsertCardBySource creates once and updates on repeated calls (idempotent)", async () => {
      const source = { kind: "jira" as const, externalId: "jira:PROJ-1", issueKey: "PROJ-1" };

      const first = await store.upsertCardBySource(source, {
        title: "Initial title",
        url: "https://jira.example.com/browse/PROJ-1",
        status: "pending",
        theme: "jira",
      });

      const second = await store.upsertCardBySource(source, {
        title: "Updated title",
        url: "https://jira.example.com/browse/PROJ-1",
        status: "wip",
        theme: "jira",
      });

      const all = await store.listCards();
      expect(all).toHaveLength(1);
      expect(second.id).toBe(first.id);
      expect(second.title).toBe("Updated title");
      expect(second.status).toBe("wip");
    });

    test("upsertCardBySource does not overwrite status once the card is pinned by the user", async () => {
      const source = { kind: "jira" as const, externalId: "jira:PROJ-2", issueKey: "PROJ-2" };

      const created = await store.upsertCardBySource(source, {
        title: "Pinned card",
        url: null,
        status: "pending",
        theme: "jira",
      });

      const moved = await store.moveCard({ id: created.id, status: "done" });
      expect(moved?.statusPinnedByUser).toBe(true);

      const synced = await store.upsertCardBySource(source, {
        title: "Pinned card (renamed upstream)",
        url: null,
        status: "wip",
        theme: "jira",
      });

      expect(synced.id).toBe(created.id);
      expect(synced.status).toBe("done");
      expect(synced.title).toBe("Pinned card (renamed upstream)");

      const all = await store.listCards();
      expect(all).toHaveLength(1);
    });

    test("upsertCardBySource does not duplicate cards under concurrent calls", async () => {
      const source = {
        kind: "gitlab" as const,
        externalId: "gitlab:1!2",
        projectId: "1",
        mrIid: "2",
      };

      const [a, b] = await Promise.all([
        store.upsertCardBySource(source, {
          title: "Concurrent A",
          url: null,
          status: "pending",
          theme: "gitlab-mr",
        }),
        store.upsertCardBySource(source, {
          title: "Concurrent B",
          url: null,
          status: "pending",
          theme: "gitlab-mr",
        }),
      ]);

      expect(a.id).toBe(b.id);
      expect(await store.listCards()).toHaveLength(1);
    });

    test("updateCard pins status so a later sync does not revert an explicit status change", async () => {
      const source = { kind: "jira" as const, externalId: "jira:PROJ-9", issueKey: "PROJ-9" };
      const created = await store.upsertCardBySource(source, {
        title: "Synced",
        url: null,
        status: "pending",
        theme: "jira",
      });
      expect(created.statusPinnedByUser).toBe(false);

      const edited = await store.updateCard({ id: created.id, status: "done" });
      expect(edited?.statusPinnedByUser).toBe(true);

      const synced = await store.upsertCardBySource(source, {
        title: "Synced",
        url: null,
        status: "wip",
        theme: "jira",
      });
      expect(synced.status).toBe("done");
    });

    test("upsertCardBySource clears assignee when the upstream ticket becomes unassigned", async () => {
      const source = { kind: "jira" as const, externalId: "jira:PROJ-10", issueKey: "PROJ-10" };
      const withAssignee = await store.upsertCardBySource(source, {
        title: "Assigned",
        url: null,
        status: "pending",
        theme: "jira",
        assignee: "Ada",
      });
      expect(withAssignee.assignee).toBe("Ada");

      const unassigned = await store.upsertCardBySource(source, {
        title: "Assigned",
        url: null,
        status: "pending",
        theme: "jira",
        assignee: null,
      });
      expect(unassigned.assignee).toBeNull();
    });

    test("concurrent createCard in the same column assigns distinct order values", async () => {
      const [a, b, c] = await Promise.all([
        store.createCard({ title: "A", status: "wip" }),
        store.createCard({ title: "B", status: "wip" }),
        store.createCard({ title: "C", status: "wip" }),
      ]);
      const orders = [a.order, b.order, c.order].sort(numericAsc);
      expect(new Set(orders).size).toBe(3);
      expect(orders).toEqual([0, 1, 2]);
    });
  });

  describe("sources", () => {
    test("creates and reloads sources from disk", async () => {
      const created = await store.createSource({
        kind: "jira",
        name: "My Jira",
        baseUrl: "https://jira.example.com",
        query: "project = PROJ",
      });

      expect(created.id).toMatch(/^kbs_[0-9a-f]{8}$/);
      expect(created.enabled).toBe(true);
      expect(created.pollEverySec).toBe(300);
      expect(created.lastSyncAt).toBeNull();

      const reloaded = new KanbanStore(tempDir);
      expect(await reloaded.listSources()).toEqual([created]);
      expect(await reloaded.getSource(created.id)).toEqual(created);
    });

    test("updateSource merges fields and can clear optional fields", async () => {
      const created = await store.createSource({
        kind: "gitlab",
        name: "GitLab",
        baseUrl: "https://gitlab.example.com",
        query: "state=opened",
        statusMap: { opened: "wip" },
      });

      const updated = await store.updateSource({
        id: created.id,
        name: "GitLab renamed",
        statusMap: null,
      });

      expect(updated?.name).toBe("GitLab renamed");
      expect(updated?.statusMap).toBeUndefined();
    });

    test("deleteSource removes the source from disk", async () => {
      const created = await store.createSource({
        kind: "jira",
        name: "Delete me",
        baseUrl: "https://jira.example.com",
        query: "project = PROJ",
      });

      expect(await store.deleteSource(created.id)).toBe(true);
      expect(await store.getSource(created.id)).toBeNull();
      expect(await store.deleteSource(created.id)).toBe(false);
    });

    test("recordSourceSync updates lastSyncAt and lastSyncError", async () => {
      const created = await store.createSource({
        kind: "jira",
        name: "Sync me",
        baseUrl: "https://jira.example.com",
        query: "project = PROJ",
      });

      const synced = await store.recordSourceSync(created.id, {
        lastSyncAt: "2026-01-01T00:00:00.000Z",
        lastSyncError: null,
      });

      expect(synced?.lastSyncAt).toBe("2026-01-01T00:00:00.000Z");
      expect(synced?.lastSyncError).toBeNull();
    });
  });
});
