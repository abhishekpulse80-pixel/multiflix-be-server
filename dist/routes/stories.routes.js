import rateLimit from 'express-rate-limit';
import { Router } from 'express';
import { env, isProd } from '../config/env.js';
import { asyncRoute } from '../lib/asyncRoute.js';
import { HttpError } from '../lib/httpError.js';
import { sendData } from '../lib/sendData.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validateBody } from '../middleware/validateBody.js';
import { createStoryBodySchema, recordStoryViewBodySchema, storyFeedQuerySchema, storyReactBodySchema, } from '../schemas/stories.schemas.js';
import * as storyService from '../services/story.service.js';
const rateLimitShared = !isProd && env.trustProxyHops === 0
    ? { validate: { xForwardedForHeader: false } }
    : {};
const strictLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    ...rateLimitShared,
});
const readLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 180,
    standardHeaders: true,
    legacyHeaders: false,
    ...rateLimitShared,
});
export const storiesRouter = Router();
function storyIdParam(req) {
    const raw = req.params.storyId;
    const id = Array.isArray(raw) ? raw[0] : raw;
    if (typeof id !== 'string' || id.length === 0) {
        throw new HttpError(400, 'Invalid story id', 'INVALID_STORY_ID');
    }
    return id;
}
/**
 * Publish a new story.
 * `POST /api/v1/stories`
 */
storiesRouter.post('/', strictLimiter, requireAuth, validateBody(createStoryBodySchema), asyncRoute(async (req, res) => {
    if (!req.auth) {
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const body = req.body;
    const story = await storyService.createStory(req.auth.userId, body);
    sendData(res, { story }, 201);
}));
/**
 * Paginated feed of all active stories (newest first).
 * `GET /api/v1/stories/feed?page=&limit=`
 */
storiesRouter.get('/feed', readLimiter, requireAuth, asyncRoute(async (req, res) => {
    if (!req.auth) {
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const parsed = storyFeedQuerySchema.safeParse(req.query);
    if (!parsed.success) {
        throw new HttpError(400, 'Invalid query parameters', 'VALIDATION_ERROR', parsed.error.flatten());
    }
    const data = await storyService.listStoryFeed(parsed.data, req.auth.userId);
    sendData(res, data);
}));
/**
 * Active stories from users in the caller's follow network, grouped by author.
 * `GET /api/v1/stories/connections`
 */
storiesRouter.get('/connections', readLimiter, requireAuth, asyncRoute(async (req, res) => {
    if (!req.auth) {
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const data = await storyService.listConnectionStories(req.auth.userId);
    sendData(res, data);
}));
/**
 * Trending active stories — one ring per author, ranked by most-viewed story.
 * `GET /api/v1/stories/trending`
 */
storiesRouter.get('/trending', readLimiter, requireAuth, asyncRoute(async (req, res) => {
    if (!req.auth) {
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const data = await storyService.listTrendingStories(undefined, req.auth.userId);
    sendData(res, data);
}));
/**
 * All active stories by a specific user (profile ring).
 * `GET /api/v1/stories/user/:userId`
 */
storiesRouter.get('/user/:userId', readLimiter, requireAuth, asyncRoute(async (req, res) => {
    if (!req.auth) {
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const raw = req.params.userId;
    const userId = Array.isArray(raw) ? raw[0] : raw;
    if (typeof userId !== 'string' || userId.length === 0) {
        throw new HttpError(400, 'Invalid user id', 'INVALID_USER_ID');
    }
    const data = await storyService.listUserStories(userId, req.auth.userId);
    sendData(res, data);
}));
/**
 * Single story by ID.
 * `GET /api/v1/stories/:storyId`
 */
storiesRouter.get('/:storyId', readLimiter, requireAuth, asyncRoute(async (req, res) => {
    if (!req.auth) {
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const storyId = storyIdParam(req);
    const story = await storyService.getStory(storyId, req.auth.userId);
    sendData(res, { story });
}));
/**
 * Record a distinct view on a story (skips if viewer is the author).
 * `POST /api/v1/stories/:storyId/view`
 */
storiesRouter.post('/:storyId/view', strictLimiter, requireAuth, validateBody(recordStoryViewBodySchema), asyncRoute(async (req, res) => {
    if (!req.auth) {
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const storyId = storyIdParam(req);
    const result = await storyService.recordStoryView(storyId, req.auth.userId);
    sendData(res, result);
}));
/**
 * List distinct viewers of a story (author-only).
 * `GET /api/v1/stories/:storyId/viewers`
 */
storiesRouter.get('/:storyId/viewers', readLimiter, requireAuth, asyncRoute(async (req, res) => {
    if (!req.auth) {
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const storyId = storyIdParam(req);
    const result = await storyService.getStoryViewers(storyId, req.auth.userId);
    sendData(res, result);
}));
/**
 * Send or toggle a reaction on a story.
 * `POST /api/v1/stories/:storyId/react`
 */
storiesRouter.post('/:storyId/react', strictLimiter, requireAuth, validateBody(storyReactBodySchema), asyncRoute(async (req, res) => {
    if (!req.auth) {
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const storyId = storyIdParam(req);
    const { reaction } = req.body;
    const result = await storyService.reactToStory(storyId, req.auth.userId, reaction);
    sendData(res, result);
}));
/**
 * Get aggregated reaction counts + viewer's reaction for a story.
 * `GET /api/v1/stories/:storyId/reactions`
 */
storiesRouter.get('/:storyId/reactions', readLimiter, requireAuth, asyncRoute(async (req, res) => {
    if (!req.auth) {
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const storyId = storyIdParam(req);
    const result = await storyService.getStoryReactions(storyId, req.auth.userId);
    sendData(res, result);
}));
/**
 * Delete the caller's own story.
 * `DELETE /api/v1/stories/:storyId`
 */
storiesRouter.delete('/:storyId', strictLimiter, requireAuth, asyncRoute(async (req, res) => {
    if (!req.auth) {
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const storyId = storyIdParam(req);
    await storyService.deleteStory(req.auth.userId, storyId);
    sendData(res, { deleted: true });
}));
