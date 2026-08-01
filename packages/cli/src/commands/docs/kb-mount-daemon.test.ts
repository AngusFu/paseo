import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client";
import {
  createKbPreferDaemon,
  knowledgeBaseHasMountsPreferDaemon,
  listKbMountsPreferDaemon,
  mountKbPreferDaemon,
  unmountKbPreferDaemon,
} from "./kb-mount-daemon.js";

const MOUNT = {
  knowledgeBaseId: "kb_abc",
  mountSlug: "runbooks",
  slug: "runbooks",
  name: "Runbooks",
};

const EMPTY_KB = {
  id: "kb_scratch",
  slug: "scratch",
  name: "Scratch",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  importedAt: null,
  lastEmbeddedAt: null,
};

function createFakeDaemonClient(overrides: {
  knowledgeBases?: boolean;
  create?: () => Promise<{
    knowledgeBase: typeof EMPTY_KB | null;
    error: string | null;
    requestId: string;
  }>;
  listMounts?: () => Promise<{ mounts: (typeof MOUNT)[]; error: string | null; requestId: string }>;
  mount?: () => Promise<{
    mount: typeof MOUNT | null;
    error: string | null;
    requestId: string;
  }>;
  unmount?: () => Promise<{
    unmounted: typeof MOUNT | null;
    error: string | null;
    requestId: string;
  }>;
  listUsages?: () => Promise<{
    workspaces: Array<{ workspaceId: string; mountSlug: string }>;
    error: string | null;
    requestId: string;
  }>;
}): DaemonClient {
  const knowledgeBases = overrides.knowledgeBases ?? true;
  return {
    getLastServerInfoMessage: () => ({
      features: { knowledgeBases },
    }),
    knowledgeBaseCreate:
      overrides.create ??
      (async () => ({ knowledgeBase: EMPTY_KB, error: null, requestId: "req-create" })),
    knowledgeBaseListMounts:
      overrides.listMounts ??
      (async () => ({ mounts: [MOUNT], error: null, requestId: "req-list" })),
    knowledgeBaseMount:
      overrides.mount ?? (async () => ({ mount: MOUNT, error: null, requestId: "req-mount" })),
    knowledgeBaseUnmount:
      overrides.unmount ??
      (async () => ({ unmounted: MOUNT, error: null, requestId: "req-unmount" })),
    knowledgeBaseListUsages:
      overrides.listUsages ??
      (async () => ({
        workspaces: [{ workspaceId: "ws_1", mountSlug: "runbooks" }],
        error: null,
        requestId: "req-usages",
      })),
    close: async () => {},
  } as unknown as DaemonClient;
}

