import { describe, expect, test } from "vitest";
import { PROSE_CLASSIFIER_FEW_SHOTS, PROSE_CLASSIFIER_SYSTEM } from "./classifier-prompt.js";

function fewShotLabel(userText: string): "WAIT" | "DONE" | null {
  const wrapped = `<message>\n${userText}\n</message>`;
  for (let i = 0; i < PROSE_CLASSIFIER_FEW_SHOTS.length - 1; i += 1) {
    const user = PROSE_CLASSIFIER_FEW_SHOTS[i];
    const model = PROSE_CLASSIFIER_FEW_SHOTS[i + 1];
    if (user?.role !== "user" || model?.role !== "model") {
      continue;
    }
    if (user.text !== wrapped) {
      continue;
    }
    const match = model.text.match(/<label>\s*(WAIT|DONE)\s*<\/label>/i);
    return match?.[1]?.toUpperCase() === "WAIT" ? "WAIT" : "DONE";
  }
  return null;
}

describe("prose-stop classifier prompt", () => {
  test("defaults to DONE when unsure", () => {
    expect(PROSE_CLASSIFIER_SYSTEM).toMatch(/if unsure[\s\S]*choose DONE/i);
    expect(PROSE_CLASSIFIER_SYSTEM).toMatch(/Default to DONE/);
  });

  test("marks short status acks as DONE few-shots", () => {
    expect(fewShotLabel("收工。")).toBe("DONE");
    expect(fewShotLabel("好。")).toBe("DONE");
    expect(fewShotLabel("知道了。")).toBe("DONE");
    expect(fewShotLabel("收到，提问链路正常。")).toBe("DONE");
    expect(fewShotLabel("对。两条通路都偏宁可误拦。")).toBe("DONE");
  });

  test("keeps clear handoff phrases as WAIT few-shots", () => {
    expect(fewShotLabel("要提交即可。")).toBe("WAIT");
    expect(fewShotLabel("需要的话我可以帮你 push。")).toBe("WAIT");
    expect(fewShotLabel("要改规则再说一声。")).toBe("WAIT");
  });
});
