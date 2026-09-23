import rateLimit from 'express-rate-limit';
import { Router, type Request } from 'express';
import { env, isProd } from '../config/env.js';
import { asyncRoute } from '../lib/asyncRoute.js';
import { HttpError } from '../lib/httpError.js';
import { sendData } from '../lib/sendData.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { publicProfileMediaQuerySchema } from '../schemas/profile.schemas.js';
import { userSearchQuerySchema } from '../schemas/userSearch.schemas.js';
import * as followService from '../services/follow.service.js';
import * as userBlockService from '../services/userBlock.service.js';
import { searchUsers } from '../services/userSearch.service.js';
import {
  getUserIdByUsername,
  getUserPublicProfile,
  listUserPublicBlogs,
  listUserPublicPosts,
} from '../services/userPublicProfile.service.js';

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

export const usersRouter = Router();

/**
 * Search onboarded users by username / full name (substring, case-insensitive).
 * Must stay above `/:userId/...` routes so `search` is not captured as a user id.
 * `GET /api/v1/users/search?q=&limit=`
 */
usersRouter.get(
  '/search',
  readLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const parsed = userSearchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'Invalid query parameters',
        'VALIDATION_ERROR',
        parsed.error.flatten(),
      );
    }
    const data = await searchUsers(
      req.auth.userId,
      parsed.data.q,
      parsed.data.limit,
    );
    sendData(res, data);
  }),
);

/**
 * Search connections (people I follow / who follow me) by username or fullName.
 * `GET /api/v1/users/connections/search?q=&limit=`
 */
usersRouter.get(
  '/connections/search',
  readLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const data = await followService.searchConnections(req.auth.userId, q, limit);
    sendData(res, data);
  }),
);

/**
 * List users blocked by the authenticated viewer (paginated).
 * `GET /api/v1/users/blocks?page=0&limit=30`
 * Must stay above `/:userId/...` routes.
 */
usersRouter.get(
  '/blocks',
  readLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const page = Math.max(0, Number(req.query.page) || 0);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 30));
    const data = await userBlockService.listBlockedUsers(
      req.auth.userId,
      page,
      limit,
    );
    sendData(res, data);
  }),
);

function userIdParam(req: Request): string {
  const raw = req.params.userId;
  const userId = Array.isArray(raw) ? raw[0] : raw;
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new HttpError(400, 'Invalid user id', 'INVALID_USER_ID');
  }
  return userId;
}

/**
 * Start following a user immediately (no pending state). Idempotent.
 * `POST /api/v1/users/:userId/follow`
 */
usersRouter.post(
  '/:userId/follow',
  writeLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const userId = userIdParam(req);
    const result = await followService.followUser(req.auth.userId, userId);
    sendData(res, result);
  }),
);

/**
 * Stop following a user. Idempotent.
 * `DELETE /api/v1/users/:userId/follow`
 */
usersRouter.delete(
  '/:userId/follow',
  writeLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const userId = userIdParam(req);
    const result = await followService.unfollowUser(req.auth.userId, userId);
    sendData(res, result);
  }),
);

/**
 * Block a user. Idempotent. Tears down follow edges in both directions.
 * `POST /api/v1/users/:userId/block`
 */
usersRouter.post(
  '/:userId/block',
  writeLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const userId = userIdParam(req);
    const result = await userBlockService.blockUser(req.auth.userId, userId);
    sendData(res, result);
  }),
);

/**
 * Unblock a user. Idempotent. Does not restore follows.
 * `DELETE /api/v1/users/:userId/block`
 */
usersRouter.delete(
  '/:userId/block',
  writeLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const userId = userIdParam(req);
    const result = await userBlockService.unblockUser(req.auth.userId, userId);
    sendData(res, result);
  }),
);

/**
 * List followers of a user (paginated).
 * `GET /api/v1/users/:userId/followers?page=0&limit=30`
 */
usersRouter.get(
  '/:userId/followers',
  readLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const userId = userIdParam(req);
    const page = Math.max(0, Number(req.query.page) || 0);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 30));
    const result = await followService.listFollowers(userId, req.auth.userId, page, limit);
    sendData(res, result);
  }),
);

/**
 * List users that `:userId` follows (paginated).
 * `GET /api/v1/users/:userId/following?page=0&limit=30`
 */
usersRouter.get(
  '/:userId/following',
  readLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const userId = userIdParam(req);
    const page = Math.max(0, Number(req.query.page) || 0);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 30));
    const result = await followService.listFollowing(userId, req.auth.userId, page, limit);
    sendData(res, result);
  }),
);

/**
 * Resolve a @username to its userId — used to open a shared profile deep
 * link (multiflix.in/u/<username>) inside the app. Declared before the
 * `/:userId/...` routes so the literal path matches first.
 * `GET /api/v1/users/by-username/:username`
 */
usersRouter.get(
  '/by-username/:username',
  readLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const raw = req.params.username;
    const username = Array.isArray(raw) ? raw[0] : raw;
    const result = await getUserIdByUsername(String(username ?? ''));
    sendData(res, result);
  }),
);

/**
 * Public profile metadata for website/social previews.
 * `GET /api/v1/users/public/by-username/:username`
 */
usersRouter.get(
  '/public/by-username/:username',
  readLimiter,
  asyncRoute(async (req, res) => {
    const raw = req.params.username;
    const username = Array.isArray(raw) ? raw[0] : raw;
    const { userId } = await getUserIdByUsername(String(username ?? ''));
    const profile = await getUserPublicProfile(userId, null);
    sendData(res, { profile });
  }),
);

/**
 * Authenticated viewer fetches another user's public profile (no email / phone / address).
 * `GET /api/v1/users/:userId/public`
 */
usersRouter.get(
  '/:userId/public',
  readLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const userId = userIdParam(req);
    const profile = await getUserPublicProfile(userId, req.auth.userId);
    sendData(res, { profile });
  }),
);

usersRouter.get(
  '/:userId/public/posts',
  readLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const userId = userIdParam(req);
    const parsed = publicProfileMediaQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'Invalid query parameters',
        'VALIDATION_ERROR',
        parsed.error.flatten(),
      );
    }
    const data = await listUserPublicPosts(userId, parsed.data, req.auth.userId);
    sendData(res, data);
  }),
);

usersRouter.get(
  '/:userId/public/blogs',
  readLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const userId = userIdParam(req);
    const parsed = publicProfileMediaQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'Invalid query parameters',
        'VALIDATION_ERROR',
        parsed.error.flatten(),
      );
    }
    const data = await listUserPublicBlogs(userId, parsed.data, req.auth.userId);
    sendData(res, data);
  }),
);
