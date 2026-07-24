import type { LlmLocalModelState } from "@getpaseo/protocol/llm/rpc-schemas";
import type pino from "pino";

const DOWNLOAD_STUB_MESSAGE =
  "Configure Local AI in host settings (base URL and model). Built-in model download is no longer available.";

export interface LocalLlmConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  // COMPAT(localLlmGguf): added in v0.1.110, remove after 2027-01-16.
  modelFilename?: string;
  // COMPAT(localLlmGguf): added in v0.1.110, remove after 2027-01-16.
  modelUrls?: string[];
}

export type LlmModelConfig = LocalLlmConfig;

// Prior turns replayed before prompting. Callers resend the full history each
// request because the backend is stateless.
export interface LlmChatHistoryItem {
  role: "user" | "model";
  text: string;
}

export function normalizeLocalLlmBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  if (!url.endsWith("/v1")) {
    url = `${url}/v1`;
  }
  return url;
}

export function resolveLocalLlmConfig(config: LocalLlmConfig | null | undefined): {
  baseUrl: string | null;
  apiKey: string | null;
  model: string | null;
} {
  const baseUrl = config?.baseUrl?.trim() || null;
  const apiKey = config?.apiKey?.trim() || null;
  const model = config?.model?.trim() || null;
  return { baseUrl, apiKey, model };
}

export class LlmGenerateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmGenerateError";
  }
}

interface LlamaServiceOptions {
  logger: pino.Logger;
  // Invoked when status changes so the daemon can broadcast llm.local.status.update.
  onStatusUpdate?: (state: LlmLocalModelState) => void;
  // Read per access so daemon-config edits apply without a restart.
  getConfig?: () => LocalLlmConfig | null | undefined;
  fetch?: typeof fetch;
}

export interface GenerateParams {
  requestId: string;
  prompt: string;
  systemPrompt?: string;
  history?: LlmChatHistoryItem[];
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  stream?: boolean;
  stopTriggers?: string[];
  onChunk?: (text: string) => void;
}

interface OpenAiChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

type FetchFn = typeof fetch;

export class LlamaService {
  private readonly logger: pino.Logger;
  private readonly onStatusUpdate?: (state: LlmLocalModelState) => void;
  private readonly getConfig?: () => LocalLlmConfig | null | undefined;
  private readonly fetchFn: FetchFn;

  private lastError: string | null = null;
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(options: LlamaServiceOptions) {
    this.logger = options.logger.child({ module: "llama-service" });
    this.onStatusUpdate = options.onStatusUpdate;
    this.getConfig = options.getConfig;
    this.fetchFn = options.fetch ?? fetch;
  }

  private resolvedConfig(): ReturnType<typeof resolveLocalLlmConfig> {
    return resolveLocalLlmConfig(this.getConfig?.());
  }

  private isConfigured(): boolean {
    const { baseUrl, model } = this.resolvedConfig();
    return Boolean(baseUrl && model);
  }

  async getStatus(): Promise<LlmLocalModelState> {
    if (!this.isConfigured()) {
      return { status: "absent" };
    }
    if (this.lastError) {
      return { status: "error", message: this.lastError };
    }
    return { status: "ready", loaded: true };
  }

  private emitStatus(state: LlmLocalModelState): void {
    this.onStatusUpdate?.(state);
  }

  private setLastError(message: string): void {
    this.lastError = message;
    this.emitStatus({ status: "error", message });
  }

  private clearLastError(): void {
    if (!this.lastError) {
      return;
    }
    this.lastError = null;
    if (this.isConfigured()) {
      this.emitStatus({ status: "ready", loaded: true });
    }
  }

  // COMPAT(localLlmGguf): download RPC stub — tell clients to configure settings.
  async startDownload(): Promise<LlmLocalModelState> {
    this.setLastError(DOWNLOAD_STUB_MESSAGE);
    throw new LlmGenerateError(DOWNLOAD_STUB_MESSAGE);
  }

