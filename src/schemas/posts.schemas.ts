import { z } from 'zod';

/** Same object as `POST /uploads/single` → `data.file` (after client unwrap). */
const uploadedFileRefSchema = z
  .object({
    key: z.string().min(1).max(1024),
    bucket: z.string().min(1).max(255),
    contentType: z.string().min(1).max(200),
    size: z.number().int().nonnegative(),
    originalName: z.string().min(1).max(200),
    url: z.union([z.string().min(1).max(2048), z.null()]),
  })
  .strict();

const objectIdString = z.string().regex(/^[a-fA-F0-9]{24}$/);

/**
 * `POST /posts` — create a feed post from a file already uploaded via `POST /uploads/single`.
 */
export const createPostBodySchema = z
  .object({
    mediaKind: z.enum(['image', 'short_video']),
    file: uploadedFileRefSchema,
    caption: z.string().max(4000).nullable().optional(),
    hashtags: z.string().max(2000).nullable().optional(),
    musicTitle: z.string().max(512).nullable().optional(),
    /** Optional curated music track attached to the post. */
    musicTrackId: objectIdString.nullable().optional(),
    /**
     * Start of the playback window in ms. Required whenever an audio source
     * is attached — either `musicTrackId` or `attachedOriginalSoundId`.
     */
    musicTrimStartMs: z.number().int().nonnegative().nullable().optional(),
    /**
     * Optional original sound (extracted from another user's video post)
     * attached to this post. Mutually exclusive with `musicTrackId` —
     * the post can attach EITHER a curated track or an OriginalSound,
     * never both.
     */
    attachedOriginalSoundId: objectIdString.nullable().optional(),
    /**
     * If true, the uploader chose to mute the original video audio. Players
     * silence the source clip regardless of an attached music track.
     * Defaults to false server-side.
     */
    originalAudioMuted: z.boolean().optional(),
    mediaWidth: z.number().int().positive().nullable().optional(),
    mediaHeight: z.number().int().positive().nullable().optional(),
    durationSeconds: z.number().finite().nonnegative().nullable().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    // musicTrimStartMs is the playback-window start for whatever audio is
    // attached, so it must be paired with an audio source — either a curated
    // track OR an original sound — and vice versa.
    const hasSource =
      data.musicTrackId != null || data.attachedOriginalSoundId != null;
    const hasTrim = data.musicTrimStartMs != null;
    if (hasSource !== hasTrim) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['musicTrimStartMs'],
        message:
          'musicTrimStartMs must be provided together with a musicTrackId or attachedOriginalSoundId',
      });
    }
    // A post can attach a curated track OR an original sound, not both.
    if (data.musicTrackId != null && data.attachedOriginalSoundId != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attachedOriginalSoundId'],
        message:
          'attachedOriginalSoundId cannot be set together with musicTrackId',
      });
    }
  });

export type CreatePostBody = z.infer<typeof createPostBodySchema>;

/** `GET /posts/feed` — offset pagination (simple until ranking exists). */
export const homeFeedQuerySchema = z.object({
  page: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type HomeFeedQuery = z.infer<typeof homeFeedQuerySchema>;

/** `GET /posts/hashtag/:tag` — paginated list of posts containing a hashtag. */
export const hashtagPostsQuerySchema = z.object({
  page: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(24),
});

export type HashtagPostsQuery = z.infer<typeof hashtagPostsQuerySchema>;

/** `GET /posts/music/:trackId` — paginated list of posts using a music track. */
export const musicPostsQuerySchema = z.object({
  page: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(24),
});

export type MusicPostsQuery = z.infer<typeof musicPostsQuerySchema>;

/** `GET /posts/saved` — paginated list of posts the viewer has saved. */
export const savedPostsQuerySchema = z.object({
  page: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(24),
});

export type SavedPostsQuery = z.infer<typeof savedPostsQuerySchema>;

/**
 * `POST /posts/:postId/like` — set like on (`liked: true`) or remove like (`liked: false`).
 * One endpoint for both actions (idempotent).
 */
export const postLikeBodySchema = z
  .object({
    liked: z.boolean(),
  })
  .strict();

export type PostLikeBody = z.infer<typeof postLikeBodySchema>;

/**
 * `POST /posts/:postId/save` — bookmark (`saved: true`) or remove bookmark
 * (`saved: false`). One endpoint for both actions (idempotent).
 */
export const postSaveBodySchema = z
  .object({
    saved: z.boolean(),
  })
  .strict();

export type PostSaveBody = z.infer<typeof postSaveBodySchema>;

/**
 * `POST /posts/views` — mark a batch of posts as seen in the home feed, so
 * they're excluded from future feed pages.
 */
export const recordPostViewsBodySchema = z
  .object({
    postIds: z.array(z.string()).min(1).max(200),
  })
  .strict();

export type RecordPostViewsBody = z.infer<typeof recordPostViewsBodySchema>;
