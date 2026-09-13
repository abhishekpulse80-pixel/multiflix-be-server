import { z } from 'zod';

/** `GET /users/search` */
export const userSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(80),
  limit: z.coerce.number().int().min(1).max(50).optional().default(25),
});

export type UserSearchQuery = z.infer<typeof userSearchQuerySchema>;
