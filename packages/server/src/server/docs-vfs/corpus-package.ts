/**
 * Knowledge-base corpus packages (Phase 1.6).
 *
 * Directory layout (locked):
 *   <dir>/manifest.json
 *   <dir>/pages/<slug>…   (relative paths mirror path_tree keys)
 *
 * Embeddings are never written into the package — rebuild on import.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

import type { PathTree } from "./vector-store.js";

export const CORPUS_PACKAGE_FORMAT = "paseo.kb.corpus/v1" as const;

export const CorpusPackageManifestSchema = z.object({
  format: z.literal(CORPUS_PACKAGE_FORMAT),
  exportedAt: z.string(),
  knowledgeBase: z.object({
    slug: z.string(),
    name: z.string(),
    /** Provenance only — import always allocates a new id. */
    id: z.string().optional(),
  }),
  pathTree: z.record(
    z.string(),
    z.object({
      isPublic: z.boolean().optional(),
      groups: z.array(z.string()).optional(),
    }),
  ),
  pageCount: z.number().int().nonnegative(),
  importProvenance: z.string().nullable().optional(),
});

export type CorpusPackageManifest = z.infer<typeof CorpusPackageManifestSchema>;

export interface CorpusPackage {
  manifest: CorpusPackageManifest;
  pages: Record<string, string>;
}

export function corpusPackageManifestPath(dir: string): string {
  return join(resolve(dir), "manifest.json");
}

export function isCorpusPackageDir(dir: string): boolean {
  const manifestPath = corpusPackageManifestPath(dir);
  if (!existsSync(manifestPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as { format?: string };
    return parsed.format === CORPUS_PACKAGE_FORMAT;
  } catch {
    return false;
  }
}

export function readCorpusPackage(dir: string): CorpusPackage {
  const root = resolve(dir);
  const manifestPath = corpusPackageManifestPath(root);
  if (!existsSync(manifestPath)) {
    throw new Error(`Not a corpus package (missing manifest.json): ${root}`);
  }
  const manifest = CorpusPackageManifestSchema.parse(
    JSON.parse(readFileSync(manifestPath, "utf8")),
  );
  const pages: Record<string, string> = {};
  for (const slug of Object.keys(manifest.pathTree).sort((a, b) => a.localeCompare(b))) {
    const pagePath = join(root, "pages", ...slug.split("/"));
    if (!existsSync(pagePath)) {
      throw new Error(`Corpus package missing page file for slug "${slug}": ${pagePath}`);
    }
    pages[slug] = readFileSync(pagePath, "utf8");
  }
  if (Object.keys(pages).length !== manifest.pageCount) {
    throw new Error(
      `Corpus package pageCount mismatch: manifest=${manifest.pageCount} files=${Object.keys(pages).length}`,
    );
  }
  return { manifest, pages };
}

export function writeCorpusPackage(input: {
  dir: string;
  slug: string;
  name: string;
  knowledgeBaseId?: string;
  pathTree: PathTree;
  pages: Record<string, string>;
  importProvenance?: string | null;
  exportedAt?: string;
}): CorpusPackageManifest {
  const root = resolve(input.dir);
  mkdirSync(join(root, "pages"), { recursive: true });

  const slugs = Object.keys(input.pathTree).sort((a, b) => a.localeCompare(b));
  for (const slug of slugs) {
    if (!(slug in input.pages)) {
      throw new Error(`Cannot export: path_tree slug missing page text: ${slug}`);
    }
    const pagePath = join(root, "pages", ...slug.split("/"));
    mkdirSync(dirname(pagePath), { recursive: true });
    writeFileSync(pagePath, input.pages[slug]!, "utf8");
  }

  const manifest: CorpusPackageManifest = {
    format: CORPUS_PACKAGE_FORMAT,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    knowledgeBase: {
      slug: input.slug,
      name: input.name,
      ...(input.knowledgeBaseId ? { id: input.knowledgeBaseId } : {}),
    },
    pathTree: input.pathTree,
    pageCount: slugs.length,
    importProvenance: input.importProvenance ?? null,
  };
  CorpusPackageManifestSchema.parse(manifest);
  writeFileSync(corpusPackageManifestPath(root), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}
