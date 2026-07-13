import { fork, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import type { LlmLocalModelState } from "@getpaseo/protocol/llm/rpc-schemas";
import type pino from "pino";
import type {
  LlmWorkerParentToWorkerMessage,
  LlmWorkerToParentMessage,
} from "./worker-protocol.js";

// The daemon's built-in local model. Single fixed model for now; a picker can
// come later. Sources are tried in order — huggingface.co first, hf-mirror for
// networks where the former is unreachable.
const MODEL_FILENAME = "gemma-4-E4B_q4_0-it.gguf";
const MODEL_URLS = [
  `https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf/resolve/main/${MODEL_FILENAME}`,
  `https://hf-mirror.com/google/gemma-4-E4B-it-qat-q4_0-gguf/resolve/main/${MODEL_FILENAME}`,
  `https://modelscope.cn/models/google/gemma-4-E4B-it-qat-q4_0-gguf/resolve/master/${MODEL_FILENAME}`,
];
const CONTEXT_SIZE = 4096;
// Unload the worker (freeing ~4.5GB) after this long without a request.
const IDLE_UNLOAD_MS = 5 * 60 * 1000;
const GGUF_MAGIC = Buffer.from("GGUF");

export class LlmGenerateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmGenerateError";
  }
}

interface LlamaServiceOptions {
  paseoHome: string;
  logger: pino.Logger;
  // Invoked on download progress and load/unload so the daemon can broadcast
  // llm.local.status.update to connected clients.
  onStatusUpdate?: (state: LlmLocalModelState) => void;
}

interface GenerateParams {
  requestId: string;
  prompt: string;
  systemPrompt?: string;
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  stream?: boolean;
  onChunk?: (text: string) => void;
}

interface PendingGenerate {
  params: GenerateParams;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  started: boolean;
}

function resolveWorkerUrl(): URL {
  const currentUrl = import.meta.url;
  if (currentUrl.endsWith(".ts")) {
    return new URL("./llm-worker.ts", currentUrl);
  }
  return new URL("./llm-worker.js", currentUrl);
}

function resolveWorkerExecArgv(): string[] {
  if (!import.meta.url.endsWith(".ts")) {
    return [];
  }
  const loaderUrl = new URL("../../terminal/terminal-ts-loader.mjs", import.meta.url).href;
  const importSource = [
    'import { register } from "node:module";',
    'import { pathToFileURL } from "node:url";',
    `register(${JSON.stringify(loaderUrl)}, pathToFileURL("./"));`,
  ].join(" ");
  return [
    "--experimental-strip-types",
    "--import",
    `data:text/javascript,${encodeURIComponent(importSource)}`,
  ];
}

export class LlamaService {
  private readonly paseoHome: string;
  private readonly logger: pino.Logger;
  private readonly onStatusUpdate?: (state: LlmLocalModelState) => void;

  private worker: ChildProcess | null = null;
  private workerLoaded = false;
  private loadPromise: Promise<void> | null = null;
  private readonly queue: PendingGenerate[] = [];
  private active: PendingGenerate | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private downloading: { receivedBytes: number; totalBytes: number | null } | null = null;
  private downloadError: string | null = null;

  constructor(options: LlamaServiceOptions) {
    this.paseoHome = options.paseoHome;
    this.logger = options.logger.child({ module: "llama-service" });
    this.onStatusUpdate = options.onStatusUpdate;
  }

  private get modelPath(): string {
    return path.join(this.paseoHome, "models", MODEL_FILENAME);
  }

  async getStatus(): Promise<LlmLocalModelState> {
    if (this.downloading) {
      return { status: "downloading", ...this.downloading };
    }
    if (this.downloadError) {
      return { status: "error", message: this.downloadError };
    }
    try {
      // A valid model file starts with the GGUF magic; a partial download
      // (daemon killed mid-write) won't have been renamed into place.
      const handle = await fs.open(this.modelPath, "r");
      try {
        const { buffer } = await handle.read(Buffer.alloc(4), 0, 4, 0);
        if (!buffer.equals(GGUF_MAGIC)) {
          return { status: "error", message: "model file is corrupt (bad GGUF header)" };
        }
      } finally {
        await handle.close();
      }
      return { status: "ready", loaded: this.workerLoaded };
    } catch {
      return { status: "absent" };
    }
  }

