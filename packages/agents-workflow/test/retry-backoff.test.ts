import { test, expect } from "vitest";
import {
  BACKEND_ERROR_RETRY_BASE_MS,
  BACKEND_ERROR_RETRY_MAX_MS,
  retryDelayMs,
} from "../src/retry-backoff.js";

test("a backend error backs off exponentially", () => {
  expect(retryDelayMs("backend-error", 0)).toBe(BACKEND_ERROR_RETRY_BASE_MS);
  expect(retryDelayMs("backend-error", 1)).toBe(BACKEND_ERROR_RETRY_BASE_MS * 2);
  expect(retryDelayMs("backend-error", 2)).toBe(BACKEND_ERROR_RETRY_BASE_MS * 4);
});

test("the backend-error backoff is capped", () => {
  expect(retryDelayMs("backend-error", 10)).toBe(BACKEND_ERROR_RETRY_MAX_MS);
  expect(retryDelayMs("backend-error", 100)).toBe(BACKEND_ERROR_RETRY_MAX_MS);
});

test("a malformed-output retry does not wait", () => {
  // The model is simply being asked again with a corrected prompt; there is no
  // external condition to wait out.
  expect(retryDelayMs("bad-output", 0)).toBe(0);
  expect(retryDelayMs("bad-output", 5)).toBe(0);
});

test("a negative attempt index is treated as the first", () => {
  expect(retryDelayMs("backend-error", -1)).toBe(BACKEND_ERROR_RETRY_BASE_MS);
});
