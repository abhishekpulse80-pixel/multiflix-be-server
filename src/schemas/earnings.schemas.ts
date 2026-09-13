import { z } from 'zod';
import { EARNING_SECTIONS } from '../models/earningRate.model.js';

/** Single entry the client flushes for a section. */
const screenTimeEntrySchema = z
  .object({
    section: z.enum(EARNING_SECTIONS as unknown as [string, ...string[]]),
    /** Whole minutes spent since the last successful flush. */
    minutes: z.number().int().min(1).max(24 * 60),
  })
  .strict();

/** POST /earnings/me/screen-time — batched flush of buffered minutes. */
export const recordScreenTimeBodySchema = z
  .object({
    entries: z.array(screenTimeEntrySchema).min(1).max(20),
  })
  .strict();

export type RecordScreenTimeBody = z.infer<typeof recordScreenTimeBodySchema>;
