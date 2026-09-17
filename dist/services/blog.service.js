import mongoose from 'mongoose';
import { HttpError } from '../lib/httpError.js';
import { BlogFavoriteModel } from '../models/blogFavorite.model.js';
import { BlogModel } from '../models/blog.model.js';
import { UserModel } from '../models/user.model.js';
import { listFolloweeIds } from './follow.service.js';
import { createNotification, sendToUser } from './notification.service.js';
import { generateVideoThumbnail } from './thumbnail.service.js';
import { isBlockedBetween, listHiddenUserIds } from './userBlock.service.js';
import { enqueueMediaProcessing } from '../queues/mediaProcessing.queue.js';
function assertBlogObjectId(id) {
    if (!mongoose.isValidObjectId(id)) {
        throw new HttpError(400, 'Invalid blog id', 'INVALID_BLOG_ID');
    }
}
function isDuplicateKeyError(err) {
    return (typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        err.code === 11000);
}
/** Remove internal seed tracking query param from URLs. */
export function playbackVideoUrl(raw) {
    try {
        const u = new URL(raw);
        u.searchParams.delete('__seed_blog__');
        return u.toString();
    }
    catch {
        return raw;
    }
}
async function favoriteBlogIdSet(userId) {
    assertBlogObjectId(userId);
    const rows = (await BlogFavoriteModel.find({ user: userId })
        .select('blog')
        .lean());
    return new Set(rows.map((r) => r.blog.toString()));
}
function toListItemDto(doc, followSet, favoriteSet) {
    const bid = doc._id.toString();
    const aid = doc.author._id.toString();
    return {
        id: bid,
        title: doc.title,
        description: doc.description,
        viewsCount: doc.viewsCount ?? 0,
        thumbnailUrl: doc.thumbnailUrl,
        videoUrl: playbackVideoUrl(doc.videoUrl),
        durationSeconds: doc.durationSeconds,
        mediaProcessingStatus: doc.mediaProcessingStatus ?? 'not_required',
        hlsUrl: doc.hlsUrl ?? null,
        hlsVariants: doc.hlsVariants ?? [],
        mediaProcessingError: doc.mediaProcessingError ?? null,
        tags: [...doc.tags],
        publishedAt: doc.publishedAt
            ? doc.publishedAt.toISOString()
            : null,
        author: {
            id: aid,
            username: doc.author.username,
            fullName: doc.author.fullName,
            avatarUrl: doc.author.avatarUrl,
        },
        fromFollowing: followSet.has(aid),
        isFavorite: favoriteSet.has(bid),
    };
}
async function populateBlogDocs(filter) {
    const docs = (await BlogModel.find(filter)
        .sort({ publishedAt: -1, _id: -1 })
        .populate({
        path: 'author',
        select: 'username fullName avatarUrl',
    })
        .lean());
    return docs.filter((d) => d.author != null);
}
export async function listBlogsForViewer(viewerId, tab) {
    assertBlogObjectId(viewerId);
    const followeeIds = await listFolloweeIds(viewerId);
    const followSet = new Set(followeeIds);
    const favoriteSet = await favoriteBlogIdSet(viewerId);
    const hiddenIds = await listHiddenUserIds(viewerId);
    const hiddenSet = new Set(hiddenIds);
    const hiddenOids = hiddenIds.map((id) => new mongoose.Types.ObjectId(id));
    if (tab === 'favorites') {
        const links = (await BlogFavoriteModel.find({ user: viewerId })
            .sort({ createdAt: -1 })
            .select('blog')
            .lean());
        if (links.length === 0) {
            return { items: [] };
        }
        const ids = links.map((l) => l.blog);
        const docs = (await BlogModel.find({
            _id: { $in: ids },
            status: 'published',
        })
            .populate({
            path: 'author',
            select: 'username fullName avatarUrl',
        })
            .lean());
        const byId = new Map(docs
            .filter((d) => d.author != null && !hiddenSet.has(d.author._id.toString()))
            .map((d) => [d._id.toString(), d]));
        const items = links
            .map((l) => byId.get(l.blog.toString()))
            .filter((d) => d != null)
            .map((d) => toListItemDto(d, followSet, favoriteSet));
        return { items };
    }
    const filter = { status: 'published' };
    if (hiddenOids.length > 0) {
        filter.author = { $nin: hiddenOids };
    }
    if (tab === 'following') {
        if (followeeIds.length === 0) {
            return { items: [] };
        }
        const visibleFolloweeOids = followeeIds
            .filter((id) => !hiddenSet.has(id))
            .map((id) => new mongoose.Types.ObjectId(id));
        if (visibleFolloweeOids.length === 0) {
            return { items: [] };
        }
        filter.author = { $in: visibleFolloweeOids };
    }
    const docs = await populateBlogDocs(filter);
    const items = docs.map((d) => toListItemDto(d, followSet, favoriteSet));
    return { items };
}
const TRENDING_BLOG_LIMIT = 6;
/** Upper bound the Trending screen can request in one call (5 grids × 4). */
const TRENDING_BLOG_MAX = 20;
/** Top published blogs by aggregate views (tie-break: newer `_id`). */
export async function listTrendingBlogs(viewerId, opts) {
    assertBlogObjectId(viewerId);
    const limit = Math.min(TRENDING_BLOG_MAX, Math.max(1, Math.trunc(opts?.limit ?? TRENDING_BLOG_LIMIT)));
    const followeeIds = await listFolloweeIds(viewerId);
    const followSet = new Set(followeeIds);
    const favoriteSet = await favoriteBlogIdSet(viewerId);
    const hiddenIds = await listHiddenUserIds(viewerId);
    const trendingFilter = { status: 'published' };
    if (hiddenIds.length > 0) {
        trendingFilter.author = {
            $nin: hiddenIds.map((id) => new mongoose.Types.ObjectId(id)),
        };
    }
    const docs = (await BlogModel.find(trendingFilter)
        .sort({ viewsCount: -1, _id: -1 })
        .limit(limit)
        .populate({
        path: 'author',
        select: 'username fullName avatarUrl',
    })
        .lean());
    const items = docs
        .filter((d) => d.author != null)
        .map((d) => toListItemDto(d, followSet, favoriteSet));
    return { items };
}
export async function getBlogById(blogId, viewerId) {
    assertBlogObjectId(blogId);
    assertBlogObjectId(viewerId);
    const doc = (await BlogModel.findOne({
        _id: blogId,
        status: 'published',
    })
        .populate({
        path: 'author',
        select: 'username fullName avatarUrl',
    })
        .lean());
    if (!doc || !doc.author) {
        throw new HttpError(404, 'Blog not found', 'BLOG_NOT_FOUND');
    }
    const authorId = doc.author._id.toString();
    if (authorId !== viewerId &&
        (await isBlockedBetween(viewerId, authorId))) {
        throw new HttpError(404, 'Blog not found', 'BLOG_NOT_FOUND');
    }
    const followeeIds = await listFolloweeIds(viewerId);
    const followSet = new Set(followeeIds);
    const favoriteSet = await favoriteBlogIdSet(viewerId);
    return { blog: toListItemDto(doc, followSet, favoriteSet) };
}
export async function setBlogFavorite(userId, blogId, favorited) {
    assertBlogObjectId(userId);
    assertBlogObjectId(blogId);
    const exists = await BlogModel.exists({ _id: blogId, status: 'published' });
    if (!exists) {
        throw new HttpError(404, 'Blog not found', 'BLOG_NOT_FOUND');
    }
    if (favorited) {
        let created = false;
        try {
            await BlogFavoriteModel.create({ user: userId, blog: blogId });
            created = true;
        }
        catch (err) {
            if (!isDuplicateKeyError(err)) {
                throw err;
            }
        }
        // Notify the blog owner on the first favourite (not on idempotent re-calls).
        if (created) {
            void (async () => {
                try {
                    const blog = await BlogModel.findById(blogId)
                        .select('author')
                        .lean();
                    const ownerId = blog?.author?.toString();
                    if (!ownerId || ownerId === userId)
                        return;
                    const liker = await UserModel.findById(userId)
                        .select('fullName username')
                        .lean();
                    const name = liker?.fullName?.trim() ||
                        liker?.username ||
                        'Someone';
                    const isNew = await createNotification({
                        recipient: ownerId,
                        actor: userId,
                        type: 'blog_like',
                        blog: blogId,
                    });
                    if (isNew) {
                        await sendToUser(ownerId, {
                            type: 'blog_like',
                            title: 'New like',
                            body: `${name} liked your blog`,
                            data: { blogId, likerId: userId },
                        });
                    }
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : 'unknown error';
                    console.warn('[blog] favourite push dispatch failed:', msg);
                }
            })();
        }
        return { favorited: true };
    }
    await BlogFavoriteModel.deleteOne({ user: userId, blog: blogId });
    return { favorited: false };
}
export async function incrementBlogViews(blogId) {
    assertBlogObjectId(blogId);
    const updated = await BlogModel.findOneAndUpdate({ _id: blogId, status: 'published' }, { $inc: { viewsCount: 1 } }, { new: true, projection: { viewsCount: 1 } })
        .lean()
        .exec();
    if (!updated) {
        throw new HttpError(404, 'Blog not found', 'BLOG_NOT_FOUND');
    }
    return { viewsCount: updated.viewsCount ?? 0 };
}
/**
 * Create a new blog post (video only).
 * If posterFile is provided, use its URL as thumbnailUrl.
 * Otherwise, generate thumbnail from the video's first frame.
 */
