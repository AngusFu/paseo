import type { ListPageInfo } from "@getpaseo/protocol/list-page";
import { SortablePager, type SortSpec } from "./sortable-pager.js";

export const DEFAULT_LIST_PAGE_LIMIT = 50;
export const MAX_LIST_PAGE_LIMIT = 200;

export interface ListPageRequest {
  limit?: number;
  cursor?: string;
}

export function clampListPageLimit(limit?: number): number {
  if (limit === undefined) {
    return DEFAULT_LIST_PAGE_LIMIT;
  }
  const normalized = Math.trunc(limit);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return DEFAULT_LIST_PAGE_LIMIT;
  }
  return Math.min(normalized, MAX_LIST_PAGE_LIMIT);
}

export function isListPageRequested(page: ListPageRequest | undefined): boolean {
  return page?.limit !== undefined || page?.cursor !== undefined;
}

export function paginateSortedList<TItem, K extends string>(
  items: TItem[],
  pager: SortablePager<TItem, K>,
  sort: readonly SortSpec<K>[],
  page: ListPageRequest | undefined,
): { items: TItem[]; pageInfo?: ListPageInfo } {
  const sorted = [...items].sort((left, right) => pager.compare(left, right, sort));
  if (!isListPageRequested(page)) {
    return { items: sorted };
  }

  const limit = clampListPageLimit(page?.limit);
  let candidates = sorted;
  if (page?.cursor) {
    const cursor = pager.decode(page.cursor, sort);
    candidates = sorted.filter((item) => pager.compareWithCursor(item, cursor, sort) > 0);
  }

  const slice = candidates.slice(0, limit);
  const hasMore = candidates.length > limit;
  const nextCursor =
    hasMore && slice.length > 0 ? pager.encode(slice[slice.length - 1]!, sort) : null;

  return {
    items: slice,
    pageInfo: { nextCursor, hasMore },
  };
}
