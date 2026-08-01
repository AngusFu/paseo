import { join } from "node:path";
import pino from "pino";
import { z } from "zod";

import { resolvePaseoHomeForDocs } from "./embeddings.js";
import { assertValidKbSlug, getKnowledgeBase } from "./knowledge-base-registry.js";
import { FileBackedWorkspaceRegistry, type WorkspaceRegistry } from "../workspace-registry.js";

export const KnowledgeBaseMountSchema = z.object({
  knowledgeBaseId: z.string(),
  mountSlug: z.string(),
});

export type KnowledgeBaseMount = z.infer<typeof KnowledgeBaseMountSchema>;

export interface KnowledgeBaseUsage {
  workspaceId: string;
  title: string | null;
  mountSlug: string;
}

function workspacesPath(paseoHome: string): string {
  return join(paseoHome, "projects", "workspaces.json");
}

/**
 * Prefer the caller's live WorkspaceRegistry (daemon Session) so mount writes
 * stay in the same cache that rename/archive persist from. Falling back to a
 * fresh FileBackedWorkspaceRegistry is for CLI / ad-hoc tests only.
 */
async function resolveWorkspaceRegistry(input: {
  paseoHome: string;
  workspaceRegistry?: WorkspaceRegistry;
}): Promise<WorkspaceRegistry> {
  if (input.workspaceRegistry) {
    await input.workspaceRegistry.initialize();
    return input.workspaceRegistry;
  }
  const registry = new FileBackedWorkspaceRegistry(
    workspacesPath(input.paseoHome),
    pino({ level: "silent" }),
  );
  await registry.initialize();
  return registry;
}

export async function listWorkspaceKnowledgeBaseMounts(input: {
  workspaceId: string;
  paseoHome?: string;
  workspaceRegistry?: WorkspaceRegistry;
}): Promise<KnowledgeBaseMount[]> {
  const paseoHome = input.paseoHome ?? resolvePaseoHomeForDocs();
  const registry = await resolveWorkspaceRegistry({
    paseoHome,
    workspaceRegistry: input.workspaceRegistry,
  });
  const row = await registry.get(input.workspaceId);
  if (!row) throw new Error(`Workspace not found: ${input.workspaceId}`);
  return row.knowledgeBaseMounts ?? [];
}

export async function mountKnowledgeBaseOnWorkspace(input: {
  workspaceId: string;
  knowledgeBaseIdOrSlug: string;
  mountSlug?: string;
  paseoHome?: string;
  workspaceRegistry?: WorkspaceRegistry;
}): Promise<KnowledgeBaseMount> {
  const paseoHome = input.paseoHome ?? resolvePaseoHomeForDocs();
  const kb = await getKnowledgeBase(input.knowledgeBaseIdOrSlug, paseoHome);
  if (!kb) throw new Error(`Knowledge base not found: ${input.knowledgeBaseIdOrSlug}`);

  const mountSlug = (input.mountSlug ?? kb.slug).trim();
  assertValidKbSlug(mountSlug);

  const registry = await resolveWorkspaceRegistry({
    paseoHome,
    workspaceRegistry: input.workspaceRegistry,
  });
  const mount: KnowledgeBaseMount = { knowledgeBaseId: kb.id, mountSlug };

  const updated = await registry.update(input.workspaceId, (existing) => {
    const mounts = [...(existing.knowledgeBaseMounts ?? [])];
    if (mounts.some((entry) => entry.knowledgeBaseId === kb.id)) {
      throw new Error(`Knowledge base already mounted on workspace: ${kb.id}`);
    }
    if (mounts.some((entry) => entry.mountSlug === mountSlug)) {
      throw new Error(`Mount slug already in use on workspace: ${mountSlug}`);
    }
    return {
      ...existing,
      knowledgeBaseMounts: [...mounts, mount],
      updatedAt: new Date().toISOString(),
    };
  });
  if (!updated) {
    throw new Error(`Workspace not found: ${input.workspaceId}`);
  }
  return mount;
}

