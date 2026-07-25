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

  it("prependPathEntry drops empty segments", () => {
    expect(prependPathEntry("/usr/bin::/bin", "/opt/bin").split(delimiter)).toEqual([
      "/opt/bin",
      "/usr/bin",
      "/bin",
    ]);
  });
});
