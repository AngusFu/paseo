import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  defaultOllamaOpenAiBaseUrl,
  listOllamaModels,
  resolveOllamaOrigin,
} from "../llm/ollama.js";

export interface EmbeddingsConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface EmbeddingsConfigOverride {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

const DEFAULT_MODEL = "qwen3-embedding:0.6b";
const DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";
const EMBEDDINGS_PROBE_TEXT = "paseo embeddings probe";

export function resolvePaseoHomeForDocs(env: NodeJS.ProcessEnv = process.env): string {
  return env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
}

function readEmbeddingsFromConfigFile(paseoHome: string): Partial<EmbeddingsConfig> {
  const configPath = join(paseoHome, "config.json");
  if (!existsSync(configPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
      localTools?: { embeddings?: Partial<EmbeddingsConfig> };
    };
    return raw.localTools?.embeddings ?? {};
  } catch {
    return {};
  }
}

/**
 * Load embeddings config from `$PASEO_HOME/config.json` `localTools.embeddings` only.
 * `env` / `PASEO_HOME` locate the home directory — they do not control embeddings.
 * `enabled` must be explicitly `true` in file config.
 */
export function loadEmbeddingsConfig(options: {
  paseoHome?: string;
  env?: NodeJS.ProcessEnv;
}): EmbeddingsConfig | null {
  const env = options.env ?? process.env;
  const paseoHome = options.paseoHome ?? resolvePaseoHomeForDocs(env);
  const fromFile = readEmbeddingsFromConfigFile(paseoHome);

  if (fromFile.enabled !== true) return null;

  return {
    enabled: true,
    baseUrl: (fromFile.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/$/, ""),
    apiKey: fromFile.apiKey?.trim() || "ollama",
    model: fromFile.model?.trim() || DEFAULT_MODEL,
  };
}

/**
 * Prefer a tag whose name contains "embedding"; else the documented default
 * when present; else the first tag (or null).
 */
export function suggestEmbeddingModel(models: readonly string[]): string | null {
  const embeddingNamed = models.find((name) => name.toLowerCase().includes("embedding"));
  if (embeddingNamed) {
    return embeddingNamed;
  }
  if (models.includes(DEFAULT_MODEL)) {
    return DEFAULT_MODEL;
  }
  return models[0] ?? null;
}

export async function detectOllamaForEmbeddings(options: {
  baseUrl?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<{
  available: boolean;
  baseUrl: string | null;
  models: string[];
  suggestedModel: string | null;
  error: string | null;
}> {
  const fillBaseUrl = options.baseUrl?.trim()
    ? `${resolveOllamaOrigin(options.baseUrl)}/v1`
    : defaultOllamaOpenAiBaseUrl();
  try {
    const models = await listOllamaModels({
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      fetchImpl: options.fetchImpl,
    });
    return {
      available: true,
      baseUrl: fillBaseUrl,
      models,
      suggestedModel: suggestEmbeddingModel(models),
      error: null,
    };
  } catch (error) {
    return {
      available: false,
      baseUrl: null,
      models: [],
      suggestedModel: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function embeddingsOverridePresent(override: EmbeddingsConfigOverride): boolean {
  return (
    override.enabled !== undefined ||
    override.baseUrl !== undefined ||
    override.apiKey !== undefined ||
    override.model !== undefined
  );
}

function mergeEmbeddingsProbeConfig(
  override: EmbeddingsConfigOverride,
  fromEffective: EmbeddingsConfig | null,
): EmbeddingsConfig | null {
  const enabled = override.enabled ?? fromEffective?.enabled ?? true;
  if (!enabled) {
    return null;
  }
  return {
    enabled: true,
    baseUrl: (override.baseUrl?.trim() || fromEffective?.baseUrl || DEFAULT_BASE_URL).replace(
      /\/$/,
      "",
    ),
    apiKey: override.apiKey?.trim() || fromEffective?.apiKey || "ollama",
    model: override.model?.trim() || fromEffective?.model || DEFAULT_MODEL,
  };
}

/**
 * Resolve config for a settings "Test" probe. When any override field is set,
 * merge onto file defaults (form values before save). Otherwise use
 * `loadEmbeddingsConfig` only.
 */
export function resolveEmbeddingsConfigForProbe(options: {
  paseoHome?: string;
  env?: NodeJS.ProcessEnv;
  override?: EmbeddingsConfigOverride;
}): EmbeddingsConfig | null {
  const override = options.override ?? {};
  const fromEffective = loadEmbeddingsConfig({
    paseoHome: options.paseoHome,
    env: options.env,
  });
  if (!embeddingsOverridePresent(override)) {
    return fromEffective;
  }
  return mergeEmbeddingsProbeConfig(override, fromEffective);
}

export async function testEmbeddingsProbe(options: {
  paseoHome?: string;
  env?: NodeJS.ProcessEnv;
  override?: EmbeddingsConfigOverride;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; dimensions: number | null; error: string | null }> {
  const config = resolveEmbeddingsConfigForProbe(options);
  if (!config) {
    return {
      ok: false,
      dimensions: null,
      error: "Embeddings disabled. Enable embeddings in Host settings → Knowledge bases.",
    };
  }
  try {
    const vectors = await embedTexts(config, [EMBEDDINGS_PROBE_TEXT], options.fetchImpl ?? fetch);
    const dimensions = vectors[0]?.length ?? 0;
    if (dimensions <= 0) {
      return { ok: false, dimensions: null, error: "Empty embedding dimensions" };
    }
    return { ok: true, dimensions, error: null };
  } catch (error) {
    return {
      ok: false,
      dimensions: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function embedTexts(
  config: EmbeddingsConfig,
  texts: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const response = await fetchImpl(`${config.baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      input: texts,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Embeddings request failed (${response.status}): ${body || response.statusText}`,
    );
  }
  const json = (await response.json()) as {
    data?: Array<{ embedding?: number[]; index?: number }>;
  };
  const data = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (data.length !== texts.length) {
    throw new Error(
      `Embeddings response size mismatch: expected ${texts.length}, got ${data.length}`,
    );
  }
  const vectors = data.map((row, i) => {
    const embedding = row.embedding;
    if (!embedding?.length) {
      throw new Error(`Missing embedding for input index ${i}`);
    }
    return embedding;
  });
  const dims = vectors[0]!.length;
  for (let i = 1; i < vectors.length; i++) {
    assertSameEmbeddingDimensions(vectors[0]!, vectors[i]!, `batch index ${i}`);
  }
  if (dims === 0) throw new Error("Empty embedding dimensions");
  return vectors;
}

/** Fail closed when query/index vectors disagree — never silently truncate. */
export function assertSameEmbeddingDimensions(
  a: number[],
  b: number[],
  context = "embedding",
): void {
  assertEmbeddingDimCount(a, b.length, context);
}

export function assertEmbeddingDimCount(
  vector: number[],
  dims: number,
  context = "embedding",
): void {
  if (vector.length !== dims) {
    throw new Error(
      `Embedding dimension mismatch (${context}): got ${vector.length}, expected ${dims}. Re-run \`paseo kb index\` with a consistent model.`,
    );
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  assertSameEmbeddingDimensions(a, b, "cosineSimilarity");
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
