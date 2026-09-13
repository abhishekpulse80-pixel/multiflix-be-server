import rateLimit from 'express-rate-limit';
import { Router } from 'express';
import { env, isProd } from '../config/env.js';
import { asyncRoute } from '../lib/asyncRoute.js';
import { sendData } from '../lib/sendData.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validateBody } from '../middleware/validateBody.js';
import { createFeedbackBodySchema, } from '../schemas/feedback.schemas.js';
import * as feedbackService from '../services/feedback.service.js';
const rateLimitShared = !isProd && env.trustProxyHops === 0
    ? {
        validate: { xForwardedForHeader: false },
    }
    : {};
const writeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    ...rateLimitShared,
});
const readLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    ...rateLimitShared,
});
export const feedbackRouter = Router();
feedbackRouter.use(requireAuth);
/** POST /feedback — submit feedback */
feedbackRouter.post('/', writeLimiter, validateBody(createFeedbackBodySchema), asyncRoute(async (req, res) => {
    const feedback = await feedbackService.createFeedback(req.auth.userId, req.body);
    sendData(res, feedback, 201);
}));
/** GET /feedback — list own feedback */
feedbackRouter.get('/', readLimiter, asyncRoute(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const result = await feedbackService.listUserFeedback(req.auth.userId, page, limit);
    sendData(res, result);
}));
