import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";

export const DEFAULT_EMBEDDINGS_BASE_URL = "http://127.0.0.1:11434/v1";
export const DEFAULT_EMBEDDINGS_API_KEY = "ollama";
export const DEFAULT_EMBEDDINGS_MODEL = "qwen3-embedding:0.6b";

export interface KnowledgeBaseEmbeddingsDraft {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * True when a config payload includes an embeddings object after get/set.
 * Used to detect old hosts that silently drop the field on patch.
 */
export function daemonConfigSupportsEmbeddings(
  config: MutableDaemonConfig | null | undefined,
): boolean {
  return Boolean(config && Object.prototype.hasOwnProperty.call(config, "embeddings"));
}

export function readKnowledgeBaseEmbeddingsDraft(
  config: MutableDaemonConfig | null | undefined,
): KnowledgeBaseEmbeddingsDraft {
  const embeddings = config?.embeddings;
  return {
    enabled: embeddings?.enabled === true,
    baseUrl: embeddings?.baseUrl ?? "",
    apiKey: embeddings?.apiKey ?? "",
    model: embeddings?.model ?? "",
  };
}

export function createKnowledgeBaseEmbeddingsPatch(
  draft: KnowledgeBaseEmbeddingsDraft,
): MutableDaemonConfigPatch {
  return {
    embeddings: {
      enabled: draft.enabled,
      baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey.trim(),
      model: draft.model.trim(),
    },
  };
}

export function knowledgeBaseEmbeddingsDraftHasChanges(
  draft: KnowledgeBaseEmbeddingsDraft,
  persisted: KnowledgeBaseEmbeddingsDraft,
): boolean {
  return (
    draft.enabled !== persisted.enabled ||
    draft.baseUrl.trim() !== persisted.baseUrl.trim() ||
    draft.apiKey.trim() !== persisted.apiKey.trim() ||
    draft.model.trim() !== persisted.model.trim()
  );
}

export function applyOllamaDetectToDraft(
  draft: KnowledgeBaseEmbeddingsDraft,
  detect: {
    baseUrl: string | null;
    suggestedModel: string | null;
    apiKey?: string | null;
  },
): KnowledgeBaseEmbeddingsDraft {
  const apiKey = detect.apiKey?.trim() || draft.apiKey.trim() || DEFAULT_EMBEDDINGS_API_KEY;
  return {
    enabled: true,
    baseUrl: detect.baseUrl?.trim() || DEFAULT_EMBEDDINGS_BASE_URL,
    apiKey,
    model: detect.suggestedModel?.trim() || DEFAULT_EMBEDDINGS_MODEL,
  };
}
