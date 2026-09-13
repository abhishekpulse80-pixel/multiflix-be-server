import { z } from 'zod';

export const createReportBodySchema = z
  .object({
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();

export type CreateReportBody = z.infer<typeof createReportBodySchema>;
