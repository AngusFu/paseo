import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import {
  DEFAULT_KNOWLEDGE_BASE_PAGE_PATH,
  defaultKnowledgeBasePageContent,
  isKnowledgeBasePagePathValid,
  normalizeKnowledgeBasePagePath,
} from "@/knowledge-bases/knowledge-base-page-path";
import type { KnowledgeBasePagePathSheetMode } from "@/knowledge-bases/knowledge-base-page-path-sheet";
import type {
  KnowledgeBaseDeletePageFn,
  KnowledgeBaseUpsertPageFn,
} from "@/knowledge-bases/resolve-knowledge-base-page-authoring";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";

export type KnowledgeBasePaneMode = "preview" | "edit";

export function useKnowledgeBasePageAuthoring(options: {
  idOrSlug: string;
  selectedPath: string | null;
  loadedContent: string | null;
  pageLoading: boolean;
  upsertPage: KnowledgeBaseUpsertPageFn | null;
  deletePage: KnowledgeBaseDeletePageFn | null;
  authoringReady: boolean;
  onSelectPath: (path: string | null) => void;
  onRefreshTree: () => void;
  onRefreshPage: () => void;
}): {
  paneMode: KnowledgeBasePaneMode;
  draftContent: string;
  dirty: boolean;
  busy: boolean;
  pathSheetVisible: boolean;
  pathSheetMode: KnowledgeBasePagePathSheetMode;
  pathDraft: string;
  contentDraft: string;
  pathFormError: string | null;
  showContentField: boolean;
  setDraftContent: (value: string) => void;
  openAddPage: (seedFirstPage?: boolean) => void;
  openRenamePage: () => void;
  closePathSheet: () => void;
  setPathDraft: (value: string) => void;
  setContentDraft: (value: string) => void;
  submitPathSheet: () => void;
  enterEdit: () => void;
  cancelEdit: () => void;
  saveEdit: () => void;
  deleteSelectedPage: () => void;
  confirmLeaveIfDirty: () => Promise<boolean>;
  notifyAuthoringUnavailable: () => void;
} {
  const {
    idOrSlug,
    selectedPath,
    loadedContent,
    pageLoading,
    upsertPage,
    deletePage,
    authoringReady,
    onSelectPath,
    onRefreshTree,
    onRefreshPage,
  } = options;
  const { t } = useTranslation();
  const toast = useToast();

  const [paneMode, setPaneMode] = useState<KnowledgeBasePaneMode>("preview");
  const [draftContent, setDraftContent] = useState("");
  const [baselineContent, setBaselineContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [pathSheetVisible, setPathSheetVisible] = useState(false);
  const [pathSheetMode, setPathSheetMode] = useState<KnowledgeBasePagePathSheetMode>("add");
  const [pathDraft, setPathDraft] = useState(DEFAULT_KNOWLEDGE_BASE_PAGE_PATH);
  const [contentDraft, setContentDraft] = useState("");
  const [pathFormError, setPathFormError] = useState<string | null>(null);
  const [seedFirstPage, setSeedFirstPage] = useState(false);
  const skipPathResetRef = useRef(false);

  const dirty = paneMode === "edit" && draftContent !== baselineContent;

  useEffect(() => {
    if (skipPathResetRef.current) {
      skipPathResetRef.current = false;
      return;
    }
    setPaneMode("preview");
    setDraftContent("");
    setBaselineContent("");
  }, [selectedPath]);

  useEffect(() => {
    if (pageLoading || loadedContent === null) return;
    if (paneMode === "edit" && dirty) return;
    setDraftContent(loadedContent);
    setBaselineContent(loadedContent);
  }, [dirty, loadedContent, pageLoading, paneMode, selectedPath]);

  const notifyAuthoringUnavailable = useCallback(() => {
    toast.error(t("knowledgeBases.detail.authoringUnavailable"));
  }, [t, toast]);

  const confirmLeaveIfDirty = useCallback(async (): Promise<boolean> => {
    if (!dirty) return true;
    return confirmDialog({
      title: t("knowledgeBases.detail.discardUnsavedTitle"),
      message: t("knowledgeBases.detail.discardUnsavedMessage"),
      confirmLabel: t("knowledgeBases.detail.discard"),
      cancelLabel: t("common.actions.cancel"),
      destructive: true,
    });
  }, [dirty, t]);

  const openAddPage = useCallback(
    (firstPage = false) => {
      if (!authoringReady || !upsertPage) {
        notifyAuthoringUnavailable();
        return;
      }
      setSeedFirstPage(firstPage);
      setPathSheetMode("add");
      setPathDraft(DEFAULT_KNOWLEDGE_BASE_PAGE_PATH);
      setContentDraft(defaultKnowledgeBasePageContent(DEFAULT_KNOWLEDGE_BASE_PAGE_PATH));
      setPathFormError(null);
      setPathSheetVisible(true);
    },
    [authoringReady, notifyAuthoringUnavailable, upsertPage],
  );

  const openRenamePage = useCallback(() => {
    if (!authoringReady || !upsertPage) {
      notifyAuthoringUnavailable();
      return;
    }
    if (!selectedPath) return;
    setSeedFirstPage(false);
    setPathSheetMode("rename");
    setPathDraft(selectedPath);
    setContentDraft("");
    setPathFormError(null);
    setPathSheetVisible(true);
  }, [authoringReady, notifyAuthoringUnavailable, selectedPath, upsertPage]);

  const closePathSheet = useCallback(() => {
    if (busy) return;
    setPathSheetVisible(false);
    setPathFormError(null);
  }, [busy]);

  const enterEdit = useCallback(() => {
    if (!authoringReady || !upsertPage) {
      notifyAuthoringUnavailable();
      return;
    }
    if (!selectedPath || loadedContent === null) return;
    setDraftContent(loadedContent);
    setBaselineContent(loadedContent);
    setPaneMode("edit");
  }, [authoringReady, loadedContent, notifyAuthoringUnavailable, selectedPath, upsertPage]);

  const cancelEdit = useCallback(() => {
    void (async () => {
      if (!(await confirmLeaveIfDirty())) return;
      setDraftContent(baselineContent);
      setPaneMode("preview");
    })();
  }, [baselineContent, confirmLeaveIfDirty]);

  const saveEdit = useCallback(() => {
    if (!upsertPage || !selectedPath) {
      notifyAuthoringUnavailable();
      return;
    }
    void (async () => {
      setBusy(true);
      try {
        const payload = await upsertPage({
          idOrSlug,
          path: selectedPath,
          content: draftContent,
        });
        if (payload.error) {
          toast.error(payload.error);
          return;
        }
        const savedPath = payload.path ?? selectedPath;
        setBaselineContent(draftContent);
        setPaneMode("preview");
        onRefreshTree();
        onRefreshPage();
        toast.show(t("knowledgeBases.detail.savedToast", { path: savedPath }), {
          variant: "success",
        });
      } catch (err) {
        toast.error(toErrorMessage(err));
      } finally {
        setBusy(false);
      }
    })();
  }, [
    draftContent,
    idOrSlug,
    notifyAuthoringUnavailable,
    onRefreshPage,
    onRefreshTree,
    selectedPath,
    t,
    toast,
    upsertPage,
  ]);

  const deleteSelectedPage = useCallback(() => {
    if (!deletePage || !selectedPath) {
      notifyAuthoringUnavailable();
      return;
    }
    void (async () => {
      if (dirty) {
        const leave = await confirmLeaveIfDirty();
        if (!leave) return;
      }
      const confirmed = await confirmDialog({
        title: t("knowledgeBases.detail.deletePageTitle"),
        message: t("knowledgeBases.detail.deletePageMessage", { path: selectedPath }),
        confirmLabel: t("knowledgeBases.detail.deletePage"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      });
      if (!confirmed) return;

      setBusy(true);
      try {
        const payload = await deletePage({ idOrSlug, path: selectedPath });
        if (payload.error) {
          toast.error(payload.error);
          return;
        }
        setPaneMode("preview");
        setDraftContent("");
        setBaselineContent("");
        onSelectPath(null);
        onRefreshTree();
        toast.show(t("knowledgeBases.detail.deletedPageToast", { path: selectedPath }), {
          variant: "success",
        });
      } catch (err) {
        toast.error(toErrorMessage(err));
      } finally {
        setBusy(false);
      }
    })();
  }, [
    confirmLeaveIfDirty,
    deletePage,
    dirty,
    idOrSlug,
    notifyAuthoringUnavailable,
    onRefreshTree,
    onSelectPath,
    selectedPath,
    t,
    toast,
  ]);

  const submitPathSheet = useCallback(() => {
    if (!upsertPage) {
      notifyAuthoringUnavailable();
      return;
    }
    const normalized = normalizeKnowledgeBasePagePath(pathDraft);
    if (!normalized || !isKnowledgeBasePagePathValid(normalized)) {
      setPathFormError(t("knowledgeBases.detail.pathInvalid"));
      return;
    }

    void (async () => {
      setBusy(true);
      setPathFormError(null);
      try {
        if (pathSheetMode === "rename") {
          if (!selectedPath) return;
          if (normalized === selectedPath) {
            setPathSheetVisible(false);
            return;
          }
          const contentForMove =
            paneMode === "edit" ? draftContent : (loadedContent ?? baselineContent);
          const payload = await upsertPage({
            idOrSlug,
            path: normalized,
            content: contentForMove,
            fromPath: selectedPath,
          });
          if (payload.error) {
            setPathFormError(payload.error);
            return;
          }
          const nextPath = payload.path ?? normalized;
          setPathSheetVisible(false);
          setBaselineContent(contentForMove);
          setDraftContent(contentForMove);
          setPaneMode("preview");
          skipPathResetRef.current = true;
          onSelectPath(nextPath);
          onRefreshTree();
          toast.show(t("knowledgeBases.detail.movedToast", { path: nextPath }), {
            variant: "success",
          });
          return;
        }

        const initialContent =
          contentDraft.trim().length > 0
            ? contentDraft
            : defaultKnowledgeBasePageContent(normalized);
        const payload = await upsertPage({
          idOrSlug,
          path: normalized,
          content: initialContent,
        });
        if (payload.error) {
          setPathFormError(payload.error);
          return;
        }
        const nextPath = payload.path ?? normalized;
        setPathSheetVisible(false);
        setDraftContent(initialContent);
        setBaselineContent(initialContent);
        setPaneMode(seedFirstPage ? "edit" : "preview");
        skipPathResetRef.current = true;
        onSelectPath(nextPath);
        onRefreshTree();
        toast.show(t("knowledgeBases.detail.createdToast", { path: nextPath }), {
          variant: "success",
        });
      } catch (err) {
        setPathFormError(toErrorMessage(err));
      } finally {
        setBusy(false);
      }
    })();
  }, [
    baselineContent,
    contentDraft,
    draftContent,
    idOrSlug,
    loadedContent,
    notifyAuthoringUnavailable,
    onRefreshTree,
    onSelectPath,
    paneMode,
    pathDraft,
    pathSheetMode,
    seedFirstPage,
    selectedPath,
    t,
    toast,
    upsertPage,
  ]);

  return {
    paneMode,
    draftContent,
    dirty,
    busy,
    pathSheetVisible,
    pathSheetMode,
    pathDraft,
    contentDraft,
    pathFormError,
    showContentField: pathSheetMode === "add",
    setDraftContent,
    openAddPage,
    openRenamePage,
    closePathSheet,
    setPathDraft,
    setContentDraft,
    submitPathSheet,
    enterEdit,
    cancelEdit,
    saveEdit,
    deleteSelectedPage,
    confirmLeaveIfDirty,
    notifyAuthoringUnavailable,
  };
}
