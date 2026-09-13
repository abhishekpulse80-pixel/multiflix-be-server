import { z } from 'zod';

const interestItem = z.string().trim().min(1).max(80);

export const updateInterestsBodySchema = z.object({
  interests: z.array(interestItem).max(40),
});

export const genderSchema = z.enum([
  'male',
  'female',
  'other',
  'prefer_not_to_say',
]);

export const updateGenderBodySchema = z.object({
  gender: genderSchema,
});

/** Calendar date `YYYY-MM-DD` (UTC date-only). */
export const updateDobBodySchema = z.object({
  dateOfBirth: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
});
