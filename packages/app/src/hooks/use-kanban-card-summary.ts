import { useTranslation } from "react-i18next";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { hashText, llmLanguageName } from "@/utils/llm-language";

// Below this the body is too thin to be worth summarizing (the card title
// already conveys as much) — fall back to showing nothing.
const MIN_CHARS = 120;
// Cap the text fed to the model so a huge ticket body can't blow the ~4K
// context. Roughly char-budgeted; the tail is dropped with a marker.
const MAX_CHARS = 6000;

const SUMMARY_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
  },
  required: ["summary"],
} as const;

function buildSummarySystemPrompt(languageCode: string): string {
  const language = llmLanguageName(languageCode);
  return `You summarize a software ticket or merge request for a busy developer. Given the raw description, respond with JSON only: {"summary": "..."}, two or three short sentences capturing what it is and what needs doing. The summary MUST be written in ${language}, translating if the source is in another language. Do not invent details not present in the text.`;
}

function prepareText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_CHARS)}\n\n[...truncated...]`;
}

export const kanbanCardSummaryQueryBaseKey = ["kanban", "card-summary"] as const;

export interface UseKanbanCardSummaryResult {
  // false when the daemon lacks the localLlm capability, or the body is too
  // thin to summarize — the caller should render nothing in that case.
  eligible: boolean;
  summary: string | null;
  isLoading: boolean;
  isError: boolean;
  refresh: () => void;
}

// Generates a plain-language summary of a card's tracker description via the
// daemon's local LLM, in the app's UI language, cached per (card, content,
// language). Lazy and on-demand: nothing runs until the detail is open with a
// long-enough body. Reverse-safe — failures surface as isError and the caller
// falls back to the card title.
export function useKanbanCardSummary(
  serverId: string | null,
  cardId: string | null,
  descriptionMarkdown: string | null,
): UseKanbanCardSummaryResult {
  const { i18n } = useTranslation();
  const languageCode = i18n.language;
  const supported = useHostFeature(serverId, "localLlm");
  const client = useHostRuntimeClient(serverId ?? "");

  const text = descriptionMarkdown?.trim() ?? "";
  const eligible = supported && client !== null && text.length >= MIN_CHARS;
  const contentHash = hashText(text);

  const query = useFetchQuery({
    queryKey: [
      ...kanbanCardSummaryQueryBaseKey,
      serverId ?? "none",
      cardId ?? "none",
      contentHash,
      languageCode,
    ],
    enabled: Boolean(eligible && cardId),
    queryFn: async () => {
      if (!client) {
        throw new Error("Local LLM host client unavailable");
      }
      const payload = await client.llmLocalGenerate({
        prompt: prepareText(text),
        systemPrompt: buildSummarySystemPrompt(languageCode),
        jsonSchema: SUMMARY_JSON_SCHEMA as unknown as Record<string, unknown>,
        maxTokens: 256,
      });
      if (payload.error || !payload.text) {
        throw new Error(payload.error ?? "Summary generation failed");
      }
      const parsed: unknown = JSON.parse(payload.text);
      const summary =
        typeof parsed === "object" && parsed !== null && "summary" in parsed
          ? String((parsed as { summary: unknown }).summary).trim()
          : "";
      if (!summary) {
        throw new Error("Empty summary");
      }
      return summary;
    },
    dataShape: "value",
    // Deterministic per content+language; only a manual refresh regenerates.
    staleTimeMs: Number.POSITIVE_INFINITY,
  });

  return {
    eligible: Boolean(eligible),
    summary: query.data ?? null,
    isLoading: eligible && query.isFetching,
    isError: query.isError,
    refresh: () => {
      void query.refetch();
    },
  };
}
