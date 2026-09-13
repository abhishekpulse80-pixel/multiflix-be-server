import { z } from 'zod';

/** `GET /posts/:postId/comments` — offset pagination (oldest comments first, page 0 = start of thread). */
export const commentListQuerySchema = z.object({
  page: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type CommentListQuery = z.infer<typeof commentListQuerySchema>;

/** `POST /posts/:postId/comments` */
export const createCommentBodySchema = z
  .object({
    text: z.string().trim().min(1).max(2000),
  })
  .strict();

export type CreateCommentBody = z.infer<typeof createCommentBodySchema>;
