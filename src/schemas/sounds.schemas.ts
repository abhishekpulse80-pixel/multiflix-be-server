import { z } from 'zod';

/**
 * `GET /sounds?page=&limit=` — paginated browse of ready+public original
 * sounds, sorted by usesCount desc.
 */
export const soundsListQuerySchema = z.object({
  page: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type SoundsListQuery = z.infer<typeof soundsListQuerySchema>;

/** `GET /sounds/:soundId/posts?page=&limit=` — posts that use this sound. */
export const soundPostsQuerySchema = z.object({
  page: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(24),
});

export type SoundPostsQuery = z.infer<typeof soundPostsQuerySchema>;
