import rateLimit from 'express-rate-limit';
import { Router } from 'express';
import { env, isProd } from '../config/env.js';
import { asyncRoute } from '../lib/asyncRoute.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validateBody } from '../middleware/validateBody.js';
import {
  appleSignInBodySchema,
  changePasswordBodySchema,
  forgotPasswordBodySchema,
  googleSignInBodySchema,
  loginBodySchema,
  registerBodySchema,
  resetPasswordBodySchema,
  verifyForgotOtpBodySchema,
} from '../schemas/auth.schemas.js';
import {
  updateDobBodySchema,
  updateGenderBodySchema,
  updateInterestsBodySchema,
} from '../schemas/onboarding.schemas.js';
import {
  fillProfileBodySchema,
  type FillProfileBody,
  updatePrivacyBodySchema,
  type UpdatePrivacyBody,
  usernameAvailableQuerySchema,
} from '../schemas/profile.schemas.js';
import {
  saveBankAccountBodySchema,
  type SaveBankAccountBody,
} from '../schemas/bankAccount.schemas.js';
import { sendData } from '../lib/sendData.js';
import type { UserGender } from '../models/user.model.js';
import * as authService from '../services/auth.service.js';

const rateLimitShared =
  !isProd && env.trustProxyHops === 0
    ? {
        validate: { xForwardedForHeader: false as const },
      }
    : {};

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  ...rateLimitShared,
});

const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  ...rateLimitShared,
});

export const authRouter = Router();

authRouter.use(limiter);

authRouter.post(
  '/register',
  strictLimiter,
  validateBody(registerBodySchema),
  asyncRoute(async (req, res) => {
    const { username, password } = req.body as {
      username: string;
      password: string;
    };
    const result = await authService.register(username, password);
    sendData(res, result, 201);
  }),
);

authRouter.post(
  '/login',
  strictLimiter,
  validateBody(loginBodySchema),
  asyncRoute(async (req, res) => {
    const { identifier, password } = req.body as {
      identifier: string;
      password: string;
    };
    const result = await authService.login(identifier, password);
    sendData(res, result);
  }),
);

authRouter.post(
  '/google',
  strictLimiter,
  validateBody(googleSignInBodySchema),
  asyncRoute(async (req, res) => {
    const { idToken } = req.body as { idToken: string };
    const result = await authService.signInWithGoogleIdToken(idToken);
    sendData(res, result, 200);
  }),
);

authRouter.post(
  '/apple',
  strictLimiter,
  validateBody(appleSignInBodySchema),
  asyncRoute(async (req, res) => {
    const { identityToken } = req.body as { identityToken: string };
    const result = await authService.signInWithAppleIdentityToken(identityToken);
    sendData(res, result, 200);
  }),
);

authRouter.post(
  '/forgot-password',
  strictLimiter,
  validateBody(forgotPasswordBodySchema),
  asyncRoute(async (req, res) => {
    const { email } = req.body as { email: string };
    await authService.forgotPassword(email);
    sendData(res, {
      ok: true,
      message:
        'If an account exists for this email, a reset code has been sent.',
    });
  }),
);

authRouter.post(
  '/verify-forgot-otp',
  strictLimiter,
  validateBody(verifyForgotOtpBodySchema),
  asyncRoute(async (req, res) => {
    const { email, code } = req.body as { email: string; code: string };
    const result = await authService.verifyForgotOtp(email, code);
    sendData(res, result);
  }),
);

authRouter.post(
  '/reset-password',
  strictLimiter,
  validateBody(resetPasswordBodySchema),
  asyncRoute(async (req, res) => {
    const { resetToken, newPassword } = req.body as {
      resetToken: string;
      newPassword: string;
    };
    const result = await authService.resetPassword(resetToken, newPassword);
    sendData(res, result);
  }),
);

authRouter.post(
  '/change-password',
  strictLimiter,
  requireAuth,
  validateBody(changePasswordBodySchema),
  asyncRoute(async (req, res) => {
    const { currentPassword, newPassword } = req.body as {
      currentPassword: string;
      newPassword: string;
    };
    const result = await authService.changePassword(
      req.auth!.userId,
      currentPassword,
      newPassword,
    );
    sendData(res, result);
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await authService.getProfile(req.auth!.userId);
    sendData(res, result);
  }),
);

