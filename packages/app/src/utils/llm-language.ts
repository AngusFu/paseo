// Maps an i18n language code to a language name the local model understands,
// for baking into a system prompt (the daemon has no locale context, so the
// client always specifies the output language explicitly).
const LLM_LANGUAGE_NAME: Record<string, string> = {
  en: "English",
  "zh-CN": "Chinese (Simplified)",
  ja: "Japanese",
  es: "Spanish",
  fr: "French",
  ru: "Russian",
  "pt-BR": "Portuguese",
  ar: "Arabic",
};

export function llmLanguageName(languageCode: string): string {
  return LLM_LANGUAGE_NAME[languageCode] ?? "English";
}

// Small stable string hash (djb2) for cache keys keyed on content.
export function hashText(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 33) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}
