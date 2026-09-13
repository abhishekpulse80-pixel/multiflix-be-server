import { z } from 'zod';
/** Admin updates an earning rate (PATCH /admin/earning-rates/:section). */
export const updateEarningRateBodySchema = z
    .object({
    /** Currency units earned per 1 minute spent in this section. */
    ratePerMinute: z.number().min(0).optional(),
    /** When false, time tracked in this section earns nothing. */
    isActive: z.boolean().optional(),
})
    .strict()
    .refine((v) => v.ratePerMinute !== undefined || v.isActive !== undefined, { message: 'At least one of ratePerMinute or isActive must be provided' });
