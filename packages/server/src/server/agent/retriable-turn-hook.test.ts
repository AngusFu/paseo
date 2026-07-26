import { describe, expect, it } from "vitest";
import {
  formatRetriableContinuePrompt,
  isRetriableProviderError,
  RETRIABLE_TURN_MAX_ATTEMPTS,
  retriableTurnBackoffMs,
  shouldRetryRetriableTurn,
} from "./retriable-turn-hook.js";

describe("retriable-turn-hook", () => {
  it("matches Cursor ACP resource_exhausted RetriableError", () => {
    expect(isRetriableProviderError("Error: RetriableError: [resource_exhausted] Error")).toBe(
      true,
    );
  });

  it("matches related quota / overload wording", () => {
    expect(isRetriableProviderError("rate_limit_exceeded")).toBe(true);
    expect(isRetriableProviderError("model overloaded, try again later")).toBe(true);
  });

  it("matches Cursor transport PING / unavailable failures", () => {
    expect(isRetriableProviderError("Error: RetriableError: [unavailable] PING timed out")).toBe(
      true,
    );
    expect(isRetriableProviderError("ConnectError: [unavailable] PING timed out")).toBe(true);
    expect(
      isRetriableProviderError("RetriableError: [internal] HTTP/2 keepalive ping timed out"),
    ).toBe(true);
  });

  it("rejects ordinary model failures", () => {
    expect(isRetriableProviderError("invalid model id")).toBe(false);
    expect(isRetriableProviderError("permission denied")).toBe(false);
  });

  it("uses exponential backoff capped at 60s", () => {
    expect(retriableTurnBackoffMs(1)).toBe(2_000);
    expect(retriableTurnBackoffMs(2)).toBe(4_000);
    expect(retriableTurnBackoffMs(3)).toBe(8_000);
    expect(retriableTurnBackoffMs(10)).toBe(60_000);
  });

  it("allows up to MAX attempts then stops", () => {
    const error = "RetriableError: [resource_exhausted]";
    expect(shouldRetryRetriableTurn({ error, attemptCount: 0 })).toBe(true);
    expect(shouldRetryRetriableTurn({ error, attemptCount: RETRIABLE_TURN_MAX_ATTEMPTS - 1 })).toBe(
      true,
    );
    expect(shouldRetryRetriableTurn({ error, attemptCount: RETRIABLE_TURN_MAX_ATTEMPTS })).toBe(
      false,
    );
  });

  it("formats a continue prompt with attempt count", () => {
    const prompt = formatRetriableContinuePrompt({
      error: "RetriableError: [resource_exhausted] Error",
      attempt: 3,
    });
    expect(prompt).toContain("Attempt 3/10");
    expect(prompt).toContain("resource_exhausted");
    expect(prompt).toContain("Do not restart from scratch");
  });

  it("embeds the latest user message so retry does not drift to an earlier task", () => {
    const prompt = formatRetriableContinuePrompt({
      error: "RetriableError: [aborted] read ECONNRESET",
      attempt: 1,
      lastUserPrompt: "完了报错",
    });
    expect(prompt).toContain("Latest user message to continue:");
    expect(prompt).toContain("完了报错");
    expect(prompt).toContain("Do not switch to an earlier task");
  });
});
