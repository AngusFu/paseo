import { describe, expect, it } from "vitest";
import {
  formatRetriableContinuePrompt,
  formatRetriableTurnRetryNotice,
  isRetriableErrorAssistantMessage,
  isRetriableProviderError,
  isSameRetriableErrorVisible,
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

  it("matches aborted TLS / socket disconnect failures", () => {
    expect(
      isRetriableProviderError(
        "Error: [aborted] Client network socket disconnected before secure TLS connection was established",
      ),
    ).toBe(true);
    expect(isRetriableProviderError("Error: [aborted] read ECONNRESET")).toBe(true);
    expect(isRetriableProviderError("request failed: socket hang up")).toBe(true);
    expect(isRetriableProviderError("connect ETIMEDOUT 1.2.3.4:443")).toBe(true);
    expect(isRetriableProviderError("UND_ERR_CONNECT_TIMEOUT")).toBe(true);
  });

  it("rejects ordinary model failures and bare user aborts", () => {
    expect(isRetriableProviderError("invalid model id")).toBe(false);
    expect(isRetriableProviderError("permission denied")).toBe(false);
    // Bare [aborted] without transport wording — do not treat as retriable.
    expect(isRetriableProviderError("Error: [aborted]")).toBe(false);
  });

  it("does not treat explanatory assistant text as a retriable turn_completed failure", () => {
    const doc = [
      "## 问题原因",
      "Provider 会流式输出 `Error: RetriableError: [unavailable] PING timed out`",
      "然后发 turn_completed。",
    ].join("\n");
    expect(isRetriableProviderError(doc)).toBe(true);
    expect(isRetriableErrorAssistantMessage(doc)).toBe(false);
  });

  it("does not treat a commit question as a retriable turn_completed failure", () => {
    expect(isRetriableErrorAssistantMessage("要我把这两处一起 commit 吗？")).toBe(false);
  });

  it("accepts streamed provider error assistant messages on turn_completed", () => {
    expect(
      isRetriableErrorAssistantMessage("Error: RetriableError: [unavailable] PING timed out"),
    ).toBe(true);
    expect(
      isRetriableErrorAssistantMessage("RetriableError: [resource_exhausted] Rate limit exceeded"),
    ).toBe(true);
    expect(isRetriableErrorAssistantMessage("ConnectError: [unavailable] PING timed out")).toBe(
      true,
    );
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

  it("omits duplicated provider error text when it is already visible", () => {
    const notice = formatRetriableTurnRetryNotice({
      error: "Error: RetriableError: [unavailable] PING timed out",
      attempt: 1,
      delayMs: 2_000,
      errorAlreadyVisible: true,
    });
    expect(notice).toBe("Retriable provider error — retrying in 2s (attempt 1).");
    expect(notice).not.toContain("PING timed out");
  });

  it("includes provider error text when it is not already visible", () => {
    const notice = formatRetriableTurnRetryNotice({
      error: "Error: RetriableError: [unavailable] PING timed out",
      attempt: 1,
      delayMs: 2_000,
    });
    expect(notice).toContain("PING timed out");
    expect(notice).toContain("Retriable provider error — retrying in 2s (attempt 1).");
  });

  it("treats streamed retriable assistant text as the same visible error", () => {
    expect(
      isSameRetriableErrorVisible(
        "Error: RetriableError: [unavailable] PING timed out",
        "Error: RetriableError: [unavailable] PING timed out",
      ),
    ).toBe(true);
  });
});
