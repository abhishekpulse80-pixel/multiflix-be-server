import rateLimit from 'express-rate-limit';
import { Router, type Request } from 'express';
import { env, isProd } from '../config/env.js';
import { asyncRoute } from '../lib/asyncRoute.js';
import { HttpError } from '../lib/httpError.js';
import { sendData } from '../lib/sendData.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { validateBody } from '../middleware/validateBody.js';
import {
  createAdBodySchema,
  patchAdBodySchema,
  type CreateAdBody,
  type PatchAdBody,
} from '../schemas/ad.schemas.js';
import {
  updateAppSettingBodySchema,
  type UpdateAppSettingBody,
} from '../schemas/appSetting.schemas.js';
import {
  sendBroadcastBodySchema,
  type SendBroadcastBody,
} from '../schemas/broadcast.schemas.js';
import {
  withdrawalDecisionBodySchema,
  withdrawalStatusFilterValues,
  type WithdrawalDecisionBody,
} from '../schemas/withdrawal.schemas.js';
import {
  updateEarningRateBodySchema,
  type UpdateEarningRateBody,
} from '../schemas/earningRate.schemas.js';
import {
  updateFeedbackStatusBodySchema,
  type UpdateFeedbackStatusBody,
} from '../schemas/feedback.schemas.js';
import {
  adminCreateArtistBodySchema,
  adminCreateMusicAlbumBodySchema,
  adminCreateMusicTrackBodySchema,
  adminPatchArtistBodySchema,
  type AdminCreateArtistBody,
  type AdminCreateMusicAlbumBody,
  type AdminCreateMusicTrackBody,
  type AdminPatchArtistBody,
} from '../schemas/music.schemas.js';
import {
  forgotPasswordBodySchema,
  resetPasswordBodySchema,
  verifyForgotOtpBodySchema,
} from '../schemas/auth.schemas.js';
import * as adminService from '../services/admin.service.js';
import * as appSettingService from '../services/appSetting.service.js';
import * as authService from '../services/auth.service.js';
import * as notificationService from '../services/notification.service.js';
import * as withdrawalService from '../services/withdrawal.service.js';

const rateLimitShared =
  !isProd && env.trustProxyHops === 0
    ? {
        validate: { xForwardedForHeader: false as const },
      }
    : {};

const readLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  ...rateLimitShared,
});

const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  ...rateLimitShared,
});

export const adminRouter = Router();

/* ------------------------------------------------------------------ */
/*  Public admin password-reset routes (must be defined BEFORE the     */
/*  requireAuth/requireAdmin middleware below).                        */
/*                                                                     */
/*  Email OTP flow for admins who forgot their password. The service   */
/*  layer rejects any email not belonging to role==='admin', so this   */
/*  cannot be used to reset regular user passwords.                    */
/* ------------------------------------------------------------------ */

adminRouter.post(
  '/auth/forgot-password',
  writeLimiter,
  validateBody(forgotPasswordBodySchema),
  asyncRoute(async (req, res) => {
    const { email } = req.body as { email: string };
    await authService.adminForgotPassword(email);
    sendData(res, {
      ok: true,
      message:
        'If an admin account exists for this email, a reset code has been sent.',
    });
  }),
);

adminRouter.post(
  '/auth/verify-forgot-otp',
  writeLimiter,
  validateBody(verifyForgotOtpBodySchema),
  asyncRoute(async (req, res) => {
    const { email, code } = req.body as { email: string; code: string };
    const result = await authService.adminVerifyForgotOtp(email, code);
    sendData(res, result);
  }),
);

adminRouter.post(
  '/auth/reset-password',
  writeLimiter,
  validateBody(resetPasswordBodySchema),
  asyncRoute(async (req, res) => {
    const { resetToken, newPassword } = req.body as {
      resetToken: string;
      newPassword: string;
    };
    const result = await authService.adminResetPassword(
      resetToken,
      newPassword,
    );
    sendData(res, result);
  }),
);

