/**
 * Runtime probes for node:sqlite — host Node always; Electron when present.
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function resolveElectronBinary(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const electronRoot = join(require.resolve("electron/package.json"), "..");
    if (process.platform === "darwin") {
      const mac = join(electronRoot, "dist", "Electron.app", "Contents", "MacOS", "Electron");
      return existsSync(mac) ? mac : null;
    }
    const bin = join(electronRoot, "dist", "electron");
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

describe("node:sqlite runtime", () => {
  it("works on the host Node used for CLI tests", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t(x INTEGER)");
    db.prepare("INSERT INTO t VALUES (?)").run(42);
    expect(db.prepare("SELECT x FROM t").get()).toEqual({ x: 42 });
    db.close();
  });

  it("works under Electron ELECTRON_RUN_AS_NODE when Electron is installed", () => {
    const electronBin = resolveElectronBinary();
    if (!electronBin) {
      // Desktop dependency may be absent in a CLI-only checkout.
      return;
    }
    const script =
      'const {DatabaseSync}=require("node:sqlite");' +
      'const db=new DatabaseSync(":memory:");' +
      'db.exec("CREATE TABLE t(x)");' +
      'db.prepare("INSERT INTO t VALUES (?)").run(1);' +
      'const row=db.prepare("SELECT x FROM t").get();' +
      "if (!row || row.x !== 1) process.exit(2);" +
      'process.stdout.write("ok "+process.versions.node);';
    const result = spawnSync(electronBin, ["-e", script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toMatch(/^ok 24\./);
  });
});
