import rateLimit from 'express-rate-limit';
import { Router, type Request } from 'express';
import { env, isProd } from '../config/env.js';
import { asyncRoute } from '../lib/asyncRoute.js';
import { HttpError } from '../lib/httpError.js';
import { sendData } from '../lib/sendData.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { listNotificationsQuerySchema } from '../schemas/notifications.schemas.js';
import * as notificationService from '../services/notification.service.js';

const rateLimitShared =
  !isProd && env.trustProxyHops === 0
    ? {
        validate: { xForwardedForHeader: false as const },
      }
    : {};

const readLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 180,
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

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

function notificationIdParam(req: Request): string {
  const raw = req.params.notificationId;
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (typeof id !== 'string' || id.length === 0) {
    throw new HttpError(
      400,
      'Invalid notification id',
      'INVALID_NOTIFICATION_ID',
    );
  }
  return id;
}

/** `GET /notifications` — paginated inbox, newest first. */
notificationsRouter.get(
  '/',
  readLimiter,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const parsed = listNotificationsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'Invalid query parameters',
        'VALIDATION_ERROR',
        parsed.error.flatten(),
      );
    }
    const data = await notificationService.listForUser(
      req.auth.userId,
      parsed.data.page,
      parsed.data.limit,
    );
    sendData(res, data);
  }),
);

/** `GET /notifications/unread-count` — unread count for the authenticated user. */
notificationsRouter.get(
  '/unread-count',
  readLimiter,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const count = await notificationService.getUnreadCount(req.auth.userId);
    sendData(res, { count });
  }),
);

/** `PATCH /notifications/read-all` — mark all unread notifications as read. */
notificationsRouter.patch(
  '/read-all',
  writeLimiter,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const modified = await notificationService.markAllAsRead(req.auth.userId);
    sendData(res, { modified });
  }),
);

/** `PATCH /notifications/:notificationId/read` — mark a single notification as read. */
notificationsRouter.patch(
  '/:notificationId/read',
  writeLimiter,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const id = notificationIdParam(req);
    await notificationService.markAsRead(req.auth.userId, id);
    sendData(res, { ok: true });
  }),
);
