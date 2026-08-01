import { Command } from "commander";
import {
  embedTexts,
  loadEmbeddingsConfig,
  openDocsVectorStore,
  parseGrepArgv,
  rebuildDocsVectorStore,
  resolveDocsRoot,
  resolveDocsTarget,
  resolvePaseoHomeForDocs,
  toVirtualPath,
  VIRTUAL_DOCS_ROOT,
  VIRTUAL_VFS_ROOT,
  type DocsVectorStore,
  type ResolvedDocsTarget,
} from "@getpaseo/server/docs-vfs";
import { addJsonOption } from "../../utils/command-options.js";
import { addDocsManageCommands } from "./manage.js";

interface DocsCommandOptions {
  root?: string;
  kb?: string;
  unsafe?: boolean;
  workspace?: string;
  ignoreCase?: boolean;
  lineNumber?: boolean;
  recursive?: boolean;
  fixedStrings?: boolean;
  extendedRegexp?: boolean;
  limit?: string;
  json?: boolean;
}

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}

function mergeOptions(local: DocsCommandOptions, command: Command): DocsCommandOptions {
  const globals = command.optsWithGlobals() as DocsCommandOptions;
  return { ...globals, ...local, json: Boolean(local.json || globals.json) };
}

function parentDocsOpts(command: Command, options: DocsCommandOptions): DocsCommandOptions {
  const parent = (command.parent?.opts() ?? {}) as DocsCommandOptions;
  return {
    ...options,
    root: options.root ?? parent.root,
    kb: options.kb ?? parent.kb,
    unsafe: Boolean(options.unsafe || parent.unsafe),
    workspace: options.workspace ?? parent.workspace,
  };
}

/** Argv after `grep`, minus global `--json` handled by Commander. */
export function extractGrepArgv(argv: string[]): string[] {
  const grepIndex = argv.lastIndexOf("grep");
  if (grepIndex < 0) return [];
  return argv.slice(grepIndex + 1).filter((arg) => arg !== "--json");
}

async function resolveTarget(
  options: DocsCommandOptions,
  pathArg?: string,
): Promise<ResolvedDocsTarget> {
  return resolveDocsTarget({
    pathArg,
    kb: options.kb,
    root: options.root,
    unsafe: options.unsafe,
    workspaceId: options.workspace,
  });
}

function openStoreFromTarget(target: ResolvedDocsTarget): DocsVectorStore {
  if (!target.storeDir) {
    throw new Error("Internal error: storeDir missing for docs open");
  }
  return openDocsVectorStore(target.storeDir, { mountSlug: target.mountSlug });
}

function virtualPath(slug: string, target: ResolvedDocsTarget): string {
  return toVirtualPath(slug, target.mountSlug);
}

export async function runDocsLsCommand(
  pathArgs: string[],
  options: DocsCommandOptions,
): Promise<void> {
  try {
    const primary = pathArgs[0];
    const target = await resolveTarget(options, primary);

    if (target.mode === "mount_listing") {
      const entries = (target.mountSlugs ?? []).map((slug) => `${slug}/`);
      if (options.json) {
        console.log(
          JSON.stringify(
            { backend: "mounts", path: VIRTUAL_VFS_ROOT, entries: target.mountSlugs ?? [] },
            null,
            2,
          ),
        );
        return;
      }
      for (const entry of entries) console.log(entry);
      return;
    }

    const store = openStoreFromTarget(target);
    const targets = pathArgs.length > 0 ? pathArgs : [virtualPath("", target)];
    const multi = targets.length > 1;
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            backend: "chroma",
            mode: target.mode,
            mountSlug: target.mountSlug,
            knowledgeBaseId: target.knowledgeBase?.id,
            meta: store.meta(),
            listings: targets.map((path) => ({
              path,
              entries: store.list(path === VIRTUAL_VFS_ROOT ? virtualPath("", target) : path),
            })),
          },
          null,
          2,
        ),
      );
      await store.close();
      return;
    }
    for (let i = 0; i < targets.length; i++) {
      const path = targets[i]!;
      const listPath = path === VIRTUAL_VFS_ROOT || path === "." ? virtualPath("", target) : path;
      const entries = store.list(listPath);
      if (multi) {
        if (i > 0) console.log("");
        console.log(`${path}:`);
      }
      for (const entry of entries) console.log(entry);
    }
    await store.close();
  } catch (error) {
    fail(error);
  }
}

