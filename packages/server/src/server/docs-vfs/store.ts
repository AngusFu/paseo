import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/** Virtual VFS prefix agents see (`/paseo-vfs/<mountSlug>/…`). */
export const VIRTUAL_VFS_ROOT = "/paseo-vfs";
/** Default mount slug for `--root` dogfood and legacy paths. */
export const DEFAULT_DOCS_MOUNT_SLUG = "docs";
/** @deprecated Prefer `virtualRootForMount` — dogfood default mount. */
export const VIRTUAL_DOCS_ROOT = `${VIRTUAL_VFS_ROOT}/${DEFAULT_DOCS_MOUNT_SLUG}`;

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt"]);

export function virtualRootForMount(mountSlug: string): string {
  return `${VIRTUAL_VFS_ROOT}/${mountSlug}`;
}

/** Split `/paseo-vfs/<mountSlug>/doc/path` into mount + in-store doc slug. */
export function parseVirtualPath(input: string): { mountSlug: string | null; docSlug: string } {
  let slug = input.trim().replaceAll("\\", "/");
  if (!slug || slug === ".") {
    return { mountSlug: null, docSlug: "" };
  }
  if (slug === VIRTUAL_VFS_ROOT || slug === `${VIRTUAL_VFS_ROOT}/`) {
    return { mountSlug: null, docSlug: "" };
  }
  if (slug.startsWith(`${VIRTUAL_VFS_ROOT}/`)) {
    const rest = slug.slice(VIRTUAL_VFS_ROOT.length + 1).replace(/\/+$/, "");
    if (!rest) return { mountSlug: null, docSlug: "" };
    const slash = rest.indexOf("/");
    if (slash === -1) {
      return { mountSlug: rest, docSlug: "" };
    }
    return {
      mountSlug: rest.slice(0, slash),
      docSlug: rest.slice(slash + 1).replace(/\/+$/, ""),
    };
  }
  return { mountSlug: null, docSlug: slug.replace(/^\/+/, "").replace(/\/+$/, "") };
}

export interface DocsPathEntry {
  slug: string;
  absolutePath: string;
  isDirectory: boolean;
}

export interface DocsStore {
  rootDir: string;
  /** File slugs relative to rootDir using `/` separators (no leading slash). */
  files: Map<string, string>;
  /** Directory slug → child names (files and dirs), sorted. */
  children: Map<string, string[]>;
}

/**
 * Normalize a path to an in-store document slug (no mount prefix).
 * Strips any `/paseo-vfs/<mountSlug>/…` prefix. Mount ACL is enforced by
 * `resolveDocsTarget` before a store is opened — not here.
 */
export function normalizeSlug(input: string): string {
  return parseVirtualPath(input).docSlug;
}

