/**
 * Hub list row presentation helpers (identity + mount usage summary).
 */

export function resolveKnowledgeBaseRowTitle(kb: { name?: string | null; slug: string }): string {
  const name = typeof kb.name === "string" ? kb.name.trim() : "";
  return name.length > 0 ? name : kb.slug;
}

export function resolveKnowledgeBaseHostSelection(input: {
  hosts: readonly { serverId: string }[];
  preferredServerId?: string | null;
  currentServerId?: string | null;
}): string {
  const preferred = trimNonEmpty(input.preferredServerId);
  if (preferred && input.hosts.some((host) => host.serverId === preferred)) {
    return preferred;
  }
  const current = trimNonEmpty(input.currentServerId);
  if (current && input.hosts.some((host) => host.serverId === current)) {
    return current;
  }
  return input.hosts[0]?.serverId ?? "";
}

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
