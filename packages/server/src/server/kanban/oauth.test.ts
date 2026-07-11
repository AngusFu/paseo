import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { KanbanStore } from "./store.js";
import { KanbanSecretsStore } from "./secrets-store.js";
import { credentialRefForConnection, KanbanOauthService } from "./oauth.js";

describe("KanbanOauthService", () => {
  let tempDir: string;
  let store: KanbanStore;
  let secrets: KanbanSecretsStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kanban-oauth-test-"));
    store = new KanbanStore(tempDir);
    secrets = new KanbanSecretsStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("startAuthorization builds a provider authorize URL with client id, redirect, and state", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const oauthService = new KanbanOauthService({ store, secrets, fetchImpl });
    const connection = await store.createConnection({
      kind: "gitlab",
      name: "GitLab",
      baseUrl: "https://gitlab.example.com",
      oauthClientId: "client-123",
    });

    const { authorizeUrl } = oauthService.startAuthorization(
      connection,
      "http://127.0.0.1:6767/kanban/oauth/callback",
    );
    const url = new URL(authorizeUrl);

    expect(url.origin + url.pathname).toBe("https://gitlab.example.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:6767/kanban/oauth/callback",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  test("startAuthorization throws when the connection has no oauthClientId", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const oauthService = new KanbanOauthService({ store, secrets, fetchImpl });
    const connection = await store.createConnection({
      kind: "jira",
      name: "Jira",
      baseUrl: "https://jira.example.com",
    });

    expect(() =>
      oauthService.startAuthorization(connection, "http://127.0.0.1:6767/kanban/oauth/callback"),
    ).toThrow(/oauth client id/i);
  });

  test("handleCallback exchanges the code, stores the token, and marks the connection connected", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
      }),
    })) as unknown as typeof fetch;
    const oauthService = new KanbanOauthService({ store, secrets, fetchImpl });
    const connection = await store.createConnection({
      kind: "gitlab",
      name: "GitLab",
      baseUrl: "https://gitlab.example.com",
      oauthClientId: "client-123",
    });

    const { authorizeUrl } = oauthService.startAuthorization(
      connection,
      "http://127.0.0.1:6767/kanban/oauth/callback",
    );
    const state = new URL(authorizeUrl).searchParams.get("state")!;

    const result = await oauthService.handleCallback({ code: "auth-code", state });
    expect(result.connectionId).toBe(connection.id);

    const secret = await secrets.get(credentialRefForConnection(connection.id));
    expect(secret).toMatchObject({
      method: "oauth",
      accessToken: "access-1",
      refreshToken: "refresh-1",
    });

    const updatedConnection = await store.getConnection(connection.id);
    expect(updatedConnection?.authConnected).toBe(true);
  });

  test("handleCallback rejects an unknown state and is single-use", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ access_token: "access-1" }),
    })) as unknown as typeof fetch;
    const oauthService = new KanbanOauthService({ store, secrets, fetchImpl });

    await expect(
      oauthService.handleCallback({ code: "x", state: "unknown-state" }),
    ).rejects.toThrow(/unknown or already-used/i);

    const connection = await store.createConnection({
      kind: "gitlab",
      name: "GitLab",
      baseUrl: "https://gitlab.example.com",
      oauthClientId: "client-123",
    });
    const { authorizeUrl } = oauthService.startAuthorization(
      connection,
      "http://127.0.0.1:6767/kanban/oauth/callback",
    );
    const state = new URL(authorizeUrl).searchParams.get("state")!;

    await oauthService.handleCallback({ code: "auth-code", state });
    await expect(oauthService.handleCallback({ code: "auth-code", state })).rejects.toThrow(
      /unknown or already-used/i,
    );
  });

  test("refreshAccessToken exchanges the refresh token and persists the new secret", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 7200,
      }),
    })) as unknown as typeof fetch;
    const oauthService = new KanbanOauthService({ store, secrets, fetchImpl });
    const connection = await store.createConnection({
      kind: "jira",
      name: "Jira",
      baseUrl: "https://jira.example.com",
      oauthClientId: "client-123",
    });

    const refreshed = await oauthService.refreshAccessToken(connection, {
      method: "oauth",
      clientId: "client-123",
      clientSecret: "shh",
      accessToken: "stale",
      refreshToken: "refresh-1",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });

    expect(refreshed).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
    expect(await secrets.get(credentialRefForConnection(connection.id))).toEqual(refreshed);
  });
});
