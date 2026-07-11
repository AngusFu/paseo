import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { KanbanService } from "./service.js";
import { KanbanSecretsStore } from "./secrets-store.js";
import { credentialRefForConnection } from "./oauth.js";

describe("KanbanService connection secret handling", () => {
  let tempDir: string;
  let service: KanbanService;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kanban-service-test-"));
    service = new KanbanService({ dir: tempDir, fetchImpl: vi.fn() as unknown as typeof fetch });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("createConnection with tokenValue writes a token secret and marks the connection connected", async () => {
    const result = await service.createConnection({
      kind: "jira",
      name: "Jira",
      baseUrl: "https://jira.example.com",
      tokenValue: "pat-secret",
    });

    expect(result.error).toBeNull();
    expect(result.connection?.authConnected).toBe(true);
    // tokenValue itself is never echoed back on the stored connection.
    expect(JSON.stringify(result.connection)).not.toContain("pat-secret");

    const secrets = new KanbanSecretsStore(tempDir);
    const secret = await secrets.get(credentialRefForConnection(result.connection!.id));
    expect(secret).toEqual({ method: "token", token: "pat-secret" });
  });

  test("createConnection with oauthClientId stores app config but leaves it unconnected", async () => {
    const result = await service.createConnection({
      kind: "gitlab",
      name: "GitLab",
      baseUrl: "https://gitlab.example.com",
      oauthClientId: "client-abc",
      oauthClientSecret: "shh",
    });

    expect(result.error).toBeNull();
    expect(result.connection?.oauthClientId).toBe("client-abc");
    expect(result.connection?.authConnected).toBe(false);
    expect(JSON.stringify(result.connection)).not.toContain("shh");
  });

  test("updateConnection with tokenValue: null clears the stored credential", async () => {
    const created = await service.createConnection({
      kind: "jira",
      name: "Jira",
      baseUrl: "https://jira.example.com",
      tokenValue: "pat-secret",
    });

    const cleared = await service.updateConnection({
      id: created.connection!.id,
      tokenValue: null,
    });

    expect(cleared.connection?.authConnected).toBe(false);
    const secrets = new KanbanSecretsStore(tempDir);
    expect(await secrets.get(credentialRefForConnection(created.connection!.id))).toBeNull();
  });

  test("deleteConnection removes the associated secret", async () => {
    const created = await service.createConnection({
      kind: "jira",
      name: "Jira",
      baseUrl: "https://jira.example.com",
      tokenValue: "pat-secret",
    });

    await service.deleteConnection(created.connection!.id);

    const secrets = new KanbanSecretsStore(tempDir);
    expect(await secrets.get(credentialRefForConnection(created.connection!.id))).toBeNull();
  });

  test("a source referencing a connected connection syncs using its credential", async () => {
    const connection = await service.createConnection({
      kind: "jira",
      name: "Jira",
      baseUrl: "https://jira.example.com",
      tokenValue: "pat-secret",
    });
    const source = await service.createSource({
      kind: "jira",
      name: "Jira issues",
      connectionId: connection.connection!.id,
      query: "project = PROJ",
    });

    expect(source.error).toBeNull();
    expect(source.source?.connectionId).toBe(connection.connection!.id);
  });
});
