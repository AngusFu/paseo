import type { StoredKanbanCard } from "./types.js";

// Source membership for a synced card. One real-world item stays one card no
// matter how many configured source queries match it, so "which source is this
// card from" is a set, not a single id — see StoredKanbanCardSchema.sourceIds.
//
// Everything here reads through the same fallback: a card written before
// `sourceIds` existed carries only `sourceId`, and is treated as a member of
// exactly that one source. A manual card belongs to no source at all.
// COMPAT(kanbanCardSourceIds): added in v0.2.0, drop the sourceId fallback
// once the daemon floor is >= v0.2.0.

type CardSourceFields = Pick<StoredKanbanCard, "sourceId" | "sourceIds">;

/** Every source this card belongs to, owner first. Empty for manual cards. */
export function resolveCardSourceIds(card: CardSourceFields): string[] {
  if (card.sourceIds && card.sourceIds.length > 0) {
    return card.sourceIds;
  }
  return card.sourceId ? [card.sourceId] : [];
}

/**
 * True when `sourceId`'s query is one of the queries backing this card.
 *
 * A card with no membership at all matches nothing — callers that need the
 * legacy "unattributed card, might be mine" behaviour check for an empty
 * result explicitly rather than having it hide inside this predicate.
 */
export function cardBelongsToSource(card: CardSourceFields, sourceId: string): boolean {
  return resolveCardSourceIds(card).includes(sourceId);
}

/**
 * Membership after `sourceId`'s query returned this card. Appends rather than
 * replaces, so the owner stays first and repeat syncs are idempotent.
 */
export function addCardSourceId(
  card: CardSourceFields,
  sourceId: string | undefined,
): string[] | undefined {
  const current = resolveCardSourceIds(card);
  if (!sourceId) {
    return current.length > 0 ? current : undefined;
  }
  if (current.includes(sourceId)) {
    return current;
  }
  return [...current, sourceId];
}

/**
 * Membership after `sourceId`'s query stopped returning this card. An empty
 * result means the card has no source left backing it — that is what makes it
 * eligible for the owner-only delete and detach rules in kanban sync.
 */
export function removeCardSourceId(card: CardSourceFields, sourceId: string): string[] {
  return resolveCardSourceIds(card).filter((id) => id !== sourceId);
}
