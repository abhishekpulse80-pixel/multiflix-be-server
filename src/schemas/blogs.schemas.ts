import { z } from 'zod';

export const blogFavoriteBodySchema = z.object({
  favorited: z.boolean(),
});

export const blogListTabSchema = z.enum(['blogging', 'favorites', 'following']);

export const blogListQuerySchema = z.object({
  tab: blogListTabSchema.optional().default('blogging'),
});

export type BlogListTab = z.infer<typeof blogListTabSchema>;

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

export const createBlogBodySchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(8000).nullable().optional(),
    file: uploadedFileRefSchema,
    /** Optional poster image already uploaded. If omitted, backend generates from 1st frame. */
    posterFile: uploadedFileRefSchema.nullable().optional(),
    durationSeconds: z.number().finite().nonnegative().nullable().optional(),
  })
  .strict();

export type CreateBlogBody = z.infer<typeof createBlogBodySchema>;
