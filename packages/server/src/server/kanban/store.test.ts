import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { KanbanStore } from "./store.js";
import type { KanbanColumn, KanbanStatus, StoredKanbanCard } from "@getpaseo/protocol/kanban/types";

const numericAsc = (x: number, y: number): number => x - y;

// Named top-level helpers rather than inline arrows in .map/.find chains
// inside tests — describe > describe > test already nests three deep, and
// an inline arrow there trips max-nested-callbacks.
function titleOf(column: KanbanColumn): string {
  return column.title;
}
function legacyStatusOf(column: KanbanColumn): KanbanStatus {
  return column.legacyStatus;
}
function orderedCardIds(cards: StoredKanbanCard[], ids: string[]): string[] {
  return cards
    .filter((card) => ids.includes(card.id))
    .sort((a, b) => a.order - b.order)
    .map((card) => card.id);
}
function isNotHidden(column: KanbanColumn): boolean {
  return !column.hidden;
}
function orderOf(column: KanbanColumn): number {
  return column.order;
}
function hasLegacyStatus(status: KanbanStatus) {
  return (column: KanbanColumn): boolean => column.legacyStatus === status;
}
function hasId(id: string) {
  return (item: { id: string }): boolean => item.id === id;
}
function toIdEntry(card: StoredKanbanCard): [string, StoredKanbanCard] {
  return [card.id, card];
}

// upsertCardBySource is a low-level store API — sync.ts always resolves a
// real columnId before calling it, so these direct-call tests need one too.
// The three default columns map 1:1 to pending/wip/done.
async function columnIdForStatus(store: KanbanStore, status: KanbanStatus): Promise<string> {
  const columns = await store.listColumns();
  const match = columns.find((column) => column.legacyStatus === status);
  if (!match) {
    throw new Error(`No default column for status: ${status}`);
  }
  return match.id;
}

