import { describe, expect, it } from "vitest";
import { checkProseStop } from "./check.js";
import { matchBlockingPatterns } from "./regex-gate.js";
import { prepareClosingText, stripQuotedContent } from "./strip-and-closing.js";

async function expectDecision(text: string, want: "block" | "allow"): Promise<void> {
  const result = await checkProseStop({
    text,
    mode: "regex",
  });
  expect(result.decision, text).toBe(want);
}

describe("stripQuotedContent", () => {
  it("strips fenced code, inline code, quotes, and blockquotes", () => {
    expect(stripQuotedContent("Done.\n\n```\nlet me know when ready\n```")).not.toMatch(
      /let me know/,
    );
    expect(stripQuotedContent("Pattern `let me know` now scoped.")).not.toMatch(/let me know/);
    expect(stripQuotedContent('Earlier the prose "shall I delete" tripped.\n\nFixed.')).not.toMatch(
      /shall I delete/,
    );
    expect(stripQuotedContent("Fix applied.\n\n> let me know when ready")).not.toMatch(
      /let me know/,
    );
  });
});

describe("prepareClosingText", () => {
  it("uses only the closing segment so mid-message blacklist phrases do not trip", () => {
    const closing = prepareClosingText(
      'Report done.\n\n| id | note |\n| --- | --- |\n| P3-10 | phrase "let me know" falsely blocks |\n\nAll items verified.',
    );
    expect(matchBlockingPatterns(closing).blocked).toBe(false);
  });

  it("widens structured option lists under a prose lead-in", () => {
    const closing = prepareClosingText("Two options:\n\n- shall I delete the branch?\n- keep it");
    expect(matchBlockingPatterns(closing).blocked).toBe(true);
  });
});

