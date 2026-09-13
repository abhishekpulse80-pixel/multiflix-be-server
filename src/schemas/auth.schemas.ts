import { z } from 'zod';
import { isValidUsernameShape } from '../lib/usernameRules.js';

const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .email()
  .transform((v) => v.toLowerCase());

const passwordSchema = z.string().min(6).max(128);

/** Chosen at sign-up. Normalised to lowercase, then shape-validated. */
const usernameSchema = z
  .string()
  .trim()
  .transform((v) => v.toLowerCase())
  .refine(isValidUsernameShape, {
    message:
      'Username must be 3–30 characters: letters, numbers, . or _ (not starting or ending with . or _)',
  });

// Sign-up collects only a username + password. Email is gathered later, as a
// required onboarding step (see fillProfile).
export const registerBodySchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
});

/**
 * Login accepts any of: email address, username, or phone number.
 * Format detection happens in the auth service — the schema only enforces
 * basic length so junk doesn't reach the DB lookup.
 */
export const loginBodySchema = z.object({
  identifier: z.string().trim().min(2).max(320),
  password: z.string().min(1).max(128),
});

export const forgotPasswordBodySchema = z.object({
  email: emailSchema,
});

export const verifyForgotOtpBodySchema = z.object({
  email: emailSchema,
  code: z.string().regex(/^\d{4}$/, 'Code must be 4 digits'),
});

export const resetPasswordBodySchema = z.object({
  resetToken: z.string().min(10).max(2048),
  newPassword: passwordSchema,
});

export const changePasswordBodySchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});

export const googleSignInBodySchema = z.object({
  idToken: z.string().min(20).max(8192),
});

export const appleSignInBodySchema = z.object({
  identityToken: z.string().min(20).max(8192),
});
