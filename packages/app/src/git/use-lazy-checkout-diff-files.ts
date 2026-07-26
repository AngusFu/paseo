import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import type { ParsedDiffFile } from "@/git/use-diff-query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import type { CheckoutDiffCompare } from "@getpaseo/client/internal/daemon-client";

const MAX_CONCURRENT_FILE_LOADS = 4;

export interface LazyCheckoutDiffLoadOptions {
  /** Attempt to load a file marked `too_large` (never auto-scheduled). */
  manual?: boolean;
}

interface QueuedLoad {
  path: string;
  manual: boolean;
}

export interface LazyCheckoutDiffFilesController {
  files: ParsedDiffFile[];
  loadFile: (path: string, options?: LazyCheckoutDiffLoadOptions) => void;
  retryFile: (path: string, options?: LazyCheckoutDiffLoadOptions) => void;
  scheduleLoadsForPaths: (paths: readonly string[]) => void;
  isFileLoading: (path: string) => boolean;
  isFileLoadFailed: (path: string) => boolean;
  isFileLoadAttempted: (path: string) => boolean;
  lazyFilesSupported: boolean;
}

function canAutoLoad(file: ParsedDiffFile): boolean {
  return file.hunksDeferred === true && file.status !== "too_large" && file.status !== "binary";
}

function canManualLoad(file: ParsedDiffFile): boolean {
  return file.status === "too_large";
}