// All remaining admin routes require authentication + admin role
adminRouter.use(requireAuth, requireAdmin);

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function paginationParams(req: Request) {
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const limit = Math.min(
    100,
    Math.max(1, parseInt(req.query.limit as string, 10) || 20),
  );
  return { page, limit };
}

/* ------------------------------------------------------------------ */
/*  Stats                                                              */
/* ------------------------------------------------------------------ */

adminRouter.get(
  '/stats',
  readLimiter,
  asyncRoute(async (_req, res) => {
    const stats = await adminService.getStats();
    sendData(res, stats);
  }),
);

adminRouter.get(
  '/stats/timeseries',
  readLimiter,
  asyncRoute(async (req, res) => {
    const days = parseInt(req.query.days as string, 10) || 30;
    const data = await adminService.getTimeseries(days);
    sendData(res, data);
  }),
);

/* ------------------------------------------------------------------ */
/*  Screen Time & Payments                                             */
/* ------------------------------------------------------------------ */

adminRouter.get(
  '/screen-time-payments',
  readLimiter,
  asyncRoute(async (req, res) => {
    const { page, limit } = paginationParams(req);
    const search = (req.query.search as string) || undefined;
    const result = await adminService.listScreenTimePayments(
      page,
      limit,
      search,
    );
    sendData(res, result);
  }),
);

/* ------------------------------------------------------------------ */
/*  Users                                                              */
/* ------------------------------------------------------------------ */

adminRouter.get(
  '/users',
  readLimiter,
  asyncRoute(async (req, res) => {
    const { page, limit } = paginationParams(req);
    const search = (req.query.search as string) || undefined;
    const role = (req.query.role as string) || undefined;
    const result = await adminService.listUsers(page, limit, search, role);
    sendData(res, result);
  }),
);

adminRouter.get(
  '/users/:userId',
  readLimiter,
  asyncRoute(async (req, res) => {
    const userId = req.params.userId as string;
    const user = await adminService.getUserDetail(userId);
    sendData(res, user);
  }),
);

adminRouter.patch(
  '/users/:userId/role',
  writeLimiter,
  asyncRoute(async (req, res) => {
    const userId = req.params.userId as string;
    const { role } = req.body as { role: string };
    if (!role || !['user', 'admin'].includes(role)) {
      throw new HttpError(400, 'Invalid role', 'INVALID_ROLE');
    }
    const user = await adminService.updateUserRole(
      userId,
      role as 'user' | 'admin',
    );
    sendData(res, user);
  }),
);

adminRouter.patch(
  '/users/:userId/block',
  writeLimiter,
  asyncRoute(async (req, res) => {
    const userId = req.params.userId as string;
    const { isBlocked } = req.body as { isBlocked: boolean };
    if (typeof isBlocked !== 'boolean') {
      throw new HttpError(400, 'isBlocked must be a boolean', 'INVALID_BODY');
    }
    const user = await adminService.setUserBlocked(userId, isBlocked);
    sendData(res, user);
  }),
);

adminRouter.delete(
  '/users/:userId',
  writeLimiter,
  asyncRoute(async (req, res) => {
    const userId = req.params.userId as string;
    await adminService.deleteUser(userId);
    sendData(res, { deleted: true });
  }),
);

/* ------------------------------------------------------------------ */
/*  Posts                                                              */
/* ------------------------------------------------------------------ */

adminRouter.get(
  '/posts',
  readLimiter,
  asyncRoute(async (req, res) => {
    const { page, limit } = paginationParams(req);
    const search = (req.query.search as string) || undefined;
    const mediaKind = (req.query.mediaKind as string) || undefined;
    const result = await adminService.listPosts(page, limit, search, mediaKind);
    sendData(res, result);
  }),
);

adminRouter.get(
  '/posts/:postId',
  readLimiter,
  asyncRoute(async (req, res) => {
    const postId = req.params.postId as string;
    const post = await adminService.getPostDetail(postId);
    sendData(res, post);
  }),
);