function cardsByExternalId(cards: StoredKanbanCard[]): Map<string | null, StoredKanbanCard> {
  const byExternalId = new Map<string | null, StoredKanbanCard>();
  for (const card of cards) {
    byExternalId.set(card.externalId, card);
  }
  return byExternalId;
}

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

    test("moveCard honors an explicit order (in-column insert position)", async () => {
      const first = await store.createCard({ title: "First" });
      const second = await store.createCard({ title: "Second" });
      const third = await store.createCard({ title: "Third" });
      expect([first.order, second.order, third.order]).toEqual([0, 1, 2]);

      // Reinsert "third" between "first" and "second" via a midpoint order —
      // this is what the app computes from the drop's Y position.
      const moved = await store.moveCard({
        id: third.id,
        status: third.status,
        order: (first.order + second.order) / 2,
      });

      expect(moved?.order).toBe(0.5);
      const ordered = orderedCardIds(await store.listCards(), [first.id, second.id, third.id]);
      expect(ordered).toEqual([first.id, third.id, second.id]);
      // A pure in-column reorder must not pin the card away from source sync.
      expect(moved?.statusPinnedByUser).toBe(false);
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
        columnId: await columnIdForStatus(store, "pending"),
        theme: "jira",
      });

      const second = await store.upsertCardBySource(source, {
        title: "Updated title",
        url: "https://jira.example.com/browse/PROJ-1",
        status: "wip",
        columnId: await columnIdForStatus(store, "wip"),
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
        columnId: await columnIdForStatus(store, "pending"),
        theme: "jira",
      });

      const moved = await store.moveCard({ id: created.id, status: "done" });
      expect(moved?.statusPinnedByUser).toBe(true);

      const synced = await store.upsertCardBySource(source, {
        title: "Pinned card (renamed upstream)",
        url: null,
        status: "wip",
        columnId: await columnIdForStatus(store, "wip"),
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

      const pendingColumnId = await columnIdForStatus(store, "pending");
      const [a, b] = await Promise.all([
        store.upsertCardBySource(source, {
          title: "Concurrent A",
          url: null,
          status: "pending",
          columnId: pendingColumnId,
          theme: "gitlab-mr",
        }),
        store.upsertCardBySource(source, {
          title: "Concurrent B",
          url: null,
          status: "pending",
          columnId: pendingColumnId,
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
        columnId: await columnIdForStatus(store, "pending"),
        theme: "jira",
      });
      expect(created.statusPinnedByUser).toBe(false);

      const edited = await store.updateCard({ id: created.id, status: "done" });
      expect(edited?.statusPinnedByUser).toBe(true);

      const synced = await store.upsertCardBySource(source, {
        title: "Synced",
        url: null,
        status: "wip",
        columnId: await columnIdForStatus(store, "wip"),
        theme: "jira",
      });
      expect(synced.status).toBe("done");
    });

    test("upsertCardBySource clears assignee when the upstream ticket becomes unassigned", async () => {
      const source = { kind: "jira" as const, externalId: "jira:PROJ-10", issueKey: "PROJ-10" };
      const pendingColumnId = await columnIdForStatus(store, "pending");
      const withAssignee = await store.upsertCardBySource(source, {
        title: "Assigned",
        url: null,
        status: "pending",
        columnId: pendingColumnId,
        theme: "jira",
        assignee: "Ada",
      });
      expect(withAssignee.assignee).toBe("Ada");

      const unassigned = await store.upsertCardBySource(source, {
        title: "Assigned",
        url: null,
        status: "pending",
        columnId: pendingColumnId,
        theme: "jira",
        assignee: null,
      });
      expect(unassigned.assignee).toBeNull();
    });

    test("listCards reflects upserts served from the in-memory cache, and a fresh store instance recovers from disk", async () => {
      const pendingColumnId = await columnIdForStatus(store, "pending");
      const wipColumnId = await columnIdForStatus(store, "wip");
      await store.upsertCardBySource(
        { kind: "jira", externalId: "jira:PROJ-20", issueKey: "PROJ-20" },
        { title: "Card A", url: null, status: "pending", columnId: pendingColumnId, theme: "jira" },
      );
      const second = await store.upsertCardBySource(
        { kind: "jira", externalId: "jira:PROJ-21", issueKey: "PROJ-21" },
        { title: "Card B", url: null, status: "pending", columnId: pendingColumnId, theme: "jira" },
      );
      const updated = await store.upsertCardBySource(
        { kind: "jira", externalId: "jira:PROJ-20", issueKey: "PROJ-20" },
        { title: "Card A renamed", url: null, status: "wip", columnId: wipColumnId, theme: "jira" },
      );

      const cached = await store.listCards();
      expect(cached).toHaveLength(2);
      const byExternalId = cardsByExternalId(cached);
      expect(byExternalId.get("jira:PROJ-20")).toMatchObject({
        id: updated.id,
        title: "Card A renamed",
        status: "wip",
      });
      expect(byExternalId.get("jira:PROJ-21")).toMatchObject({ id: second.id, title: "Card B" });

      // A brand new store instance has no cache yet, so it must rebuild it
      // from what's actually on disk rather than trusting stale state.
      const reloaded = new KanbanStore(tempDir);
      const fromDisk = await reloaded.listCards();
      const fromDiskByExternalId = cardsByExternalId(fromDisk);
      expect(fromDisk).toHaveLength(2);
      // upsertCardBySource returns the stored card plus a `created` marker —
      // strip it before comparing against what a fresh store reads from disk.
      const { created: _updatedCreated, ...updatedCard } = updated;
      const { created: _secondCreated, ...secondCard } = second;
      expect(fromDiskByExternalId.get("jira:PROJ-20")).toEqual(updatedCard);
      expect(fromDiskByExternalId.get("jira:PROJ-21")).toEqual(secondCard);
    });

    test("deleteCard removes the card from the cache too, not just disk", async () => {
      const created = await store.createCard({ title: "Doomed" });
      await store.listCards();

      expect(await store.deleteCard(created.id)).toBe(true);

      expect(await store.listCards()).toEqual([]);
      expect(await store.getCard(created.id)).toBeNull();
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

  describe("columns", () => {
    test("lazily migrates three default status-category columns (To Do/In Progress/Done)", async () => {
      const columns = await store.listColumns();

      expect(columns).toHaveLength(3);
      expect(columns.map(titleOf)).toEqual(["To Do", "In Progress", "Done"]);
      expect(columns.map(legacyStatusOf)).toEqual(["pending", "wip", "done"]);
      expect(columns.every(isNotHidden)).toBe(true);
      expect(columns.map(orderOf)).toEqual([0, 1, 2]);

      // Migration only ever runs once: a fresh store instance sees the same
      // columns (same ids), not a second freshly-generated set.
      const reloaded = new KanbanStore(tempDir);
      const reloadedColumns = await reloaded.listColumns();
      expect(reloadedColumns).toEqual(columns);
    });

    test("migration is idempotent under concurrent first reads", async () => {
      const [a, b, c] = await Promise.all([
        store.listColumns(),
        store.listColumns(),
        store.listColumns(),
      ]);
      expect(a).toEqual(b);
      expect(b).toEqual(c);
      expect(a).toHaveLength(3);
    });

    test("createColumn appends after the current max order by default", async () => {
      await store.listColumns(); // triggers migration (orders 0,1,2)
      const created = await store.createColumn({ title: "Blocked", legacyStatus: "fail" });

      expect(created.order).toBe(3);
      expect(created.hidden).toBe(false);
      expect(created.id).toMatch(/^kbcol_[0-9a-f]{8}$/);

      const columns = await store.listColumns();
      expect(columns.map(titleOf)).toContain("Blocked");
    });

    test("updateColumn renames, hides, and changes legacyStatus", async () => {
      const created = await store.createColumn({ title: "Review", legacyStatus: "wip" });

      const updated = await store.updateColumn({
        id: created.id,
        title: "In Review",
        hidden: true,
        legacyStatus: "pending",
      });

      expect(updated).toMatchObject({
        id: created.id,
        title: "In Review",
        hidden: true,
        legacyStatus: "pending",
      });
    });

    test("updateColumn returns null for a missing column", async () => {
      expect(await store.updateColumn({ id: "kbcol_deadbeef", title: "x" })).toBeNull();
    });

    test("reorderColumn sets a new order value", async () => {
      const created = await store.createColumn({ title: "Review", legacyStatus: "wip" });
      const reordered = await store.reorderColumn({ id: created.id, order: 0.5 });
      expect(reordered?.order).toBe(0.5);
    });

    test("deleteColumn moves its cards to moveCardsToColumnId and removes the column", async () => {
      const columns = await store.listColumns();
      const done = columns.find(hasLegacyStatus("done"))!;
      const review = await store.createColumn({ title: "Review", legacyStatus: "wip" });

      const card = await store.createCard({ title: "In review", status: "wip" });
      const moved = await store.moveCard({ id: card.id, columnId: review.id, status: "wip" });
      expect(moved?.columnId).toBe(review.id);

      const deleted = await store.deleteColumn({ id: review.id, moveCardsToColumnId: done.id });
      expect(deleted).toBe(true);

      const remainingColumns = await store.listColumns();
      expect(remainingColumns.find(hasId(review.id))).toBeUndefined();

      const reloadedCard = await store.getCard(card.id);
      expect(reloadedCard?.columnId).toBe(done.id);
      expect(reloadedCard?.status).toBe("done");
    });

    test("deleteColumn returns false for a missing column", async () => {
      const columns = await store.listColumns();
      expect(
        await store.deleteColumn({ id: "kbcol_deadbeef", moveCardsToColumnId: columns[0].id }),
      ).toBe(false);
    });

    test("deleteColumn throws when moveCardsToColumnId does not exist", async () => {
      const columns = await store.listColumns();
      await expect(
        store.deleteColumn({ id: columns[0].id, moveCardsToColumnId: "kbcol_deadbeef" }),
      ).rejects.toThrow(/not found/);
    });

    test("backfills columnId for pre-existing cards lazily, bucketing skip/fail/abort into Done", async () => {
      // Migrate columns first so the raw card files below can't race the
      // migration inside listCards().
      const columns = await store.listColumns();
      const toDo = columns.find(hasLegacyStatus("pending"))!;
      const inProgress = columns.find(hasLegacyStatus("wip"))!;
      const done = columns.find(hasLegacyStatus("done"))!;

      // Simulate cards persisted before columnId existed: write raw card JSON
      // with no columnId field at all, bypassing the store's write path.
      const cardsDir = join(tempDir, "cards");
      await mkdir(cardsDir, { recursive: true });
      const now = new Date().toISOString();
      function legacyCard(id: string, status: KanbanStatus): StoredKanbanCard {
        return {
          id,
          title: id,
          url: null,
          status,
          theme: "manual",
          source: { kind: "manual" },
          externalId: null,
          order: 0,
          statusPinnedByUser: false,
          createdAt: now,
          updatedAt: now,
        };
      }
      await writeFile(
        join(cardsDir, "kbc_00000001.json"),
        JSON.stringify(legacyCard("kbc_00000001", "pending")),
      );
      await writeFile(
        join(cardsDir, "kbc_00000002.json"),
        JSON.stringify(legacyCard("kbc_00000002", "wip")),
      );
      await writeFile(
        join(cardsDir, "kbc_00000003.json"),
        JSON.stringify(legacyCard("kbc_00000003", "skip")),
      );

      const cards = await store.listCards();
      const byId = new Map(cards.map(toIdEntry));
      expect(byId.get("kbc_00000001")?.columnId).toBe(toDo.id);
      expect(byId.get("kbc_00000002")?.columnId).toBe(inProgress.id);
      // skip/fail/abort are terminal outcomes and bucket into Done, the same
      // as the three default columns' status-category grouping.
      expect(byId.get("kbc_00000003")?.columnId).toBe(done.id);
      // status itself is left untouched by the lazy backfill.
      expect(byId.get("kbc_00000003")?.status).toBe("skip");
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
      expect(created.connectionId).toBeNull();

      const reloaded = new KanbanStore(tempDir);
      expect(await reloaded.listSources()).toEqual([created]);
      expect(await reloaded.getSource(created.id)).toEqual(created);
    });

    test("createSource persists connectionId when provided", async () => {
      const connection = await store.createConnection({
        kind: "gitlab",
        name: "GitLab",
        baseUrl: "https://gitlab.example.com",
      });
      const created = await store.createSource({
        kind: "gitlab",
        name: "GitLab MRs",
        connectionId: connection.id,
        query: "state=opened",
      });

      expect(created.connectionId).toBe(connection.id);
    });

    test("updateSource can set auth directly (legacy no-connection path)", async () => {
      const created = await store.createSource({
        kind: "jira",
        name: "Jira",
        baseUrl: "https://jira.example.com",
        query: "project = PROJ",
      });

      const updated = await store.updateSource({
        id: created.id,
        auth: { method: "token", credentialRef: "kbs_secret_x" },
      });

      expect(updated).toMatchObject({ auth: { method: "token", credentialRef: "kbs_secret_x" } });
      expect(await store.updateSource({ id: "kbs_deadbeef", auth: null })).toBeNull();
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

    test("createSource persists promptTemplate and updateSource can clear it", async () => {
      const created = await store.createSource({
        kind: "jira",
        name: "Jira",
        baseUrl: "https://jira.example.com",
        query: "project = PROJ",
        promptTemplate: "Fix {{issueKey}}: {{title}}",
      });

      expect(created.promptTemplate).toBe("Fix {{issueKey}}: {{title}}");

      const cleared = await store.updateSource({ id: created.id, promptTemplate: null });
      expect(cleared?.promptTemplate).toBeUndefined();
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

  describe("connections", () => {
    test("creates and reloads connections from disk", async () => {
      const created = await store.createConnection({
        kind: "gitlab",
        name: "GitLab",
        baseUrl: "https://gitlab.example.com",
      });

      expect(created.id).toMatch(/^kbn_[0-9a-f]{8}$/);
      expect(created.oauthClientId).toBeNull();
      expect(created.authConnected).toBe(false);

      const reloaded = new KanbanStore(tempDir);
      expect(await reloaded.listConnections()).toEqual([created]);
      expect(await reloaded.getConnection(created.id)).toEqual(created);
    });

    test("createConnection persists oauthClientId when provided", async () => {
      const created = await store.createConnection({
        kind: "jira",
        name: "Jira",
        baseUrl: "https://jira.example.com",
        oauthClientId: "client-abc",
      });

      expect(created.oauthClientId).toBe("client-abc");
    });

    test("updateConnection merges fields", async () => {
      const created = await store.createConnection({
        kind: "gitlab",
        name: "GitLab",
        baseUrl: "https://gitlab.example.com",
      });

      const updated = await store.updateConnection({ id: created.id, name: "GitLab renamed" });

      expect(updated?.name).toBe("GitLab renamed");
      expect(updated?.baseUrl).toBe("https://gitlab.example.com");
    });

    test("setConnectionAuthConnected flips the connected flag", async () => {
      const created = await store.createConnection({
        kind: "jira",
        name: "Jira",
        baseUrl: "https://jira.example.com",
      });

      const connected = await store.setConnectionAuthConnected(created.id, true);
      expect(connected?.authConnected).toBe(true);

      expect(await store.setConnectionAuthConnected("kbn_deadbeef", true)).toBeNull();
    });

    test("deleteConnection removes the connection from disk", async () => {
      const created = await store.createConnection({
        kind: "gitlab",
        name: "GitLab",
        baseUrl: "https://gitlab.example.com",
      });

      expect(await store.deleteConnection(created.id)).toBe(true);
      expect(await store.getConnection(created.id)).toBeNull();
      expect(await store.deleteConnection(created.id)).toBe(false);
    });
  });
});
