import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeJsonFileAtomic } from "../atomic-file.js";
import { resolvePaseoHomeForDocs } from "./embeddings.js";
import { knowledgeBaseHasMounts } from "./knowledge-base-mounts.js";
import { SqliteDocsVectorStore } from "./vector-store-sqlite.js";

export const KB_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const KnowledgeBaseRecordSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Set when corpus was one-shot imported (folder or package). */
  importedAt: z.string().nullable().optional(),
  /** Last successful embedding rebuild from in-KB corpus. */
  lastEmbeddedAt: z.string().nullable().optional(),
  /** Optional note of import input (path/package) — not a sync link. */
  importProvenance: z.string().nullable().optional(),
});

export type KnowledgeBaseRecord = z.infer<typeof KnowledgeBaseRecordSchema>;

const RegistryFileSchema = z.object({
  knowledgeBases: z.array(KnowledgeBaseRecordSchema),
});

export function generateKnowledgeBaseId(): string {
  return `kb_${randomBytes(8).toString("hex")}`;
}

export function knowledgeBasesPath(paseoHome: string): string {
  return join(paseoHome, "knowledge-bases.json");
}

export function docsVfsDirForKnowledgeBase(paseoHome: string, knowledgeBaseId: string): string {
  return join(paseoHome, "docs-vfs", knowledgeBaseId);
}

export function assertValidKbSlug(slug: string): void {
  if (!KB_SLUG_PATTERN.test(slug)) {
    throw new Error(
      `Invalid knowledge base slug "${slug}". Use lowercase letters, digits, and hyphens (max 63), starting with alphanumeric.`,
    );
  }
}

export function knowledgeBaseLastEmbeddedAt(record: KnowledgeBaseRecord): string | null {
  return record.lastEmbeddedAt ?? null;
}

