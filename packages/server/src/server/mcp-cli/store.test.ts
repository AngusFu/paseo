import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpCliServerStore } from "./store.js";

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("McpCliServerStore", () => {
  it("merges presets with stored overrides", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-mcp-cli-store-"));
    temps.push(home);
    const store = new McpCliServerStore(home);
    const listed = await store.listMerged();
    expect(listed.map((server) => server.name)).toEqual(["atlassian", "figma"]);
    expect(listed.every((server) => server.enabled === false)).toBe(true);

    await store.upsert({
      name: "atlassian",
      url: "https://mcp.atlassian.com/v1/mcp/authv2",
      enabled: true,
      auth: { kind: "oauth", clientId: "cid" },
      preset: true,
    });

    const after = await store.listMerged();
    const atlassian = after.find((server) => server.name === "atlassian");
    expect(atlassian?.enabled).toBe(true);
    expect(atlassian?.auth).toEqual({ kind: "oauth", clientId: "cid" });
    expect(await store.enabledNames()).toEqual(new Set(["atlassian"]));
  });
});
