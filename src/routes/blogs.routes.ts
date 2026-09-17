import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { Router, type Request } from 'express';
import { env, isProd } from '../config/env.js';
import { asyncRoute } from '../lib/asyncRoute.js';
import { HttpError } from '../lib/httpError.js';
import { sendData } from '../lib/sendData.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validateBody } from '../middleware/validateBody.js';
import {
  blogFavoriteBodySchema,
  blogListQuerySchema,
  createBlogBodySchema,
} from '../schemas/blogs.schemas.js';
import * as blogService from '../services/blog.service.js';
import { BlogModel } from '../models/blog.model.js';

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

export const blogsRouter = Router();

function blogIdParam(req: Request): string {
  const raw = req.params.blogId;
  const blogId = Array.isArray(raw) ? raw[0] : raw;
  if (typeof blogId !== 'string' || blogId.length === 0) {
    throw new HttpError(400, 'Invalid blog id', 'INVALID_BLOG_ID');
  }
  return blogId;
}

/**
 * Trending published blogs by most views (max 6).
 * `GET /api/v1/blogs/trending`
 */
blogsRouter.get(
  '/trending',
  readLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const rawLimit = Number(req.query.limit);
    const data = await blogService.listTrendingBlogs(req.auth.userId, {
      limit: Number.isFinite(rawLimit) ? rawLimit : undefined,
    });
    sendData(res, data);
  }),
);

blogsRouter.get(
  '/',
  readLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const parsed = blogListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'Invalid query parameters',
        'VALIDATION_ERROR',
        parsed.error.flatten(),
      );
    }
    const data = await blogService.listBlogsForViewer(
      req.auth.userId,
      parsed.data.tab,
    );
    sendData(res, data);
  }),
);

/**
 * Favorite or unfavorite a published blog (idempotent).
 * `POST /api/v1/blogs/:blogId/favorite` — body `{ "favorited": true | false }`
 */
blogsRouter.post(
  '/:blogId/favorite',
  writeLimiter,
  requireAuth,
  validateBody(blogFavoriteBodySchema),
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const blogId = blogIdParam(req);
    const { favorited } = req.body as { favorited: boolean };
    const result = await blogService.setBlogFavorite(
      req.auth.userId,
      blogId,
      favorited,
    );
    sendData(res, result);
  }),
);

/**
 * Increment blog view counter (aggregate only, no viewer details).
 * `POST /api/v1/blogs/:blogId/view`
 */
blogsRouter.post(
  '/:blogId/view',
  writeLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const blogId = blogIdParam(req);
    const result = await blogService.incrementBlogViews(blogId);
    sendData(res, result);
  }),
);

/**
 * Create a new blog (video only).
 * `POST /api/v1/blogs` — body includes file ref from upload, title, description, optional poster.
 */
blogsRouter.post(
  '/',
  writeLimiter,
  requireAuth,
  validateBody(createBlogBodySchema),
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const body = req.body as import('../schemas/blogs.schemas.js').CreateBlogBody;
    const result = await blogService.createBlog(req.auth.userId, body);
    sendData(res, { blog: result }, 201);
  }),
);

/**
 * HLS processing status for a video blog.
 * `GET /api/v1/blogs/:blogId/media-status`
 */
blogsRouter.get(
  '/:blogId/media-status',
  readLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    const blogId = blogIdParam(req);
    if (!mongoose.isValidObjectId(blogId)) {
      throw new HttpError(400, 'Invalid blog id', 'INVALID_BLOG_ID');
    }
    const blog = await BlogModel.findById(blogId)
      .select('mediaProcessingStatus hlsUrl hlsVariants mediaProcessingError')
      .lean();
    if (!blog) {
      throw new HttpError(404, 'Blog not found', 'BLOG_NOT_FOUND');
    }
    sendData(res, {
      mediaId: blogId,
      mediaKind: 'video',
      status: blog.mediaProcessingStatus,
      hlsUrl: blog.hlsUrl,
      variants: blog.hlsVariants,
      error: blog.mediaProcessingError,
    });
  }),
);

blogsRouter.get(
  '/:blogId',
  readLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const blogId = blogIdParam(req);
    const data = await blogService.getBlogById(blogId, req.auth.userId);
    sendData(res, data);
  }),
);

/**
 * Delete a blog the authenticated user owns.
 * `DELETE /api/v1/blogs/:blogId`
 */
blogsRouter.delete(
  '/:blogId',
  writeLimiter,
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    const blogId = blogIdParam(req);
    await blogService.deleteBlog(req.auth.userId, blogId);
    sendData(res, { deleted: true });
  }),
);
