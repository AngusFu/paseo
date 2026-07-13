import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
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
    explanation: {
      type: "string",
      description: "One short sentence describing when it runs.",
    },
  },
  required: ["expression", "explanation"],
} as const;

// The model's own language name for the explanation directive, keyed by i18n
// language code (falls back to English for unknown codes).
const EXPLANATION_LANGUAGE: Record<string, string> = {
  en: "English",
  "zh-CN": "Chinese (Simplified)",
  ja: "Japanese",
  es: "Spanish",
  fr: "French",
  ru: "Russian",
  "pt-BR": "Portuguese",
  ar: "Arabic",
};

// Few-shot examples matter: small models reliably drop compound syntax like a
// range with a step (8-17/3) unless they have seen it spelled out.
function buildSystemPrompt(languageCode: string): string {
  const language = EXPLANATION_LANGUAGE[languageCode] ?? "English";
  return `You convert natural-language scheduling requests into standard 5-field cron expressions (minute hour day-of-month month day-of-week). Allowed syntax per field: numbers, * , ranges (a-b), lists (a,b), steps (*/n), and ranges with steps (a-b/n). Days of week: 0=Sunday … 6=Saturday. Respond with JSON only. Always write the "explanation" field in ${language}, regardless of the request's language.

Examples:
"every weekday at 9:30" -> {"expression": "30 9 * * 1-5"}
"every 15 minutes during work hours" -> {"expression": "*/15 9-18 * * 1-5"}
"every 3 hours starting 8:30 on weekdays" -> {"expression": "30 8-17/3 * * 1-5"}
"每周一和周四晚上11点" -> {"expression": "0 23 * * 1,4"}
"每月1号和15号凌晨2点" -> {"expression": "0 2 1,15 * *"}`;
}

export interface CronGenerationResult {
  expression: string;
  // The model's one-line description, in the request's language. May be empty.
  explanation: string;
}

export interface UseLocalLlmCronResult {
  // false when the daemon lacks the localLlm capability — hide the UI entirely.
  supported: boolean;
  model: LlmLocalModelState | null;
  startDownload: () => void;
  generate: (text: string) => Promise<CronGenerationResult | null>;
  isGenerating: boolean;
}

// Drives the "describe a schedule in natural language → cron" affordance in the
// cadence editor, backed by the daemon's local LLM (llm.local.* RPCs).
export function useLocalLlmCron(serverId: string | null | undefined): UseLocalLlmCronResult {
  const { i18n } = useTranslation();
  const { supported, model, startDownload, refreshStatus } = useLocalLlmModel(serverId);
  const client = useHostRuntimeClient(serverId ?? "");
  const [isGenerating, setIsGenerating] = useState(false);
  const languageCode = i18n.language;

  // Returns a validated cron expression, or null when generation/parsing
  // failed. Grammar-constrained output means the JSON always parses; the model
  // can still hallucinate an invalid field value, so validateCron gates it.
  const generate = useCallback(
    async (text: string): Promise<CronGenerationResult | null> => {
      if (!client) {
        return null;
      }
      setIsGenerating(true);
      try {
        const payload = await client.llmLocalGenerate({
          prompt: text,
          systemPrompt: buildSystemPrompt(languageCode),
          jsonSchema: CRON_JSON_SCHEMA as unknown as Record<string, unknown>,
          maxTokens: 160,
        });
        if (payload.error || !payload.text) {
          return null;
        }
        const parsed: unknown = JSON.parse(payload.text);
        if (typeof parsed !== "object" || parsed === null || !("expression" in parsed)) {
          return null;
        }
        const expression = String((parsed as { expression: unknown }).expression).trim();
        if (!expression || validateCron(expression) !== null) {
          return null;
        }
        const explanation =
          "explanation" in parsed
            ? String((parsed as { explanation: unknown }).explanation).trim()
            : "";
        return { expression, explanation };
      } catch {
        return null;
      } finally {
        setIsGenerating(false);
        void refreshStatus();
      }
    },
    [client, languageCode, refreshStatus],
  );

  return { supported, model, startDownload, generate, isGenerating };
}
