import { readFileSync } from "node:fs";
import { Command } from "commander";
import {
  deleteKnowledgeBase,
  exportKnowledgeBase,
  getKnowledgeBase,
  importKnowledgeBase,
  knowledgeBaseLastEmbeddedAt,
  listKnowledgeBases,
  loadEmbeddingsConfig,
} from "@getpaseo/server/docs-vfs";
import { addDaemonHostOption, addJsonOption } from "../../utils/command-options.js";
import {
  createKbPreferDaemon,
  deleteKbPagePreferDaemon,
  knowledgeBaseHasMountsPreferDaemon,
  listKbMountsPreferDaemon,
  mountKbPreferDaemon,
  unmountKbPreferDaemon,
  upsertKbPagePreferDaemon,
} from "./kb-mount-daemon.js";

interface JsonOptions {
  json?: boolean;
}

interface HostOptions {
  host?: string;
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

export async function runDocsCreateCommand(
  options: {
    slug: string;
    name?: string;
    json?: boolean;
  } & HostOptions,
): Promise<void> {
  try {
    const knowledgeBase = await createKbPreferDaemon({
      slug: options.slug,
      name: options.name,
      host: options.host,
    });
    if (options.json) {
      console.log(JSON.stringify({ knowledgeBase }, null, 2));
      return;
    }
    console.log(`Created ${knowledgeBase.slug} (${knowledgeBase.id})`);
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

export async function runDocsDeleteCommand(
  idOrSlug: string,
  options: JsonOptions & HostOptions,
): Promise<void> {
  try {
    const record = await getKnowledgeBase(idOrSlug);
    if (!record) throw new Error(`Knowledge base not found: ${idOrSlug}`);
    if (
      await knowledgeBaseHasMountsPreferDaemon({
        idOrSlug,
        knowledgeBaseId: record.id,
        host: options.host,
      })
    ) {
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

export async function runDocsMountsCommand(
  options: {
    workspace?: string;
    json?: boolean;
  } & HostOptions,
): Promise<void> {
  try {
    const workspaceId = workspaceIdOrEnv(options.workspace);
    const mounts = await listKbMountsPreferDaemon({
      workspaceId,
      host: options.host,
    });
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
  options: { workspace?: string; slug?: string; json?: boolean } & HostOptions,
): Promise<void> {
  try {
    const workspaceId = workspaceIdOrEnv(options.workspace);
    const mount = await mountKbPreferDaemon({
      workspaceId,
      idOrSlug,
      mountSlug: options.slug,
      host: options.host,
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
  options: { workspace?: string; json?: boolean } & HostOptions,
): Promise<void> {
  try {
    const workspaceId = workspaceIdOrEnv(options.workspace);
    const mount = await unmountKbPreferDaemon({
      workspaceId,
      mountSlugOrKbId,
      host: options.host,
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

async function readPutContent(file: string): Promise<string> {
  if (file === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  return readFileSync(file, "utf8");
}

export async function runDocsPutCommand(
  path: string,
  options: {
    kb: string;
    file: string;
    from?: string;
    json?: boolean;
  } & HostOptions,
): Promise<void> {
  try {
    const content = await readPutContent(options.file);
    const result = await upsertKbPagePreferDaemon({
      idOrSlug: options.kb,
      path,
      content,
      ...(options.from !== undefined ? { fromPath: options.from } : {}),
      host: options.host,
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`Wrote ${result.path}`);
  } catch (error) {
    fail(error);
  }
}

export async function runDocsRmCommand(
  path: string,
  options: { kb: string; json?: boolean } & HostOptions,
): Promise<void> {
  try {
    const result = await deleteKbPagePreferDaemon({
      idOrSlug: options.kb,
      path,
      host: options.host,
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`Deleted ${result.path}`);
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

  addDaemonHostOption(
    addJsonOption(
      kb
        .command("create")
        .description("Create an empty knowledge base (no pages yet; importedAt stays null)")
        .requiredOption("--slug <slug>", "Daemon-unique slug (a-z0-9-)")
        .option("--name <name>", "Display name (defaults to slug)"),
    ),
  ).action(async (options: { slug: string; name?: string; json?: boolean } & HostOptions) => {
    await runDocsCreateCommand(options);
  });

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

  addDaemonHostOption(
    addJsonOption(
      kb
        .command("delete")
        .description("Delete a knowledge base (refuses if still mounted)")
        .argument("<id-or-slug>", "Knowledge base id or slug"),
    ),
  ).action(async (idOrSlug: string, options: JsonOptions & HostOptions) => {
    await runDocsDeleteCommand(idOrSlug, options);
  });

  addDaemonHostOption(
    addJsonOption(
      kb
        .command("mounts")
        .description("List knowledge base mounts for a workspace")
        .option("--workspace <id>", "Workspace id (default: PASEO_WORKSPACE_ID)"),
    ),
  ).action(async (options: { workspace?: string; json?: boolean } & HostOptions) => {
    await runDocsMountsCommand(options);
  });

  addDaemonHostOption(
    addJsonOption(
      kb
        .command("mount")
        .description("Mount a knowledge base on a workspace")
        .argument("<id-or-slug>", "Knowledge base id or slug")
        .option("--workspace <id>", "Workspace id (default: PASEO_WORKSPACE_ID)")
        .option("--slug <mountSlug>", "Mount slug under /paseo-vfs (default: KB slug)"),
    ),
  ).action(
    async (
      idOrSlug: string,
      options: { workspace?: string; slug?: string; json?: boolean } & HostOptions,
    ) => {
      await runDocsMountCommand(idOrSlug, options);
    },
  );

  addDaemonHostOption(
    addJsonOption(
      kb
        .command("unmount")
        .description("Remove a knowledge base mount from a workspace")
        .argument("<mount-slug-or-kb-id>", "Mount slug or knowledge base id")
        .option("--workspace <id>", "Workspace id (default: PASEO_WORKSPACE_ID)"),
    ),
  ).action(
    async (
      mountSlugOrKbId: string,
      options: { workspace?: string; json?: boolean } & HostOptions,
    ) => {
      await runDocsUnmountCommand(mountSlugOrKbId, options);
    },
  );

  addDaemonHostOption(
    addJsonOption(
      kb
        .command("put")
        .description("Create or update a page in a knowledge base (host authoring; not VFS)")
        .argument("<path>", "Page path inside the KB (e.g. guides/a.md)")
        .requiredOption("--kb <id-or-slug>", "Knowledge base id or slug")
        .requiredOption("--file <path>", "Markdown file path, or - for stdin")
        .option("--from <path>", "Rename/move from this existing path"),
    ),
  ).action(
    async (
      path: string,
      options: { kb: string; file: string; from?: string; json?: boolean } & HostOptions,
    ) => {
      await runDocsPutCommand(path, options);
    },
  );

  addDaemonHostOption(
    addJsonOption(
      kb
        .command("rm")
        .description("Delete a page from a knowledge base (host authoring; not VFS)")
        .argument("<path>", "Page path inside the KB")
        .requiredOption("--kb <id-or-slug>", "Knowledge base id or slug"),
    ),
  ).action(async (path: string, options: { kb: string; json?: boolean } & HostOptions) => {
    await runDocsRmCommand(path, options);
  });
}