adminRouter.delete(
  '/posts/:postId',
  writeLimiter,
  asyncRoute(async (req, res) => {
    const postId = req.params.postId as string;
    await adminService.deletePost(postId);
    sendData(res, { deleted: true });
  }),
);

/* ------------------------------------------------------------------ */
/*  Blogs                                                              */
/* ------------------------------------------------------------------ */

adminRouter.get(
  '/blogs',
  readLimiter,
  asyncRoute(async (req, res) => {
    const { page, limit } = paginationParams(req);
    const search = (req.query.search as string) || undefined;
    const result = await adminService.listBlogs(page, limit, search);
    sendData(res, result);
  }),
);

adminRouter.delete(
  '/blogs/:blogId',
  writeLimiter,
  asyncRoute(async (req, res) => {
    const blogId = req.params.blogId as string;
    await adminService.deleteBlog(blogId);
    sendData(res, { deleted: true });
  }),
);

/* ------------------------------------------------------------------ */
/*  Reports                                                            */
/* ------------------------------------------------------------------ */

adminRouter.get(
  '/reports',
  readLimiter,
  asyncRoute(async (req, res) => {
    const { page, limit } = paginationParams(req);
    const status = (req.query.status as string) || undefined;
    const result = await adminService.listReports(page, limit, status);
    sendData(res, result);
  }),
);

adminRouter.patch(
  '/reports/:reportId/status',
  writeLimiter,
  asyncRoute(async (req, res) => {
    const reportId = req.params.reportId as string;
    const { status } = req.body as { status: string };
    if (!status || !['pending', 'reviewed', 'resolved'].includes(status)) {
      throw new HttpError(400, 'Invalid status', 'INVALID_STATUS');
    }
    const report = await adminService.updateReportStatus(reportId, status);
    sendData(res, report);
  }),
);

/* ------------------------------------------------------------------ */
/*  Music                                                              */
/* ------------------------------------------------------------------ */

adminRouter.get(
  '/music',
  readLimiter,
  asyncRoute(async (req, res) => {
    const { page, limit } = paginationParams(req);
    const search = (req.query.search as string) || undefined;
    const result = await adminService.listMusic(page, limit, search);
    sendData(res, result);
  }),
);

adminRouter.get(
  '/music/albums/dropdown',
  readLimiter,
  asyncRoute(async (_req, res) => {
    const albums = await adminService.listAlbumsDropdown();
    sendData(res, albums);
  }),
);

adminRouter.post(
  '/music/albums',
  writeLimiter,
  validateBody(adminCreateMusicAlbumBodySchema),
  asyncRoute(async (req, res) => {
    const album = await adminService.createAlbum(
      req.body as AdminCreateMusicAlbumBody,
    );
    sendData(res, album, 201);
  }),
);

adminRouter.delete(
  '/music/albums/:albumId',
  writeLimiter,
  asyncRoute(async (req, res) => {
    const albumId = req.params.albumId as string;
    await adminService.deleteAlbum(albumId);
    sendData(res, { deleted: true });
  }),
);

adminRouter.get(
  '/music/tracks',
  readLimiter,
  asyncRoute(async (req, res) => {
    const { page, limit } = paginationParams(req);
    const search = (req.query.search as string) || undefined;
    const result = await adminService.listTracks(page, limit, search);
    sendData(res, result);
  }),
);

adminRouter.post(
  '/music/tracks',
  writeLimiter,
  validateBody(adminCreateMusicTrackBodySchema),
  asyncRoute(async (req, res) => {
    const track = await adminService.createTrack(
      req.body as AdminCreateMusicTrackBody,
    );
    sendData(res, track, 201);
  }),
);

adminRouter.delete(
  '/music/tracks/:trackId',
  writeLimiter,
  asyncRoute(async (req, res) => {
    const trackId = req.params.trackId as string;
    await adminService.deleteTrack(trackId);
    sendData(res, { deleted: true });
  }),
);

