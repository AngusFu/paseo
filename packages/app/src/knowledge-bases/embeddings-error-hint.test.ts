import { describe, expect, it } from "vitest";
import { isEmbeddingsConfigError, withEmbeddingsConfigHint } from "./embeddings-error-hint";

describe("embeddings error hint", () => {
  it("detects embeddings-disabled errors", () => {
    expect(
      isEmbeddingsConfigError(
        "Embeddings disabled. Set localTools.embeddings.enabled=true before importing.",
      ),
    ).toBe(true);
    expect(isEmbeddingsConfigError("slug already exists")).toBe(false);
  });

  it("appends the Host settings hint once", () => {
    const hint = "Configure them in Settings → Host → Knowledge bases.";
    const error = "Embeddings disabled. Set localTools.embeddings.enabled=true.";
    expect(withEmbeddingsConfigHint({ error, hint })).toBe(`${error}\n${hint}`);
    expect(withEmbeddingsConfigHint({ error: `${error}\n${hint}`, hint })).toBe(
      `${error}\n${hint}`,
    );
    expect(withEmbeddingsConfigHint({ error: "other", hint })).toBe("other");
  });
});
