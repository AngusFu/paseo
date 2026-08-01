/**
 * CLI-level docs VFS tests: real process + SQLite corpus + local Chroma + stub embeddings HTTP.
 * Does not require Ollama or a daemon (Chroma sidecar is spawned under the temp PASEO_HOME).
 */

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function makeDocsFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "paseo-docs-cli-"));
  const docs = join(root, "docs");
  mkdirSync(join(docs, "guides"), { recursive: true });
  writeFileSync(join(docs, "architecture.md"), "# Architecture\n\nHooks rewrite virtual docs.\n");
  writeFileSync(join(docs, "guides", "start.md"), "# Start\n\nSchedule cron heartbeats.\n");
  return docs;
}

/** Deterministic unit vector from text so search ranking is stable. */
function stubEmbedding(text: string): number[] {
  const digest = createHash("sha256").update(text).digest();
  const dims = 8;
  const values = Array.from({ length: dims }, (_, i) => digest[i]! / 255);
  const norm = Math.hypot(...values) || 1;
  return values.map((v) => v / norm);
}

async function startStubEmbeddingsServer(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server: Server = createServer((req, res) => {
    if (req.method === "POST" && (req.url === "/v1/embeddings" || req.url === "/embeddings")) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          input?: string | string[];
        };
        let inputs: string[] = [];
        if (Array.isArray(body.input)) inputs = body.input;
        else if (body.input !== undefined) inputs = [body.input];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: inputs.map((text, index) => ({
              index,
              embedding: stubEmbedding(text),
            })),
          }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("stub embeddings server failed to bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

async function runDocsCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const cliEntry = join(import.meta.dirname, "..", "..", "index.ts");
  const childEnv = { ...process.env, ...env };
  // Empty string cannot reliably clear inherited agent env on all platforms.
  if (!env.PASEO_WORKSPACE_ID) {
    delete childEnv.PASEO_WORKSPACE_ID;
  }
  return new Promise((resolve, reject) => {
    const proc = spawn("npx", ["tsx", cliEntry, "kb", ...args], {
      env: childEnv,
      cwd: join(import.meta.dirname, "..", "..", "..", ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`timed out: paseo kb ${args.join(" ")}`));
    }, 60_000);
    proc.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

describe("paseo kb CLI (chroma + stub embeddings)", () => {
  let docsRoot = "";
  let paseoHome = "";
  let baseUrl = "";
  let closeServer: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    docsRoot = makeDocsFixture();
    paseoHome = mkdtempSync(join(tmpdir(), "paseo-home-docs-cli-"));
    const stub = await startStubEmbeddingsServer();
    baseUrl = stub.baseUrl;
    closeServer = stub.close;
    writeFileSync(
      join(paseoHome, "config.json"),
      `${JSON.stringify({
        localTools: {
          embeddings: {
            enabled: true,
            baseUrl,
            model: "qwen3-embedding:0.6b",
            apiKey: "test",
          },
        },
      })}\n`,
    );
  }, 30_000);

  afterAll(async () => {
    await closeServer?.();
  });

  function env(): NodeJS.ProcessEnv {
    return {
      PASEO_HOME: paseoHome,
      // Parent agent shells often inject this; dogfood --root must not see it.
      PASEO_WORKSPACE_ID: "",
    };
  }

  it("indexes then serves ls/cat/grep/search over Chroma + SQLite corpus", async () => {
    // Every command needs the same --root: openIndexedStore keys the DB by resolved docs root.
    const withRoot = (...args: string[]) => ["--root", docsRoot, ...args];

    const index = await runDocsCli(withRoot("index", "--json"), env());
    expect(index.exitCode, index.stderr).toBe(0);
    const payload = JSON.parse(index.stdout) as {
      backend: string;
      chunkCount: number;
      dbPath: string;
      chromaPath: string;
      chromaCollection: string;
      model: string;
      rootDir: string;
    };
    expect(payload).toMatchObject({
      backend: "chroma",
      model: "qwen3-embedding:0.6b",
      rootDir: docsRoot,
    });
    expect(payload.chunkCount).toBeGreaterThan(0);
    expect(payload.dbPath).toContain("docs.sqlite");
    expect(payload.chromaPath).toContain("_chroma");
    expect(payload.chromaCollection).toMatch(/^docs_/);

    const ls = await runDocsCli(withRoot("ls", "/paseo-vfs/docs", "--json"), env());
    expect(ls.exitCode, ls.stderr).toBe(0);
    const listing = JSON.parse(ls.stdout) as {
      listings: Array<{ entries: string[] }>;
    };
    expect(listing.listings[0]?.entries).toEqual(
      expect.arrayContaining(["architecture.md", "guides/"]),
    );

    const cat = await runDocsCli(withRoot("cat", "/paseo-vfs/docs/architecture.md"), env());
    expect(cat.exitCode, cat.stderr).toBe(0);
    expect(cat.stdout).toContain("Hooks rewrite virtual docs");

    const grep = await runDocsCli(
      withRoot("grep", "-ni", "hooks", "/paseo-vfs/docs", "--json"),
      env(),
    );
    expect(grep.exitCode, grep.stderr).toBe(0);
    const grepJson = JSON.parse(grep.stdout) as {
      hits: Array<{ slug: string; text: string }>;
    };
    expect(grepJson.hits.some((hit) => hit.slug === "architecture.md")).toBe(true);

    const search = await runDocsCli(
      withRoot("search", "hooks rewrite virtual", "--limit", "2", "--json"),
      env(),
    );
    expect(search.exitCode, search.stderr).toBe(0);
    const searchJson = JSON.parse(search.stdout) as {
      results: Array<{ slug: string; score: number }>;
    };
    expect(searchJson.results.length).toBeGreaterThan(0);
    expect(searchJson.results[0]?.slug).toBe("architecture.md");
  }, 60_000);

  it("fails ls before index with a clear message", async () => {
    const emptyHome = mkdtempSync(join(tmpdir(), "paseo-home-empty-"));
    const result = await runDocsCli(["--root", docsRoot, "ls", "/paseo-vfs/docs"], {
      ...env(),
      PASEO_HOME: emptyHome,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("paseo kb index");
  }, 30_000);

  it("fails index when embeddings are disabled", async () => {
    const disabledHome = mkdtempSync(join(tmpdir(), "paseo-home-docs-cli-off-"));
    writeFileSync(
      join(disabledHome, "config.json"),
      `${JSON.stringify({
        localTools: {
          embeddings: {
            enabled: false,
            baseUrl,
            model: "qwen3-embedding:0.6b",
          },
        },
      })}\n`,
    );
    const result = await runDocsCli(["--root", docsRoot, "index"], {
      PASEO_HOME: disabledHome,
      PASEO_WORKSPACE_ID: "",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Embeddings disabled|Host settings/i);
  }, 30_000);
});
