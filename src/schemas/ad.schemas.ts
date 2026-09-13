import { z } from 'zod';

export const adPlacementSchema = z.enum(['feed', 'stories', 'blog', 'banner']);
export const adStatusSchema = z.enum(['draft', 'active', 'paused', 'expired']);

/** Admin creates an ad (POST /admin/ads). */
export const createAdBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    imageUrl: z.string().trim().url().max(2048),
    targetUrl: z.string().trim().url().max(2048),
    placement: adPlacementSchema.optional(),
    status: adStatusSchema.optional(),
    startDate: z.string().datetime().nullable().optional(),
    endDate: z.string().datetime().nullable().optional(),
  })
  .strict();

export type CreateAdBody = z.infer<typeof createAdBodySchema>;

/** Admin updates an ad (PATCH /admin/ads/:adId). */
export const patchAdBodySchema = createAdBodySchema.partial().strict();

export type PatchAdBody = z.infer<typeof patchAdBodySchema>;
