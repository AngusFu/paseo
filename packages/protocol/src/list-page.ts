import { z } from "zod";

/** Cursor-based list continuation metadata shared by paginated RPCs. */
export const ListPageInfoSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export type ListPageInfo = z.infer<typeof ListPageInfoSchema>;

/** Optional page request fields — omit both for unpaged (legacy) responses. */
export const ListPageRequestFieldsSchema = {
  limit: z.number().int().positive().optional(),
  cursor: z.string().optional(),
} as const;
