import rateLimit from 'express-rate-limit';
import { Router } from 'express';
import { env, isProd } from '../config/env.js';
import { asyncRoute } from '../lib/asyncRoute.js';
import { HttpError } from '../lib/httpError.js';
import { sendData } from '../lib/sendData.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validateBody } from '../middleware/validateBody.js';
import {
  createWithdrawalRequestBodySchema,
  type CreateWithdrawalRequestBody,
} from '../schemas/withdrawal.schemas.js';
import * as withdrawalService from '../services/withdrawal.service.js';

const rateLimitShared =
  !isProd && env.trustProxyHops === 0
    ? {
        validate: { xForwardedForHeader: false as const },
      }
    : {};

const readLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  ...rateLimitShared,
});

/** Writes are tight — don't let a buggy client spam withdrawal attempts. */
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  ...rateLimitShared,
});

export const withdrawalsRouter = Router();

withdrawalsRouter.use(requireAuth);

/** `GET /withdrawals/settings` — `{ minimumAmount }` (INR). */
withdrawalsRouter.get(
  '/settings',
  readLimiter,
  asyncRoute(async (_req, res) => {
    const result = await withdrawalService.getWithdrawalSettings();
    sendData(res, result);
  }),
);

/** `GET /withdrawals/mine?page=&limit=` — caller's own request history. */
withdrawalsRouter.get(
  '/mine',
  readLimiter,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const page = Math.max(0, parseInt(req.query.page as string, 10) || 0);
    const limit = Math.min(
      50,
      Math.max(1, parseInt(req.query.limit as string, 10) || 20),
    );
    const result = await withdrawalService.listMyWithdrawalRequests(
      req.auth.userId,
      page,
      limit,
    );
    sendData(res, result);
  }),
);

/** `POST /withdrawals` — user places a withdrawal request. */
withdrawalsRouter.post(
  '/',
  writeLimiter,
  validateBody(createWithdrawalRequestBodySchema),
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const body = req.body as CreateWithdrawalRequestBody;
    const result = await withdrawalService.createWithdrawalRequest(
      req.auth.userId,
      body.amount,
    );
    sendData(res, result, 201);
  }),
);
