import { describe, expect, test } from "vitest";

import { toDshMcpCordisEntry } from "./mcp.js";

describe("ACP MCP to DSH Cordis", () => {
  test("maps stdio servers and environment variables", () => {
    expect(
      toDshMcpCordisEntry({
        type: "stdio",
        name: "local",
        command: "node",
        args: ["server.js"],
        env: [{ name: "TOKEN", value: "secret" }],
      }),
    ).toEqual({
      id: "mcp-local",
      name: "@deepseek-ai/dsh-mcp-client",
      config: {
        serverName: "local",
        transport: "stdio",
        command: "node",
        args: ["server.js"],
        env: { TOKEN: "secret" },
      },
    });
  });

  test("maps Paseo HTTP servers and authorization headers", () => {
    expect(
      toDshMcpCordisEntry({
        type: "http",
        name: "paseo",
        url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
        headers: [{ name: "Authorization", value: "Bearer token" }],
      }),
    ).toEqual({
      id: "mcp-paseo",
      name: "@deepseek-ai/dsh-mcp-client",
      config: {
        serverName: "paseo",
        transport: "streamable-http",
        url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
        headers: { Authorization: "Bearer token" },
      },
    });
  });
});
