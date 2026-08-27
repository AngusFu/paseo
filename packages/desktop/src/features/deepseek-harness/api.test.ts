import { describe, expect, it } from "vitest";
import { allocateFreePort, buildDeepseekHarnessSpawnArgs } from "./index.js";
import { normalizeBaseUrl, unwrapDshResult } from "./api.js";
import {
  buildDeepseekHarnessEmbedUrl,
  buildDshPaseoOverlayPatchYaml,
  resolveDshHome,
  resolveDshPaseoPluginRoot,
} from "./plugin.js";

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

describe("buildDeepseekHarnessSpawnArgs", () => {
  it("puts --expose-internals before the dsh entry for HMR", () => {
    expect(
      buildDeepseekHarnessSpawnArgs({
        entryPath: "/tmp/dsh/lib/bin.js",
        port: 4123,
      }),
    ).toEqual([
      "--expose-internals",
      "/tmp/dsh/lib/bin.js",
      "--profile",
      "web",
      "--port",
      "4123",
      "--no-open",
    ]);
  });

  it("places --patch with launcher flags before port options", () => {
    expect(
      buildDeepseekHarnessSpawnArgs({
        entryPath: "/tmp/dsh/lib/bin.js",
        port: 4123,
        patchPath: "/tmp/dsh-paseo.overlay.yml",
      }),
    ).toEqual([
      "--expose-internals",
      "/tmp/dsh/lib/bin.js",
      "--profile",
      "web",
      "--patch",
      "/tmp/dsh-paseo.overlay.yml",
      "--port",
      "4123",
      "--no-open",
    ]);
  });
});

describe("dsh-paseo plugin helpers", () => {
  it("builds embed URLs with workspaceId", () => {
    expect(
      buildDeepseekHarnessEmbedUrl("http://127.0.0.1:3080/", {
        workspaceId: "ws_abc",
      }),
    ).toBe("http://127.0.0.1:3080/?paseoEmbed=1&workspaceId=ws_abc");
  });

  it("prefers sessionId over workspaceId for agent deep links", () => {
    expect(
      buildDeepseekHarnessEmbedUrl("http://127.0.0.1:3080", {
        workspaceId: "ws_abc",
        sessionId: "sess_1",
      }),
    ).toBe("http://127.0.0.1:3080/?paseoEmbed=1&sessionId=sess_1");
  });

  it("resolves DSH_HOME from env", () => {
    expect(resolveDshHome({ env: { DSH_HOME: "/tmp/custom-dsh" }, homedir: () => "/home/x" })).toBe(
      "/tmp/custom-dsh",
    );
  });

  it("resolves packaged plugin root from resourcesPath", () => {
    expect(
      resolveDshPaseoPluginRoot({
        isPackaged: true,
        resourcesPath: "/App/Contents/Resources",
        existsSync: (filePath) => filePath.endsWith("/dsh-paseo/package.json"),
      }),
    ).toBe("/App/Contents/Resources/dsh-paseo");
  });

  it("emits a host-only overlay patch", () => {
    expect(buildDshPaseoOverlayPatchYaml()).toContain("name: dsh-paseo");
    expect(buildDshPaseoOverlayPatchYaml()).not.toContain("mcp-dsh-paseo");
  });
});

describe("allocateFreePort", () => {
  it("returns a positive TCP port", async () => {
    const port = await allocateFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });
});