export async function unmountKnowledgeBaseFromWorkspace(input: {
  workspaceId: string;
  mountSlugOrKbId: string;
  paseoHome?: string;
  workspaceRegistry?: WorkspaceRegistry;
}): Promise<KnowledgeBaseMount> {
  const paseoHome = input.paseoHome ?? resolvePaseoHomeForDocs();
  const registry = await resolveWorkspaceRegistry({
    paseoHome,
    workspaceRegistry: input.workspaceRegistry,
  });

  let removed: KnowledgeBaseMount | null = null;
  const updated = await registry.update(input.workspaceId, (existing) => {
    const mounts = [...(existing.knowledgeBaseMounts ?? [])];
    const mountIndex = mounts.findIndex(
      (entry) =>
        entry.mountSlug === input.mountSlugOrKbId ||
        entry.knowledgeBaseId === input.mountSlugOrKbId,
    );
    if (mountIndex < 0) {
      throw new Error(`Mount not found on workspace: ${input.mountSlugOrKbId}`);
    }
    const [entry] = mounts.splice(mountIndex, 1);
    removed = entry ?? null;
    const { knowledgeBaseMounts: _priorMounts, ...rest } = existing;
    return {
      ...rest,
      ...(mounts.length > 0 ? { knowledgeBaseMounts: mounts } : {}),
      updatedAt: new Date().toISOString(),
    };
  });
  if (!updated) {
    throw new Error(`Workspace not found: ${input.workspaceId}`);
  }
  if (!removed) {
    throw new Error(`Mount not found on workspace: ${input.mountSlugOrKbId}`);
  }
  return removed;
}

/** True if any workspace still mounts this KB (blocks delete). */
export async function knowledgeBaseHasMounts(
  knowledgeBaseId: string,
  paseoHome = resolvePaseoHomeForDocs(),
  workspaceRegistry?: WorkspaceRegistry,
): Promise<boolean> {
  const usages = await listKnowledgeBaseUsages(knowledgeBaseId, paseoHome, workspaceRegistry);
  return usages.length > 0;
}

/** Workspaces that still mount this KB (delete-blocked UX / list_usages). */
export async function listKnowledgeBaseUsages(
  knowledgeBaseId: string,
  paseoHome = resolvePaseoHomeForDocs(),
  workspaceRegistry?: WorkspaceRegistry,
): Promise<KnowledgeBaseUsage[]> {
  const registry = await resolveWorkspaceRegistry({ paseoHome, workspaceRegistry });
  const rows = await registry.list();
  const usages: KnowledgeBaseUsage[] = [];
  for (const row of rows) {
    for (const mount of row.knowledgeBaseMounts ?? []) {
      if (mount.knowledgeBaseId !== knowledgeBaseId) continue;
      usages.push({
        workspaceId: row.workspaceId,
        title: row.title ?? row.displayName ?? null,
        mountSlug: mount.mountSlug,
      });
    }
  }
  return usages;
}

/** Count of workspaces that mount each KB id (for registry list enrichment). */
export async function countKnowledgeBaseMountsById(
  paseoHome = resolvePaseoHomeForDocs(),
  workspaceRegistry?: WorkspaceRegistry,
): Promise<Map<string, number>> {
  const registry = await resolveWorkspaceRegistry({ paseoHome, workspaceRegistry });
  const rows = await registry.list();
  const counts = new Map<string, number>();
  for (const row of rows) {
    const seen = new Set<string>();
    for (const mount of row.knowledgeBaseMounts ?? []) {
      if (seen.has(mount.knowledgeBaseId)) continue;
      seen.add(mount.knowledgeBaseId);
      counts.set(mount.knowledgeBaseId, (counts.get(mount.knowledgeBaseId) ?? 0) + 1);
    }
  }
  return counts;
}