/* ------------------------------------------------------------------ */
/*  Music — Artists                                                    */
/* ------------------------------------------------------------------ */

adminRouter.get(
  '/music/artists',
  readLimiter,
  asyncRoute(async (req, res) => {
    const { page, limit } = paginationParams(req);
    const search = (req.query.search as string) || undefined;
    const result = await adminService.listArtists(page, limit, search);
    sendData(res, result);
  }),
);

adminRouter.get(
  '/music/artists/dropdown',
  readLimiter,
  asyncRoute(async (_req, res) => {
    const result = await adminService.listArtistsDropdown();
    sendData(res, result);
  }),
);

adminRouter.post(
  '/music/artists',
  writeLimiter,
  validateBody(adminCreateArtistBodySchema),
  asyncRoute(async (req, res) => {
    const artist = await adminService.createArtist(
      req.body as AdminCreateArtistBody,
    );
    sendData(res, artist, 201);
  }),
);

adminRouter.patch(
  '/music/artists/:artistId',
  writeLimiter,
  validateBody(adminPatchArtistBodySchema),
  asyncRoute(async (req, res) => {
    const artistId = req.params.artistId as string;
    const artist = await adminService.patchArtist(
      artistId,
      req.body as AdminPatchArtistBody,
    );
    sendData(res, artist);
  }),
);

adminRouter.delete(
  '/music/artists/:artistId',
  writeLimiter,
  asyncRoute(async (req, res) => {
    const artistId = req.params.artistId as string;
    await adminService.deleteArtist(artistId);
    sendData(res, { deleted: true });
  }),
);

/* ------------------------------------------------------------------ */
/*  Feedback                                                           */
/* ------------------------------------------------------------------ */

adminRouter.get(
  '/feedback',
  readLimiter,
  asyncRoute(async (req, res) => {
    const { page, limit } = paginationParams(req);
    const status = (req.query.status as string) || undefined;
    const result = await adminService.listFeedback(page, limit, status);
    sendData(res, result);
  }),
);

adminRouter.patch(
  '/feedback/:feedbackId/status',
  writeLimiter,
  validateBody(updateFeedbackStatusBodySchema),
  asyncRoute(async (req, res) => {
    const feedbackId = req.params.feedbackId as string;
    const feedback = await adminService.updateFeedbackStatus(
      feedbackId,
      req.body as UpdateFeedbackStatusBody,
    );
    sendData(res, feedback);
  }),
);

/* ------------------------------------------------------------------ */
/*  Ads                                                                */
/* ------------------------------------------------------------------ */

adminRouter.get(
  '/ads',
  readLimiter,
  asyncRoute(async (req, res) => {
    const { page, limit } = paginationParams(req);
    const status = (req.query.status as string) || undefined;
    const placement = (req.query.placement as string) || undefined;
    const result = await adminService.listAds(page, limit, status, placement);
    sendData(res, result);
  }),
);

adminRouter.post(
  '/ads',
  writeLimiter,
  validateBody(createAdBodySchema),
  asyncRoute(async (req, res) => {
    const ad = await adminService.createAd(req.body as CreateAdBody);
    sendData(res, ad, 201);
  }),
);

adminRouter.patch(
  '/ads/:adId',
  writeLimiter,
  validateBody(patchAdBodySchema),
  asyncRoute(async (req, res) => {
    const adId = req.params.adId as string;
    const ad = await adminService.patchAd(adId, req.body as PatchAdBody);
    sendData(res, ad);
  }),
);

adminRouter.delete(
  '/ads/:adId',
  writeLimiter,
  asyncRoute(async (req, res) => {
    const adId = req.params.adId as string;
    await adminService.deleteAd(adId);
    sendData(res, { deleted: true });
  }),
);

/* ------------------------------------------------------------------ */
/*  Earning Rates                                                      */
/* ------------------------------------------------------------------ */

adminRouter.get(
  '/earning-rates',
  readLimiter,
  asyncRoute(async (_req, res) => {
    const result = await adminService.listEarningRates();
    sendData(res, result);
  }),
);

