import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { KanbanStore } from "./store.js";
import { KanbanSecretsStore } from "./secrets-store.js";
import { KanbanCardWriteBackService } from "./writeback.js";
import { credentialRefForConnection } from "./oauth.js";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  };
}

async function seedJiraCard(options: { store: KanbanStore; secrets: KanbanSecretsStore }) {
  const { store, secrets } = options;
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
  await store.setConnectionAuthConnected(connection.id, true);
  await store.createSource({
    kind: "jira",
    name: "Jira Cloud",
    connectionId: connection.id,
    query: "project = PROJ",
  });
  const columns = await store.listColumns();
  return store.upsertCardBySource(
    { kind: "jira", externalId: "jira:PROJ-1", project: "PROJ", issueKey: "PROJ-1" },
    {
      title: "Fix the thing",
      url: "https://jira.example.com/browse/PROJ-1",
      status: "wip",
      columnId: columns.find((column) => column.legacyStatus === "wip")?.id,
      theme: "jira",
    },
  );
}

describe("KanbanCardWriteBackService", () => {
  let tempDir: string;
  let store: KanbanStore;
  let secrets: KanbanSecretsStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kanban-writeback-test-"));
    store = new KanbanStore(tempDir);
    secrets = new KanbanSecretsStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("listTransitions fetches legal transitions for the issue's current status", async () => {
    const card = await seedJiraCard({ store, secrets });
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("/rest/api/3/issue/PROJ-1/transitions");
      return jsonResponse(200, {
        transitions: [
          { id: "21", name: "Start Progress", to: { name: "In Progress" } },
          { id: "31", name: "Done", to: { name: "Done", statusCategory: { key: "done" } } },
        ],
      });
    }) as unknown as typeof fetch;
    const service = new KanbanCardWriteBackService({ store, secrets, fetchImpl });

    const result = await service.listTransitions(card.id);

    expect(result.error).toBeNull();
    expect(result.transitions).toEqual([
      { id: "21", name: "Start Progress", toStatusName: "In Progress" },
      { id: "31", name: "Done", toStatusName: "Done" },
    ]);
  });

  test("applyTransition executes the transition, refetches status, and writes it back without pinning", async () => {
    const card = await seedJiraCard({ store, secrets });
    const columns = await store.listColumns();
    const doneColumn = columns.find((column) => column.legacyStatus === "done")!;

    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        expect(url).toContain("/rest/api/3/issue/PROJ-1/transitions");
        expect(JSON.parse(init.body as string)).toEqual({ transition: { id: "31" } });
        return jsonResponse(204, {});
      }
      expect(url).toContain("/rest/api/3/issue/PROJ-1?fields=status");
      return jsonResponse(200, {
        fields: { status: { name: "Done", statusCategory: { key: "done" } } },
      });
    }) as unknown as typeof fetch;
    const service = new KanbanCardWriteBackService({ store, secrets, fetchImpl });

    const result = await service.applyTransition(card.id, "31");

    expect(result.error).toBeNull();
    expect(result.card?.status).toBe("done");
    expect(result.card?.columnId).toBe(doneColumn.id);
    // Jira is authoritative post-transition — no reason to pin against a
    // future sync the way a manual drag/edit would.
    expect(result.card?.statusPinnedByUser).toBe(false);
    // The board's Jira lane lookup reads metadata.status.name — must reflect
    // the post-transition status without waiting on the next periodic sync.
    expect(result.card?.metadata?.status).toEqual({
      name: "Done",
      statusCategory: { key: "done" },
    });
  });

  test("addComment posts an ADF-wrapped body to Jira Cloud and returns the created comment", async () => {
    const card = await seedJiraCard({ store, secrets });
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/rest/api/3/issue/PROJ-1/comment");
      const body = JSON.parse(init!.body as string) as { body: unknown };
      expect(body.body).toMatchObject({ type: "doc", version: 1 });
      return jsonResponse(201, {
        author: { displayName: "Ada Lovelace" },
        created: "2026-01-01T00:00:00.000Z",
      });
    }) as unknown as typeof fetch;
    const service = new KanbanCardWriteBackService({ store, secrets, fetchImpl });

    const result = await service.addComment(card.id, "Looks good to me");

    expect(result.error).toBeNull();
    expect(result.comment).toEqual({
      author: "Ada Lovelace",
      createdAt: "2026-01-01T00:00:00.000Z",
      bodyMarkdown: "Looks good to me",
    });
  });

  test("rejects every write-back RPC for a non-jira card", async () => {
    const manualCard = await store.createCard({
      title: "Manual task",
      status: "pending",
    });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const service = new KanbanCardWriteBackService({ store, secrets, fetchImpl });

    const transitions = await service.listTransitions(manualCard.id);
    const transition = await service.applyTransition(manualCard.id, "31");
    const comment = await service.addComment(manualCard.id, "hi");

    expect(transitions.error).toBe("This action is only available for Jira cards");
    expect(transition.error).toBe("This action is only available for Jira cards");
    expect(comment.error).toBe("This action is only available for Jira cards");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