  private emitStatus(state: LlmLocalModelState): void {
    this.onStatusUpdate?.(state);
  }

  // Starts the model download unless it is already running or done.
  async startDownload(): Promise<LlmLocalModelState> {
    const current = await this.getStatus();
    if (current.status === "downloading" || current.status === "ready") {
      return current;
    }
    this.downloadError = null;
    this.downloading = { receivedBytes: 0, totalBytes: null };
    void this.runDownload().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: error }, "Model download failed");
      this.downloading = null;
      this.downloadError = message;
      this.emitStatus({ status: "error", message });
    });
    return { status: "downloading", receivedBytes: 0, totalBytes: null };
  }

  private async runDownload(): Promise<void> {
    const dir = path.dirname(this.modelPath);
    await fs.mkdir(dir, { recursive: true });
    const partPath = `${this.modelPath}.part`;

    let lastError: Error | null = null;
    for (const url of MODEL_URLS) {
      try {
        await this.downloadFrom(url, partPath);
        await fs.rename(partPath, this.modelPath);
        this.downloading = null;
        this.emitStatus({ status: "ready", loaded: this.workerLoaded });
        this.logger.info({ modelPath: this.modelPath }, "Model download complete");
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger.warn({ err: lastError, url }, "Model download source failed, trying next");
      }
    }
    throw lastError ?? new Error("model download failed");
  }

  private async downloadFrom(url: string, partPath: string): Promise<void> {
    let existing = 0;
    try {
      existing = (await fs.stat(partPath)).size;
    } catch {
      // no partial file yet
    }
    const response = await fetch(url, {
      headers: existing > 0 ? { Range: `bytes=${existing}-` } : {},
    });
    if (!response.ok || !response.body) {
      throw new Error(`download failed: HTTP ${response.status}`);
    }
    const resumed = response.status === 206;
    if (!resumed) {
      existing = 0;
    }
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    const totalBytes = contentLength > 0 ? existing + contentLength : null;
    let receivedBytes = existing;
    this.downloading = { receivedBytes, totalBytes };

    const stream = createWriteStream(partPath, { flags: resumed ? "a" : "w" });
    let lastEmit = 0;
    // The fetch ReadableStream type is slightly different from what Readable.fromWeb expects
    // oxlint-disable-next-line typescript-eslint/no-explicit-any
    const body = Readable.fromWeb(response.body as any);
    try {
      for await (const chunk of body) {
        const buffer = Buffer.from(chunk);
        if (!stream.write(buffer)) {
          await new Promise<void>((resolve) => stream.once("drain", resolve));
        }
        receivedBytes += buffer.length;
        this.downloading = { receivedBytes, totalBytes };
        const now = Date.now();
        if (now - lastEmit > 1000) {
          lastEmit = now;
          this.emitStatus({ status: "downloading", receivedBytes, totalBytes });
        }
      }
    } finally {
      stream.end();
      await finished(stream);
    }
  }

  async generate(params: GenerateParams): Promise<string> {
    const status = await this.getStatus();
    if (status.status !== "ready") {
      throw new LlmGenerateError(`model is not ready (status: ${status.status})`);
    }
    return new Promise<string>((resolve, reject) => {
      this.queue.push({ params, resolve, reject, started: false });
      void this.pump();
    });
  }

  cancel(generateRequestId: string): boolean {
    const queued = this.queue.findIndex((p) => p.params.requestId === generateRequestId);
    if (queued >= 0) {
      const [pending] = this.queue.splice(queued, 1);
      pending.reject(new LlmGenerateError("cancelled"));
      return true;
    }
    if (this.active?.params.requestId === generateRequestId && this.worker) {
      this.sendToWorker({ type: "cancel", id: generateRequestId });
      return true;
    }
    return false;
  }

  private async pump(): Promise<void> {
    if (this.active) {
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      this.scheduleIdleUnload();
      return;
    }
    this.clearIdleTimer();
    this.active = next;
    try {
      await this.ensureWorkerLoaded();
      next.started = true;
      this.sendToWorker({
        type: "generate",
        id: next.params.requestId,
        prompt: next.params.prompt,
        systemPrompt: next.params.systemPrompt,
        jsonSchema: next.params.jsonSchema,
        maxTokens: next.params.maxTokens,
        stream: next.params.stream,
      });
    } catch (error) {
      this.active = null;
      next.reject(error instanceof Error ? error : new Error(String(error)));
      void this.pump();
    }
  }

  private async ensureWorkerLoaded(): Promise<void> {
    if (this.worker && this.workerLoaded) {
      return;
    }
    if (!this.loadPromise) {
      this.loadPromise = this.spawnAndLoad().catch((error) => {
        this.loadPromise = null;
        throw error;
      });
    }
    await this.loadPromise;
  }

  private spawnAndLoad(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.logger.info("Spawning llm worker");
      const worker = fork(fileURLToPath(resolveWorkerUrl()), [], {
        execArgv: resolveWorkerExecArgv(),
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      this.worker = worker;
      this.workerLoaded = false;

      let stderrTail = "";
      worker.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2000);
      });

      let settled = false;
      worker.on("message", (message: LlmWorkerToParentMessage) => {
        if (message.type === "loaded") {
          this.logger.info({ gpu: message.gpu, ms: message.ms }, "llm worker loaded model");
          this.workerLoaded = true;
          this.emitStatus({ status: "ready", loaded: true });
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }
        this.handleWorkerMessage(message);
        // A load-phase error (no id) fails the spawn.
        if (message.type === "error" && message.id === undefined && !settled) {
          settled = true;
          reject(new LlmGenerateError(message.message));
        }
      });

      worker.on("exit", (code, signal) => {
        const wasLoaded = this.workerLoaded;
        this.worker = null;
        this.workerLoaded = false;
        this.loadPromise = null;
        this.clearIdleTimer();
        const message = `llm worker exited (code ${code}, signal ${signal}). ${stderrTail ? `Last stderr: ${stderrTail.slice(-500)}` : ""}`;
        this.logger.warn({ code, signal, wasLoaded }, "llm worker exited");
        if (!settled) {
          settled = true;
          reject(new LlmGenerateError(message));
        }
        const active = this.active;
        if (active) {
          this.active = null;
          active.reject(new LlmGenerateError(message));
        }
        this.emitStatus({ status: "ready", loaded: false });
        void this.pump();
      });

      this.sendToWorker({
        type: "load",
        modelPath: this.modelPath,
        contextSize: CONTEXT_SIZE,
      });
    });
  }

  private handleWorkerMessage(message: LlmWorkerToParentMessage): void {
    if (message.type === "chunk") {
      if (this.active?.params.requestId === message.id) {
        this.active.params.onChunk?.(message.text);
      }
      return;
    }
    if (message.type === "done") {
      if (this.active?.params.requestId === message.id) {
        const active = this.active;
        this.active = null;
        active.resolve(message.text);
        void this.pump();
      }
      return;
    }
    if (message.type === "error" && message.id !== undefined) {
      if (this.active?.params.requestId === message.id) {
        const active = this.active;
        this.active = null;
        active.reject(new LlmGenerateError(message.message));
        void this.pump();
      }
    }
  }

  private sendToWorker(message: LlmWorkerParentToWorkerMessage): void {
    this.worker?.send(message);
  }

  private scheduleIdleUnload(): void {
    if (!this.worker || this.idleTimer) {
      return;
    }
    const timer = setTimeout(() => {
      this.idleTimer = null;
      if (this.active || this.queue.length > 0) {
        return;
      }
      this.logger.info("Unloading idle llm worker");
      this.stopWorker();
    }, IDLE_UNLOAD_MS);
    timer.unref();
    this.idleTimer = timer;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private stopWorker(): void {
    const worker = this.worker;
    this.worker = null;
    this.workerLoaded = false;
    this.loadPromise = null;
    worker?.kill();
  }

  stop(): void {
    this.clearIdleTimer();
    for (const pending of this.queue.splice(0)) {
      pending.reject(new LlmGenerateError("daemon shutting down"));
    }
    this.active?.reject(new LlmGenerateError("daemon shutting down"));
    this.active = null;
    this.stopWorker();
  }
}
