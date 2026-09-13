import rateLimit from 'express-rate-limit';
import { Router } from 'express';
import { env, isProd } from '../config/env.js';
import { asyncRoute } from '../lib/asyncRoute.js';
import { HttpError } from '../lib/httpError.js';
import { sendData } from '../lib/sendData.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validateBody } from '../middleware/validateBody.js';
import { commentListQuerySchema, createCommentBodySchema, } from '../schemas/comments.schemas.js';
import { createPostBodySchema, hashtagPostsQuerySchema, homeFeedQuerySchema, musicPostsQuerySchema, postLikeBodySchema, postSaveBodySchema, recordPostViewsBodySchema, savedPostsQuerySchema, } from '../schemas/posts.schemas.js';
import { createReportBodySchema } from '../schemas/reports.schemas.js';
import * as commentService from '../services/comment.service.js';
import * as postService from '../services/post.service.js';
import * as reportService from '../services/report.service.js';
const rateLimitShared = !isProd && env.trustProxyHops === 0
    ? {
        validate: { xForwardedForHeader: false },
    }
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
export const postsRouter = Router();
function postIdParam(req) {
    const raw = req.params.postId;
    const postId = Array.isArray(raw) ? raw[0] : raw;
    if (typeof postId !== 'string' || postId.length === 0) {
        throw new HttpError(400, 'Invalid post id', 'INVALID_POST_ID');
    }
    return postId;
}
/**
 * Trending posts by most likes (max 6).
 * `GET /api/v1/posts/trending`
 */
