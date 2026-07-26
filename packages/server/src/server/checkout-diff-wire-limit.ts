import type { CheckoutDiffSnapshotPayload } from "./checkout-diff-manager.js";
import { MAX_PHYSICAL_SOCKET_BUFFERED_BYTES } from "./websocket/physical-socket.js";

/** Headroom for the session envelope, ids, and compare echo outside `files`. */
const CHECKOUT_DIFF_WIRE_OVERHEAD_BYTES = 512 * 1024;

export const MAX_CHECKOUT_DIFF_WIRE_BYTES =
  MAX_PHYSICAL_SOCKET_BUFFERED_BYTES - CHECKOUT_DIFF_WIRE_OVERHEAD_BYTES;

/** Minimal compare shape used to estimate subscription payload size on the wire. */
export interface CheckoutDiffWireCompareEstimate {
  mode: "uncommitted" | "base" | "refs";
  baseRef?: string;
  fromRef?: string;
  toRef?: string;
  ignoreWhitespace?: boolean;
  tool?: string;
  gitAlgorithm?: string;
  mergeBase?: boolean;
}

export type CheckoutDiffWireSnapshot = CheckoutDiffSnapshotPayload;

type WireDiffFile = CheckoutDiffSnapshotPayload["files"][number];

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Conservative estimate of the largest checkout-diff session outbound frame. */
export function estimateCheckoutDiffOutboundBytes(
  payload: CheckoutDiffWireSnapshot,
  options?: { compare?: CheckoutDiffWireCompareEstimate },
): number {
  const envelope = {
    type: "session",
    sessionId: "x".repeat(36),
    message: {
      type: "subscribe_checkout_diff_response",
      payload: {
        subscriptionId: "x".repeat(36),
        requestId: "x".repeat(36),
        ...(options?.compare ? { compare: options.compare } : {}),
        ...payload,
      },
    },
  };
  return utf8ByteLength(JSON.stringify(envelope));
}

function deferFileHunks(file: WireDiffFile): WireDiffFile {
  if (file.status === "too_large" || file.status === "binary") {
    return { ...file, hunks: [] };
  }
  return {
    path: file.path,
    isNew: file.isNew,
    isDeleted: file.isDeleted,
    additions: file.additions,
    deletions: file.deletions,
    hunks: [],
    hunksDeferred: true,
    ...(file.status !== undefined ? { status: file.status } : {}),
    ...(file.diffTool !== undefined ? { diffTool: file.diffTool } : {}),
  };
}

/** Strip hunks from every loadable file, then trim the file list if metadata still exceeds the frame budget. */
export function prepareCheckoutDiffSnapshotForWire(
  snapshot: CheckoutDiffWireSnapshot,
  options?: { maxBytes?: number; compare?: CheckoutDiffWireCompareEstimate },
): CheckoutDiffWireSnapshot {
  const maxBytes = options?.maxBytes ?? MAX_CHECKOUT_DIFF_WIRE_BYTES;
  const totalFileCount = snapshot.files.length;
  let files = snapshot.files.map(deferFileHunks);
  const base: CheckoutDiffWireSnapshot = {
    cwd: snapshot.cwd,
    files,
    error: snapshot.error,
  };

  if (totalFileCount === 0) {
    return base;
  }

  const estimate = (nextFiles: WireDiffFile[], filesOmitted = 0) =>
    estimateCheckoutDiffOutboundBytes(
      {
        ...base,
        files: nextFiles,
        lazyHunks: true,
        totalFileCount,
        ...(filesOmitted > 0 ? { wireTruncated: true, filesOmitted } : { filesOmitted: 0 }),
      },
      options,
    );

  while (files.length > 0) {
    const filesOmitted = totalFileCount - files.length;
    if (estimate(files, filesOmitted) <= maxBytes) {
      break;
    }
    files.pop();
  }

  const filesOmitted = totalFileCount - files.length;
  if (filesOmitted === 0) {
    return {
      ...base,
      lazyHunks: true,
      totalFileCount,
      filesOmitted: 0,
    };
  }

  return {
    ...base,
    files,
    lazyHunks: true,
    wireTruncated: true,
    totalFileCount,
    filesOmitted,
  };
}
