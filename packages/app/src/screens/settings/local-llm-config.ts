import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";

export const DEFAULT_LOCAL_LLM_BASE_URL = "http://127.0.0.1:11434/v1";

/** Fixed Ollama tag — Local AI is prose-check only. */
export const LOCAL_LLM_PROSE_CHECK_MODEL = "qwen2.5:0.5b";

export interface LocalLlmDraft {
  baseUrl: string;
  apiKey: string;
}

export function readLocalLlmDraft(config: MutableDaemonConfig | null | undefined): LocalLlmDraft {
  return {
    baseUrl: config?.localLlm?.baseUrl ?? "",
    apiKey: config?.localLlm?.apiKey ?? "",
  };
}

export function createLocalLlmPatch(draft: LocalLlmDraft): MutableDaemonConfigPatch {
  return {
    localLlm: {
      baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey.trim(),
      model: LOCAL_LLM_PROSE_CHECK_MODEL,
    },
  };
}

export function localLlmDraftHasChanges(draft: LocalLlmDraft, persisted: LocalLlmDraft): boolean {
  return (
    draft.baseUrl.trim() !== persisted.baseUrl.trim() ||
    draft.apiKey.trim() !== persisted.apiKey.trim()
  );
}
