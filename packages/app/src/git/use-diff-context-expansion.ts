import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import {
  applyLoadedDiffContext,
  buildDiffContextFileKey,
  EMPTY_DIFF_FILE_CONTEXT_STATE,
  type DiffContextDirection,
  type DiffContextGap,
  type DiffFileContextState,
} from "@/git/diff-context-ranges";
import type { ParsedDiffFile } from "@/git/use-diff-query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";

/** The comparison the context has to be read from — the same one the diff was computed with. */
export interface DiffContextCompare {
  mode: "uncommitted" | "base" | "refs";
  baseRef?: string;
  fromRef?: string;
  toRef?: string;
  mergeBase?: boolean;
}

export interface DiffContextExpansionController {
  /** Loaded context per file, keyed by `buildDiffContextFileKey`. */
  statesByFileKey: ReadonlyMap<string, DiffFileContextState>;
  /** `${fileKey}:${gapId}` for every gap with a request in flight. */
  pendingKeys: ReadonlySet<string>;
  expand: (input: {
    file: ParsedDiffFile;
    gap: DiffContextGap;
    direction: DiffContextDirection;
  }) => void;
}

function rangeFor(gap: DiffContextGap, direction: DiffContextDirection) {
  if (direction === "up") {
    return gap.expandUp;
  }
  if (direction === "down") {
    return gap.expandDown;
  }
  return gap.expandAll;
}

/**
 * Context expansion for one diff surface.
 *
 * Returns null when the daemon can't serve `checkout.diff.context` — the caller
 * then renders no expanders at all, rather than a control that would fail.
 *
 * Everything loaded is dropped when the comparison changes, and each file's
 * state is keyed by its hunk geometry, so a diff that moved underneath (a new
 * commit, a switch between uncommitted and base) can't show context that no
 * longer lines up with the lines around it.
 */
export function useDiffContextExpansion(input: {
  serverId: string;
  cwd: string;
  compare: DiffContextCompare;
  enabled: boolean;
}): DiffContextExpansionController | null {
  const { serverId, cwd, compare, enabled } = input;
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const supported = useHostFeature(serverId, "diffContextExpand");

  const [statesByFileKey, setStatesByFileKey] = useState<ReadonlyMap<string, DiffFileContextState>>(
    () => new Map(),
  );
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());

  const scopeKey = useMemo(
    () => JSON.stringify({ serverId, cwd, compare }),
    [compare, cwd, serverId],
  );
  // Bumped with the scope so a response that outlived its comparison is dropped
  // instead of landing on top of a different diff.
  const scopeRef = useRef(scopeKey);
  useEffect(() => {
    scopeRef.current = scopeKey;
    setStatesByFileKey(new Map());
    setPendingKeys(new Set());
  }, [scopeKey]);

  const expand = useCallback(
    ({
      file,
      gap,
      direction,
    }: {
      file: ParsedDiffFile;
      gap: DiffContextGap;
      direction: DiffContextDirection;
    }) => {
      const range = rangeFor(gap, direction);
      if (!range || !client) {
        return;
      }
      const fileKey = buildDiffContextFileKey(file);
      const pendingKey = `${fileKey}:${gap.id}`;
      const requestScope = scopeRef.current;
      let alreadyPending = false;
      setPendingKeys((previous) => {
        if (previous.has(pendingKey)) {
          alreadyPending = true;
          return previous;
        }
        return new Set(previous).add(pendingKey);
      });
      if (alreadyPending) {
        return;
      }

      void (async () => {
        try {
          const result = await client.readDiffContext({
            cwd,
            path: file.path,
            compare,
            startLine: range.startLine,
            endLine: range.endLine,
          });
          if (scopeRef.current !== requestScope) {
            return;
          }
          if (result.error) {
            toast.error(result.error.message);
            return;
          }
          setStatesByFileKey((previous) => {
            const next = new Map(previous);
            next.set(
              fileKey,
              applyLoadedDiffContext({
                state: previous.get(fileKey) ?? EMPTY_DIFF_FILE_CONTEXT_STATE,
                gap,
                direction,
                response: result,
              }),
            );
            return next;
          });
        } catch (error) {
          toast.error(
            error instanceof Error ? error.message : t("workspace.git.diff.contextExpandFailed"),
          );
        } finally {
          setPendingKeys((previous) => {
            if (!previous.has(pendingKey)) {
              return previous;
            }
            const next = new Set(previous);
            next.delete(pendingKey);
            return next;
          });
        }
      })();
    },
    [client, compare, cwd, t, toast],
  );

  return useMemo(
    () => (enabled && supported && client ? { statesByFileKey, pendingKeys, expand } : null),
    [client, enabled, expand, pendingKeys, statesByFileKey, supported],
  );
}
