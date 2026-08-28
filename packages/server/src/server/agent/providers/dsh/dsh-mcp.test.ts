import { describe, expect, test } from "vitest";

import { toDshMcpCordisEntries, toDshMcpCordisEntry } from "./dsh-mcp.js";

describe("toDshMcpCordisEntry", () => {
  test("maps stdio MCP servers", () => {
    expect(
      toDshMcpCordisEntry("paseo", {
        type: "stdio",
        command: "node",
        args: ["server.js"],
        env: { FOO: "bar" },
      }),
    ).toEqual({
      id: "mcp-paseo",
      name: "@deepseek-ai/dsh-mcp-client",
      config: {
        serverName: "paseo",
        transport: "stdio",
        command: "node",
        args: ["server.js"],
        env: { FOO: "bar" },
      },
    });
  });

  test("maps streamable-http MCP servers", () => {
    expect(
      toDshMcpCordisEntry("remote", {
        type: "streamable-http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer token" },
      }),
    ).toEqual({
      id: "mcp-remote",
      name: "@deepseek-ai/dsh-mcp-client",
      config: {
        serverName: "remote",
        transport: "streamable-http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer token" },
      },
    });
  });

  test("rejects invalid server names", () => {
    expect(() =>
      toDshMcpCordisEntry("bad name", {
        type: "stdio",
        command: "node",
      }),
    ).toThrow(/must match/);
  });
});

describe("toDshMcpCordisEntries", () => {
  test("returns empty array when servers are undefined", () => {
    expect(toDshMcpCordisEntries(undefined)).toEqual([]);
  });
});
