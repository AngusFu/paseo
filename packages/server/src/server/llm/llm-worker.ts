// Child-process entry for the local LLM. Loads a GGUF via node-llama-cpp and
// serves generate requests over fork() IPC. Runs one request at a time — the
// parent LlamaService serializes. node-llama-cpp is imported lazily so simply
// forking the worker never pulls native binaries into the daemon process.
import type {
  LlmWorkerParentToWorkerMessage,
  LlmWorkerToParentMessage,
} from "./worker-protocol.js";

type LlamaModule = typeof import("node-llama-cpp");

interface WorkerState {
  llama: Awaited<ReturnType<LlamaModule["getLlama"]>>;
  model: Awaited<ReturnType<Awaited<ReturnType<LlamaModule["getLlama"]>>["loadModel"]>>;
  context: Awaited<
    ReturnType<
      Awaited<
        ReturnType<Awaited<ReturnType<LlamaModule["getLlama"]>>["loadModel"]>
      >["createContext"]
    >
  >;
  createSession: (systemPrompt?: string) => InstanceType<LlamaModule["LlamaChatSession"]>;
  createGrammar: (schema: Record<string, unknown>) => Promise<unknown>;
}

let state: WorkerState | null = null;
const abortControllers = new Map<string, AbortController>();

function send(message: LlmWorkerToParentMessage): void {
  process.send?.(message);
}

async function handleLoad(modelPath: string, contextSize: number): Promise<void> {
  const t0 = Date.now();
  const { getLlama, LlamaChatSession } = await import("node-llama-cpp");
  const llama = await getLlama();
  const model = await llama.loadModel({ modelPath });
  const context = await model.createContext({ contextSize });
  state = {
    llama,
    model,
    context,
    createSession: (systemPrompt) =>
      new LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt }),
    createGrammar: (schema) =>
      // node-llama-cpp types the schema parameter with a generic the wire
      // payload can't satisfy statically; the runtime accepts any JSON Schema.
      llama.createGrammarForJsonSchema(schema as never),
  };
  send({ type: "loaded", gpu: llama.gpu, ms: Date.now() - t0 });
}

async function handleGenerate(msg: {
  id: string;
  prompt: string;
  systemPrompt?: string;
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  stream?: boolean;
}): Promise<void> {
  if (!state) {
    send({ type: "error", id: msg.id, message: "model not loaded" });
    return;
  }
  const controller = new AbortController();
  abortControllers.set(msg.id, controller);
  const session = state.createSession(msg.systemPrompt);
  try {
    const grammar = msg.jsonSchema ? await state.createGrammar(msg.jsonSchema) : undefined;
    const text = await session.prompt(msg.prompt, {
      maxTokens: msg.maxTokens ?? 512,
      signal: controller.signal,
      // Grammar-constrained output; typed as never above for the same reason.
      grammar: grammar as never,
      onTextChunk: msg.stream
        ? (chunk: string) => send({ type: "chunk", id: msg.id, text: chunk })
        : undefined,
    });
    send({ type: "done", id: msg.id, text });
  } catch (error) {
    if (controller.signal.aborted) {
      send({ type: "error", id: msg.id, message: "cancelled" });
    } else {
      send({
        type: "error",
        id: msg.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    abortControllers.delete(msg.id);
    session.dispose({ disposeSequence: true });
  }
}

process.on("message", (msg: LlmWorkerParentToWorkerMessage) => {
  switch (msg.type) {
    case "load":
      handleLoad(msg.modelPath, msg.contextSize).catch((error) => {
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      });
      break;
    case "generate":
      void handleGenerate(msg);
      break;
    case "cancel":
      abortControllers.get(msg.id)?.abort();
      break;
  }
});

process.on("disconnect", () => {
  process.exit(0);
});