postsRouter.get('/trending', readLimiter, requireAuth, asyncRoute(async (req, res) => {
    if (!req.auth) {
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const rawLimit = Number(req.query.limit);
    const data = await postService.listTrendingPosts(req.auth.userId, {
        limit: Number.isFinite(rawLimit) ? rawLimit : undefined,
    });
    sendData(res, data);
}));
postsRouter.get('/feed', readLimiter, requireAuth, asyncRoute(async (req, res) => {
    if (!req.auth) {
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const parsed = homeFeedQuerySchema.safeParse(req.query);
    if (!parsed.success) {
        throw new HttpError(400, 'Invalid query parameters', 'VALIDATION_ERROR', parsed.error.flatten());
    }
    const feed = await postService.listHomeFeed(parsed.data, req.auth.userId);
    sendData(res, feed);
}));
/**
 * Paginated list of posts containing a hashtag (caption or hashtags field).
 * `GET /api/v1/posts/hashtag/:tag?page=&limit=`
 */
postsRouter.get('/hashtag/:tag', readLimiter, requireAuth, asyncRoute(async (req, res) => {
    if (!req.auth) {
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const raw = req.params.tag;
    const tag = Array.isArray(raw) ? raw[0] : raw;
    if (typeof tag !== 'string' || tag.length === 0) {
        throw new HttpError(400, 'Invalid hashtag', 'INVALID_HASHTAG');
    }
    const parsed = hashtagPostsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
        throw new HttpError(400, 'Invalid query parameters', 'VALIDATION_ERROR', parsed.error.flatten());
    }
    const data = await postService.listPostsByHashtag(tag, parsed.data, req.auth.userId);
    sendData(res, data);
}));
/**
 * Paginated list of posts using a given music track.
 * `GET /api/v1/posts/music/:trackId?page=&limit=`
 */
postsRouter.get('/music/:trackId', readLimiter, requireAuth, asyncRoute(async (req, res) => {
    if (!req.auth) {
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const raw = req.params.trackId;
    const trackId = Array.isArray(raw) ? raw[0] : raw;
    if (typeof trackId !== 'string' || trackId.length === 0) {
        throw new HttpError(400, 'Invalid music track id', 'INVALID_MUSIC_TRACK_ID');
    }
    const parsed = musicPostsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
        throw new HttpError(400, 'Invalid query parameters', 'VALIDATION_ERROR', parsed.error.flatten());
    }
    const data = await postService.listPostsByMusicTrack(trackId, parsed.data, req.auth.userId);
    sendData(res, data);
}));
/**
 * Paginated list of the posts the authenticated viewer has saved (bookmarked).
 * Literal segment — declared before `/:postId/*` so it is never shadowed.
 * `GET /api/v1/posts/saved?page=&limit=`
 */
postsRouter.get('/saved', readLimiter, requireAuth, asyncRoute(async (req, res) => {
    if (!req.auth) {
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const parsed = savedPostsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
        throw new HttpError(400, 'Invalid query parameters', 'VALIDATION_ERROR', parsed.error.flatten());
    }
    const data = await postService.listSavedPosts(req.auth.userId, parsed.data);
    sendData(res, data);
}));
/**
 * Like (`{ "liked": true }`) or remove like (`{ "liked": false }`). Single endpoint, idempotent.
 * `POST /api/v1/posts/:postId/like`
 */
postsRouter.post('/:postId/like', strictLimiter, requireAuth, validateBody(postLikeBodySchema), asyncRoute(async (req, res) => {
    if (!req.auth) {
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const postId = postIdParam(req);
    const { liked } = req.body;
    const result = await postService.setPostLike(req.auth.userId, postId, liked);
    sendData(res, result);
}));
/**
 * Save (`{ "saved": true }`) or remove bookmark (`{ "saved": false }`). Single endpoint, idempotent.
 * `POST /api/v1/posts/:postId/save`
 */
postsRouter.post('/:postId/save', strictLimiter, requireAuth, validateBody(postSaveBodySchema), asyncRoute(async (req, res) => {
    if (!req.auth) {
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const postId = postIdParam(req);
    const { saved } = req.body;
    const result = await postService.setPostSave(req.auth.userId, postId, saved);
    sendData(res, result);
}));
/**
 * Mark a batch of posts as seen in the home feed (so they're excluded from
 * future feed pages). Literal segment — declared before `/:postId/*`.
 * `POST /api/v1/posts/views` — body `{ postIds: string[] }`
 */
postsRouter.post('/views', readLimiter, requireAuth, validateBody(recordPostViewsBodySchema), asyncRoute(async (req, res) => {
    if (!req.auth) {
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const { postIds } = req.body;
    const result = await postService.recordPostViews(req.auth.userId, postIds);
    sendData(res, result);
}));
/**
 * Paginated comments for a post (oldest first: page 0 = start of thread).
 * `GET /api/v1/posts/:postId/comments?page=&limit=`
 */
postsRouter.get('/:postId/comments', readLimiter, requireAuth, asyncRoute(async (req, res) => {
    if (!req.auth) {
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const postId = postIdParam(req);
    const parsed = commentListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
        throw new HttpError(400, 'Invalid query parameters', 'VALIDATION_ERROR', parsed.error.flatten());
    }
    const data = await commentService.listComments(postId, parsed.data, req.auth.userId);
    sendData(res, data);
}));
/**
 * Add a comment to a post.
 * `POST /api/v1/posts/:postId/comments` — body `{ "text": "..." }`
 */
postsRouter.post('/:postId/comments', strictLimiter, requireAuth, validateBody(createCommentBodySchema), asyncRoute(async (req, res) => {
    if (!req.auth) {
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const postId = postIdParam(req);
    const body = req.body;
    const comment = await commentService.createComment(req.auth.userId, postId, body);
    sendData(res, { comment }, 201);
}));
/**
 * Report a post.
 * `POST /api/v1/posts/:postId/report` — body `{ "reason": "..." }`
 */
postsRouter.post('/:postId/report', strictLimiter, requireAuth, validateBody(createReportBodySchema), asyncRoute(async (req, res) => {
    if (!req.auth) {
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const postId = postIdParam(req);
    const body = req.body;
    const report = await reportService.reportPost(req.auth.userId, postId, body);
    sendData(res, { report }, 201);
}));
/**
 * Delete a post (owner only).
 * `DELETE /api/v1/posts/:postId`
 */
postsRouter.delete('/:postId', strictLimiter, requireAuth, asyncRoute(async (req, res) => {
    if (!req.auth) {
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const postId = postIdParam(req);
    await postService.deletePost(req.auth.userId, postId);
    sendData(res, { deleted: true });
}));
postsRouter.post('/', strictLimiter, requireAuth, asyncRoute(async (req, res) => {
    if (!req.auth) {
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const parsed = createPostBodySchema.safeParse(req.body);
    if (!parsed.success) {
        throw new HttpError(400, 'Invalid request body', 'VALIDATION_ERROR', parsed.error.flatten());
    }
    const post = await postService.createPost(req.auth.userId, parsed.data);
    sendData(res, { post }, 201);
}));
