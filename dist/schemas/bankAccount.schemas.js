import { z } from 'zod';
/**
 * `PUT /auth/me/bank-account` — save or update the caller's bank account.
 */
export const saveBankAccountBodySchema = z
    .object({
    holderName: z.string().trim().min(1).max(120),
    accountNumber: z.string().trim().min(5).max(30),
    ifscCode: z.string().trim().min(4).max(20),
    bankName: z.string().trim().min(1).max(200),
    /** Optional UPI VPA — basic shape: `name@handle`. */
    upiId: z
        .string()
        .trim()
        .max(100)
        .regex(/^[\w.\-]{2,}@[\w.\-]{2,}$/, 'Invalid UPI id')
        .nullable()
        .optional(),
})
    .strict();
