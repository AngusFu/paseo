import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface EmbeddingsConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}

const DEFAULT_MODEL = "qwen3-embedding:0.6b";
const DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";

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

function envFlagTrue(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function loadEmbeddingsConfig(options: {
  paseoHome?: string;
  env?: NodeJS.ProcessEnv;
}): EmbeddingsConfig | null {
  const env = options.env ?? process.env;
  const paseoHome = options.paseoHome ?? resolvePaseoHomeForDocs(env);
  const fromFile = readEmbeddingsFromConfigFile(paseoHome);

  const enabled =
    envFlagTrue(env.PASEO_EMBEDDINGS_ENABLED) ??
    fromFile.enabled ??
    Boolean(env.PASEO_EMBEDDINGS_MODEL?.trim());
  if (!enabled) return null;

  return {
    enabled: true,
    baseUrl: (
      env.PASEO_EMBEDDINGS_BASE_URL?.trim() ||
      fromFile.baseUrl ||
      DEFAULT_BASE_URL
    ).replace(/\/$/, ""),
    apiKey: env.PASEO_EMBEDDINGS_API_KEY?.trim() || fromFile.apiKey || "ollama",
    model: env.PASEO_EMBEDDINGS_MODEL?.trim() || fromFile.model || DEFAULT_MODEL,
  };
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
