import type { DaemonClient } from "@getpaseo/client";
import type { KnowledgeBase, KnowledgeBaseMount } from "@getpaseo/protocol/knowledge-base/types";
import {
  createEmptyKnowledgeBase,
  deleteKnowledgeBasePage,
  knowledgeBaseHasMounts,
  listWorkspaceKnowledgeBaseMounts,
  mountKnowledgeBaseOnWorkspace,
  resolvePaseoHomeForDocs,
  unmountKnowledgeBaseFromWorkspace,
  upsertKnowledgeBasePage,
  type KnowledgeBaseRecord,
} from "@getpaseo/server/docs-vfs";
import { tryConnectToDaemon } from "../../utils/client.js";

function toWireKnowledgeBase(record: KnowledgeBaseRecord): KnowledgeBase {
  return {
    id: record.id,
    slug: record.slug,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.importedAt !== undefined ? { importedAt: record.importedAt } : {}),
    ...(record.lastEmbeddedAt !== undefined ? { lastEmbeddedAt: record.lastEmbeddedAt } : {}),
    ...(record.importProvenance !== undefined ? { importProvenance: record.importProvenance } : {}),
  };
}

export type TryConnectToDaemon = typeof tryConnectToDaemon;

export interface KbMountDaemonDeps {
  tryConnectToDaemon?: TryConnectToDaemon;
}

function supportsKnowledgeBases(client: DaemonClient): boolean {
  // COMPAT(knowledgeBases): added in v0.1.106, drop the gate when floor >= v0.1.106.
  return client.getLastServerInfoMessage()?.features?.knowledgeBases === true;
}

async function withOptionalKbDaemonClient<T>(
  host: string | undefined,
  deps: KbMountDaemonDeps,
  run: (client: DaemonClient | null) => Promise<T>,
): Promise<T> {
  const tryConnect = deps.tryConnectToDaemon ?? tryConnectToDaemon;
  const client = await tryConnect({ host });
  if (!client || !supportsKnowledgeBases(client)) {
    if (client) {
      await client.close().catch(() => {});
    }
    return run(null);
  }
  try {
    return await run(client);
  } finally {
    await client.close().catch(() => {});
  }
}

/** Create a blank KB via daemon RPC when reachable; else local docs-vfs. */
export async function createKbPreferDaemon(
  input: {
    slug: string;
    name?: string;
    host?: string;
  },
  deps: KbMountDaemonDeps = {},
): Promise<KnowledgeBase> {
  return withOptionalKbDaemonClient(input.host, deps, async (client) => {
    if (!client) {
      const record = await createEmptyKnowledgeBase({
        slug: input.slug,
        name: input.name,
      });
      return toWireKnowledgeBase(record);
    }
    const payload = await client.knowledgeBaseCreate({
      slug: input.slug,
      ...(input.name !== undefined ? { name: input.name } : {}),
    });
    if (payload.error || !payload.knowledgeBase) {
      throw new Error(payload.error ?? "Create failed");
    }
    return payload.knowledgeBase;
  });
}

/** List workspace mounts via daemon RPC when reachable; else local docs-vfs. */
export async function listKbMountsPreferDaemon(
  input: {
    workspaceId: string;
    host?: string;
  },
  deps: KbMountDaemonDeps = {},
): Promise<KnowledgeBaseMount[]> {
  return withOptionalKbDaemonClient(input.host, deps, async (client) => {
    if (!client) {
      return listWorkspaceKnowledgeBaseMounts({ workspaceId: input.workspaceId });
    }
    const payload = await client.knowledgeBaseListMounts({ workspaceId: input.workspaceId });
    if (payload.error) {
      throw new Error(payload.error);
    }
    return payload.mounts;
  });
}

