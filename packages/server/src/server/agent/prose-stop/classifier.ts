import { randomUUID } from "node:crypto";
import type { LlamaService } from "../../llm/llama-service.js";
import {
  PROSE_CLASSIFIER_FEW_SHOTS,
  PROSE_CLASSIFIER_SYSTEM,
  wrapClassifierInput,
} from "./classifier-prompt.js";

export type ClassifierVerdict = "WAIT" | "DONE" | "SKIP";

export interface ClassifyProseResult {
  verdict: ClassifierVerdict;
  status: string;
}

function parseClassifierOutput(raw: string): ClassifierVerdict {
  const text = raw.trim();
  const labeled = text.match(/<label>\s*(WAIT|DONE)\s*<\/label>/i);
  if (labeled?.[1]) {
    return labeled[1].toUpperCase() as "WAIT" | "DONE";
  }
  if (/^\s*WAIT\s*$/i.test(text) || /\bWAIT\b/i.test(text.split("\n")[0] ?? "")) {
    return "WAIT";
  }
  if (/^\s*DONE\s*$/i.test(text) || /\bDONE\b/i.test(text.split("\n")[0] ?? "")) {
    return "DONE";
  }
  return "SKIP";
}

export interface ClassifyProseStopParams {
  closingText: string;
  llamaService: LlamaService;
}

/**
 * Call local LLM to classify closing prose. Never throws — failures → SKIP.
 */
export async function classifyProseStop(
  params: ClassifyProseStopParams,
): Promise<ClassifyProseResult> {
  const { closingText, llamaService } = params;
  if (!closingText.trim()) {
    return { verdict: "SKIP", status: "empty" };
  }

  try {
    const status = await llamaService.getStatus();
    if (status.status !== "ready") {
      return { verdict: "SKIP", status: `not_ready:${status.status}` };
    }

    const raw = await llamaService.generate({
      requestId: randomUUID(),
      systemPrompt: PROSE_CLASSIFIER_SYSTEM,
      history: PROSE_CLASSIFIER_FEW_SHOTS.map((shot) => ({
        role: shot.role,
        text: shot.text,
      })),
      prompt: wrapClassifierInput(closingText),
      maxTokens: 16,
    });

    const verdict = parseClassifierOutput(raw);
    if (verdict === "SKIP") {
      return { verdict: "SKIP", status: "bad_output" };
    }
    return { verdict, status: "ok" };
  } catch {
    return { verdict: "SKIP", status: "error" };
  }
}
