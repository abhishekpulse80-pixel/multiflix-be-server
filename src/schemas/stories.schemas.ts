import { z } from 'zod';

/**
 * Story video duration is capped at the same value posts use (60 s).
 * Image stories don't have a duration. The mobile trim editor enforces
 * the cap before upload; this schema enforces it as defence-in-depth.
 */
export const STORY_VIDEO_MAX_SECONDS = 60;

/** Same `file` object returned by `POST /uploads/single` after client unwrap. */
const uploadedFileRefSchema = z
  .object({
    key: z.string().min(1).max(1024),
    bucket: z.string().min(1).max(255),
    contentType: z.string().min(1).max(200),
    size: z.number().int().nonnegative(),
    originalName: z.string().min(1).max(200),
    url: z.union([z.string().min(1).max(2048), z.null()]),
    imageVariants: z
      .array(z.object({ quality: z.enum(['360w', '720w', '1080w']), width: z.number().int().positive(), url: z.string().url() }).strict())
      .max(3)
      .optional(),
  })
  .strict();

const objectIdString = z.string().regex(/^[a-fA-F0-9]{24}$/);

/**
 * `POST /stories` — publish a new story from an already-uploaded file.
 */
export const createStoryBodySchema = z
  .object({
    mediaKind: z.enum(['image', 'short_video']),
    file: uploadedFileRefSchema,
    soundTitle: z.string().max(512).nullable().optional(),
    musicTrackId: objectIdString.nullable().optional(),
    musicTrimStartMs: z.number().int().nonnegative().nullable().optional(),
    caption: z.string().max(2000).nullable().optional(),
    mediaWidth: z.number().int().positive().nullable().optional(),
    mediaHeight: z.number().int().positive().nullable().optional(),
    durationSeconds: z.number().finite().nonnegative().nullable().optional(),
    showInTrending: z.boolean().optional(),
    textOverlays: z
      .array(
        z
          .object({
            text: z.string().min(1).max(300),
            x: z.number().min(0).max(1),
            y: z.number().min(0).max(1),
            color: z
              .string()
              .regex(/^#[0-9A-Fa-f]{6}$/)
              .optional(),
            fontSize: z.number().int().min(10).max(80).optional(),
          })
          .strict(),
      )
      .max(10)
      .optional(),
    /** Optional pinch/pan transform from the editor. */
    mediaTransform: z
      .object({
        scale: z.number().min(0.5).max(5),
        translateX: z.number().min(-2).max(2),
        translateY: z.number().min(-2).max(2),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    // Video stories need a duration and must fit within the 60s cap.
    if (data.mediaKind === 'short_video') {
      const d = data.durationSeconds;
      if (d == null || d <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['durationSeconds'],
          message: 'durationSeconds is required for video stories',
        });
      } else if (d > STORY_VIDEO_MAX_SECONDS + 0.5) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['durationSeconds'],
          message: `Video stories cannot exceed ${String(STORY_VIDEO_MAX_SECONDS)} seconds`,
        });
      }
    }
    // musicTrackId and musicTrimStartMs must be paired.
    const hasTrack = data.musicTrackId != null;
    const hasTrim = data.musicTrimStartMs != null;
    if (hasTrack !== hasTrim) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['musicTrimStartMs'],
        message:
          'musicTrackId and musicTrimStartMs must be provided together',
      });
    }
  });

export type CreateStoryBody = z.infer<typeof createStoryBodySchema>;

/**
 * `GET /stories/feed` — paginated list of active (non-expired) stories.
 * Ordered newest-first within each author group.
 */
export const storyFeedQuerySchema = z.object({
  page: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type StoryFeedQuery = z.infer<typeof storyFeedQuerySchema>;

/**
 * `POST /stories/:storyId/view` — record a view on a story (idempotent).
 */
export const recordStoryViewBodySchema = z
  .object({
    viewed: z.literal(true),
  })
  .strict();

export type RecordStoryViewBody = z.infer<typeof recordStoryViewBodySchema>;

/**
 * `POST /stories/:storyId/react` — send a reaction to a story.
 */
export const storyReactBodySchema = z
  .object({
    reaction: z.enum(['happy', 'funny', 'thrilled', 'angry', 'sad', 'wow']),
  })
  .strict();

export type StoryReactBody = z.infer<typeof storyReactBodySchema>;
