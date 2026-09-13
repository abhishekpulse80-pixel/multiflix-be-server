import rateLimit from 'express-rate-limit';
import { Router, type Request } from 'express';
import { env, isProd } from '../config/env.js';
import { asyncRoute } from '../lib/asyncRoute.js';
import { HttpError } from '../lib/httpError.js';
import { sendData } from '../lib/sendData.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validateBody } from '../middleware/validateBody.js';
import {
  musicListQuerySchema,
  musicSearchQuerySchema,
  musicTrackFavouriteBodySchema,
} from '../schemas/music.schemas.js';
import * as musicService from '../services/music.service.js';

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

const playLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  ...rateLimitShared,
});

export const musicRouter = Router();

function albumIdParam(req: Request): string {
  const raw = req.params.albumId;
  const albumId = Array.isArray(raw) ? raw[0] : raw;
  if (typeof albumId !== 'string' || albumId.length === 0) {
    throw new HttpError(400, 'Invalid album id', 'INVALID_ALBUM_ID');
  }
  return albumId;
}

function trackIdParam(req: Request): string {
  const raw = req.params.trackId;
  const trackId = Array.isArray(raw) ? raw[0] : raw;
  if (typeof trackId !== 'string' || trackId.length === 0) {
    throw new HttpError(400, 'Invalid track id', 'INVALID_TRACK_ID');
  }
  return trackId;
}

function artistIdParam(req: Request): string {
  const raw = req.params.artistId;
  const artistId = Array.isArray(raw) ? raw[0] : raw;
  if (typeof artistId !== 'string' || artistId.length === 0) {
    throw new HttpError(400, 'Invalid artist id', 'INVALID_ARTIST_ID');
  }
  return artistId;
}

/**
 * Published albums for the music home carousel.
 * `GET /api/v1/music/albums?page=&limit=`
 */
musicRouter.get(
  '/albums',
  readLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const parsed = musicListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'Invalid query parameters',
        'VALIDATION_ERROR',
        parsed.error.flatten(),
      );
    }
    const data = await musicService.listPublishedMusicAlbums(parsed.data);
    sendData(res, data);
  }),
);

/**
 * Published tracks for “Recommend for you” (by streams, paginated).
 * `GET /api/v1/music/tracks/recommended?page=&limit=`
 */
musicRouter.get(
  '/tracks/recommended',
  readLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const parsed = musicListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'Invalid query parameters',
        'VALIDATION_ERROR',
        parsed.error.flatten(),
      );
    }
    const data = await musicService.listRecommendedMusicTracks(
      parsed.data,
      req.auth.userId,
    );
    sendData(res, data);
  }),
);

/**
 * Single track by id with the viewer's favourite flag. Defined after
 * `/tracks/recommended` so that literal path is matched first.
 * `GET /api/v1/music/tracks/:trackId`
 */
musicRouter.get(
  '/tracks/:trackId',
  readLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const trackId = trackIdParam(req);
    const data = await musicService.getMusicTrackById(
      trackId,
      req.auth.userId,
    );
    sendData(res, data);
  }),
);

/**
 * Search published tracks + albums by title/artist (case-insensitive).
 * `GET /api/v1/music/search?q=&limit=`
 */
musicRouter.get(
  '/search',
  readLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const parsed = musicSearchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'Invalid query parameters',
        'VALIDATION_ERROR',
        parsed.error.flatten(),
      );
    }
    const data = await musicService.searchMusic(parsed.data, req.auth.userId);
    sendData(res, data);
  }),
);

/**
 * Viewer's favourited tracks (most recent first).
 * `GET /api/v1/music/favourites?page=&limit=`
 */
musicRouter.get(
  '/favourites',
  readLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const parsed = musicListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'Invalid query parameters',
        'VALIDATION_ERROR',
        parsed.error.flatten(),
      );
    }
    const data = await musicService.listMusicFavourites(
      req.auth.userId,
      parsed.data,
    );
    sendData(res, data);
  }),
);

/**
 * Record a play on a track (fired by the client after ~3s of playback).
 * `POST /api/v1/music/tracks/:trackId/play`
 */
musicRouter.post(
  '/tracks/:trackId/play',
  playLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const trackId = trackIdParam(req);
    const data = await musicService.recordMusicTrackPlay(trackId);
    sendData(res, data);
  }),
);

/**
 * Toggle favourite on a track. Idempotent.
 * `POST /api/v1/music/tracks/:trackId/favourite` body `{ favourited: boolean }`
 */
musicRouter.post(
  '/tracks/:trackId/favourite',
  writeLimiter,
  requireAuth,
  validateBody(musicTrackFavouriteBodySchema),
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const trackId = trackIdParam(req);
    const { favourited } = req.body as { favourited: boolean };
    const data = await musicService.setMusicTrackFavourite(
      req.auth.userId,
      trackId,
      favourited,
    );
    sendData(res, data);
  }),
);

/**
 * Album artist block + ordered tracks.
 * `GET /api/v1/music/albums/:albumId`
 */
musicRouter.get(
  '/albums/:albumId',
  readLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const albumId = albumIdParam(req);
    const data = await musicService.getPublishedMusicAlbumById(
      albumId,
      req.auth.userId,
    );
    sendData(res, data);
  }),
);

/**
 * Published artists for the music tab horizontal carousel.
 * `GET /api/v1/music/artists?page=&limit=`
 */
musicRouter.get(
  '/artists',
  readLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const parsed = musicListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'Invalid query parameters',
        'VALIDATION_ERROR',
        parsed.error.flatten(),
      );
    }
    const data = await musicService.listPublishedArtists(parsed.data);
    sendData(res, data);
  }),
);

/**
 * Artist profile + their published albums + most-streamed tracks.
 * `GET /api/v1/music/artists/:artistId`
 */
musicRouter.get(
  '/artists/:artistId',
  readLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const artistId = artistIdParam(req);
    const data = await musicService.getPublishedArtistById(
      artistId,
      req.auth.userId,
    );
    sendData(res, data);
  }),
);