  async generate(params: GenerateParams): Promise<string> {
    const status = await this.getStatus();
    if (status.status === "absent") {
      throw new LlmGenerateError("local LLM is not configured (missing base URL or model)");
    }

    const { baseUrl, apiKey, model } = this.resolvedConfig();
    if (!baseUrl || !model) {
      throw new LlmGenerateError("local LLM is not configured (missing base URL or model)");
    }

    const controller = new AbortController();
    this.abortControllers.set(params.requestId, controller);

    try {
      const text = await this.callChatCompletions({
        baseUrl: normalizeLocalLlmBaseUrl(baseUrl),
        apiKey,
        model,
        messages: buildOpenAiMessages(params),
        maxTokens: params.maxTokens,
        stream: params.stream,
        jsonSchema: params.jsonSchema,
        stop: params.stopTriggers,
        signal: controller.signal,
        onChunk: params.onChunk,
      });

      if (params.jsonSchema) {
        try {
          JSON.parse(text);
        } catch {
          const message = "model response is not valid JSON";
          this.setLastError(message);
          throw new LlmGenerateError(message);
        }
      }

      this.clearLastError();
      return text;
    } catch (error) {
      if (isAbortError(error) || (error instanceof Error && error.message === "cancelled")) {
        throw new LlmGenerateError("cancelled");
      }
      if (error instanceof LlmGenerateError) {
        if (error.message !== "cancelled") {
          this.setLastError(error.message);
        }
        throw error;
      }
      const message =
        error instanceof Error ? `generation failed: ${error.message}` : String(error);
      this.setLastError(message);
      throw new LlmGenerateError(message);
    } finally {
      this.abortControllers.delete(params.requestId);
    }
  }

  cancel(generateRequestId: string): boolean {
    const controller = this.abortControllers.get(generateRequestId);
    if (!controller) {
      return false;
    }
    controller.abort();
    this.abortControllers.delete(generateRequestId);
    return true;
  }

  stop(): void {
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    this.abortControllers.clear();
  }

  private async callChatCompletions(args: {
    baseUrl: string;
    apiKey: string | null;
    model: string;
    messages: OpenAiChatMessage[];
    maxTokens?: number;
    stream?: boolean;
    jsonSchema?: Record<string, unknown>;
    stop?: string[];
    signal: AbortSignal;
    onChunk?: (text: string) => void;
  }): Promise<string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (args.apiKey) {
      headers.Authorization = `Bearer ${args.apiKey}`;
    }

    const body: Record<string, unknown> = {
      model: args.model,
      messages: args.messages,
      stream: Boolean(args.stream && args.onChunk),
    };
    if (args.maxTokens !== undefined) {
      body.max_tokens = args.maxTokens;
    }
    if (args.stop && args.stop.length > 0) {
      body.stop = args.stop;
    }
    if (args.jsonSchema) {
      body.response_format = { type: "json_object" };
    }

    const url = `${args.baseUrl}/chat/completions`;
    const response = await this.fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: args.signal,
    });

    if (!response.ok) {
      const detail = await readResponseText(response);
      throw new LlmGenerateError(
        `backend returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      );
    }

    if (body.stream === true && args.onChunk) {
      try {
        return await readSseCompletion(response, args.onChunk, args.signal);
      } catch (error) {
        if (args.signal.aborted) {
          throw new LlmGenerateError("cancelled");
        }
        this.logger.warn({ err: error }, "SSE streaming failed, retrying without stream");
        return this.callChatCompletions({ ...args, stream: false, onChunk: undefined });
      }
    }

    const payload: unknown = await response.json();
    const text = extractCompletionText(payload);
    if (text === null) {
      throw new LlmGenerateError("backend returned an empty completion");
    }
    return text;
  }
}

function buildOpenAiMessages(params: GenerateParams): OpenAiChatMessage[] {
  const messages: OpenAiChatMessage[] = [];
  const systemPrompt = augmentSystemPrompt(params.systemPrompt, params.jsonSchema);
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  for (const item of params.history ?? []) {
    messages.push({
      role: item.role === "user" ? "user" : "assistant",
      content: item.text,
    });
  }
  messages.push({ role: "user", content: params.prompt });
  return messages;
}

function augmentSystemPrompt(
  systemPrompt: string | undefined,
  jsonSchema: Record<string, unknown> | undefined,
): string | undefined {
  if (!jsonSchema) {
    return systemPrompt;
  }
  const schemaHint = `Respond with valid JSON matching this schema:\n${JSON.stringify(jsonSchema, null, 2)}`;
  return systemPrompt ? `${systemPrompt}\n\n${schemaHint}` : schemaHint;
}

function extractCompletionText(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  const content = message?.content;
  return typeof content === "string" ? content : null;
}

async function readResponseText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.trim().slice(0, 500);
  } catch {
    return "";
  }
}

async function readSseCompletion(
  response: Response,
  onChunk: (text: string) => void,
  signal: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new LlmGenerateError("backend returned an empty streaming body");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  while (true) {
    if (signal.aborted) {
      throw new LlmGenerateError("cancelled");
    }
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        continue;
      }
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = (parsed as { choices?: Array<{ delta?: { content?: unknown } }> }).choices?.[0]
        ?.delta?.content;
      if (typeof delta !== "string" || delta.length === 0) {
        continue;
      }
      fullText += delta;
      onChunk(delta);
    }
  }

  return fullText;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}