describe("prose-stop regex fixtures (from test-check-prose-stop.sh)", () => {
  it("allows quoted / mid-message phrases", async () => {
    await expectDecision(
      'Report done.\n\n| id | note |\n| --- | --- |\n| P3-10 | phrase "let me know" falsely blocks |\n\nAll items verified.',
      "allow",
    );
    await expectDecision("说明一下：要继续吗这句话曾误触门禁。\n\n修复已完成。", "allow");
    await expectDecision(
      'Earlier the prose "shall I delete the branch" tripped the gate.\n\nFixed now.',
      "allow",
    );
    await expectDecision("Done.\n\n```\nlet me know when ready\n```", "allow");
    await expectDecision("Example:\n\n```\nlet me know\n```\n\nDone.", "allow");
    await expectDecision("Pattern `let me know` now scoped to closing.", "allow");
    await expectDecision("Fix applied.\n\n> let me know when ready", "allow");
    await expectDecision("All fixtures updated. Suite green.", "allow");
    await expectDecision("修复完成，测试全部通过。", "allow");
  });

  it("denies real closing asks", async () => {
    await expectDecision("Work done.\n\nLet me know when ready.", "block");
    await expectDecision("第一步已完成。\n\n要继续吗?", "block");
    await expectDecision("分支已合并。\n\n删掉这个吗?", "block");
    await expectDecision("Setup complete.\n\nReady when you are.", "block");
    await expectDecision("Branch merged.\n\nShall I delete the old worktree?", "block");
    await expectDecision("Let me know if I should proceed.", "block");
    await expectDecision("Two options:\n\n- shall I delete the branch?\n- keep it", "block");
  });

  it("requires a real question marker for 删…吗", async () => {
    await expectDecision("我已经删掉了旧文件吗记录。", "allow");
    await expectDecision("构建完成。\n\n删了缓存吗？", "block");
  });

  it("denies statement-form waiting without ?", async () => {
    await expectDecision(
      "已完成 validate。\n\n需要我接着跑 full（按报告逐项 gating 改）再说一声即可。",
      "block",
    );
    await expectDecision("报告已生成。\n\n需要我继续深入分析某一项，告知即可。", "block");
    await expectDecision("先做到这里。\n\n要继续的话说一声即可。", "block");
    await expectDecision("改完了。\n\n还需要别的就吱一声。", "block");
    await expectDecision("这个改动需要重启 dev server 才生效。", "allow");
    await expectDecision("脚本会在失败时告知调用方，逻辑已验证。", "allow");
  });

  it("denies bare say-verb handoffs", async () => {
    await expectDecision(
      "Facet F 仍 defer 到 2026-08-04。\n\n要提交 .claude 这些改动时直接说即可。",
      "block",
    );
    await expectDecision("validate 跑完了。\n\n想跑 full 直接说。", "block");
    await expectDecision("先到这里。\n\n随时告诉我。", "block");
    await expectDecision("方案写好了。\n\n你说一声我就做。", "block");
    await expectDecision("改完了。\n\n需要别的尽管说。", "block");
    await expectDecision("文档里直接说明了原因。", "allow");
    await expectDecision("我直接说结论:这条是假阳。", "allow");
    await expectDecision("报错信息直接说清楚为什么失败。", "allow");
    await expectDecision("脚本会在失败时告诉调用方。", "allow");
  });

  it("denies condition-first 即可 and exempts instructional 要…即可", async () => {
    await expectDecision("改完了。\n\n要 push 即可。", "block");
    await expectDecision("validate 完成。\n\n要跑 full 即可。", "block");
    await expectDecision("都验证过了。\n\n要提交即可。", "block");
    await expectDecision("报告写好了。\n\n想改哪条告诉我。", "block");
    await expectDecision("先到这里。\n\n要继续说一声。", "block");
    await expectDecision("想复现只需跑一次即可。", "allow");
    await expectDecision("要跑测试用 npm test 即可。", "allow");
    await expectDecision("要修复执行 npm i 即可。", "allow");
    await expectDecision("这样改即可。", "allow");
    await expectDecision("清理完成。\n\n要执行删掉这个吗?", "block");
    // 需要时…即可 must not trip via the 要 inside 需要
    await expectDecision("需要时打开 DMG 即可。", "allow");
    await expectDecision("需要时拖进 Applications 即可。", "allow");
    await expectDecision("收工。", "allow");
    await expectDecision("好。", "allow");
    await expectDecision("知道了。", "allow");
  });

  it("denies offer-if-wanted without ?", async () => {
    await expectDecision(
      "纯 [skip ci] 过不了 commitlint，所以加了 chore: 前缀；GitLab 仍会识别并跳过 CI。本地比远端超前 1 个 commit，需要的话我可以帮你 push。",
      "block",
    );
    await expectDecision("改完了。\n\n要的话我可以继续。", "block");
    await expectDecision("分支好了。\n\n如果需要我可以帮你提交。", "block");
    await expectDecision("先到这里。\n\n有需要的话随时喊我。", "block");
    await expectDecision("这条警告不需要的话可以忽略。", "allow");
    await expectDecision("这个改动需要的话会重启。", "allow");
    await expectDecision("需要的环境变量已写好。", "allow");
  });

  it("does not block report-and-stop closings (v1 skip WARN)", async () => {
    await expectDecision("以上是本次审计的发现。", "allow");
    await expectDecision("Here are the findings.", "allow");
    await expectDecision("The audit is complete.", "allow");
  });
});

describe("checkProseStop regex-first", () => {
  it("skips LLM when regex already blocks", async () => {
    let classifyCalls = 0;
    const result = await checkProseStop({
      text: "Work done.\n\nLet me know when ready.",
      mode: "regex-first",
      classify: async () => {
        classifyCalls += 1;
        return "DONE";
      },
    });
    expect(result).toMatchObject({ decision: "block", source: "regex" });
    expect(classifyCalls).toBe(0);
  });

  it("blocks on LLM WAIT when regex misses", async () => {
    const result = await checkProseStop({
      text: "All fixtures updated. Suite green.",
      mode: "regex-first",
      classify: async () => "WAIT",
    });
    expect(result).toMatchObject({ decision: "block", source: "llm", llmVerdict: "WAIT" });
  });

  it("allows on LLM SKIP / DONE when regex misses", async () => {
    await expect(
      checkProseStop({
        text: "All fixtures updated. Suite green.",
        mode: "regex-first",
        classify: async () => "SKIP",
      }),
    ).resolves.toMatchObject({ decision: "allow", llmVerdict: "SKIP" });

    await expect(
      checkProseStop({
        text: "All fixtures updated. Suite green.",
        mode: "regex-first",
        classify: async () => "DONE",
      }),
    ).resolves.toMatchObject({ decision: "allow", llmVerdict: "DONE" });
  });
});
