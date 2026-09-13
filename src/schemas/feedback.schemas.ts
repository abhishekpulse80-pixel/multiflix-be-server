import { z } from 'zod';

export const feedbackStatusSchema = z.enum(['new', 'read', 'addressed']);

/** User submits feedback (POST /feedback). */
export const createFeedbackBodySchema = z
  .object({
    subject: z.string().trim().min(1).max(200),
    message: z.string().trim().min(1).max(5000),
  })
  .strict();

export type CreateFeedbackBody = z.infer<typeof createFeedbackBodySchema>;

/** Admin updates feedback status (PATCH /admin/feedback/:id/status). */
export const updateFeedbackStatusBodySchema = z
  .object({
    status: feedbackStatusSchema,
    adminNotes: z.string().trim().max(2000).optional(),
  })
  .strict();

export type UpdateFeedbackStatusBody = z.infer<typeof updateFeedbackStatusBodySchema>;
