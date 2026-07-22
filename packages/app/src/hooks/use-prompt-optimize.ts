import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LlmLocalModelState } from "@getpaseo/protocol/llm/rpc-schemas";
import { useLocalLlmModel } from "@/hooks/use-local-llm-model";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { llmLanguageName } from "@/utils/llm-language";

function buildOptimizeSystemPrompt(languageCode: string): string {
  const language = llmLanguageName(languageCode);
  // The output-only directive is load-bearing: without it small models prepend
  // "Here is the improved prompt:" style chatter that would land in the field.
  return `You rewrite rough task drafts into clear, well-structured prompts for an AI coding agent. Keep every concrete detail from the draft (file paths, names, constraints, error messages) — never invent requirements that are not implied. Make the goal explicit, add acceptance criteria only when the draft implies them, and keep it concise. Write the rewritten prompt in ${language}, matching the draft's language. Respond with ONLY the rewritten prompt text — no preamble, no quotes, no markdown fences.`;
}

export interface UsePromptOptimizeResult {
  // false when the daemon lacks the localLlm capability — hide the button.
  supported: boolean;
  model: LlmLocalModelState | null;
  startDownload: () => void;
  // Returns the rewritten prompt, or null when generation failed.
  optimize: (draft: string) => Promise<string | null>;
  isOptimizing: boolean;
}

// One-tap "improve this prompt" backed by the daemon's local model. Used by
// the agent composer and the workflow dispatch task field.
export function usePromptOptimize(serverId: string | null | undefined): UsePromptOptimizeResult {
  const { i18n } = useTranslation();
  const { supported, model, startDownload, refreshStatus } = useLocalLlmModel(serverId);
  const client = useHostRuntimeClient(serverId ?? "");
  const [isOptimizing, setIsOptimizing] = useState(false);
  const languageCode = i18n.language;

  const optimize = useCallback(
    async (draft: string): Promise<string | null> => {
      const trimmed = draft.trim();
      if (!client || !trimmed) {
        return null;
      }
      setIsOptimizing(true);
      try {
        const payload = await client.llmLocalGenerate({
          prompt: trimmed,
          systemPrompt: buildOptimizeSystemPrompt(languageCode),
          maxTokens: 1024,
        });
        if (payload.error || !payload.text) {
          return null;
        }
        const text = payload.text.trim();
        return text.length > 0 ? text : null;
      } catch {
        return null;
      } finally {
        setIsOptimizing(false);
        void refreshStatus();
      }
    },
    [client, languageCode, refreshStatus],
  );

  return {
    supported: supported && model?.status === "ready",
    model,
    startDownload,
    optimize,
    isOptimizing,
  };
}
