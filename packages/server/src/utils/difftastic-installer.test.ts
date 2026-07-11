import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  DifftInstallError,
  DifftUnavailableError,
  installDifft,
  resolveDifftAsset,
  uninstallDifft,
  isDifftInstalled,
  __setDifftAssetSha256ForTests,
  __resetDifftAssetSha256ForTests,
} from "./difftastic-installer.js";

function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "paseo-difft-installer-"));
}

/** Builds a tiny tar.gz fixture containing a "difft" (or "difft.exe") stub script/exe. */
function buildFixtureArchive(
  dir: string,
  binaryName: string,
): { archivePath: string; sha256: string } {
  const stageDir = path.join(dir, "stage");
  mkdirSync(stageDir, { recursive: true });
  const binaryPath = path.join(stageDir, binaryName);
  writeFileSync(binaryPath, '#!/bin/sh\necho "Difftastic 0.69.0"\n');
  chmodSync(binaryPath, 0o755);

  const archivePath = path.join(dir, "fixture.tar.gz");
  execFileSync("tar", ["-czf", archivePath, "-C", stageDir, binaryName]);

  const sha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  return { archivePath, sha256 };
}

function fakeFetchFromFile(archivePath: string): typeof fetch {
  return (async () => {
    const bytes = readFileSync(archivePath);
    return new Response(bytes, { status: 200 });
  }) as unknown as typeof fetch;
}

describe("resolveDifftAsset", () => {
  test("maps darwin arm64", () => {
    expect(resolveDifftAsset({ platform: "darwin", arch: "arm64" })).toEqual({
      name: "difft-aarch64-apple-darwin.tar.gz",
      kind: "tar.gz",
    });
  });

  test("maps darwin x64", () => {
    expect(resolveDifftAsset({ platform: "darwin", arch: "x64" })).toEqual({
      name: "difft-x86_64-apple-darwin.tar.gz",
      kind: "tar.gz",
    });
  });

  test("maps linux x64 gnu (default libc)", () => {
    expect(resolveDifftAsset({ platform: "linux", arch: "x64" })).toEqual({
      name: "difft-x86_64-unknown-linux-gnu.tar.gz",
      kind: "tar.gz",
    });
  });

  test("maps linux arm64 gnu", () => {
    expect(resolveDifftAsset({ platform: "linux", arch: "arm64" })).toEqual({
      name: "difft-aarch64-unknown-linux-gnu.tar.gz",
      kind: "tar.gz",
    });
  });

  test("maps linux x64 musl when explicitly requested", () => {
    expect(resolveDifftAsset({ platform: "linux", arch: "x64", libc: "musl" })).toEqual({
      name: "difft-x86_64-unknown-linux-musl.tar.gz",
      kind: "tar.gz",
    });
  });

  test("linux arm64 musl is unsupported (no published asset)", () => {
    expect(resolveDifftAsset({ platform: "linux", arch: "arm64", libc: "musl" })).toBeNull();
  });

  test("maps win32 x64 and arm64 to zip assets", () => {
    expect(resolveDifftAsset({ platform: "win32", arch: "x64" })).toEqual({
      name: "difft-x86_64-pc-windows-msvc.zip",
      kind: "zip",
    });
    expect(resolveDifftAsset({ platform: "win32", arch: "arm64" })).toEqual({
      name: "difft-aarch64-pc-windows-msvc.zip",
      kind: "zip",
    });
  });

  test("unsupported platform returns null", () => {
    expect(resolveDifftAsset({ platform: "sunos" as NodeJS.Platform, arch: "x64" })).toBeNull();
    expect(resolveDifftAsset({ platform: "darwin", arch: "ia32" })).toBeNull();
  });
});

describe("installDifft", () => {
  const dirs: string[] = [];

  afterEach(() => {
    __resetDifftAssetSha256ForTests();
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  test("throws DifftUnavailableError for an unsupported platform, before touching the network", async () => {
    const paseoHome = makeTmpDir();
    dirs.push(paseoHome);

    await expect(
      installDifft({
        paseoHome,
        platform: "sunos" as NodeJS.Platform,
        arch: "x64",
        fetchImpl: (async () => {
          throw new Error("must not be called for unsupported platforms");
        }) as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(DifftUnavailableError);
  });

  test("rejects and never installs when the download's sha256 does not match the pinned digest", async () => {
    const workspace = makeTmpDir();
    dirs.push(workspace);
    const paseoHome = makeTmpDir();
    dirs.push(paseoHome);

    const { archivePath } = buildFixtureArchive(workspace, "difft");
    // Deliberately do NOT register the fixture's real sha256, so the pinned (real
    // release) digest for this asset name is used and will not match the fixture bytes.

    let caught: unknown;
    try {
      await installDifft({
        paseoHome,
        platform: "darwin",
        arch: "arm64",
        fetchImpl: fakeFetchFromFile(archivePath),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DifftInstallError);
    expect((caught as DifftInstallError).phase).toBe("verifying");
    expect(existsSync(path.join(paseoHome, "bin", "difft"))).toBe(false);
  });

  test("happy path: downloads, verifies, extracts, installs, and validates the binary", async () => {
    const workspace = makeTmpDir();
    dirs.push(workspace);
    const paseoHome = makeTmpDir();
    dirs.push(paseoHome);

    const { archivePath, sha256 } = buildFixtureArchive(workspace, "difft");
    __setDifftAssetSha256ForTests("difft-aarch64-apple-darwin.tar.gz", sha256);

    const progressPhases: string[] = [];
    const onInstalled = vi.fn();

    const result = await installDifft({
      paseoHome,
      platform: "darwin",
      arch: "arm64",
      fetchImpl: fakeFetchFromFile(archivePath),
      onProgress: (phase) => progressPhases.push(phase),
      onInstalled,
    });

    expect(result.path).toBe(path.join(paseoHome, "bin", "difft"));
    expect(result.version).toBe("0.69.0");
    expect(existsSync(result.path)).toBe(true);
    expect(progressPhases).toEqual([
      "resolving",
      "downloading",
      "verifying",
      "extracting",
      "validating",
    ]);
    expect(onInstalled).toHaveBeenCalledWith(result);
    expect(await isDifftInstalled({ paseoHome, platform: "darwin" })).toBe(true);

    await uninstallDifft({ paseoHome, platform: "darwin" });
    expect(existsSync(result.path)).toBe(false);
    expect(await isDifftInstalled({ paseoHome, platform: "darwin" })).toBe(false);
  });

  test("uninstallDifft is a no-op when nothing was installed", async () => {
    const paseoHome = makeTmpDir();
    dirs.push(paseoHome);
    await expect(uninstallDifft({ paseoHome, platform: "darwin" })).resolves.toBeUndefined();
  });
});