export async function runDocsCatCommand(
  files: string[],
  options: DocsCommandOptions,
): Promise<void> {
  try {
    if (files.length === 0) throw new Error("paseo kb cat: missing file operand");
    const target = await resolveTarget(options, files[0]);
    if (target.mode === "mount_listing") {
      throw new Error("paseo kb cat: pick a path under a mounted knowledge base");
    }
    const store = openStoreFromTarget(target);
    if (options.json) {
      const docs = [];
      for (const file of files) {
        const { slug, content } = await store.cat(file);
        docs.push({ slug, virtualPath: virtualPath(slug, target), content });
      }
      console.log(JSON.stringify({ backend: "chroma", docs }, null, 2));
      await store.close();
      return;
    }
    for (const file of files) {
      const { content } = await store.cat(file);
      process.stdout.write(content.endsWith("\n") ? content : `${content}\n`);
    }
    await store.close();
  } catch (error) {
    fail(error);
  }
}

export async function runDocsGrepCommand(
  argv: string[],
  options: DocsCommandOptions,
): Promise<void> {
  try {
    const parsed = parseGrepArgv(argv);
    const pathHint = parsed.paths[0];
    const target = await resolveTarget(options, pathHint);
    if (target.mode === "mount_listing") {
      throw new Error("paseo kb grep: pass a path under a mounted knowledge base");
    }
    const store = openStoreFromTarget(target);
    const paths = parsed.paths.length > 0 ? parsed.paths : [virtualPath("", target)];
    const hits = await store.grep(parsed.pattern, {
      paths,
      ignoreCase: parsed.ignoreCase || Boolean(options.ignoreCase),
      fixedStrings: parsed.fixedStrings || Boolean(options.fixedStrings),
    });
    const lineNumber = parsed.lineNumber || Boolean(options.lineNumber);
    if (options.json) {
      console.log(JSON.stringify({ backend: "chroma", pattern: parsed.pattern, hits }, null, 2));
      await store.close();
      return;
    }
    for (const hit of hits) {
      const path = virtualPath(hit.slug, target);
      if (lineNumber) console.log(`${path}:${hit.line}:${hit.text}`);
      else console.log(`${path}:${hit.text}`);
    }
    await store.close();
  } catch (error) {
    fail(error);
  }
}