export function resolveDocsRoot(options: {
  explicitRoot?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = options.env ?? process.env;
  if (options.explicitRoot) {
    return resolve(options.explicitRoot);
  }
  if (env.PASEO_DOCS_ROOT) {
    return resolve(env.PASEO_DOCS_ROOT);
  }

  let dir = resolve(options.cwd ?? process.cwd());
  for (;;) {
    const candidate = join(dir, "docs");
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    "Could not find a docs/ directory. Pass --root, set PASEO_DOCS_ROOT, or run from a repo that has docs/.",
  );
}

function isDocFile(name: string): boolean {
  const lower = name.toLowerCase();
  for (const ext of DOC_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

function toPosixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

export function buildDocsStore(rootDir: string): DocsStore {
  const resolvedRoot = resolve(rootDir);
  if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) {
    throw new Error(`Docs root is not a directory: ${resolvedRoot}`);
  }

  const files = new Map<string, string>();
  const children = new Map<string, string[]>();
  children.set("", []);

  function walk(absDir: string, slugDir: string): void {
    const entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = join(absDir, entry.name);
      const slug = slugDir ? `${slugDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const list = children.get(slugDir) ?? [];
        list.push(`${entry.name}/`);
        children.set(slugDir, list);
        children.set(slug, []);
        walk(abs, slug);
        continue;
      }
      if (!entry.isFile() || !isDocFile(entry.name)) continue;
      files.set(slug, abs);
      const list = children.get(slugDir) ?? [];
      list.push(entry.name);
      children.set(slugDir, list);
    }
  }

  walk(resolvedRoot, "");

  for (const [key, list] of children) {
    children.set(
      key,
      [...new Set(list)].sort((a, b) => a.localeCompare(b)),
    );
  }

  return { rootDir: resolvedRoot, files, children };
}

export function listDocs(
  store: DocsStore,
  pathInput = "",
  mountSlug = DEFAULT_DOCS_MOUNT_SLUG,
): string[] {
  const slug = normalizeSlug(pathInput);
  if (slug && store.files.has(slug)) {
    return [toVirtualPath(slug, mountSlug)];
  }
  const kids = store.children.get(slug);
  if (!kids) {
    const display = slug
      ? `${virtualRootForMount(mountSlug)}/${slug}`
      : virtualRootForMount(mountSlug);
    throw new Error(`No such path in virtual docs: ${display}`);
  }
  // ls-style names: files as-is, directories keep trailing /
  return [...kids];
}

export function resolveDocFile(
  store: DocsStore,
  pathInput: string,
  mountSlug = DEFAULT_DOCS_MOUNT_SLUG,
): { slug: string; absolutePath: string } {
  const slug = normalizeSlug(pathInput);
  if (!slug) {
    throw new Error("cat requires a document slug (e.g. architecture.md)");
  }

  const direct = store.files.get(slug);
  if (direct) return { slug, absolutePath: direct };

  // Allow omitting extension when the stem uniquely matches a basename.
  const stemMatches = [...store.files.keys()].filter((key) => {
    const base = key.split("/").pop() ?? key;
    const stem = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
    return base === slug || stem === slug || key === slug;
  });
  if (stemMatches.length === 1) {
    const found = stemMatches[0]!;
    return { slug: found, absolutePath: store.files.get(found)! };
  }
  if (stemMatches.length > 1) {
    throw new Error(`Ambiguous slug "${slug}". Candidates: ${stemMatches.join(", ")}`);
  }
  throw new Error(`No such document: ${virtualRootForMount(mountSlug)}/${slug}`);
}

export function readDoc(store: DocsStore, pathInput: string): { slug: string; content: string } {
  const { slug, absolutePath } = resolveDocFile(store, pathInput);
  return { slug, content: readFileSync(absolutePath, "utf8") };
}

export interface GrepHit {
  slug: string;
  line: number;
  text: string;
}

function slugMatchesPathFilter(slug: string, pathFilters: string[], recursive: boolean): boolean {
  if (pathFilters.length === 0) return true;
  for (const raw of pathFilters) {
    const prefix = normalizeSlug(raw);
    if (!prefix) return true;
    if (slug === prefix) return true;
    if (recursive && slug.startsWith(`${prefix}/`)) return true;
    // Directory path without -r: still recurse under that tree (grep DIR is uncommon;
    // agents almost always pass -r with /paseo-vfs/docs).
    if (slug.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

export function grepDocs(
  store: DocsStore,
  pattern: string,
  options: {
    paths?: string[];
    /** @deprecated use paths */
    path?: string;
    ignoreCase?: boolean;
    fixedStrings?: boolean;
    maxHits?: number;
    recursive?: boolean;
  } = {},
): GrepHit[] {
  const source = options.fixedStrings ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
  const flags = options.ignoreCase ? "i" : "";
  let regex: RegExp;
  try {
    regex = new RegExp(source, flags);
  } catch (error) {
    throw new Error(
      `Invalid grep pattern: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const pathFilters = [...(options.paths ?? []), ...(options.path ? [options.path] : [])];
  const maxHits = options.maxHits ?? 200;
  const recursive = options.recursive ?? true;
  const hits: GrepHit[] = [];

  const slugs = [...store.files.keys()].sort((a, b) => a.localeCompare(b));
  for (const slug of slugs) {
    if (!slugMatchesPathFilter(slug, pathFilters, recursive)) continue;
    const content = readFileSync(store.files.get(slug)!, "utf8");
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!regex.test(line)) continue;
      hits.push({ slug, line: i + 1, text: line });
      if (hits.length >= maxHits) return hits;
      regex.lastIndex = 0;
    }
  }
  return hits;
}

export function chunkDoc(
  content: string,
  slug: string,
  maxChars = 1200,
): Array<{ slug: string; chunkIndex: number; text: string }> {
  const paragraphs = content.split(/\n{2,}/);
  const chunks: Array<{ slug: string; chunkIndex: number; text: string }> = [];
  let buf = "";
  let index = 0;

  function flush(): void {
    const text = buf.trim();
    if (!text) return;
    chunks.push({ slug, chunkIndex: index, text });
    index += 1;
    buf = "";
  }

  for (const part of paragraphs) {
    const next = buf ? `${buf}\n\n${part}` : part;
    if (next.length > maxChars && buf) {
      flush();
      buf = part;
    } else {
      buf = next;
    }
  }
  flush();
  if (chunks.length === 0 && content.trim()) {
    chunks.push({ slug, chunkIndex: 0, text: content.trim() });
  }
  return chunks;
}

export function listAllFileSlugs(store: DocsStore): string[] {
  return [...store.files.keys()].sort((a, b) => a.localeCompare(b));
}

export function docsRootLabel(store: DocsStore, mountSlug = DEFAULT_DOCS_MOUNT_SLUG): string {
  return `${virtualRootForMount(mountSlug)} → ${store.rootDir}`;
}

export function toVirtualPath(slug: string, mountSlug = DEFAULT_DOCS_MOUNT_SLUG): string {
  const root = virtualRootForMount(mountSlug);
  return slug ? `${root}/${slug}` : root;
}

/** Exposed for tests — posix relative helper. */
export function docsRelativePosix(rootDir: string, absolutePath: string): string {
  return toPosixRelative(rootDir, absolutePath);
}
