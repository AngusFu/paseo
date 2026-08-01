import { Command } from "commander";
import {
  deleteKnowledgeBase,
  exportKnowledgeBase,
  getKnowledgeBase,
  importKnowledgeBase,
  knowledgeBaseHasMounts,
  knowledgeBaseLastEmbeddedAt,
  listKnowledgeBases,
  listWorkspaceKnowledgeBaseMounts,
  loadEmbeddingsConfig,
  mountKnowledgeBaseOnWorkspace,
  unmountKnowledgeBaseFromWorkspace,
} from "@getpaseo/server/docs-vfs";
import { addJsonOption } from "../../utils/command-options.js";

interface JsonOptions {
  json?: boolean;
}

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}

function workspaceIdOrEnv(explicit?: string): string {
  const id = explicit?.trim() || process.env.PASEO_WORKSPACE_ID?.trim();
  if (!id) {
    throw new Error("Pass --workspace <id> or set PASEO_WORKSPACE_ID");
  }
  return id;
}

export async function runDocsListCommand(options: JsonOptions): Promise<void> {
  try {
    const list = await listKnowledgeBases();
    if (options.json) {
      console.log(JSON.stringify({ knowledgeBases: list }, null, 2));
      return;
    }
    if (list.length === 0) {
      console.log("(no knowledge bases)");
      return;
    }
    for (const row of list) {
      const embedded = knowledgeBaseLastEmbeddedAt(row) ?? "never";
      const provenance = row.importProvenance ?? "-";
      console.log(`${row.slug}\t${row.id}\tembedded=${embedded}\t${provenance}`);
    }
  } catch (error) {
    fail(error);
  }
}

