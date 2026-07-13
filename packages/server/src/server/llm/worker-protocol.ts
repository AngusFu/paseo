// IPC message types between the daemon and the llm-worker child process.
// The worker holds the model in memory; the daemon only ever talks to it via
// fork() IPC, so a bad GGUF or an OOM kills the worker, never the daemon.

export interface LlmWorkerLoadRequest {
  type: "load";
  modelPath: string;
  contextSize: number;
}

export interface LlmWorkerGenerateRequest {
  type: "generate";
  id: string;
  prompt: string;
  systemPrompt?: string;
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  stream?: boolean;
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
