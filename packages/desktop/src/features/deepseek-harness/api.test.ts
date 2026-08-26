import { describe, expect, it } from "vitest";
import { allocateFreePort } from "./index.js";
import { normalizeBaseUrl, unwrapDshResult } from "./api.js";

describe("deepseek-harness api helpers", () => {
  it("normalizes trailing slashes on base urls", () => {
    expect(normalizeBaseUrl("http://127.0.0.1:3080/")).toBe("http://127.0.0.1:3080");
  });

  it("unwraps successful envelopes", () => {
    expect(
      unwrapDshResult(
        {
          type: "server-response",
          result: { ok: true, value: { workspaceId: "ws_1" } },
        },
        "workspace.create",
      ),
    ).toEqual({ workspaceId: "ws_1" });
  });

  it("throws on failed envelopes", () => {
    expect(() =>
      unwrapDshResult(
        {
          type: "server-response",
          result: { ok: false, error: { message: "boom" } },
        },
        "workspace.create",
      ),
    ).toThrow(/workspace\.create failed: boom/);
  });
});

describe("allocateFreePort", () => {
  it("returns a positive TCP port", async () => {
    const port = await allocateFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });
});