export async function loadKnowledgeBaseRegistry(
  paseoHome = resolvePaseoHomeForDocs(),
): Promise<KnowledgeBaseRecord[]> {
  const filePath = knowledgeBasesPath(paseoHome);
  if (!existsSync(filePath)) return [];
  try {
    const parsed = RegistryFileSchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
    return parsed.knowledgeBases;
  } catch (error) {
    throw new Error(
      `Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function saveKnowledgeBaseRegistry(
  paseoHome: string,
  knowledgeBases: KnowledgeBaseRecord[],
): Promise<void> {
  const filePath = knowledgeBasesPath(paseoHome);
  mkdirSync(dirname(filePath), { recursive: true });
  await writeJsonFileAtomic(filePath, { knowledgeBases });
}

export async function listKnowledgeBases(
  paseoHome = resolvePaseoHomeForDocs(),
): Promise<KnowledgeBaseRecord[]> {
  const list = await loadKnowledgeBaseRegistry(paseoHome);
  return [...list].sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function getKnowledgeBase(
  idOrSlug: string,
  paseoHome = resolvePaseoHomeForDocs(),
): Promise<KnowledgeBaseRecord | null> {
  const list = await loadKnowledgeBaseRegistry(paseoHome);
  return list.find((kb) => kb.id === idOrSlug || kb.slug === idOrSlug) ?? null;
}

/** Register a self-contained KB after one-shot import (no durable disk sync link). */
export async function registerImportedKnowledgeBase(input: {
  slug: string;
  name?: string;
  importProvenance?: string | null;
  paseoHome?: string;
  now?: string;
}): Promise<KnowledgeBaseRecord> {
  const paseoHome = input.paseoHome ?? resolvePaseoHomeForDocs();
  const slug = input.slug.trim();
  assertValidKbSlug(slug);

  const list = await loadKnowledgeBaseRegistry(paseoHome);
  if (list.some((kb) => kb.slug === slug)) {
    throw new Error(`Knowledge base slug already exists: ${slug}`);
  }

  const now = input.now ?? new Date().toISOString();
  const record: KnowledgeBaseRecord = {
    id: generateKnowledgeBaseId(),
    slug,
    name: input.name?.trim() || slug,
    createdAt: now,
    updatedAt: now,
    importedAt: now,
    lastEmbeddedAt: null,
    importProvenance: input.importProvenance ?? null,
  };
  KnowledgeBaseRecordSchema.parse(record);
  await saveKnowledgeBaseRegistry(paseoHome, [...list, record]);
  return record;
}

/**
 * Create a blank Knowledge base (registry row + empty SQLite corpus).
 * `importedAt` stays null until a one-shot import path sets it.
 */
export async function createEmptyKnowledgeBase(input: {
  slug: string;
  name?: string;
  paseoHome?: string;
  now?: string;
}): Promise<KnowledgeBaseRecord> {
  const paseoHome = input.paseoHome ?? resolvePaseoHomeForDocs();
  const slug = input.slug.trim();
  assertValidKbSlug(slug);

  const list = await loadKnowledgeBaseRegistry(paseoHome);
  if (list.some((kb) => kb.slug === slug)) {
    throw new Error(`Knowledge base slug already exists: ${slug}`);
  }

  const now = input.now ?? new Date().toISOString();
  const record: KnowledgeBaseRecord = {
    id: generateKnowledgeBaseId(),
    slug,
    name: input.name?.trim() || slug,
    createdAt: now,
    updatedAt: now,
    importedAt: null,
    lastEmbeddedAt: null,
    importProvenance: null,
  };
  KnowledgeBaseRecordSchema.parse(record);

  const storeDir = docsVfsDirForKnowledgeBase(paseoHome, record.id);
  const store = SqliteDocsVectorStore.createEmpty(storeDir, { createdAt: now });
  await store.close();

  try {
    await saveKnowledgeBaseRegistry(paseoHome, [...list, record]);
  } catch (error) {
    rmSync(storeDir, { recursive: true, force: true });
    throw error;
  }
  return record;
}

export async function markKnowledgeBaseEmbedded(input: {
  id: string;
  paseoHome?: string;
  embeddedAt?: string;
}): Promise<KnowledgeBaseRecord> {
  const paseoHome = input.paseoHome ?? resolvePaseoHomeForDocs();
  const list = await loadKnowledgeBaseRegistry(paseoHome);
  const index = list.findIndex((kb) => kb.id === input.id);
  if (index < 0) throw new Error(`Knowledge base not found: ${input.id}`);
  const now = input.embeddedAt ?? new Date().toISOString();
  const next: KnowledgeBaseRecord = {
    ...list[index]!,
    updatedAt: now,
    lastEmbeddedAt: now,
  };
  list[index] = next;
  await saveKnowledgeBaseRegistry(paseoHome, list);
  return next;
}

/** Bump `updatedAt` after corpus page mutations that do not refresh embeddings. */
export async function touchKnowledgeBase(input: {
  id: string;
  paseoHome?: string;
  updatedAt?: string;
}): Promise<KnowledgeBaseRecord> {
  const paseoHome = input.paseoHome ?? resolvePaseoHomeForDocs();
  const list = await loadKnowledgeBaseRegistry(paseoHome);
  const index = list.findIndex((kb) => kb.id === input.id);
  if (index < 0) throw new Error(`Knowledge base not found: ${input.id}`);
  const now = input.updatedAt ?? new Date().toISOString();
  const next: KnowledgeBaseRecord = {
    ...list[index]!,
    updatedAt: now,
  };
  list[index] = next;
  await saveKnowledgeBaseRegistry(paseoHome, list);
  return next;
}

export async function deleteKnowledgeBase(input: {
  idOrSlug: string;
  paseoHome?: string;
  removeIndexDir?: boolean;
}): Promise<KnowledgeBaseRecord> {
  const paseoHome = input.paseoHome ?? resolvePaseoHomeForDocs();
  const list = await loadKnowledgeBaseRegistry(paseoHome);
  const existing = list.find((kb) => kb.id === input.idOrSlug || kb.slug === input.idOrSlug);
  if (!existing) throw new Error(`Knowledge base not found: ${input.idOrSlug}`);

  if (await knowledgeBaseHasMounts(existing.id, paseoHome)) {
    throw new Error(
      `Knowledge base ${existing.slug} is still mounted on one or more workspaces. Unmount first.`,
    );
  }

  await saveKnowledgeBaseRegistry(
    paseoHome,
    list.filter((kb) => kb.id !== existing.id),
  );

  if (input.removeIndexDir !== false) {
    rmSync(docsVfsDirForKnowledgeBase(paseoHome, existing.id), { recursive: true, force: true });
  }
  return existing;
}
