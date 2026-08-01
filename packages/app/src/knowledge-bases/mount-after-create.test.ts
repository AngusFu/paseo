import { describe, expect, it, vi } from "vitest";
import { formatMountFailuresMessage, mountKnowledgeBaseSelections } from "./mount-after-create";

describe("mountKnowledgeBaseSelections", () => {
  it("mounts each selection and collects failures without throwing", async () => {
    const knowledgeBaseMount = vi
      .fn()
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: "slug taken" });

    const result = await mountKnowledgeBaseSelections({
      client: { knowledgeBaseMount },
      workspaceId: "wks_1",
      selections: [
        { knowledgeBaseId: "kb_1", idOrSlug: "runbooks", mountSlug: "runbooks" },
        { knowledgeBaseId: "kb_2", idOrSlug: "faq", mountSlug: "faq" },
      ],
    });

    expect(knowledgeBaseMount).toHaveBeenCalledTimes(2);
    expect(result.mounted).toEqual(["runbooks"]);
    expect(result.failures).toEqual([{ idOrSlug: "faq", mountSlug: "faq", error: "slug taken" }]);
  });

  it("formats failure copy", () => {
    expect(
      formatMountFailuresMessage({
        failures: [],
        partialFailed: () => "partial",
        singleFailed: () => "single",
      }),
    ).toBeNull();
    expect(
      formatMountFailuresMessage({
        failures: [{ idOrSlug: "a", mountSlug: "a", error: "boom" }],
        partialFailed: (count) => `${count} failed`,
        singleFailed: (error) => `fail: ${error}`,
      }),
    ).toBe("fail: boom");
  });
});