export async function createBlog(userId, body) {
    const videoUrl = body.file.url ?? '';
    if (!videoUrl) {
        throw new HttpError(400, 'Video file URL is required', 'MISSING_VIDEO_URL');
    }
    let thumbnailUrl = '';
    if (body.posterFile?.url) {
        thumbnailUrl = body.posterFile.url;
    }
    else {
        // Generate from first frame (blocking so the blog has a thumbnail immediately)
        const generated = await generateVideoThumbnail(body.file.key, userId);
        thumbnailUrl = generated ?? '';
    }
    // If thumbnail generation failed and no poster was provided, use a placeholder
    if (!thumbnailUrl) {
        thumbnailUrl = 'https://placehold.co/640x360/1a202c/a0aec0/png?text=Blog';
    }
    const now = new Date();
    const doc = await BlogModel.create({
        author: new mongoose.Types.ObjectId(userId),
        title: body.title.trim(),
        description: body.description?.trim() ?? null,
        videoUrl,
        videoKey: body.file.key,
        mediaProcessingStatus: 'processing',
        hlsUrl: null,
        hlsVariants: [],
        mediaProcessingError: null,
        thumbnailUrl,
        durationSeconds: body.durationSeconds ?? null,
        status: 'published',
        publishedAt: now,
    });
    enqueueMediaProcessing('blog', doc._id.toString()).catch((err) => {
        void BlogModel.updateOne({ _id: doc._id }, {
            $set: {
                mediaProcessingStatus: 'failed',
                mediaProcessingError: 'Media processing queue unavailable',
            },
        });
        console.error(`[blogs] enqueueMediaProcessing failed blogId=${doc._id.toString()}:`, err instanceof Error ? err.message : err);
    });
    return { id: doc._id.toString() };
}
export async function deleteBlog(userId, blogId) {
    assertBlogObjectId(blogId);
    const doc = await BlogModel.findById(blogId).lean().exec();
    if (!doc) {
        throw new HttpError(404, 'Blog not found', 'BLOG_NOT_FOUND');
    }
    if (doc.author.toString() !== userId) {
        throw new HttpError(403, 'Not authorised to delete this blog', 'FORBIDDEN');
    }
    await BlogFavoriteModel.deleteMany({ blog: doc._id });
    await BlogModel.deleteOne({ _id: doc._id });
}
