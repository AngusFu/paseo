import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import {
  buildMarkdownArgv,
  createMarkdownCommand,
  preferUnpackedAsarPath,
  resolveMarkdownRenderScript,
  resolveUvBinary,
  wantsNoCache,
} from "./markdown.js";

describe("paseo markdown", () => {
  it("resolves the bundled render.py next to the CLI package", () => {
    const script = resolveMarkdownRenderScript();
    expect(script.endsWith("/tools/markdown/render.py")).toBe(true);
    expect(existsSync(script)).toBe(true);
  });

  it("leaves asar paths alone when no unpacked twin exists", () => {
    expect(preferUnpackedAsarPath("/App/Resources/app.asar/tools/markdown/render.py")).toBe(
      "/App/Resources/app.asar/tools/markdown/render.py",
    );
  });

  it("forwards CLI flags to the python renderer", () => {
    expect(
      buildMarkdownArgv("notes.md", {
        template: "plan",
        out: "/tmp/x.html",
        stdout: true,
        print: true,
        backlink: "/",
      }),
    ).toEqual([
      "--template",
      "plan",
      "--out",
      "/tmp/x.html",
      "--stdout",
      "--print",
      "--backlink",
      "/",
      "notes.md",
    ]);
  });

  it("supports serve mode without an md path", () => {
    expect(buildMarkdownArgv(undefined, { serve: true, port: "4501" })).toEqual([
      "--serve",
      "--port",
      "4501",
    ]);
  });

  it("forwards cache control flags", () => {
    expect(buildMarkdownArgv("notes.md", { noCache: true, clear: true })).toEqual([
      "--clear",
      "--no-cache",
      "notes.md",
    ]);
    // Commander parses CLI `--no-cache` as `{ cache: false }`.
    expect(wantsNoCache({ cache: false })).toBe(true);
    expect(buildMarkdownArgv("notes.md", { cache: false })).toEqual(["--no-cache", "notes.md"]);
    expect(buildMarkdownArgv(undefined, { clearAll: true, cacheDir: true, lsCache: true })).toEqual(
      ["--cache-dir", "--ls-cache", "--clear-all"],
    );
  });

  it("resolves uv from PATH or common install locations", () => {
    const uv = resolveUvBinary({
      which: () => "/tmp/fake-uv",
      existsSync: () => false,
      env: {},
    });
    expect(uv).toBe("/tmp/fake-uv");
  });

  it("errors with an install hint when uv is missing", () => {
    expect(() =>
      resolveUvBinary({
        which: () => undefined,
        existsSync: () => false,
        env: { HOME: "/no-such-home" },
      }),
    ).toThrow(/requires uv/);
  });

  it("shows help for `markdown help` and bare `markdown`", async () => {
    for (const argv of [["help"], []]) {
      const command = createMarkdownCommand().exitOverride();
      let help = "";
      command.configureOutput({
        writeOut: (str) => {
          help += str;
        },
        writeErr: (str) => {
          help += str;
        },
      });
      await command.parseAsync(argv, { from: "user" });
      expect(help).toContain("Usage: markdown");
      expect(help).toContain("--clear-all");
      expect(help).toContain("paseo markdown notes.md --no-cache");
    }
  });
});
