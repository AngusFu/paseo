// IPC message types between the daemon and the llm-worker child process.
// The worker holds the model in memory; the daemon only ever talks to it via
// fork() IPC, so a bad GGUF or an OOM kills the worker, never the daemon.

export interface LlmWorkerLoadRequest {
  type: "load";
  modelPath: string;
  contextSize: number;
}

// Prior turns replayed into the chat session before prompting. The worker is
// stateless across requests — multi-turn callers resend the full history.
export interface LlmWorkerHistoryItem {
  role: "user" | "model";
  text: string;
}

export interface LlmWorkerGenerateRequest {
  type: "generate";
  id: string;
  prompt: string;
  systemPrompt?: string;
  history?: LlmWorkerHistoryItem[];
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  stream?: boolean;
  // Generation halts when any of these strings would be produced. Used to keep
  // Gemma's native tool-call tokens out of free-form chat replies.
  stopTriggers?: string[];
}

export interface LlmWorkerCancelRequest {
  type: "cancel";
  id: string;
}

export type LlmWorkerParentToWorkerMessage =
  | LlmWorkerLoadRequest
  | LlmWorkerGenerateRequest
  | LlmWorkerCancelRequest;

export interface LlmWorkerLoadedMessage {
  type: "loaded";
  gpu: string | false;
  ms: number;
}

export interface LlmWorkerChunkMessage {
  type: "chunk";
  id: string;
  text: string;
}

export interface LlmWorkerDoneMessage {
  type: "done";
  id: string;
  text: string;
}

export interface LlmWorkerErrorMessage {
  type: "error";
  id?: string;
  message: string;
}

export type LlmWorkerToParentMessage =
  | LlmWorkerLoadedMessage
  | LlmWorkerChunkMessage
  | LlmWorkerDoneMessage
  | LlmWorkerErrorMessage;
