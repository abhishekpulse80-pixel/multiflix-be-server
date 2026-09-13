import { z } from 'zod';

/** `GET /notifications` — offset pagination (0-based, matches feed convention). */
export const listNotificationsQuerySchema = z.object({
  page: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type ListNotificationsQuery = z.infer<
  typeof listNotificationsQuerySchema
>;
