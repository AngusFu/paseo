/** Default first page for an empty Knowledge base (product P2). */
export const DEFAULT_KNOWLEDGE_BASE_PAGE_PATH = "index.md";

const DOC_EXTENSIONS = [".md", ".mdx", ".txt"] as const;

/**
 * Normalize a user-entered in-KB page path.
 * Returns null when the path is empty or escapes the Knowledge base root.
 */
export function normalizeKnowledgeBasePagePath(raw: string): string | null {
  const trimmed = raw.trim().replace(/\\/g, "/");
  if (!trimmed) return null;

  const withoutLeading = trimmed.replace(/^\/+/, "");
  const segments = withoutLeading.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === "." || segment === "..")) return null;

  return segments.join("/");
}

export function isKnowledgeBasePagePathValid(raw: string): boolean {
  const normalized = normalizeKnowledgeBasePagePath(raw);
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  return DOC_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Seed markdown for a new page from its basename (without extension). */
export function defaultKnowledgeBasePageContent(path: string): string {
  const normalized = normalizeKnowledgeBasePagePath(path) ?? path;
  const base = normalized.split("/").pop() ?? "page";
  const title = base.replace(/\.(md|mdx|txt)$/i, "") || "page";
  return `# ${title}\n`;
}
