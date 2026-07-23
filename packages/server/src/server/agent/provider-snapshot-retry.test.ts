import { describe, expect, it } from "vitest";
import {
  PROVIDER_ERROR_RETRY_COOLDOWN_MS,
  shouldRetryProviderError,
} from "./provider-snapshot-retry";

const NOW = Date.parse("2026-07-23T04:35:00.000Z");

function erroredAt(msAgo: number): { status: string; fetchedAt: string } {
  return { status: "error", fetchedAt: new Date(NOW - msAgo).toISOString() };
}

describe("shouldRetryProviderError", () => {
  it("retries a failure once the cooldown has passed", () => {
    // The case this exists for: a provider failed its probe at daemon start and
    // a workflow asked for it two hours later.
    expect(shouldRetryProviderError(erroredAt(2 * 60 * 60 * 1000), NOW)).toBe(true);
  });

  it("does not retry a failure inside the cooldown", () => {
    expect(shouldRetryProviderError(erroredAt(PROVIDER_ERROR_RETRY_COOLDOWN_MS - 1), NOW)).toBe(
      false,
    );
  });

  it("retries exactly at the cooldown boundary", () => {
    expect(shouldRetryProviderError(erroredAt(PROVIDER_ERROR_RETRY_COOLDOWN_MS), NOW)).toBe(true);
  });

  it("leaves ready, loading and missing entries alone", () => {
    expect(
      shouldRetryProviderError({ status: "ready", fetchedAt: erroredAt(0).fetchedAt }, NOW),
    ).toBe(false);
    expect(shouldRetryProviderError({ status: "loading" }, NOW)).toBe(false);
    expect(shouldRetryProviderError(undefined, NOW)).toBe(false);
  });

  it("retries a failure with no or unreadable timestamp", () => {
    expect(shouldRetryProviderError({ status: "error" }, NOW)).toBe(true);
    expect(shouldRetryProviderError({ status: "error", fetchedAt: "not a date" }, NOW)).toBe(true);
  });

  it("treats a backwards clock as fresh rather than retrying every request", () => {
    expect(shouldRetryProviderError(erroredAt(-60_000), NOW)).toBe(false);
  });

  it("honours an explicit cooldown", () => {
    expect(shouldRetryProviderError(erroredAt(5_000), NOW, 1_000)).toBe(true);
    expect(shouldRetryProviderError(erroredAt(5_000), NOW, 60_000)).toBe(false);
  });
});