/** Mount via daemon RPC when reachable; else local docs-vfs file writer. */
export async function mountKbPreferDaemon(
  input: {
    workspaceId: string;
    idOrSlug: string;
    mountSlug?: string;
    host?: string;
  },
  deps: KbMountDaemonDeps = {},
): Promise<KnowledgeBaseMount> {
  return withOptionalKbDaemonClient(input.host, deps, async (client) => {
    if (!client) {
      return mountKnowledgeBaseOnWorkspace({
        workspaceId: input.workspaceId,
        knowledgeBaseIdOrSlug: input.idOrSlug,
        mountSlug: input.mountSlug,
      });
    }
    const payload = await client.knowledgeBaseMount({
      workspaceId: input.workspaceId,
      idOrSlug: input.idOrSlug,
      ...(input.mountSlug !== undefined ? { mountSlug: input.mountSlug } : {}),
    });
    if (payload.error || !payload.mount) {
      throw new Error(payload.error ?? "Mount failed");
    }
    return payload.mount;
  });
}

/** Unmount via daemon RPC when reachable; else local docs-vfs file writer. */
export async function unmountKbPreferDaemon(
  input: {
    workspaceId: string;
    mountSlugOrKbId: string;
    host?: string;
  },
  deps: KbMountDaemonDeps = {},
): Promise<KnowledgeBaseMount> {
  return withOptionalKbDaemonClient(input.host, deps, async (client) => {
    if (!client) {
      return unmountKnowledgeBaseFromWorkspace({
        workspaceId: input.workspaceId,
        mountSlugOrKbId: input.mountSlugOrKbId,
      });
    }
    const payload = await client.knowledgeBaseUnmount({
      workspaceId: input.workspaceId,
      mountSlugOrKbId: input.mountSlugOrKbId,
    });
    if (payload.error || !payload.unmounted) {
      throw new Error(payload.error ?? "Unmount failed");
    }
    return payload.unmounted;
  });
}

/**
 * Delete-blocked usages check: prefer daemon list_usages when reachable so the
 * check sees the same WorkspaceRegistry cache mount RPCs update.
 */
export async function knowledgeBaseHasMountsPreferDaemon(
  input: {
    idOrSlug: string;
    knowledgeBaseId: string;
    host?: string;
  },
  deps: KbMountDaemonDeps = {},
): Promise<boolean> {
  return withOptionalKbDaemonClient(input.host, deps, async (client) => {
    if (!client) {
      return knowledgeBaseHasMounts(input.knowledgeBaseId);
    }
    const payload = await client.knowledgeBaseListUsages({ idOrSlug: input.idOrSlug });
    if (payload.error) {
      throw new Error(payload.error);
    }
    return payload.workspaces.length > 0;
  });
}

/** Upsert (create/update/rename) a page via daemon RPC when reachable; else local docs-vfs. */
export async function upsertKbPagePreferDaemon(
  input: {
    idOrSlug: string;
    path: string;
    content: string;
    fromPath?: string;
    host?: string;
  },
  deps: KbMountDaemonDeps = {},
): Promise<{ path: string }> {
  return withOptionalKbDaemonClient(input.host, deps, async (client) => {
    if (!client) {
      return upsertKnowledgeBasePage({
        idOrSlug: input.idOrSlug,
        path: input.path,
        content: input.content,
        ...(input.fromPath !== undefined ? { fromPath: input.fromPath } : {}),
        paseoHome: resolvePaseoHomeForDocs(),
      });
    }
    const payload = await client.knowledgeBaseUpsertPage({
      idOrSlug: input.idOrSlug,
      path: input.path,
      content: input.content,
      ...(input.fromPath !== undefined ? { fromPath: input.fromPath } : {}),
    });
    if (payload.error || !payload.path) {
      throw new Error(payload.error ?? "Upsert page failed");
    }
    return { path: payload.path };
  });
}

/** Delete a page via daemon RPC when reachable; else local docs-vfs. */
export async function deleteKbPagePreferDaemon(
  input: {
    idOrSlug: string;
    path: string;
    host?: string;
  },
  deps: KbMountDaemonDeps = {},
): Promise<{ path: string }> {
  return withOptionalKbDaemonClient(input.host, deps, async (client) => {
    if (!client) {
      return deleteKnowledgeBasePage({
        idOrSlug: input.idOrSlug,
        path: input.path,
        paseoHome: resolvePaseoHomeForDocs(),
      });
    }
    const payload = await client.knowledgeBaseDeletePage({
      idOrSlug: input.idOrSlug,
      path: input.path,
    });
    if (payload.error || !payload.path) {
      throw new Error(payload.error ?? "Delete page failed");
    }
    return { path: payload.path };
  });
}
