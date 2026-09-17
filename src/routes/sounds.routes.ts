import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
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
import { OriginalSoundModel } from '../models/originalSound.model.js';

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

function recommendedAudioQuality(speedMbps: number): 'low' | 'medium' | 'high' {
  if (!Number.isFinite(speedMbps) || speedMbps < 0.5) return 'low';
  if (speedMbps < 1.5) return 'medium';
  return 'high';
}

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

/** `GET /api/v1/sounds/:soundId/audio-status?networkSpeedMbps=4` */
soundsRouter.get(
  '/:soundId/audio-status',
  readLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    const soundId = soundIdParam(req);
    if (!mongoose.isValidObjectId(soundId)) {
      throw new HttpError(400, 'Invalid sound id', 'INVALID_SOUND_ID');
    }
    const sound = await OriginalSoundModel.findById(soundId)
      .select('audioUrl audioProcessingStatus audioVariants audioProcessingError')
      .lean();
    if (!sound) {
      throw new HttpError(404, 'Original sound not found', 'ORIGINAL_SOUND_NOT_FOUND');
    }
    const rawSpeed = Number(req.query.networkSpeedMbps ?? 6);
    const quality = recommendedAudioQuality(rawSpeed);
    const recommended = sound.audioVariants?.find((variant) => variant.quality === quality);
    sendData(res, {
      soundId,
      status: sound.audioProcessingStatus ?? 'not_required',
      recommendedQuality: quality,
      recommendedUrl: recommended?.url ?? sound.audioUrl ?? null,
      variants: sound.audioVariants ?? [],
      error: sound.audioProcessingError ?? null,
    });
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