describe("kb mount CLI prefers daemon when provided", () => {
  it("create uses DaemonClient.knowledgeBaseCreate when connect succeeds", async () => {
    const knowledgeBaseCreate = vi.fn(async () => ({
      knowledgeBase: EMPTY_KB,
      error: null,
      requestId: "req-create",
    }));
    const client = createFakeDaemonClient({ create: knowledgeBaseCreate });
    const tryConnectToDaemon = vi.fn(async () => client);

    const created = await createKbPreferDaemon(
      { slug: "scratch", name: "Scratch" },
      { tryConnectToDaemon },
    );

    expect(tryConnectToDaemon).toHaveBeenCalledTimes(1);
    expect(knowledgeBaseCreate).toHaveBeenCalledWith({ slug: "scratch", name: "Scratch" });
    expect(created).toEqual(EMPTY_KB);
  });

  it("mount uses DaemonClient.knowledgeBaseMount when connect succeeds", async () => {
    const knowledgeBaseMount = vi.fn(async () => ({
      mount: MOUNT,
      error: null,
      requestId: "req-mount",
    }));
    const client = createFakeDaemonClient({ mount: knowledgeBaseMount });
    const tryConnectToDaemon = vi.fn(async () => client);

    const mount = await mountKbPreferDaemon(
      { workspaceId: "ws_1", idOrSlug: "runbooks", mountSlug: "runbooks" },
      { tryConnectToDaemon },
    );

    expect(tryConnectToDaemon).toHaveBeenCalledTimes(1);
    expect(knowledgeBaseMount).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      idOrSlug: "runbooks",
      mountSlug: "runbooks",
    });
    expect(mount).toEqual(MOUNT);
  });

  it("list mounts uses DaemonClient.knowledgeBaseListMounts when connect succeeds", async () => {
    const knowledgeBaseListMounts = vi.fn(async () => ({
      mounts: [MOUNT],
      error: null,
      requestId: "req-list",
    }));
    const client = createFakeDaemonClient({ listMounts: knowledgeBaseListMounts });

    const mounts = await listKbMountsPreferDaemon(
      { workspaceId: "ws_1" },
      { tryConnectToDaemon: async () => client },
    );

    expect(knowledgeBaseListMounts).toHaveBeenCalledWith({ workspaceId: "ws_1" });
    expect(mounts).toEqual([MOUNT]);
  });

  it("unmount uses DaemonClient.knowledgeBaseUnmount when connect succeeds", async () => {
    const knowledgeBaseUnmount = vi.fn(async () => ({
      unmounted: MOUNT,
      error: null,
      requestId: "req-unmount",
    }));
    const client = createFakeDaemonClient({ unmount: knowledgeBaseUnmount });

    const unmounted = await unmountKbPreferDaemon(
      { workspaceId: "ws_1", mountSlugOrKbId: "runbooks" },
      { tryConnectToDaemon: async () => client },
    );

    expect(knowledgeBaseUnmount).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      mountSlugOrKbId: "runbooks",
    });
    expect(unmounted).toEqual(MOUNT);
  });

  it("delete usages check uses DaemonClient.knowledgeBaseListUsages when connect succeeds", async () => {
    const knowledgeBaseListUsages = vi.fn(async () => ({
      workspaces: [{ workspaceId: "ws_1", mountSlug: "runbooks" }],
      error: null,
      requestId: "req-usages",
    }));
    const client = createFakeDaemonClient({ listUsages: knowledgeBaseListUsages });

    const hasMounts = await knowledgeBaseHasMountsPreferDaemon(
      { idOrSlug: "runbooks", knowledgeBaseId: "kb_abc" },
      { tryConnectToDaemon: async () => client },
    );

    expect(knowledgeBaseListUsages).toHaveBeenCalledWith({ idOrSlug: "runbooks" });
    expect(hasMounts).toBe(true);
  });

  it("falls back to local writers when daemon is unreachable", async () => {
    // Null connect → local docs-vfs path (no daemon RPCs). Missing KB/workspace
    // proves we hit the local writer rather than a mocked daemon success.
    const tryConnectToDaemon = vi.fn(async () => null);

    await expect(
      mountKbPreferDaemon(
        { workspaceId: "ws_missing", idOrSlug: "missing-kb" },
        { tryConnectToDaemon },
      ),
    ).rejects.toThrow(/Knowledge base not found|Workspace not found/);

    expect(tryConnectToDaemon).toHaveBeenCalledTimes(1);
  });

  it("falls back to local when daemon lacks knowledgeBases capability", async () => {
    const knowledgeBaseMount = vi.fn(async () => ({
      mount: MOUNT,
      error: null,
      requestId: "req-mount",
    }));
    const client = createFakeDaemonClient({
      knowledgeBases: false,
      mount: knowledgeBaseMount,
    });
    const tryConnectToDaemon = vi.fn(async () => client);

    await expect(
      mountKbPreferDaemon(
        { workspaceId: "ws_missing", idOrSlug: "missing-kb" },
        { tryConnectToDaemon },
      ),
    ).rejects.toThrow(/Knowledge base not found|Workspace not found/);

    expect(knowledgeBaseMount).not.toHaveBeenCalled();
  });
});
