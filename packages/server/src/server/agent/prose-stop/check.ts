import { classifyProseStop, type ClassifierVerdict } from "./classifier.js";
import type { LlamaService } from "../../llm/llama-service.js";
import { matchBlockingPatterns } from "./regex-gate.js";
import { prepareClosingText } from "./strip-and-closing.js";

export type ProseStopMode = "regex" | "regex-first";

export type ProseStopDecision = "block" | "allow";

export interface ProseStopCheckResult {
  decision: ProseStopDecision;
  source: "regex" | "llm" | "none";
  pattern?: string;
  closingText: string;
  regexBlocked: boolean;
  llmVerdict: ClassifierVerdict;
}

export interface CheckProseStopParams {
  text: string;
  mode: ProseStopMode;
  /** Optional classifier — only used when mode is regex-first. */
  classify?: (closingText: string) => Promise<ClassifierVerdict>;
}

export async function checkProseStop(params: CheckProseStopParams): Promise<ProseStopCheckResult> {
  const closingText = prepareClosingText(params.text);
  const empty: ProseStopCheckResult = {
    decision: "allow",
    source: "none",
    closingText,
    regexBlocked: false,
    llmVerdict: "SKIP",
  };

  if (!params.text.trim() || !closingText) {
    return empty;
  }

  const regex = matchBlockingPatterns(closingText);
  if (regex.blocked) {
    return {
      decision: "block",
      source: "regex",
      pattern: regex.pattern,
      closingText,
      regexBlocked: true,
      llmVerdict: "SKIP",
    };
  }

  if (params.mode !== "regex-first" || !params.classify) {
    return {
      ...empty,
      closingText,
      regexBlocked: false,
    };
  }

  const llmVerdict = await params.classify(closingText);
  if (llmVerdict === "WAIT") {
    return {
      decision: "block",
      source: "llm",
      closingText,
      regexBlocked: false,
      llmVerdict,
    };
  }

  return {
    decision: "allow",
    source: llmVerdict === "DONE" ? "llm" : "none",
    closingText,
    regexBlocked: false,
    llmVerdict,
  };
}

export interface ResolveProseStopModeParams {
  localLlmReady: boolean;
}

export function resolveProseStopMode(params: ResolveProseStopModeParams): ProseStopMode {
  return params.localLlmReady ? "regex-first" : "regex";
}

export async function checkProseStopWithLlama(params: {
  text: string;
  llamaService: LlamaService | null;
}): Promise<ProseStopCheckResult> {
  let localLlmReady = false;
  if (params.llamaService) {
    try {
      const status = await params.llamaService.getStatus();
      localLlmReady = status.status === "ready";
    } catch {
      localLlmReady = false;
    }
  }

  const mode = resolveProseStopMode({ localLlmReady });
  const llamaService = params.llamaService;

  return checkProseStop({
    text: params.text,
    mode,
    classify:
      mode === "regex-first" && llamaService
        ? async (closingText) => {
            const result = await classifyProseStop({ closingText, llamaService });
            return result.verdict;
          }
        : undefined,
  });
}