adminRouter.patch(
  '/earning-rates/:section',
  writeLimiter,
  validateBody(updateEarningRateBodySchema),
  asyncRoute(async (req, res) => {
    const section = req.params.section as string;
    const rate = await adminService.updateEarningRate(
      section,
      req.body as UpdateEarningRateBody,
    );
    sendData(res, rate);
  }),
);

/* ------------------------------------------------------------------ */
/*  App Settings (generic key/value)                                   */
/* ------------------------------------------------------------------ */

/** `GET /admin/settings` — list all known app settings (seeds defaults on first read). */
adminRouter.get(
  '/settings',
  readLimiter,
  asyncRoute(async (_req, res) => {
    const result = await appSettingService.listAppSettings();
    sendData(res, result);
  }),
);

/** `PATCH /admin/settings/:key` — update a single known setting. */
adminRouter.patch(
  '/settings/:key',
  writeLimiter,
  validateBody(updateAppSettingBodySchema),
  asyncRoute(async (req, res) => {
    const key = req.params.key as string;
    const body = req.body as UpdateAppSettingBody;
    const setting = await appSettingService.updateAppSetting(key, body.value);
    sendData(res, setting);
  }),
);

/* ------------------------------------------------------------------ */
/*  Broadcast                                                          */
/* ------------------------------------------------------------------ */

/** `POST /admin/broadcast` — send a push to every subscribed client. */
adminRouter.post(
  '/broadcast',
  writeLimiter,
  validateBody(sendBroadcastBodySchema),
  asyncRoute(async (req, res) => {
    const body = req.body as SendBroadcastBody;
    const ok = await notificationService.sendBroadcast(body.title, body.body);
    if (!ok) {
      throw new HttpError(
        502,
        'Could not send broadcast. Check FCM configuration.',
        'BROADCAST_FAILED',
      );
    }
    sendData(res, { ok: true });
  }),
);

/* ------------------------------------------------------------------ */
/*  Withdrawal Requests                                                */
/* ------------------------------------------------------------------ */

function withdrawalIdParam(req: Request): string {
  const raw = req.params.id;
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (typeof id !== 'string' || id.length === 0) {
    throw new HttpError(400, 'Invalid withdrawal id', 'INVALID_WITHDRAWAL_ID');
  }
  return id;
}

/** `GET /admin/withdrawals?status=&page=&limit=` — paginated admin list. */
adminRouter.get(
  '/withdrawals',
  readLimiter,
  asyncRoute(async (req, res) => {
    const { page, limit } = paginationParams(req);
    const rawStatus = (req.query.status as string) || '';
    const status = (withdrawalStatusFilterValues as readonly string[]).includes(
      rawStatus,
    )
      ? (rawStatus as (typeof withdrawalStatusFilterValues)[number])
      : undefined;
    const result = await withdrawalService.listWithdrawalRequests(
      page,
      limit,
      status,
    );
    sendData(res, result);
  }),
);

/** `POST /admin/withdrawals/:id/approve` — approve a pending request. */
adminRouter.post(
  '/withdrawals/:id/approve',
  writeLimiter,
  validateBody(withdrawalDecisionBodySchema),
  asyncRoute(async (req, res) => {
    const id = withdrawalIdParam(req);
    const body = req.body as WithdrawalDecisionBody;
    const result = await withdrawalService.approveWithdrawalRequest(
      id,
      body.adminNote,
    );
    sendData(res, result);
  }),
);

/** `POST /admin/withdrawals/:id/reject` — reject a pending request. */
adminRouter.post(
  '/withdrawals/:id/reject',
  writeLimiter,
  validateBody(withdrawalDecisionBodySchema),
  asyncRoute(async (req, res) => {
    const id = withdrawalIdParam(req);
    const body = req.body as WithdrawalDecisionBody;
    const result = await withdrawalService.rejectWithdrawalRequest(
      id,
      body.adminNote,
    );
    sendData(res, result);
  }),
);
