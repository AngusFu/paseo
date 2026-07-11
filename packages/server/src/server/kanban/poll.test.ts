import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { KanbanStore } from "./store.js";
import { KanbanPollService } from "./poll.js";

describe("KanbanPollService", () => {
  let tempDir: string;
  let store: KanbanStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kanban-poll-test-"));
    store = new KanbanStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("tick syncs a source that has never synced", async () => {
    const source = await store.createSource({
      kind: "jira",
      name: "Jira",
      baseUrl: "https://jira.example.com",
      query: "project = PROJ",
      pollEverySec: 60,
    });
    const sync = vi.fn(async (s) => ({ source: s, cards: [], error: null }));
    const poll = new KanbanPollService({ store, syncService: { sync } as never });

    await poll.tick();

    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync.mock.calls[0][0].id).toBe(source.id);
  });

  test("tick skips a source that isn't due yet", async () => {
    const now = () => new Date("2026-01-01T00:00:30.000Z");
    await store.createSource({
      kind: "jira",
      name: "Jira",
      baseUrl: "https://jira.example.com",
      query: "project = PROJ",
      pollEverySec: 300,
    });
    await store.recordSourceSync((await store.listSources())[0].id, {
      lastSyncAt: "2026-01-01T00:00:00.000Z",
      lastSyncError: null,
    });
    const sync = vi.fn(async (s) => ({ source: s, cards: [], error: null }));
    const poll = new KanbanPollService({ store, syncService: { sync } as never, now });

    await poll.tick();

    expect(sync).not.toHaveBeenCalled();
  });

  test("tick syncs a source once its pollEverySec has elapsed", async () => {
    const now = () => new Date("2026-01-01T00:10:00.000Z");
    const created = await store.createSource({
      kind: "jira",
      name: "Jira",
      baseUrl: "https://jira.example.com",
      query: "project = PROJ",
      pollEverySec: 300,
    });
    await store.recordSourceSync(created.id, {
      lastSyncAt: "2026-01-01T00:00:00.000Z",
      lastSyncError: null,
    });
    const sync = vi.fn(async (s) => ({ source: s, cards: [], error: null }));
    const poll = new KanbanPollService({ store, syncService: { sync } as never, now });

    await poll.tick();

    expect(sync).toHaveBeenCalledTimes(1);
  });

  test("tick skips disabled sources", async () => {
    await store.createSource({
      kind: "jira",
      name: "Jira",
      baseUrl: "https://jira.example.com",
      query: "project = PROJ",
      pollEverySec: 60,
      enabled: false,
    });
    const sync = vi.fn(async (s) => ({ source: s, cards: [], error: null }));
    const poll = new KanbanPollService({ store, syncService: { sync } as never });

    await poll.tick();

    expect(sync).not.toHaveBeenCalled();
  });

  test("start/stop toggle the timer without throwing", () => {
    const sync = vi.fn(async (s) => ({ source: s, cards: [], error: null }));
    const poll = new KanbanPollService({
      store,
      syncService: { sync } as never,
      tickIntervalMs: 50,
    });

    poll.start();
    poll.start(); // idempotent
    poll.stop();
    poll.stop(); // idempotent
  });
});