export async function runDocsIndexCommand(options: DocsCommandOptions): Promise<void> {
  try {
    if (options.kb) {
      throw new Error(
        "`paseo kb index` is for --root dogfood only. Use `paseo kb import` for a registered knowledge base.",
      );
    }
    const docsRoot = resolveDocsRoot({ explicitRoot: options.root });
    const config = loadEmbeddingsConfig({});
    if (!config?.enabled) {
      throw new Error(
        "Embeddings disabled. Enable embeddings in Host settings → Knowledge bases " +
          "(or set localTools.embeddings.enabled=true in $PASEO_HOME/config.json).",
      );
    }
    if (process.env.PASEO_WORKSPACE_ID?.trim() && !options.unsafe) {
      throw new Error(
        "paseo kb index --root is blocked when PASEO_WORKSPACE_ID is set. Pass --unsafe for dogfood, or use `paseo kb import`.",
      );
    }
    const result = await rebuildDocsVectorStore({
      docsRoot,
      paseoHome: resolvePaseoHomeForDocs(),
      config,
    });
    const payload = {
      backend: "chroma",
      dir: result.dir,
      dbPath: result.dbPath,
      chromaPath: result.chromaPath,
      chromaCollection: result.chromaCollection,
      ...result.meta,
    };
    if (options.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(
      `Indexed ${result.meta.chunkCount} chunks → Chroma (${result.meta.model})\n` +
        `corpus ${result.dbPath}\nvectors ${result.chromaPath} (${result.chromaCollection})`,
    );
  } catch (error) {
    fail(error);
  }
}

export async function runDocsSearchCommand(
  query: string,
  options: DocsCommandOptions,
): Promise<void> {
  try {
    const config = loadEmbeddingsConfig({});
    if (!config?.enabled) {
      throw new Error(
        "Embeddings disabled. Enable embeddings in Host settings → Knowledge bases, then run `paseo kb index` or `paseo kb import`.",
      );
    }
    const target = await resolveTarget(options);
    if (target.mode === "mount_listing") {
      throw new Error(
        "paseo kb search needs a mounted knowledge base. Pass --kb or a path under /paseo-vfs/<mount>/…",
      );
    }
    const store = openStoreFromTarget(target);
    const [queryVec] = await embedTexts(config, [query]);
    if (!queryVec) {
      await store.close();
      throw new Error("Empty embedding for query");
    }
    const limit = options.limit ? Number(options.limit) : 8;
    if (!Number.isFinite(limit) || limit <= 0) throw new Error("--limit must be a positive number");
    const results = await store.search(queryVec, { limit });
    if (options.json) {
      console.log(
        JSON.stringify({ backend: "chroma", query, model: config.model, results }, null, 2),
      );
      await store.close();
      return;
    }
    for (const hit of results) {
      const preview = hit.text.replace(/\s+/g, " ").slice(0, 160);
      console.log(
        `${hit.score.toFixed(3)}\t${virtualPath(hit.slug, target)}#${hit.chunkIndex}\t${preview}`,
      );
    }
    await store.close();
  } catch (error) {
    fail(error);
  }
}

/** Product CLI: explore + manage under `paseo kb`. */
export function createKbCommand(): Command {
  const root = new Command("kb").description(
    `Knowledge bases + VFS (${VIRTUAL_VFS_ROOT}/<mount>; explore: ls|cat|grep|search; manage: import|export|list|mount|…)`,
  );

  root
    .option("--root <dir>", "Dogfood: index/read a directory without a registered KB")
    .option("--kb <id-or-slug>", "Open a registered knowledge base")
    .option("--workspace <id>", "Workspace id for mount ACL (default: PASEO_WORKSPACE_ID)")
    .option("--unsafe", "Allow --root / unmounted --kb when a workspace id is set");

  addJsonOption(
    root
      .command("ls")
      .description("List directory contents from path_tree (or mounted KB slugs)")
      .argument("[file...]", `Path under ${VIRTUAL_VFS_ROOT}/<mount>`),
  ).action(async (files: string[], options: DocsCommandOptions, command: Command) => {
    await runDocsLsCommand(files, parentDocsOpts(command, mergeOptions(options, command)));
  });

  addJsonOption(
    root
      .command("cat")
      .description("Read a page from the corpus (like Mintlify cat)")
      .argument("<file...>", `e.g. ${VIRTUAL_DOCS_ROOT}/architecture.md`),
  ).action(async (files: string[], options: DocsCommandOptions, command: Command) => {
    await runDocsCatCommand(files, parentDocsOpts(command, mergeOptions(options, command)));
  });

  // GNU-shaped argv after `kb grep` (including clustered `-ri`) for prefix rewrite.
  addJsonOption(
    root
      .command("grep")
      .description("Coarse DB text filter + fine line regex (Mintlify grep)")
      .argument("[args...]", "GNU grep-shaped argv: [-inrEF] PATTERN [FILE...]")
      .allowUnknownOption(true),
  ).action(async (_args: string[], options: DocsCommandOptions, command: Command) => {
    await runDocsGrepCommand(
      extractGrepArgv(process.argv),
      parentDocsOpts(command, mergeOptions(options, command)),
    );
  });

  addJsonOption(
    root
      .command("index")
      .description(
        "Dogfood: ingest --root into hash-keyed corpus + Chroma (prefer `kb import` for registered KBs)",
      ),
  ).action(async (options: DocsCommandOptions, command: Command) => {
    await runDocsIndexCommand(parentDocsOpts(command, mergeOptions(options, command)));
  });

  addJsonOption(
    root
      .command("search")
      .description("Vector search over chunk embeddings in local Chroma")
      .argument("<query>", "Natural-language query")
      .option("--limit <n>", "Max results (default 8)"),
  ).action(async (query: string, options: DocsCommandOptions, command: Command) => {
    await runDocsSearchCommand(query, parentDocsOpts(command, mergeOptions(options, command)));
  });

  addDocsManageCommands(root);

  return root;
}
