import { describe, expect, it } from "vitest";
import {
  parseCodeServerOpenWindowInput,
  PASEO_CODE_SERVER_PARTITION,
  workspaceBasename,
} from "./code-server-window.js";

describe("code-server window", () => {
  it("derives a workspace basename for the window title", () => {
    expect(workspaceBasename("/Users/dev/projects/better-paseo/")).toBe("better-paseo");
  });

  it("parses open-window input", () => {
    expect(
      parseCodeServerOpenWindowInput({
        url: "http://127.0.0.1:19491/?folder=%2Frepo",
        cwd: "/Users/dev/repo",
      }),
    ).toEqual({
      url: "http://127.0.0.1:19491/?folder=%2Frepo",
      cwd: "/Users/dev/repo",
    });
  });

  it("rejects invalid URLs and empty cwd", () => {
    expect(() =>
      parseCodeServerOpenWindowInput({
        url: "file:///etc/passwd",
        cwd: "/repo",
      }),
    ).toThrow(/Invalid code-server window input/);
    expect(() =>
      parseCodeServerOpenWindowInput({
        url: "http://127.0.0.1:19491/",
        cwd: "",
      }),
    ).toThrow(/Invalid code-server window input/);
  });

  it("exports a dedicated session partition", () => {
    expect(PASEO_CODE_SERVER_PARTITION).toBe("persist:paseo-code-server");
  });
});
