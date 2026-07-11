import type { ServerDiffToolsCapability } from "@getpaseo/protocol/messages";
import { detectDifft } from "./difftastic.js";
import { resolveDifftAsset } from "./difftastic-installer.js";

// Tri-state difftastic capability for the server_info capabilities block.
// git and vscode-diff run with no external dependency, so they're always
// "available"; difftastic depends on the difft binary:
//   available   -> detected on this machine at a JSON-capable version (>= 0.51.0,
//                  enforced inside detectDifft)
//   installable -> not detected, but a pinned release asset exists for this platform
//   unavailable -> not detected and no asset to auto-install
export async function computeDiffToolsCapability(): Promise<ServerDiffToolsCapability> {
  const difft = await detectDifft();
  if (difft) {
    return {
      git: "available",
      vscode: "available",
      difftastic: "available",
      difftasticVersion: difft.version,
    };
  }
  const asset = resolveDifftAsset({ platform: process.platform, arch: process.arch });
  return {
    git: "available",
    vscode: "available",
    difftastic: asset ? "installable" : "unavailable",
  };
}
