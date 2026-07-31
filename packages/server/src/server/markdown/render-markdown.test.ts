import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRenderMarkdownArgv,
  preferUnpackedAsarPath,
  renderMarkdown,
  resolveMarkdownRenderScript,
  resolveUvBinary,
} from "./render-markdown.js";

describe("render-markdown", () => {
  it("resolves the cli-bundled render.py", () => {
    const script = resolveMarkdownRenderScript();
    expect(script.endsWith("/tools/markdown/render.py")).toBe(true);
    expect(existsSync(script)).toBe(true);
  });

  it("leaves asar paths alone when no unpacked twin exists", () => {
    expect(preferUnpackedAsarPath("/App/Resources/app.asar/tools/markdown/render.py")).toBe(
      "/App/Resources/app.asar/tools/markdown/render.py",
    );
  });

  it("builds argv for render / clear / no-cache", () => {
    expect(
      buildRenderMarkdownArgv({
        path: "/tmp/a.md",
        open: false,
        noCache: true,
        template: "plan",
      }),
    ).toEqual(["--no-cache", "--template", "plan", "--print", "/tmp/a.md"]);

    expect(buildRenderMarkdownArgv({ clearAll: true })).toEqual(["--clear-all"]);
    expect(buildRenderMarkdownArgv({ path: "/tmp/a.md", clear: true })).toEqual([
      "--clear",
      "/tmp/a.md",
    ]);
  });

  it("renders a real markdown file through uv when available", async () => {
    let uv: string;
    try {
      uv = resolveUvBinary();
    } catch {
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), "paseo-render-md-"));
    const md = join(dir, "note.md");
    writeFileSync(md, "# Hello\n\nbody\n");

    const result = await renderMarkdown({ path: md, open: false, noCache: true });
    expect(result.opened).toBe(false);
    expect(result.htmlPath).toMatch(/\.html$/);
    expect(existsSync(result.htmlPath!)).toBe(true);
    expect(uv.length).toBeGreaterThan(0);
  }, 60_000);
});
