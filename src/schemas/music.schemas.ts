import { z } from 'zod';

export const musicAlbumStatusSchema = z.enum(['draft', 'published']);
export const musicTrackStatusSchema = z.enum(['draft', 'published']);

const objectIdString = z
  .string()
  .trim()
  .regex(/^[a-f\d]{24}$/i, 'Invalid id');

/** Public / client list query (future `GET /music/albums`). */
export const musicListQuerySchema = z.object({
  page: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type MusicListQuery = z.infer<typeof musicListQuerySchema>;

/** `GET /music/search?q=&limit=` — searches tracks + albums. */
export const musicSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type MusicSearchQuery = z.infer<typeof musicSearchQuerySchema>;

export const artistStatusSchema = z.enum(['draft', 'published']);

/** Admin: create artist. */
export const adminCreateArtistBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    bio: z.string().trim().max(2000).nullable().optional(),
    profileImageUrl: z
      .string()
      .trim()
      .url()
      .max(2048)
      .nullable()
      .optional(),
    status: artistStatusSchema.optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .strict();

export type AdminCreateArtistBody = z.infer<typeof adminCreateArtistBodySchema>;

export const adminPatchArtistBodySchema = adminCreateArtistBodySchema
  .partial()
  .strict();

export type AdminPatchArtistBody = z.infer<typeof adminPatchArtistBodySchema>;

/** Admin: create album. Requires `artistId` (Artist anchor — Subtask 2). */
export const adminCreateMusicAlbumBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    coverArtUrl: z.string().trim().url().max(2048),
    featured: z.boolean().optional(),
    artistId: objectIdString,
    status: musicAlbumStatusSchema.optional(),
    sortOrder: z.number().int().min(0).optional(),
    publishedAt: z.string().datetime().nullable().optional(),
  })
  .strict();

export type AdminCreateMusicAlbumBody = z.infer<
  typeof adminCreateMusicAlbumBodySchema
>;

/** Admin: add track. Requires `artistId` (independent of album artist). */
export const adminCreateMusicTrackBodySchema = z
  .object({
    albumId: objectIdString.nullable().optional(),
    title: z.string().trim().min(1).max(200),
    artistId: objectIdString,
    artUrl: z.string().trim().url().max(2048),
    audioUrl: z.string().trim().url().max(2048),
    durationSeconds: z.number().int().min(0).nullable().optional(),
    sortOrder: z.number().int().min(0).optional(),
    status: musicTrackStatusSchema.optional(),
    streamsCount: z.number().int().min(0).optional(),
  })
  .strict();

export type AdminCreateMusicTrackBody = z.infer<
  typeof adminCreateMusicTrackBodySchema
>;

/** Future admin: patch album. */
export const adminPatchMusicAlbumBodySchema = adminCreateMusicAlbumBodySchema
  .partial()
  .strict();

export type AdminPatchMusicAlbumBody = z.infer<
  typeof adminPatchMusicAlbumBodySchema
>;

/**
 * `POST /music/tracks/:trackId/favourite` —
 * `{ favourited: true }` to favourite, `{ favourited: false }` to un-favourite.
 * One endpoint for both actions (idempotent).
 */
export const musicTrackFavouriteBodySchema = z
  .object({
    favourited: z.boolean(),
  })
  .strict();

export type MusicTrackFavouriteBody = z.infer<
  typeof musicTrackFavouriteBodySchema
>;
