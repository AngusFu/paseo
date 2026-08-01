/** True when a daemon/CLI error is about missing Embeddings config. */
export function isEmbeddingsConfigError(message: string | null | undefined): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return lower.includes("embeddings disabled") || lower.includes("localtools.embeddings");
}

/** Append Host settings pointer when the error is clearly about Embeddings. */
export function withEmbeddingsConfigHint(args: {
  error: string | null | undefined;
  hint: string;
}): string | null {
  const error = args.error?.trim();
  if (!error) return null;
  if (!isEmbeddingsConfigError(error)) return error;
  if (error.includes(args.hint)) return error;
  return `${error}\n${args.hint}`;
}
