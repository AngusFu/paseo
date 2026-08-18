import { describe, expect, it } from "vitest";
import { parseAnswerPairs } from "./ask-question-card";

describe("parseAnswerPairs", () => {
  it("reads header-keyed answers from a flat map", () => {
    expect(parseAnswerPairs({ 后续: "跟进 MR" })).toEqual({ 后续: "跟进 MR" });
  });

  it("unwraps MCP structured { answers } output", () => {
    expect(parseAnswerPairs({ answers: { 后续: "跟进 MR" }, dismissed: false })).toEqual({
      后续: "跟进 MR",
    });
  });

  it("rejects opaque ACP {success:true} so the card does not show → —", () => {
    expect(parseAnswerPairs({ success: true })).toBeNull();
    expect(parseAnswerPairs({ ok: true })).toBeNull();
  });
});
