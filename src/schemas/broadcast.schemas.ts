import { z } from 'zod';

/** `POST /admin/broadcast` — admin sends a push to every subscribed client. */
export const sendBroadcastBodySchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(500),
  })
  .strict();

export type SendBroadcastBody = z.infer<typeof sendBroadcastBodySchema>;
