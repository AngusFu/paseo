import { existsSync } from "node:fs";
import {
  docsVfsDirForKnowledgeBase,
  getKnowledgeBase,
  type KnowledgeBaseRecord,
} from "./knowledge-base-registry.js";
import { listWorkspaceKnowledgeBaseMounts } from "./knowledge-base-mounts.js";
import { docsVfsDir } from "./vector-store.js";
import { loadEmbeddingsConfig, resolvePaseoHomeForDocs } from "./embeddings.js";
import {
  DEFAULT_DOCS_MOUNT_SLUG,
  parseVirtualPath,
  resolveDocsRoot,
  VIRTUAL_VFS_ROOT,
} from "./store.js";

export type DocsOpenMode = "knowledge_base" | "root_dogfood" | "mount_listing";

export interface ResolvedDocsTarget {
  mode: DocsOpenMode;
  paseoHome: string;
  /** Directory containing docs.sqlite when mode opens a store. */
  storeDir?: string;
  knowledgeBase?: KnowledgeBaseRecord;
  mountSlug?: string;
  /** For mount_listing — ordered mount slugs on the workspace. */
  mountSlugs?: string[];
}

export interface ResolveDocsTargetInput {
  pathArg?: string;
  kb?: string;
  root?: string;
  unsafe?: boolean;
  workspaceId?: string;
  paseoHome?: string;
  env?: NodeJS.ProcessEnv;
}

function workspaceIdFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.PASEO_WORKSPACE_ID?.trim();
  return value || undefined;
}

function dogfoodRootTarget(input: {
  root?: string;
  paseoHome: string;
  env: NodeJS.ProcessEnv;
}): ResolvedDocsTarget {
  const docsRoot = resolveDocsRoot({ explicitRoot: input.root, env: input.env });
  const config = loadEmbeddingsConfig({ paseoHome: input.paseoHome, env: input.env });
  const model = config?.model ?? "qwen3-embedding:0.6b";
  return {
    mode: "root_dogfood",
    paseoHome: input.paseoHome,
    storeDir: docsVfsDir(input.paseoHome, docsRoot, model),
    mountSlug: DEFAULT_DOCS_MOUNT_SLUG,
  };
}

async function resolveExplicitKb(input: {
  kb: string;
  workspaceId?: string;
  unsafe: boolean;
  paseoHome: string;
}): Promise<ResolvedDocsTarget> {
  const kb = await getKnowledgeBase(input.kb, input.paseoHome);
  if (!kb) throw new Error(`Knowledge base not found: ${input.kb}`);

  if (input.workspaceId && !input.unsafe) {
    const mounts = await listWorkspaceKnowledgeBaseMounts({
      workspaceId: input.workspaceId,
      paseoHome: input.paseoHome,
    });
    const mount = mounts.find((entry) => entry.knowledgeBaseId === kb.id);
    if (!mount) {
      throw new Error(
        `Knowledge base "${kb.slug}" is not mounted on workspace ${input.workspaceId}. Mount it first, or pass --unsafe.`,
      );
    }
    return {
      mode: "knowledge_base",
      paseoHome: input.paseoHome,
      storeDir: docsVfsDirForKnowledgeBase(input.paseoHome, kb.id),
      knowledgeBase: kb,
      mountSlug: mount.mountSlug,
    };
  }

  return {
    mode: "knowledge_base",
    paseoHome: input.paseoHome,
    storeDir: docsVfsDirForKnowledgeBase(input.paseoHome, kb.id),
    knowledgeBase: kb,
    mountSlug: kb.slug,
  };
}

