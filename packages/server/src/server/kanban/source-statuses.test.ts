import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { KanbanStore } from "./store.js";
import { KanbanSecretsStore } from "./secrets-store.js";
import { KanbanSourceStatusService } from "./source-statuses.js";
import { credentialRefForConnection } from "./oauth.js";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  };
}

describe("KanbanSourceStatusService", () => {
  let tempDir: string;
  let store: KanbanStore;
  let secrets: KanbanSecretsStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kanban-source-statuses-test-"));
    store = new KanbanStore(tempDir);
    secrets = new KanbanSecretsStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("merges and dedupes statuses across every project the source's cards touch", async () => {
    await store.createConnection({
      kind: "jira",
      name: "Jira Cloud",
      baseUrl: "https://jira.example.com",
      email: "dev@example.com",
    });
    const connection = (await store.listConnections())[0];
    await secrets.set(credentialRefForConnection(connection.id), {
      method: "token",
      token: "secret-token",
    });
    const source = await store.createSource({
      kind: "jira",
      name: "Jira Cloud",
      connectionId: connection.id,
      query: "project in (SCIF, PROJ)",
    });
    const columns = await store.listColumns();
    const wipColumnId = columns.find((column) => column.legacyStatus === "wip")?.id;
    await store.upsertCardBySource(
      { kind: "jira", externalId: "jira:SCIF-1", project: "SCIF", issueKey: "SCIF-1" },
      {
        title: "Scif card",
        url: "https://jira.example.com/browse/SCIF-1",
        status: "wip",
        columnId: wipColumnId,
        theme: "jira",
        sourceId: source.id,
      },
    );
    await store.upsertCardBySource(
      { kind: "jira", externalId: "jira:PROJ-1", project: "PROJ", issueKey: "PROJ-1" },
      {
        title: "Proj card",
        url: "https://jira.example.com/browse/PROJ-1",
        status: "wip",
        columnId: wipColumnId,
        theme: "jira",
        sourceId: source.id,
      },
    );

    const requestedUrls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      requestedUrls.push(url);
      if (url.includes("/rest/agile/")) {
        // No Jira Software board — service must keep workflow-definition order.
        return jsonResponse(404, { message: "no board" });
      }
      if (url.includes("/project/SCIF/")) {
        return jsonResponse(200, [
          {
            statuses: [
              { name: "To Do", statusCategory: { key: "new" } },
              { name: "In Progress", statusCategory: { key: "indeterminate" } },
            ],
          },
        ]);
      }
      return jsonResponse(200, [
        {
          statuses: [
            // "To Do" also appears here — must be deduped, not doubled.
            { name: "To Do", statusCategory: { key: "new" } },
            { name: "Done", statusCategory: { key: "done" } },
          ],
        },
      ]);
    }) as unknown as typeof fetch;

    const service = new KanbanSourceStatusService({ store, secrets, fetchImpl });
    const result = await service.listStatuses(source.id);

    expect(result.error).toBeNull();
    expect(requestedUrls.some((url) => url.includes("/rest/api/3/project/SCIF/statuses"))).toBe(
      true,
    );
    expect(requestedUrls.some((url) => url.includes("/rest/api/3/project/PROJ/statuses"))).toBe(
      true,
    );
    expect(result.statuses?.map((status) => status.name).sort()).toEqual([
      "Done",
      "In Progress",
      "To Do",
    ]);
    // Fetched once per project (plus one board probe each) — the second
    // listStatuses call is served entirely from cache.
    const callsAfterFirst = requestedUrls.length;
    const secondResult = await service.listStatuses(source.id);
    expect(secondResult.statuses).toEqual(result.statuses);
    expect(requestedUrls.length).toBe(callsAfterFirst);
  });

  test("orders statuses by the agile board's column order when a board exists", async () => {
    await store.createConnection({
      kind: "jira",
      name: "Jira Cloud",
      baseUrl: "https://jira.example.com",
      email: "dev@example.com",
    });
    const connection = (await store.listConnections())[0];
    await secrets.set(credentialRefForConnection(connection.id), {
      method: "token",
      token: "secret-token",
    });
    const source = await store.createSource({
      kind: "jira",
      name: "Jira Cloud",
      connectionId: connection.id,
      query: "project = SCIF",
    });
    const columns = await store.listColumns();
    const wipColumnId = columns.find((column) => column.legacyStatus === "wip")?.id;
    await store.upsertCardBySource(
      { kind: "jira", externalId: "jira:SCIF-9", project: "SCIF", issueKey: "SCIF-9" },
      {
        title: "Scif card",
        url: "https://jira.example.com/browse/SCIF-9",
        status: "wip",
        columnId: wipColumnId,
        theme: "jira",
        sourceId: source.id,
      },
    );

    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/rest/agile/1.0/board?")) {
        return jsonResponse(200, { values: [{ id: 7 }] });
      }
      if (url.includes("/rest/agile/1.0/board/7/configuration")) {
        return jsonResponse(200, {
          columnConfig: {
            columns: [
              { name: "To Do", statuses: [{ id: "1" }] },
              { name: "Review", statuses: [{ id: "3" }] },
              { name: "QA", statuses: [{ id: "2" }] },
            ],
          },
        });
      }
      // Workflow-definition order puts "In QA" BEFORE "Pending Code Review" —
      // the board order above must win.
      return jsonResponse(200, [
        {
          statuses: [
            { id: "1", name: "To Do", statusCategory: { key: "new" } },
            { id: "2", name: "In QA", statusCategory: { key: "indeterminate" } },
            { id: "3", name: "Pending Code Review", statusCategory: { key: "indeterminate" } },
            { id: "9", name: "Unmapped", statusCategory: { key: "indeterminate" } },
          ],
        },
      ]);
    }) as unknown as typeof fetch;

    const service = new KanbanSourceStatusService({ store, secrets, fetchImpl });
    const result = await service.listStatuses(source.id);

    expect(result.error).toBeNull();
    expect(result.statuses?.map((status) => status.name)).toEqual([
      "To Do",
      "Pending Code Review",
      "In QA",
      "Unmapped", // not on the board -> keeps its place after mapped statuses
    ]);
    // The internal Jira status id must not leak over the RPC shape.
    expect(result.statuses?.every((status) => !("id" in status))).toBe(true);
  });

  test("rejects a non-jira source with an explicit error", async () => {
    const source = await store.createSource({
      kind: "gitlab",
      name: "GitLab",
      baseUrl: "https://gitlab.example.com",
      query: "state=opened",
    });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const service = new KanbanSourceStatusService({ store, secrets, fetchImpl });

    const result = await service.listStatuses(source.id);

    expect(result.statuses).toBeNull();
    expect(result.error).toBe("This action is only available for Jira sources");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("returns an empty array (not an error) when the source has no cards to derive a project from", async () => {
    const source = await store.createSource({
      kind: "jira",
      name: "Jira",
      baseUrl: "https://jira.example.com",
      query: "project = EMPTY",
    });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const service = new KanbanSourceStatusService({ store, secrets, fetchImpl });

    const result = await service.listStatuses(source.id);

    expect(result.error).toBeNull();
    expect(result.statuses).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
