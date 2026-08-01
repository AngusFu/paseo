/**
 * Docs VFS content plane (ChromaFs-shaped) shared by CLI + MCP tools.
 * Corpus: SQLite under $PASEO_HOME/docs-vfs/<kbId|hash>/docs.sqlite (node:sqlite).
 * Vectors: local Chroma sidecar at $PASEO_HOME/docs-vfs/_chroma/ (chromadb CLI + HTTP client).
 */

export {
  DEFAULT_DOCS_MOUNT_SLUG,
  VIRTUAL_DOCS_ROOT,
  VIRTUAL_VFS_ROOT,
  buildDocsStore,
  chunkDoc,
  docsRootLabel,
  grepDocs,
  listAllFileSlugs,
  listDocs,
  assertValidPageSlug,
  normalizeSlug,
  parseVirtualPath,
  readDoc,
  resolveDocsRoot,
  toVirtualPath,
  virtualRootForMount,
  type DocsStore,
  type GrepHit,
} from "./store.js";

export {
  assertEmbeddingDimCount,
  assertSameEmbeddingDimensions,
  cosineSimilarity,
  detectOllamaForEmbeddings,
  embedTexts,
  loadEmbeddingsConfig,
  resolveEmbeddingsConfigForProbe,
  resolvePaseoHomeForDocs,
  suggestEmbeddingModel,
  testEmbeddingsProbe,
  type EmbeddingsConfig,
  type EmbeddingsConfigOverride,
} from "./embeddings.js";

export {
  PATH_TREE_DOC_ID,
  buildPathTreeFromStore,
  chromaCollectionForStoreDir,
  docsVfsDir,
  ingestDocsToMemoryStore,
  ingestPagesToMemoryStore,
  listFromPathTree,
  openDocsVectorStore,
  rebuildDocsVectorStore,
  rebuildDocsVectorStoreFromPages,
  type DocsChunkRow,
  type DocsVectorStore,
  type DocsVectorStoreMeta,
  type PathTree,
  type PathTreeNode,
  type RebuildDocsVectorStoreResult,
} from "./vector-store.js";

export { SqliteDocsVectorStore, sqliteDbPath } from "./vector-store-sqlite.js";

export {
  createDocsChromaClient,
  docsChromaDataDir,
  docsChromaRoot,
  ensureDocsChromaSidecar,
  stopDocsChromaSidecar,
  type DocsChromaEndpoint,
} from "./chroma-sidecar.js";

export {
  chromaCollectionNameForStoreKey,
  deleteDocsChromaChunkIds,
  deleteDocsChromaIndex,
  docsChromaIndexCount,
  paseoHomeFromStoreDir,
  queryDocsChromaIndex,
  replaceDocsChromaIndex,
  storeKeyFromStoreDir,
  upsertDocsChromaChunks,
} from "./chroma-vector-index.js";

export { escapeFixedString, parseGrepArgv, type ParsedGrepArgs } from "./unix-args.js";

export {
  KB_SLUG_PATTERN,
  KnowledgeBaseRecordSchema,
  assertValidKbSlug,
  createEmptyKnowledgeBase,
  deleteKnowledgeBase,
  docsVfsDirForKnowledgeBase,
  generateKnowledgeBaseId,
  getKnowledgeBase,
  knowledgeBaseLastEmbeddedAt,
  knowledgeBasesPath,
  listKnowledgeBases,
  loadKnowledgeBaseRegistry,
  markKnowledgeBaseEmbedded,
  registerImportedKnowledgeBase,
  touchKnowledgeBase,
  type KnowledgeBaseRecord,
} from "./knowledge-base-registry.js";

export { deleteKnowledgeBasePage, upsertKnowledgeBasePage } from "./knowledge-base-pages.js";

export {
  KnowledgeBaseMountSchema,
  countKnowledgeBaseMountsById,
  knowledgeBaseHasMounts,
  listKnowledgeBaseUsages,
  listWorkspaceKnowledgeBaseMounts,
  mountKnowledgeBaseOnWorkspace,
  unmountKnowledgeBaseFromWorkspace,
  type KnowledgeBaseMount,
  type KnowledgeBaseUsage,
} from "./knowledge-base-mounts.js";

export {
  CORPUS_PACKAGE_FORMAT,
  CorpusPackageManifestSchema,
  isCorpusPackageDir,
  readCorpusPackage,
  writeCorpusPackage,
  type CorpusPackage,
  type CorpusPackageManifest,
} from "./corpus-package.js";

export {
  exportKnowledgeBase,
  importKnowledgeBase,
  readDocsFolderPages,
  type ExportKnowledgeBaseResult,
  type ImportKnowledgeBaseResult,
} from "./knowledge-base-import-export.js";

export {
  resolveDocsTarget,
  type DocsOpenMode,
  type ResolveDocsTargetInput,
  type ResolvedDocsTarget,
} from "./resolve-docs-target.js";
