import rateLimit from 'express-rate-limit';
import { Router } from 'express';
import { env, isProd } from '../config/env.js';
import { asyncRoute } from '../lib/asyncRoute.js';
import { sendData } from '../lib/sendData.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validateBody } from '../middleware/validateBody.js';
import {
  recordScreenTimeBodySchema,
  type RecordScreenTimeBody,
} from '../schemas/earnings.schemas.js';
import * as earningsService from '../services/earnings.service.js';

const rateLimitShared =
  !isProd && env.trustProxyHops === 0
    ? {
        validate: { xForwardedForHeader: false as const },
      }
    : {};

/** Client flushes every ~5 minutes; allow generous headroom for retries. */
const flushLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  ...rateLimitShared,
});

const readLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  ...rateLimitShared,
});

export const earningsRouter = Router();

earningsRouter.use(requireAuth);

/** POST /earnings/me/screen-time — credit buffered minutes for the signed-in user. */
earningsRouter.post(
  '/me/screen-time',
  flushLimiter,
  validateBody(recordScreenTimeBodySchema),
  asyncRoute(async (req, res) => {
    const result = await earningsService.recordScreenTime(
      req.auth!.userId,
      req.body as RecordScreenTimeBody,
    );
    sendData(res, result);
  }),
);

/** GET /earnings/me/wallet — current cached wallet balance. */
earningsRouter.get(
  '/me/wallet',
  readLimiter,
  asyncRoute(async (req, res) => {
    const wallet = await earningsService.getWallet(req.auth!.userId);
    sendData(res, wallet);
  }),
);

/** GET /earnings/me/screen-time?days=7 — per-day minutes for the last N days. */
earningsRouter.get(
  '/me/screen-time',
  readLimiter,
  asyncRoute(async (req, res) => {
    const days = parseInt(req.query.days as string, 10) || 7;
    const result = await earningsService.getScreenTime(
      req.auth!.userId,
      days,
    );
    sendData(res, result);
  }),
);

/** GET /earnings/me/transactions?page=&limit= — paginated history. */
earningsRouter.get(
  '/me/transactions',
  readLimiter,
  asyncRoute(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(
      50,
      Math.max(1, parseInt(req.query.limit as string, 10) || 20),
    );
    const result = await earningsService.listTransactions(
      req.auth!.userId,
      page,
      limit,
    );
    sendData(res, result);
  }),
);