/** `DELETE /api/v1/auth/me` — hard-delete the authenticated user's account. */
authRouter.delete(
  '/me',
  strictLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await authService.deleteAccount(req.auth!.userId);
    sendData(res, result);
  }),
);

authRouter.post(
  '/fill-profile',
  strictLimiter,
  requireAuth,
  validateBody(fillProfileBodySchema),
  asyncRoute(async (req, res) => {
    const result = await authService.fillProfile(
      req.auth!.userId,
      req.body as FillProfileBody,
    );
    sendData(res, result);
  }),
);

authRouter.get(
  '/username-available',
  strictLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    const parsed = usernameAvailableQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendData(res, { available: false, reason: 'invalid' });
      return;
    }
    const result = await authService.checkUsernameAvailability(
      req.auth!.userId,
      parsed.data.username,
    );
    sendData(res, result);
  }),
);

authRouter.post(
  '/complete-onboarding',
  strictLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await authService.markOnboardingComplete(req.auth!.userId);
    sendData(res, result);
  }),
);

authRouter.post(
  '/onboarding/interests',
  strictLimiter,
  requireAuth,
  validateBody(updateInterestsBodySchema),
  asyncRoute(async (req, res) => {
    const { interests } = req.body as { interests: string[] };
    const result = await authService.updateOnboardingInterests(
      req.auth!.userId,
      interests,
    );
    sendData(res, result);
  }),
);

authRouter.post(
  '/onboarding/gender',
  strictLimiter,
  requireAuth,
  validateBody(updateGenderBodySchema),
  asyncRoute(async (req, res) => {
    const { gender } = req.body as { gender: UserGender };
    const result = await authService.updateOnboardingGender(
      req.auth!.userId,
      gender,
    );
    sendData(res, result);
  }),
);

authRouter.post(
  '/onboarding/dob',
  strictLimiter,
  requireAuth,
  validateBody(updateDobBodySchema),
  asyncRoute(async (req, res) => {
    const { dateOfBirth } = req.body as { dateOfBirth: string };
    const result = await authService.updateOnboardingDob(
      req.auth!.userId,
      dateOfBirth,
    );
    sendData(res, result);
  }),
);

/**
 * Update the caller's privacy settings (e.g. private followers list).
 * `PATCH /api/v1/auth/me/privacy`
 */
authRouter.patch(
  '/me/privacy',
  strictLimiter,
  requireAuth,
  validateBody(updatePrivacyBodySchema),
  asyncRoute(async (req, res) => {
    const result = await authService.updatePrivacySettings(
      req.auth!.userId,
      req.body as UpdatePrivacyBody,
    );
    sendData(res, result);
  }),
);

/**
 * Get the caller's bank account.
 * `GET /api/v1/auth/me/bank-account`
 */
authRouter.get(
  '/me/bank-account',
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await authService.getBankAccount(req.auth!.userId);
    sendData(res, result);
  }),
);

/**
 * Save or update the caller's bank account.
 * `PUT /api/v1/auth/me/bank-account`
 */
authRouter.put(
  '/me/bank-account',
  strictLimiter,
  requireAuth,
  validateBody(saveBankAccountBodySchema),
  asyncRoute(async (req, res) => {
    const result = await authService.saveBankAccount(
      req.auth!.userId,
      req.body as SaveBankAccountBody,
    );
    sendData(res, result);
  }),
);

/**
 * Register/refresh the caller's FCM device token.
 * `POST /api/v1/auth/me/push-token`  body: { token: string }
 */
authRouter.post(
  '/me/push-token',
  strictLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    const { token } = (req.body ?? {}) as { token?: string };
    const result = await authService.registerPushToken(
      req.auth!.userId,
      token ?? '',
    );
    sendData(res, result);
  }),
);

/**
 * Clear the caller's FCM device token (called on logout).
 * `DELETE /api/v1/auth/me/push-token`
 */
authRouter.delete(
  '/me/push-token',
  strictLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await authService.clearPushToken(req.auth!.userId);
    sendData(res, result);
  }),
);
