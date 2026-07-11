import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { KanbanSecretsStore } from "./secrets-store.js";

describe("KanbanSecretsStore", () => {
  let tempDir: string;
  let store: KanbanSecretsStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kanban-secrets-test-"));
    store = new KanbanSecretsStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("get returns null when no secret is stored", async () => {
    expect(await store.get("kbs_secret_missing")).toBeNull();
  });

  test("set + get round-trips a token secret", async () => {
    await store.set("kbs_secret_a", { method: "token", token: "pat-123" });
    expect(await store.get("kbs_secret_a")).toEqual({ method: "token", token: "pat-123" });
  });

  test("set + get round-trips an oauth secret and persists across reload", async () => {
    await store.set("kbs_secret_b", {
      method: "oauth",
      clientId: "client",
      clientSecret: "secret",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: "2026-01-01T00:00:00.000Z",
    });

    const reloaded = new KanbanSecretsStore(tempDir);
    expect(await reloaded.get("kbs_secret_b")).toEqual({
      method: "oauth",
      clientId: "client",
      clientSecret: "secret",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: "2026-01-01T00:00:00.000Z",
    });
  });

  test("delete removes the secret and is a no-op for a missing ref", async () => {
    await store.set("kbs_secret_c", { method: "token", token: "pat" });
    await store.delete("kbs_secret_c");
    expect(await store.get("kbs_secret_c")).toBeNull();
    await expect(store.delete("kbs_secret_c")).resolves.toBeUndefined();
  });

  test("secrets file is written with 0600 permissions", async () => {
    if (process.platform === "win32") {
      return;
    }
    await store.set("kbs_secret_d", { method: "token", token: "pat" });
    const stats = await stat(join(tempDir, "secrets.json"));
    expect(stats.mode & 0o777).toBe(0o600);
  });

  test("does not clobber other refs when setting one key", async () => {
    await store.set("kbs_secret_a", { method: "token", token: "a" });
    await store.set("kbs_secret_b", { method: "token", token: "b" });
    expect(await store.get("kbs_secret_a")).toEqual({ method: "token", token: "a" });
    expect(await store.get("kbs_secret_b")).toEqual({ method: "token", token: "b" });
  });
});
