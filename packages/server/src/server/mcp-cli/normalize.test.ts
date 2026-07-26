import { describe, expect, it } from "vitest";
import { normalizeMcpCliServerConfig, resolveMcpCliTransport } from "./normalize.js";

describe("normalizeMcpCliServerConfig", () => {
  it("defaults legacy url-only rows to http", () => {
    const next = normalizeMcpCliServerConfig({
      name: "open",
      url: "https://example.com/mcp",
      enabled: true,
    });
    expect(next).toEqual({
      name: "open",
      transport: "http",
      url: "https://example.com/mcp",
      enabled: true,
    });
    expect(resolveMcpCliTransport(next)).toBe("http");
  });

  it("normalizes stdio command rows", () => {
    const next = normalizeMcpCliServerConfig({
      name: "fs",
      command: "npx",
      args: ["-y", "foo"],
      env: { FOO: "1" },
      enabled: true,
    });
    expect(next).toEqual({
      name: "fs",
      transport: "stdio",
      command: "npx",
      args: ["-y", "foo"],
      env: { FOO: "1" },
      enabled: true,
    });
  });

  it("rejects http without url and stdio without command", () => {
    expect(() =>
      normalizeMcpCliServerConfig({ name: "x", transport: "http", enabled: true }),
    ).toThrow(/requires url/);
    expect(() =>
      normalizeMcpCliServerConfig({ name: "x", transport: "stdio", enabled: true }),
    ).toThrow(/requires command/);
  });
});
