import { z } from 'zod';

/** `POST /withdrawals` — user places a withdrawal request. */
export const createWithdrawalRequestBodySchema = z
  .object({
    /** INR amount. Must be >= admin-configured minimum and <= current wallet balance. */
    amount: z.number().positive().finite(),
  })
  .strict();

export type CreateWithdrawalRequestBody = z.infer<
  typeof createWithdrawalRequestBodySchema
>;

/** `POST /admin/withdrawals/:id/approve|reject` — optional admin note. */
export const withdrawalDecisionBodySchema = z
  .object({
    adminNote: z.string().trim().max(500).optional(),
  })
  .strict();

export type WithdrawalDecisionBody = z.infer<
  typeof withdrawalDecisionBodySchema
>;

/** Admin list filter value. Not required. */
export const withdrawalStatusFilterValues = [
  'pending',
  'approved',
  'rejected',
] as const;