export function useLazyCheckoutDiffFiles(input: {
  serverId: string;
  cwd: string;
  compare: CheckoutDiffCompare;
  files: ParsedDiffFile[];
  enabled: boolean;
}): LazyCheckoutDiffFilesController {
  const { serverId, cwd, compare, files, enabled } = input;
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const supported = useHostFeature(serverId, "checkoutDiffLazyFile");

  const [loadedByPath, setLoadedByPath] = useState<ReadonlyMap<string, ParsedDiffFile>>(
    () => new Map(),
  );
  const [pendingPaths, setPendingPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [failedPaths, setFailedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [attemptedPaths, setAttemptedPaths] = useState<ReadonlySet<string>>(() => new Set());

  const filesRef = useRef(files);
  filesRef.current = files;
  const loadedByPathRef = useRef(loadedByPath);
  loadedByPathRef.current = loadedByPath;
  const queueRef = useRef<QueuedLoad[]>([]);
  const inFlightRef = useRef(0);
  const pumpQueueRef = useRef<() => void>(() => {});

  const scopeKey = useMemo(
    () => JSON.stringify({ serverId, cwd, compare }),
    [compare, cwd, serverId],
  );
  const scopeRef = useRef(scopeKey);
  useEffect(() => {
    scopeRef.current = scopeKey;
    setLoadedByPath(new Map());
    setPendingPaths(new Set());
    setFailedPaths(new Set());
    setAttemptedPaths(new Set());
    queueRef.current = [];
    inFlightRef.current = 0;
  }, [scopeKey]);

  const runLoad = useCallback(
    async (path: string, _manual: boolean) => {
      if (!client) {
        return;
      }
      const requestScope = scopeRef.current;
      try {
        const result = await client.readCheckoutDiffFile({ cwd, path, compare });
        if (scopeRef.current !== requestScope) {
          return;
        }
        setAttemptedPaths((previous) => new Set(previous).add(path));
        if (result.error) {
          setFailedPaths((previous) => new Set(previous).add(path));
          toast.error(result.error.message);
          return;
        }
        if (!result.file) {
          setFailedPaths((previous) => new Set(previous).add(path));
          toast.error(t("workspace.git.diff.lazyHunksFailed"));
          return;
        }
        setLoadedByPath((previous) => {
          const next = new Map(previous);
          next.set(path, { ...result.file!, hunksDeferred: false });
          return next;
        });
        setFailedPaths((previous) => {
          if (!previous.has(path)) {
            return previous;
          }
          const next = new Set(previous);
          next.delete(path);
          return next;
        });
      } catch (error) {
        if (scopeRef.current !== requestScope) {
          return;
        }
        setAttemptedPaths((previous) => new Set(previous).add(path));
        setFailedPaths((previous) => new Set(previous).add(path));
        toast.error(
          error instanceof Error ? error.message : t("workspace.git.diff.lazyHunksFailed"),
        );
      } finally {
        setPendingPaths((previous) => {
          if (!previous.has(path)) {
            return previous;
          }
          const next = new Set(previous);
          next.delete(path);
          return next;
        });
        inFlightRef.current -= 1;
        pumpQueueRef.current();
      }
    },
    [client, compare, cwd, t, toast],
  );

  const pumpQueue = useCallback(() => {
    while (inFlightRef.current < MAX_CONCURRENT_FILE_LOADS && queueRef.current.length > 0) {
      const next = queueRef.current.shift();
      if (!next) {
        return;
      }
      inFlightRef.current += 1;
      void runLoad(next.path, next.manual);
    }
  }, [runLoad]);

  pumpQueueRef.current = pumpQueue;

  const enqueueLoad = useCallback(
    (path: string, options?: LazyCheckoutDiffLoadOptions) => {
      if (!enabled || !supported || !client) {
        return;
      }
      const baseFile = filesRef.current.find((file) => file.path === path);
      if (!baseFile) {
        return;
      }
      if (baseFile.status === "binary") {
        return;
      }
      const manual = options?.manual === true;
      if (manual) {
        if (!canManualLoad(baseFile)) {
          return;
        }
      } else if (!canAutoLoad(baseFile)) {
        return;
      }
      if (loadedByPathRef.current.has(path)) {
        return;
      }
      if (pendingPaths.has(path)) {
        return;
      }
      if (queueRef.current.some((entry) => entry.path === path)) {
        return;
      }

      setPendingPaths((previous) => new Set(previous).add(path));
      queueRef.current.push({ path, manual });
      pumpQueueRef.current();
    },
    [client, enabled, pendingPaths, supported],
  );

  const loadFile = useCallback(
    (path: string, options?: LazyCheckoutDiffLoadOptions) => {
      enqueueLoad(path, options);
    },
    [enqueueLoad],
  );

  const retryFile = useCallback(
    (path: string, options?: LazyCheckoutDiffLoadOptions) => {
      setFailedPaths((previous) => {
        if (!previous.has(path)) {
          return previous;
        }
        const next = new Set(previous);
        next.delete(path);
        return next;
      });
      setLoadedByPath((previous) => {
        if (!previous.has(path)) {
          return previous;
        }
        const next = new Map(previous);
        next.delete(path);
        return next;
      });
      setAttemptedPaths((previous) => {
        if (!previous.has(path)) {
          return previous;
        }
        const next = new Set(previous);
        next.delete(path);
        return next;
      });
      queueRef.current = queueRef.current.filter((entry) => entry.path !== path);
      loadFile(path, options);
    },
    [loadFile],
  );

  const scheduleLoadsForPaths = useCallback(
    (paths: readonly string[]) => {
      if (!enabled || !supported) {
        return;
      }
      for (const path of paths) {
        loadFile(path);
      }
    },
    [enabled, loadFile, supported],
  );

  const mergedFiles = useMemo(
    () =>
      files.map((file) => {
        const loaded = loadedByPath.get(file.path);
        return loaded ?? file;
      }),
    [files, loadedByPath],
  );

  const isFileLoading = useCallback((path: string) => pendingPaths.has(path), [pendingPaths]);
  const isFileLoadFailed = useCallback((path: string) => failedPaths.has(path), [failedPaths]);
  const isFileLoadAttempted = useCallback(
    (path: string) => attemptedPaths.has(path),
    [attemptedPaths],
  );

  return useMemo(
    () => ({
      files: mergedFiles,
      loadFile,
      retryFile,
      scheduleLoadsForPaths,
      isFileLoading,
      isFileLoadFailed,
      isFileLoadAttempted,
      lazyFilesSupported: supported,
    }),
    [
      isFileLoadAttempted,
      isFileLoadFailed,
      isFileLoading,
      loadFile,
      mergedFiles,
      retryFile,
      scheduleLoadsForPaths,
      supported,
    ],
  );
}
