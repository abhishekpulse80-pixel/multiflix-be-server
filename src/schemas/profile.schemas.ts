import { z } from 'zod';
import { USERNAME_REGEX } from '../lib/usernameRules.js';

/** Trimmed string, max length; empty input becomes `null` to clear the field. */
function profileField(max: number) {
  return z
    .union([z.string(), z.null(), z.undefined()])
    .transform((v) => {
      if (v === undefined) {
        return undefined;
      }
      if (v === null) {
        return null;
      }
      const t = String(v).trim().slice(0, max);
      return t === '' ? null : t;
    });
}

/**
 * `POST /auth/fill-profile` — all keys optional; send only fields to create/update.
 * Use `null` to clear a stored value.
 */
export const fillProfileBodySchema = z
  .object({
    fullName: profileField(120),
    phone: profileField(40),
    address: profileField(500),
    /** Public URL from `POST /uploads/single` (or CDN), if any. */
    avatarUrl: profileField(2048),
    /** Email — collected here (not at sign-up); uniqueness checked in service. */
    email: z.string().trim().toLowerCase().email().max(320).optional(),
    /** Handle — lowercase, 3–30 chars, letters/numbers/._ ; uniqueness
     * checked in the service. */
    username: z
      .string()
      .trim()
      .toLowerCase()
      .min(3)
      .max(30)
      .regex(USERNAME_REGEX, 'Invalid username')
      .optional(),
  })
  .partial()
  .strict();

/** `GET /auth/username-available?username=...` */
export const usernameAvailableQuerySchema = z.object({
  username: z.string().trim().toLowerCase().min(1).max(40),
});

export type UsernameAvailableQuery = z.infer<
  typeof usernameAvailableQuerySchema
>;

export type FillProfileBody = z.infer<typeof fillProfileBodySchema>;

/** `GET /users/:userId/public/posts` and `/public/blogs` pagination */
export const publicProfileMediaQuerySchema = z.object({
  page: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

export type PublicProfileMediaQuery = z.infer<typeof publicProfileMediaQuerySchema>;

/** `PATCH /auth/me/privacy` — partial update of privacy flags. */
export const updatePrivacyBodySchema = z
  .object({
    isFollowersListPrivate: z.boolean().optional(),
    notificationsEnabled: z.boolean().optional(),
  })
  .strict();

export type UpdatePrivacyBody = z.infer<typeof updatePrivacyBodySchema>;
