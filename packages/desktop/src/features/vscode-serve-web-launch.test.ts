import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildServeWebArguments,
  createVSCodeNodeSafeEnvironment,
  ensureCodeServerDataDir,
  resolveCodeServerDataDir,
  resolveVSCodeServeWebLaunch,
} from "./vscode-serve-web-launch.js";

describe("createVSCodeNodeSafeEnvironment", () => {
  it("moves NODE_OPTIONS into VSCODE_NODE_OPTIONS and strips conflicting keys", () => {
    expect(
      createVSCodeNodeSafeEnvironment({
        NODE_OPTIONS: "--max-old-space-size=4096",
        NODE_REPL_EXTERNAL_MODULE: "esbuild-register",
        VSCODE_NODE_OPTIONS: "stale",
      }),
    ).toEqual({
      VSCODE_NODE_OPTIONS: "--max-old-space-size=4096",
      VSCODE_NODE_REPL_EXTERNAL_MODULE: "esbuild-register",
    });
  });
});

describe("resolveVSCodeServeWebLaunch", () => {
  it("prefers the cached code-server binary from VS Code serve-web LRU cache", () => {
    const launch = resolveVSCodeServeWebLaunch({
      platform: "darwin",
      homeDirectory: "/Users/tester",
      env: { HOME: "/Users/tester" },
      pathExists: (targetPath) =>
        targetPath === "/Applications/Visual Studio Code.app" ||
        targetPath === "/Applications/Visual Studio Code.app/Contents/Resources/app" ||
        targetPath === "/Users/tester/.vscode/cli/serve-web/cache-a/bin/code-server" ||
        targetPath === "/Users/tester/.vscode/cli/serve-web/lru.json",
      readFile: (targetPath) => {
        if (targetPath.endsWith("product.json")) {
          return JSON.stringify({ dataFolderName: ".vscode" });
        }
        if (targetPath.endsWith("lru.json")) {
          return JSON.stringify(["cache-a", "cache-b"]);
        }
        return null;
      },
      readDir: () => [],
    });

    expect(launch?.executable).toBe("/Users/tester/.vscode/cli/serve-web/cache-a/bin/code-server");
    expect(launch?.usesServeWebSubcommand).toBe(false);
    expect(launch?.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it("falls back to code-tunnel with ELECTRON_RUN_AS_NODE when no cache exists", () => {
    const tunnelPath =
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code-tunnel";
    const launch = resolveVSCodeServeWebLaunch({
      platform: "darwin",
      homeDirectory: "/Users/tester",
      env: { HOME: "/Users/tester", NODE_OPTIONS: "--trace-warnings" },
      pathExists: (targetPath) =>
        targetPath === "/Applications/Visual Studio Code.app" ||
        targetPath === "/Applications/Visual Studio Code.app/Contents/Resources/app" ||
        targetPath === tunnelPath,
      readFile: (targetPath) =>
        targetPath.endsWith("product.json") ? JSON.stringify({ dataFolderName: ".vscode" }) : null,
      readDir: () => [],
    });

    expect(launch).toEqual({
      executable: tunnelPath,
      usesServeWebSubcommand: true,
      env: {
        HOME: "/Users/tester",
        ELECTRON_RUN_AS_NODE: "1",
        VSCODE_NODE_OPTIONS: "--trace-warnings",
      },
    });
  });

  it("builds serve-web args with and without the serve-web subcommand", () => {
    const serverDataDir = "/tmp/paseo-code-server-data";
    expect(
      buildServeWebArguments({
        launch: {
          executable: "/tmp/code-tunnel",
          usesServeWebSubcommand: true,
          env: {},
        },
        host: "127.0.0.1",
        port: 19490,
        serverDataDir,
      }),
    ).toEqual([
      "serve-web",
      "--server-data-dir",
      serverDataDir,
      "--host",
      "127.0.0.1",
      "--port",
      "19490",
      "--without-connection-token",
      "--accept-server-license-terms",
    ]);

    expect(
      buildServeWebArguments({
        launch: {
          executable: "/tmp/code-server",
          usesServeWebSubcommand: false,
          env: {},
        },
        host: "127.0.0.1",
        port: 19490,
        serverDataDir,
      }),
    ).toEqual([
      "--server-data-dir",
      serverDataDir,
      "--disable-workspace-trust",
      "--host",
      "127.0.0.1",
      "--port",
      "19490",
      "--without-connection-token",
      "--accept-server-license-terms",
    ]);
  });

  it("seeds workspace trust defaults into the Paseo code-server data dir", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "paseo-code-server-"));
    ensureCodeServerDataDir(dataDir);
    const settings = JSON.parse(readFileSync(path.join(dataDir, "User/settings.json"), "utf8")) as {
      "security.workspace.trust.enabled"?: boolean;
      "security.workspace.trust.startupPrompt"?: string;
    };
    expect(settings["security.workspace.trust.enabled"]).toBe(false);
    expect(settings["security.workspace.trust.startupPrompt"]).toBe("never");
  });

  it("resolves the code-server data dir under PASEO_HOME", () => {
    expect(resolveCodeServerDataDir({ PASEO_HOME: "/tmp/paseo" })).toBe(
      "/tmp/paseo/code-server-data",
    );
  });
});
