export function parentDirectoryPath(path: string): string | null {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  if (!trimmed || trimmed === "/" || trimmed === "~") {
    return trimmed === "~" ? "/" : null;
  }
  if (/^[A-Za-z]:$/.test(trimmed) || /^[A-Za-z]:\\$/.test(path.trim())) {
    return null;
  }
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (slash <= 0) {
    return trimmed.startsWith("/") ? "/" : null;
  }
  if (/^[A-Za-z]:[\\/]/.test(trimmed) && slash <= 2) {
    return `${trimmed.slice(0, 2)}\\`;
  }
  return trimmed.slice(0, slash) || "/";
}
