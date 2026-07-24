import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";

export interface LocalLlmDraft {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function readLocalLlmDraft(config: MutableDaemonConfig | null | undefined): LocalLlmDraft {
  return {
    baseUrl: config?.localLlm?.baseUrl ?? "",
    apiKey: config?.localLlm?.apiKey ?? "",
    model: config?.localLlm?.model ?? "",
  };
}

export function createLocalLlmPatch(draft: LocalLlmDraft): MutableDaemonConfigPatch {
  return {
    localLlm: {
      baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey.trim(),
      model: draft.model.trim(),
    },
  };
}

export function localLlmDraftHasChanges(draft: LocalLlmDraft, persisted: LocalLlmDraft): boolean {
  return (
    draft.baseUrl.trim() !== persisted.baseUrl.trim() ||
    draft.apiKey.trim() !== persisted.apiKey.trim() ||
    draft.model.trim() !== persisted.model.trim()
  );
}