async function resolveWorkspacePath(input: {
  workspaceId: string;
  pathArg?: string;
  parsed: { mountSlug: string | null; docSlug: string } | null;
  paseoHome: string;
}): Promise<ResolvedDocsTarget> {
  const mounts = await listWorkspaceKnowledgeBaseMounts({
    workspaceId: input.workspaceId,
    paseoHome: input.paseoHome,
  });
  const pathLooksLikeVfsRoot =
    !input.pathArg ||
    input.pathArg === "." ||
    input.pathArg === VIRTUAL_VFS_ROOT ||
    input.pathArg === `${VIRTUAL_VFS_ROOT}/`;

  if (pathLooksLikeVfsRoot && !input.parsed?.mountSlug) {
    return {
      mode: "mount_listing",
      paseoHome: input.paseoHome,
      mountSlugs: mounts.map((mount) => mount.mountSlug),
    };
  }

  const mountSlug = input.parsed?.mountSlug;
  if (!mountSlug) {
    if (mounts.length === 1) {
      const only = mounts[0]!;
      const kb = await getKnowledgeBase(only.knowledgeBaseId, input.paseoHome);
      if (!kb) throw new Error(`Mounted knowledge base missing: ${only.knowledgeBaseId}`);
      return {
        mode: "knowledge_base",
        paseoHome: input.paseoHome,
        storeDir: docsVfsDirForKnowledgeBase(input.paseoHome, kb.id),
        knowledgeBase: kb,
        mountSlug: only.mountSlug,
      };
    }
    throw new Error(
      `Pass a path under ${VIRTUAL_VFS_ROOT}/<mountSlug>/… or --kb <id|slug> (workspace has ${mounts.length} mounts).`,
    );
  }

  const mount = mounts.find((entry) => entry.mountSlug === mountSlug);
  if (!mount) {
    const available = mounts.map((entry) => entry.mountSlug).join(", ") || "(none)";
    throw new Error(
      `Mount "${mountSlug}" is not available on workspace ${input.workspaceId}. Mounted: ${available}.`,
    );
  }
  const kb = await getKnowledgeBase(mount.knowledgeBaseId, input.paseoHome);
  if (!kb) throw new Error(`Mounted knowledge base missing: ${mount.knowledgeBaseId}`);
  return {
    mode: "knowledge_base",
    paseoHome: input.paseoHome,
    storeDir: docsVfsDirForKnowledgeBase(input.paseoHome, kb.id),
    knowledgeBase: kb,
    mountSlug: mount.mountSlug,
  };
}

/**
 * Resolve which SQLite store (or mount listing) a `paseo kb` command should use.
 *
 * Enforcement: when a workspace id is present (env or explicit), `--root` and
 * unmounted `--kb` require `--unsafe`.
 */
export async function resolveDocsTarget(
  input: ResolveDocsTargetInput,
): Promise<ResolvedDocsTarget> {
  const env = input.env ?? process.env;
  const paseoHome = input.paseoHome ?? resolvePaseoHomeForDocs(env);
  const workspaceId = input.workspaceId?.trim() || workspaceIdFromEnv(env);
  const unsafe = Boolean(input.unsafe);
  const parsed = input.pathArg ? parseVirtualPath(input.pathArg) : null;

  if (input.root) {
    if (workspaceId && !unsafe) {
      throw new Error(
        "paseo kb --root is blocked when PASEO_WORKSPACE_ID is set (mount ACL). Pass --unsafe for dogfood, or use a mounted knowledge base.",
      );
    }
    return dogfoodRootTarget({ root: input.root, paseoHome, env });
  }

  if (input.kb) {
    return resolveExplicitKb({ kb: input.kb, workspaceId, unsafe, paseoHome });
  }

  if (workspaceId) {
    return resolveWorkspacePath({ workspaceId, pathArg: input.pathArg, parsed, paseoHome });
  }

  // No workspace context: dogfood --root resolution from cwd / env.
  const target = dogfoodRootTarget({ paseoHome, env });
  if (
    !existsSync(target.storeDir!) &&
    parsed?.mountSlug &&
    parsed.mountSlug !== DEFAULT_DOCS_MOUNT_SLUG
  ) {
    throw new Error(
      `No workspace context and no index for mount "${parsed.mountSlug}". Create a knowledge base (\`paseo kb import\`) or pass --kb / --root.`,
    );
  }
  return target;
}
