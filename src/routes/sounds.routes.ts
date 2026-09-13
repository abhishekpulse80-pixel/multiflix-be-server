import rateLimit from 'express-rate-limit';
import { Router, type Request } from 'express';
import { env, isProd } from '../config/env.js';
import { asyncRoute } from '../lib/asyncRoute.js';
import { HttpError } from '../lib/httpError.js';
import { sendData } from '../lib/sendData.js';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  soundPostsQuerySchema,
  soundsListQuerySchema,
} from '../schemas/sounds.schemas.js';
import * as originalSoundService from '../services/originalSound.service.js';

const rateLimitShared =
  !isProd && env.trustProxyHops === 0
    ? { validate: { xForwardedForHeader: false as const } }
    : {};

const readLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  ...rateLimitShared,
});

export const soundsRouter = Router();

function soundIdParam(req: Request): string {
  const raw = req.params.soundId;
  const soundId = Array.isArray(raw) ? raw[0] : raw;
  if (typeof soundId !== 'string' || soundId.length === 0) {
    throw new HttpError(400, 'Invalid sound id', 'INVALID_SOUND_ID');
  }
  return soundId;
}

/** `GET /api/v1/sounds` — paginated browse of ready + public original sounds. */
soundsRouter.get(
  '/',
  readLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const parsed = soundsListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'Invalid query parameters',
        'VALIDATION_ERROR',
        parsed.error.flatten(),
      );
    }
    const { page, limit } = parsed.data;
    const data = await originalSoundService.listPublishedOriginalSounds(
      page,
      limit,
    );
    sendData(res, data);
  }),
);

/** `GET /api/v1/sounds/:soundId` — single original sound detail. */
soundsRouter.get(
  '/:soundId',
  readLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const soundId = soundIdParam(req);
    const data = await originalSoundService.getOriginalSoundById(soundId);
    sendData(res, data);
  }),
);

/** `GET /api/v1/sounds/:soundId/posts` — posts that reuse this sound. */
soundsRouter.get(
  '/:soundId/posts',
  readLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const soundId = soundIdParam(req);
    const parsed = soundPostsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'Invalid query parameters',
        'VALIDATION_ERROR',
        parsed.error.flatten(),
      );
    }
    const { page, limit } = parsed.data;
    const data = await originalSoundService.listPostsUsingOriginalSound(
      soundId,
      page,
      limit,
    );
    sendData(res, data);
  }),
);
