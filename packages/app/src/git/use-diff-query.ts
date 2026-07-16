import { useMemo } from "react";
import { useReplicaQuery } from "@/data/query";
import { checkoutDiffPushRoute } from "@/data/push-router";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { ParsedDiffFile, SubscribeCheckoutDiffResponse } from "@getpaseo/protocol/messages";
import { checkoutDiffQueryKey } from "@/git/query-keys";

export type DiffToolId = "git" | "vscode" | "difftastic";
export type GitDiffAlgorithm = "histogram" | "myers" | "patience";

interface UseCheckoutDiffQueryOptions {
  serverId: string;
  cwd: string;
  mode: "uncommitted" | "base" | "refs";
  baseRef?: string;
  ignoreWhitespace?: boolean;
  // Diff engine selection; see CheckoutDiffCompareSchema in @getpaseo/protocol.
  tool?: DiffToolId;
  gitAlgorithm?: GitDiffAlgorithm;
  // Only used when mode is "refs" — arbitrary branch/ref compare (see diff-pane's branch picker).
  fromRef?: string;
  toRef?: string;
  mergeBase?: boolean;
  enabled?: boolean;
}

type CheckoutDiffQueryPayload = Omit<SubscribeCheckoutDiffResponse["payload"], "subscriptionId">;

// Re-export the canonical protocol type so all consumers share one definition.
export type { ParsedDiffFile };
export type DiffHunk = ParsedDiffFile["hunks"][number];
export type DiffLine = DiffHunk["lines"][number];
export type HighlightToken = NonNullable<DiffLine["tokens"]>[number];

interface NormalizedCheckoutDiffCompare {
  mode: "uncommitted" | "base" | "refs";
  baseRef?: string;
  ignoreWhitespace: boolean;
  tool?: DiffToolId;
  gitAlgorithm?: GitDiffAlgorithm;
  fromRef?: string;
  toRef?: string;
  mergeBase?: boolean;
}

function normalizeCheckoutDiffCompare(compare: {
  mode: "uncommitted" | "base" | "refs";
  baseRef?: string;
  ignoreWhitespace?: boolean;
  tool?: DiffToolId;
  gitAlgorithm?: GitDiffAlgorithm;
  fromRef?: string;
  toRef?: string;
  mergeBase?: boolean;
}): NormalizedCheckoutDiffCompare {
  const ignoreWhitespace = compare.ignoreWhitespace === true;
  // Engine selection is orthogonal to compare mode, so it's threaded through unconditionally;
  // "git" is the implicit default and is left unset on the wire (server does the same).
  const engine = {
    ...(compare.tool && compare.tool !== "git" ? { tool: compare.tool } : {}),
    ...(compare.tool === "git" && compare.gitAlgorithm
      ? { gitAlgorithm: compare.gitAlgorithm }
      : {}),
  };
  if (compare.mode === "uncommitted") {
    return { mode: "uncommitted", ignoreWhitespace, ...engine };
  }
  if (compare.mode === "refs") {
    const trimmedFromRef = compare.fromRef?.trim();
    const trimmedToRef = compare.toRef?.trim();
    return {
      mode: "refs",
      ignoreWhitespace,
      ...(trimmedFromRef ? { fromRef: trimmedFromRef } : {}),
      ...(trimmedToRef ? { toRef: trimmedToRef } : {}),
      mergeBase: compare.mergeBase !== false,
      ...engine,
    };
  }
  const trimmedBaseRef = compare.baseRef?.trim();
  return trimmedBaseRef
    ? { mode: "base", baseRef: trimmedBaseRef, ignoreWhitespace, ...engine }
    : { mode: "base", ignoreWhitespace, ...engine };
}

export function useCheckoutDiffQuery({
  serverId,
  cwd,
  mode,
  baseRef,
  ignoreWhitespace,
  tool,
  gitAlgorithm,
  fromRef,
  toRef,
  mergeBase,
  enabled = true,
}: UseCheckoutDiffQueryOptions) {
  const isConnected = useHostRuntimeIsConnected(serverId);
  const normalizedCompare = useMemo(
    () =>
      normalizeCheckoutDiffCompare({
        mode,
        baseRef,
        ignoreWhitespace,
        tool,
        gitAlgorithm,
        fromRef,
        toRef,
        mergeBase,
      }),
    [mode, baseRef, ignoreWhitespace, tool, gitAlgorithm, fromRef, toRef, mergeBase],
  );
  const compareMode = normalizedCompare.mode;
  const compareBaseRef = normalizedCompare.baseRef;
  const compareIgnoreWhitespace = normalizedCompare.ignoreWhitespace;
  const compareTool = normalizedCompare.tool;
  const compareGitAlgorithm = normalizedCompare.gitAlgorithm;
  const compareFromRef = normalizedCompare.fromRef;
  const compareToRef = normalizedCompare.toRef;
  const compareMergeBase = normalizedCompare.mergeBase;
  const queryKey = useMemo(
    () =>
      checkoutDiffQueryKey(
        serverId,
        cwd,
        compareMode,
        compareBaseRef,
        compareIgnoreWhitespace,
        compareTool,
        compareGitAlgorithm,
        compareFromRef,
        compareToRef,
        compareMergeBase,
      ),
    [
      serverId,
      cwd,
      compareMode,
      compareBaseRef,
      compareIgnoreWhitespace,
      compareTool,
      compareGitAlgorithm,
      compareFromRef,
      compareToRef,
      compareMergeBase,
    ],
  );
  const subscriptionId = useMemo(() => `checkoutDiff:${JSON.stringify(queryKey)}`, [queryKey]);
  const routeEnabled = Boolean(enabled && isConnected && cwd);

  const query = useReplicaQuery<CheckoutDiffQueryPayload>({
    queryKey,
    enabled: routeEnabled,
    pushEvent: "checkout_diff_update",
    meta: checkoutDiffPushRoute({
      enabled: routeEnabled,
      serverId,
      subscriptionId,
      cwd,
      compare: {
        mode: compareMode,
        ...(compareBaseRef ? { baseRef: compareBaseRef } : {}),
        ignoreWhitespace: compareIgnoreWhitespace,
        ...(compareTool ? { tool: compareTool } : {}),
        ...(compareGitAlgorithm ? { gitAlgorithm: compareGitAlgorithm } : {}),
        ...(compareFromRef ? { fromRef: compareFromRef } : {}),
        ...(compareToRef ? { toRef: compareToRef } : {}),
        ...(compareMergeBase !== undefined ? { mergeBase: compareMergeBase } : {}),
      },
    }),
  });

  const payload = query.data ?? null;
  const payloadError = payload?.error ?? null;

  return {
    files: payload?.files ?? [],
    payloadError,
    isLoading: payload === null && enabled && isConnected,
    isFetching: false,
    isError: Boolean(payloadError),
    error: null,
  };
}
