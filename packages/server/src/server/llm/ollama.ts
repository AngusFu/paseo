import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_OLLAMA_ORIGIN = "http://127.0.0.1:11434";

const OLLAMA_BINARY_CANDIDATES = [
  "ollama",
  "/opt/homebrew/bin/ollama",
  "/usr/local/bin/ollama",
  `${process.env.HOME ?? ""}/.local/bin/ollama`,
  "/usr/bin/ollama",
];

export function resolveOllamaOrigin(baseUrl: string | null | undefined): string {
  const raw = (baseUrl?.trim() || DEFAULT_OLLAMA_ORIGIN).replace(/\/+$/, "");
  const withoutV1 = raw.replace(/\/v1$/i, "");
  return withoutV1.length > 0 ? withoutV1 : DEFAULT_OLLAMA_ORIGIN;
}

export function defaultOllamaOpenAiBaseUrl(): string {
  return `${DEFAULT_OLLAMA_ORIGIN}/v1`;
}

async function isExecutable(filePath: string): Promise<boolean> {
  if (!filePath.trim()) {
    return false;
  }
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findOllamaBinary(options?: {
  execFileImpl?: typeof execFileAsync;
  candidates?: string[];
  isExecutableImpl?: (filePath: string) => Promise<boolean>;
}): Promise<string | null> {
  const execFileImpl = options?.execFileImpl ?? execFileAsync;
  const isExecutableImpl = options?.isExecutableImpl ?? isExecutable;
  const candidates = options?.candidates ?? OLLAMA_BINARY_CANDIDATES;

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      if (await isExecutableImpl(candidate)) {
        return candidate;
      }
      continue;
    }
    try {
      const { stdout } = await execFileImpl(process.platform === "win32" ? "where" : "which", [
        candidate,
      ]);
      const resolved = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      if (resolved && (await isExecutableImpl(resolved))) {
        return resolved;
      }
    } catch {
      // keep looking
    }
  }
  return null;
}

function parseOpenAiModelsPayload(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return [];
  }
  const models: string[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const id = (item as { id?: unknown }).id;
    if (typeof id === "string" && id.trim().length > 0) {
      models.push(id.trim());
    }
  }
  return models;
}

function parseOllamaTagsPayload(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) {
    return [];
  }
  const names: string[] = [];
  for (const item of models) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as { name?: unknown; model?: unknown };
    let name: string | null = null;
    if (typeof record.name === "string" && record.name.trim().length > 0) {
      name = record.name.trim();
    } else if (typeof record.model === "string" && record.model.trim().length > 0) {
      name = record.model.trim();
    }
    if (name) {
      names.push(name);
    }
  }
  return names;
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

export async function listOllamaModels(args: {
  baseUrl?: string | null;
  apiKey?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  const origin = resolveOllamaOrigin(args.baseUrl);
  const fetchImpl = args.fetchImpl ?? fetch;
  const headers: Record<string, string> = { Accept: "application/json" };
  const apiKey = args.apiKey?.trim();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  // Prefer Ollama's native tags endpoint; fall back to OpenAI-compatible /v1/models.
  const attempts = [`${origin}/api/tags`, `${origin}/v1/models`];
  let lastError: Error | null = null;
  for (const url of attempts) {
    try {
      const response = await fetchImpl(url, { headers });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status} from ${url}`);
        continue;
      }
      const payload: unknown = await response.json();
      const models = url.endsWith("/api/tags")
        ? parseOllamaTagsPayload(payload)
        : parseOpenAiModelsPayload(payload);
      if (models.length > 0) {
        return uniqueSorted(models);
      }
      // Empty list is still a successful probe.
      return [];
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error("Unable to list Ollama models");
}

export async function detectAndListOllamaModels(args: {
  baseUrl?: string | null;
  apiKey?: string | null;
  fetchImpl?: typeof fetch;
  execFileImpl?: typeof execFileAsync;
  candidates?: string[];
  isExecutableImpl?: (filePath: string) => Promise<boolean>;
}): Promise<{
  ollamaAvailable: boolean;
  ollamaPath: string | null;
  models: string[];
  error: string | null;
}> {
  const ollamaPath = await findOllamaBinary({
    execFileImpl: args.execFileImpl,
    candidates: args.candidates,
    isExecutableImpl: args.isExecutableImpl,
  });
  if (!ollamaPath) {
    return {
      ollamaAvailable: false,
      ollamaPath: null,
      models: [],
      error: null,
    };
  }

  try {
    const models = await listOllamaModels({
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      fetchImpl: args.fetchImpl,
    });
    return {
      ollamaAvailable: true,
      ollamaPath,
      models,
      error: null,
    };
  } catch (error) {
    return {
      ollamaAvailable: true,
      ollamaPath,
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
