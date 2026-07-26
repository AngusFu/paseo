import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import { prependMcpCliBinPath, prependPathEntry } from "./path.js";
import { mcpCliBinDir } from "./paths.js";

describe("prependMcpCliBinPath", () => {
  it("puts $PASEO_HOME/mcp-cli/bin first without duplicating", () => {
    const home = "/tmp/paseo-home-mcp-cli";
    const bin = mcpCliBinDir(home);
    const once = prependMcpCliBinPath({ PATH: ["/usr/bin", "/bin"].join(delimiter) }, home);
    expect(once.PATH?.split(delimiter)[0]).toBe(bin);
    const twice = prependMcpCliBinPath(once, home);
    expect(twice.PATH?.split(delimiter).filter((entry) => entry === bin)).toHaveLength(1);
  });

  it("inherits process PATH when the overlay has none", () => {
    const home = "/tmp/paseo-home-mcp-cli";
    const bin = mcpCliBinDir(home);
    const previous = process.env.PATH;
    process.env.PATH = ["/usr/local/bin", "/usr/bin"].join(delimiter);
    try {
      const next = prependMcpCliBinPath({ PASEO_AGENT_ID: "agent-1" }, home);
      expect(next.PATH?.split(delimiter)[0]).toBe(bin);
      expect(next.PATH).toContain("/usr/local/bin");
      expect(next.PATH).toContain("/usr/bin");
      expect(next.PASEO_AGENT_ID).toBe("agent-1");
    } finally {
      if (previous === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previous;
      }
    }
  });

  it("prependPathEntry drops empty segments", () => {
    expect(prependPathEntry("/usr/bin::/bin", "/opt/bin").split(delimiter)).toEqual([
      "/opt/bin",
      "/usr/bin",
      "/bin",
    ]);
  });
});
