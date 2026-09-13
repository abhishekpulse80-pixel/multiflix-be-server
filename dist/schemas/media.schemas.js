import { z } from 'zod';
export const mediaQualitySchema = z.enum(['normal', 'fast']);
export const deliveryProfileQuerySchema = z.object({
    quality: mediaQualitySchema.default('normal'),
});
export const networkProfileBodySchema = z
    .object({
    quality: z.enum(['slow', 'normal', 'fast']).optional(),
    effectiveType: z.enum(['slow-2g', '2g', '3g', '4g']).optional(),
    downlinkMbps: z.number().finite().min(0).max(10000).optional(),
    rttMs: z.number().finite().int().min(0).max(600000).optional(),
    saveData: z.boolean().optional(),
})
    .strict();
