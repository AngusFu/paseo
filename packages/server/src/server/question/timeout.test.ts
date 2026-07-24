import { describe, expect, test } from "vitest";
import { isAskQuestionTimeoutFailure } from "./timeout.js";

describe("isAskQuestionTimeoutFailure", () => {
  test("matches MCP timeout code and common transport failures", () => {
    expect(isAskQuestionTimeoutFailure({ code: -32001, message: "Request timed out" })).toBe(true);
    expect(isAskQuestionTimeoutFailure(new Error("MCP error -32001: timeout"))).toBe(true);
    expect(isAskQuestionTimeoutFailure("tool unavailable")).toBe(true);
    expect(isAskQuestionTimeoutFailure({ code: "ASK_QUESTION_TIMEOUT" })).toBe(true);
  });

  test("does not match ordinary dismiss / user abort prose", () => {
    expect(isAskQuestionTimeoutFailure({ dismissed: true })).toBe(false);
    expect(isAskQuestionTimeoutFailure("Question dismissed")).toBe(false);
    expect(isAskQuestionTimeoutFailure("User cancelled the form")).toBe(false);
  });
});
