import { describe, expect, it } from "vitest";
import { escapeFixedString, parseGrepArgv } from "./unix-args.js";

describe("parseGrepArgv", () => {
  it("parses clustered short flags like grep -ri", () => {
    expect(parseGrepArgv(["-ri", "hooks", "/paseo-vfs/docs"])).toEqual({
      pattern: "hooks",
      paths: ["/paseo-vfs/docs"],
      ignoreCase: true,
      lineNumber: false,
      recursive: true,
      fixedStrings: false,
    });
  });

  it("parses -n and fixed strings", () => {
    expect(parseGrepArgv(["-nF", "a.b", "architecture.md"])).toEqual({
      pattern: "a.b",
      paths: ["architecture.md"],
      ignoreCase: false,
      lineNumber: true,
      recursive: false,
      fixedStrings: true,
    });
    expect(escapeFixedString("a.b")).toBe("a\\.b");
  });
});
