import { useCallback, useState } from "react";
import type { LlmLocalModelState } from "@getpaseo/protocol/llm/rpc-schemas";
import { useLocalLlmModel } from "@/hooks/use-local-llm-model";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { validateCron } from "@/utils/schedule-format";

const CRON_JSON_SCHEMA = {
  type: "object",
  properties: {
    expression: {
      type: "string",
      description: "Standard 5-field cron expression: minute hour day-of-month month day-of-week",
    },
  },
  required: ["expression"],
} as const;

const CRON_SYSTEM_PROMPT =
  "You convert natural-language scheduling requests into standard 5-field cron " +
  "expressions (minute hour day-of-month month day-of-week). Use numeric fields, " +
  "*, ranges (a-b), lists (a,b) and steps (*/n) only. Respond with JSON only.";

export interface UseLocalLlmCronResult {
  // false when the daemon lacks the localLlm capability — hide the UI entirely.
  supported: boolean;
  model: LlmLocalModelState | null;
  startDownload: () => void;
  generate: (text: string) => Promise<string | null>;
  isGenerating: boolean;
}

// Drives the "describe a schedule in natural language → cron" affordance in the
// cadence editor, backed by the daemon's local LLM (llm.local.* RPCs).
export function useLocalLlmCron(serverId: string | null | undefined): UseLocalLlmCronResult {
  const { supported, model, startDownload, refreshStatus } = useLocalLlmModel(serverId);
  const client = useHostRuntimeClient(serverId ?? "");
  const [isGenerating, setIsGenerating] = useState(false);

  // Returns a validated cron expression, or null when generation/parsing
  // failed. Grammar-constrained output means the JSON always parses; the model
  // can still hallucinate an invalid field value, so validateCron gates it.
  const generate = useCallback(
    async (text: string): Promise<string | null> => {
      if (!client) {
        return null;
      }
      setIsGenerating(true);
      try {
        const payload = await client.llmLocalGenerate({
          prompt: text,
          systemPrompt: CRON_SYSTEM_PROMPT,
          jsonSchema: CRON_JSON_SCHEMA as unknown as Record<string, unknown>,
          maxTokens: 128,
        });
        if (payload.error || !payload.text) {
          return null;
        }
        const parsed: unknown = JSON.parse(payload.text);
        const expression =
          typeof parsed === "object" && parsed !== null && "expression" in parsed
            ? String((parsed as { expression: unknown }).expression).trim()
            : null;
        if (!expression || validateCron(expression) !== null) {
          return null;
        }
        return expression;
      } catch {
        return null;
      } finally {
        setIsGenerating(false);
        void refreshStatus();
      }
    },
    [client, refreshStatus],
  );

  return { supported, model, startDownload, generate, isGenerating };
}