export async function runDocsImportCommand(options: {
  slug: string;
  from: string;
  name?: string;
  json?: boolean;
}): Promise<void> {
  try {
    const config = loadEmbeddingsConfig({});
    const result = await importKnowledgeBase({
      slug: options.slug,
      name: options.name,
      from: options.from,
      config: config ?? { enabled: false, baseUrl: "", apiKey: "", model: "" },
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `Imported ${result.knowledgeBase.slug} (${result.knowledgeBase.id}) from ${result.source}\n` +
        `${result.meta.chunkCount} chunks → ${result.dbPath}`,
    );
  } catch (error) {
    fail(error);
  }
}

export async function runDocsExportCommand(
  idOrSlug: string,
  options: { out: string; json?: boolean },
): Promise<void> {
  try {
    const result = await exportKnowledgeBase({
      idOrSlug,
      outDir: options.out,
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `Exported ${result.knowledgeBase.slug} → ${result.outDir}\n` +
        `${result.manifest.pageCount} pages (format ${result.manifest.format})`,
    );
  } catch (error) {
    fail(error);
  }
}

export async function runDocsDeleteCommand(idOrSlug: string, options: JsonOptions): Promise<void> {
  try {
    const record = await getKnowledgeBase(idOrSlug);
    if (!record) throw new Error(`Knowledge base not found: ${idOrSlug}`);
    if (await knowledgeBaseHasMounts(record.id)) {
      throw new Error(
        `Knowledge base ${record.slug} is still mounted on one or more workspaces. Unmount first.`,
      );
    }
    const deleted = await deleteKnowledgeBase({ idOrSlug: record.id });
    if (options.json) {
      console.log(JSON.stringify({ deleted }, null, 2));
      return;
    }
    console.log(`Deleted ${deleted.slug} (${deleted.id})`);
  } catch (error) {
    fail(error);
  }
}

export async function runDocsMountsCommand(options: {
  workspace?: string;
  json?: boolean;
}): Promise<void> {
  try {
    const workspaceId = workspaceIdOrEnv(options.workspace);
    const mounts = await listWorkspaceKnowledgeBaseMounts({ workspaceId });
    if (options.json) {
      console.log(JSON.stringify({ workspaceId, mounts }, null, 2));
      return;
    }
    if (mounts.length === 0) {
      console.log("(no mounts)");
      return;
    }
    for (const mount of mounts) {
      console.log(`${mount.mountSlug}\t${mount.knowledgeBaseId}`);
    }
  } catch (error) {
    fail(error);
  }
}

export async function runDocsMountCommand(
  idOrSlug: string,
  options: { workspace?: string; slug?: string; json?: boolean },
): Promise<void> {
  try {
    const workspaceId = workspaceIdOrEnv(options.workspace);
    const mount = await mountKnowledgeBaseOnWorkspace({
      workspaceId,
      knowledgeBaseIdOrSlug: idOrSlug,
      mountSlug: options.slug,
    });
    if (options.json) {
      console.log(JSON.stringify({ workspaceId, mount }, null, 2));
      return;
    }
    console.log(`Mounted ${mount.knowledgeBaseId} as /paseo-vfs/${mount.mountSlug}`);
  } catch (error) {
    fail(error);
  }
}

export async function runDocsUnmountCommand(
  mountSlugOrKbId: string,
  options: { workspace?: string; json?: boolean },
): Promise<void> {
  try {
    const workspaceId = workspaceIdOrEnv(options.workspace);
    const mount = await unmountKnowledgeBaseFromWorkspace({
      workspaceId,
      mountSlugOrKbId,
    });
    if (options.json) {
      console.log(JSON.stringify({ workspaceId, unmounted: mount }, null, 2));
      return;
    }
    console.log(`Unmounted /paseo-vfs/${mount.mountSlug}`);
  } catch (error) {
    fail(error);
  }
}

/** Register KB management subcommands on `paseo kb`. */
export function addDocsManageCommands(kb: Command): void {
  addJsonOption(kb.command("list").description("List knowledge bases on this daemon")).action(
    async (options: JsonOptions) => {
      await runDocsListCommand(options);
    },
  );

  addJsonOption(
    kb
      .command("import")
      .description(
        "One-shot import: create a new self-contained KB from a docs folder or corpus package",
      )
      .requiredOption("--slug <slug>", "Daemon-unique slug (a-z0-9-)")
      .requiredOption(
        "--from <dir>",
        "Docs folder (.md/.mdx/.txt) or corpus package dir (manifest.json + pages/)",
      )
      .option("--name <name>", "Display name (defaults to slug)"),
  ).action(async (options: { slug: string; from: string; name?: string; json?: boolean }) => {
    await runDocsImportCommand(options);
  });

  addJsonOption(
    kb
      .command("export")
      .description("Export a KB corpus package (path_tree + page text + metadata; no embeddings)")
      .argument("<id-or-slug>", "Knowledge base id or slug")
      .requiredOption("--out <dir>", "Output directory for the corpus package"),
  ).action(async (idOrSlug: string, options: { out: string; json?: boolean }) => {
    await runDocsExportCommand(idOrSlug, options);
  });

  addJsonOption(
    kb
      .command("delete")
      .description("Delete a knowledge base (refuses if still mounted)")
      .argument("<id-or-slug>", "Knowledge base id or slug"),
  ).action(async (idOrSlug: string, options: JsonOptions) => {
    await runDocsDeleteCommand(idOrSlug, options);
  });

  addJsonOption(
    kb
      .command("mounts")
      .description("List knowledge base mounts for a workspace")
      .option("--workspace <id>", "Workspace id (default: PASEO_WORKSPACE_ID)"),
  ).action(async (options: { workspace?: string; json?: boolean }) => {
    await runDocsMountsCommand(options);
  });

  addJsonOption(
    kb
      .command("mount")
      .description("Mount a knowledge base on a workspace")
      .argument("<id-or-slug>", "Knowledge base id or slug")
      .option("--workspace <id>", "Workspace id (default: PASEO_WORKSPACE_ID)")
      .option("--slug <mountSlug>", "Mount slug under /paseo-vfs (default: KB slug)"),
  ).action(
    async (idOrSlug: string, options: { workspace?: string; slug?: string; json?: boolean }) => {
      await runDocsMountCommand(idOrSlug, options);
    },
  );

  addJsonOption(
    kb
      .command("unmount")
      .description("Remove a knowledge base mount from a workspace")
      .argument("<mount-slug-or-kb-id>", "Mount slug or knowledge base id")
      .option("--workspace <id>", "Workspace id (default: PASEO_WORKSPACE_ID)"),
  ).action(async (mountSlugOrKbId: string, options: { workspace?: string; json?: boolean }) => {
    await runDocsUnmountCommand(mountSlugOrKbId, options);
  });
}
