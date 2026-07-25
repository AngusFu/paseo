import { describe, expect, it } from "vitest";
import { formatMcpCliDaemonAppendPrompt, stripMcpServersMatchingCliNames } from "./prompt.js";

describe("formatMcpCliDaemonAppendPrompt", () => {
  it("returns empty when nothing enabled", () => {
    expect(
      formatMcpCliDaemonAppendPrompt([
        {
          name: "atlassian",
          url: "https://example.com",
          enabled: false,
          preset: true,
        },
      ]),
    ).toBe("");
  });

  it("lists enabled CLIs with usage examples", () => {
    const text = formatMcpCliDaemonAppendPrompt([
      {
        name: "atlassian",
        url: "https://mcp.atlassian.com/v1/mcp/authv2",
        enabled: true,
        preset: true,
      },
      {
        name: "figma",
        url: "https://mcp.figma.com/mcp",
        enabled: true,
        preset: true,
      },
    ]);
    expect(text).toContain("atlassian");
    expect(text).toContain("figma");
    expect(text).toContain("getJiraIssue");
    expect(text).toContain("--list");
    expect(text).toContain("mcp_cli_import_local");
  });
});

describe("stripMcpServersMatchingCliNames", () => {
  it("removes only colliding keys and leaves others", () => {
    const next = stripMcpServersMatchingCliNames(
      {
        atlassian: { url: "https://a" },
        other: { url: "https://b" },
      },
      new Set(["atlassian"]),
    );
    expect(next).toEqual({ other: { url: "https://b" } });
  });

  it("returns undefined when all keys stripped", () => {
    expect(
      stripMcpServersMatchingCliNames({ atlassian: { url: "https://a" } }, new Set(["atlassian"])),
    ).toBeUndefined();
  });

  it("is a no-op when names do not collide", () => {
    const servers = { custom: { url: "https://c" } };
    expect(stripMcpServersMatchingCliNames(servers, new Set(["atlassian"]))).toBe(servers);
  });
});
