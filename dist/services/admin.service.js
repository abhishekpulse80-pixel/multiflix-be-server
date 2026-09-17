import { s3Env } from '../config/s3Env.js';
import { extractAudioDurationFromUrl } from '../lib/audioDuration.js';
import { HttpError } from '../lib/httpError.js';
import { AdModel } from '../models/ad.model.js';
import { BlogModel } from '../models/blog.model.js';
import { BlogFavoriteModel } from '../models/blogFavorite.model.js';
import { CommentModel } from '../models/comment.model.js';
import { ConversationModel } from '../models/conversation.model.js';
import { FeedbackModel } from '../models/feedback.model.js';
import { FollowModel } from '../models/follow.model.js';
import { MessageModel } from '../models/message.model.js';
import { ArtistModel } from '../models/artist.model.js';
import { MusicAlbumModel } from '../models/musicAlbum.model.js';
import { MusicTrackModel } from '../models/musicTrack.model.js';
import { MusicTrackFavouriteModel } from '../models/musicTrackFavourite.model.js';
import { PostModel } from '../models/post.model.js';
import { PostLikeModel } from '../models/postLike.model.js';
import { ReportModel } from '../models/report.model.js';
import { StoryModel } from '../models/story.model.js';
import { StoryReactionModel } from '../models/storyReaction.model.js';
import { StoryViewModel } from '../models/storyView.model.js';
import { TransactionModel } from '../models/transaction.model.js';
import { UserBlockModel } from '../models/userBlock.model.js';
import { UserModel } from '../models/user.model.js';
import { EARNING_SECTIONS, EarningRateModel, } from '../models/earningRate.model.js';
import { enqueueMediaProcessing } from '../queues/mediaProcessing.queue.js';
function sourceKeyFromPublicUrl(rawUrl) {
    const prefix = `${s3Env.publicBaseUrl}/`;
    if (!s3Env.publicBaseUrl || !rawUrl.startsWith(prefix))
        return null;
    return decodeURIComponent(rawUrl.slice(prefix.length).split('?')[0] ?? '');
}
/* ------------------------------------------------------------------ */
/*  Stats                                                              */
/* ------------------------------------------------------------------ */
export async function getStats() {
    const [totalUsers, totalPosts, totalBlogs, totalReports, totalMusic, totalStories, totalFeedback, totalAds] = await Promise.all([
        UserModel.countDocuments(),
        PostModel.countDocuments(),
        BlogModel.countDocuments(),
        ReportModel.countDocuments(),
        MusicAlbumModel.countDocuments(),
        StoryModel.countDocuments(),
        FeedbackModel.countDocuments(),
        AdModel.countDocuments(),
    ]);
    return { totalUsers, totalPosts, totalBlogs, totalReports, totalMusic, totalStories, totalFeedback, totalAds };
}
/**
 * Returns day-bucketed counts for users + posts created in the last `days` days,
 * plus the overall content distribution.
 * Zero-count days are filled in so the client can render a continuous line.
 */
export async function getTimeseries(days = 30) {
    const cappedDays = Math.min(365, Math.max(1, days));
    const end = new Date();
    end.setUTCHours(23, 59, 59, 999);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - (cappedDays - 1));
    start.setUTCHours(0, 0, 0, 0);
    const bucket = (model) => model.aggregate([
        { $match: { createdAt: { $gte: start, $lte: end } } },
        {
            $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                count: { $sum: 1 },
            },
        },
        { $sort: { _id: 1 } },
    ]);
    const [userBuckets, postBuckets, totalPosts, totalBlogs, totalMusic, totalStories] = await Promise.all([
        bucket(UserModel),
        bucket(PostModel),
        PostModel.countDocuments(),
        BlogModel.countDocuments(),
        MusicAlbumModel.countDocuments(),
        StoryModel.countDocuments(),
    ]);
    const fill = (buckets) => {
        const map = new Map(buckets.map((b) => [b._id, b.count]));
        const out = [];
        for (let i = 0; i < cappedDays; i++) {
            const d = new Date(start);
            d.setUTCDate(start.getUTCDate() + i);
            const key = d.toISOString().slice(0, 10);
            out.push({ date: key, count: map.get(key) ?? 0 });
        }
        return out;
    };
    return {
        days: cappedDays,
        users: fill(userBuckets),
        posts: fill(postBuckets),
        distribution: {
            posts: totalPosts,
            blogs: totalBlogs,
            music: totalMusic,
            stories: totalStories,
        },
    };
}
/* ------------------------------------------------------------------ */
/*  Users                                                              */
/* ------------------------------------------------------------------ */
export async function listUsers(page, limit, search, role) {
    // Admins are never shown in the admin user list.
    const filter = { role: { $ne: 'admin' } };
    if (search) {
        const regex = new RegExp(search, 'i');
        filter.$or = [{ username: regex }, { email: regex }, { fullName: regex }];
    }
    if (role && role !== 'admin') {
        filter.role = role;
    }
    const [rawItems, total] = await Promise.all([
        UserModel.find(filter)
            .select('_id email username fullName avatarUrl role isOnboarded isBlocked createdAt')
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
        UserModel.countDocuments(filter),
    ]);
    const items = rawItems.map(({ _id, ...rest }) => ({ id: String(_id), ...rest }));
    return { items, total, page, limit };
}
/**
 * Per-user screen time + earnings for the current calendar month.
 * Aggregates `Transaction` rows of type `earning`, grouped by user,
 * left-joined onto the paginated user list so users with zero activity
 * still appear (as 0 minutes / 0 earned).
 *
 * Amount is in INR (same unit the earning rate uses).
 */
export async function listScreenTimePayments(page, limit, search) {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const filter = { role: { $ne: 'admin' } };
    if (search) {
        const regex = new RegExp(search, 'i');
        filter.$or = [{ username: regex }, { email: regex }, { fullName: regex }];
    }
    const [users, total] = await Promise.all([
        UserModel.find(filter)
            .select('_id email username fullName avatarUrl')
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
        UserModel.countDocuments(filter),
    ]);
    if (users.length === 0) {
        return { items: [], total, page, limit };
    }
    const userIds = users.map((u) => u._id);
    const agg = (await TransactionModel.aggregate([
        {
            $match: {
                user: { $in: userIds },
                type: 'earning',
                createdAt: { $gte: monthStart },
            },
        },
        {
            $group: {
                _id: '$user',
                minutesThisMonth: { $sum: { $ifNull: ['$minutes', 0] } },
                earningThisMonth: { $sum: '$amount' },
            },
        },
    ]));
    const byUser = new Map(agg.map((a) => [
        String(a._id),
        {
            minutesThisMonth: a.minutesThisMonth,
            earningThisMonth: Math.round(a.earningThisMonth * 100) / 100,
        },
    ]));
    const items = users.map((u) => {
        const id = String(u._id);
        const stats = byUser.get(id) ?? {
            minutesThisMonth: 0,
            earningThisMonth: 0,
        };
        return {
            id,
            username: u.username ?? '',
            email: u.email,
            fullName: u.fullName ?? null,
            avatarUrl: u.avatarUrl ?? null,
            minutesThisMonth: stats.minutesThisMonth,
            earningThisMonth: stats.earningThisMonth,
        };
    });
    return { items, total, page, limit, monthStart: monthStart.toISOString() };
}
export async function setUserBlocked(userId, isBlocked) {
    const user = await UserModel.findByIdAndUpdate(userId, { isBlocked }, { new: true, runValidators: true })
        .select('_id email username fullName role isBlocked')
        .lean();
    if (!user)
        throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
    const { _id, ...rest } = user;
    return { id: String(_id), ...rest };
}
export async function getUserDetail(userId) {
    const user = await UserModel.findById(userId)
        .select('_id email username fullName avatarUrl role isOnboarded isBlocked ' +
        'gender dateOfBirth phone address interests createdAt updatedAt')
        .lean();
    if (!user)
        throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
    const [postsCount, blogsCount, storiesCount] = await Promise.all([
        PostModel.countDocuments({ author: user._id }),
        BlogModel.countDocuments({ author: user._id }),
        StoryModel.countDocuments({ author: user._id }),
    ]);
    const { _id, ...rest } = user;
    return {
        id: String(_id),
        ...rest,
        counts: {
            posts: postsCount,
            blogs: blogsCount,
            stories: storiesCount,
        },
    };
}
export async function updateUserRole(userId, role) {
    const user = await UserModel.findByIdAndUpdate(userId, { role }, { new: true, runValidators: true })
        .select('_id email username fullName role')
        .lean();
    if (!user)
        throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
    return user;
}
/**
 * Hard-delete a user and every piece of data related to them:
 *   - User doc itself
 *   - Content authored by user: Posts, Blogs, Stories, Comments
 *   - Cascade on the user's own content (owned by other users):
 *       PostLikes / Comments / Reports on their posts,
 *       StoryViews / StoryReactions / Reports on their stories,
 *       Reports on their comments, BlogFavorites on their blogs.
 *   - Direct activity: PostLikes, StoryViews, StoryReactions, Follows
 *       (both sides), UserBlocks (both sides), BlogFavorites,
 *       MusicTrackFavourites, Feedback, Reports (as reporter).
 *   - Conversations the user is part of, plus all messages in those.
 *
 * Admins cannot be deleted via this endpoint (403 USER_IS_ADMIN).
 * Deletes are sequential & idempotent, so a re-run after partial failure
 * safely completes the cleanup.
 */
export async function deleteUser(userId) {
    const user = await UserModel.findById(userId).select('_id role').lean();
    if (!user)
        throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
    if (user.role === 'admin') {
        throw new HttpError(403, 'Admin users cannot be deleted', 'USER_IS_ADMIN');
    }
    // 1) Collect IDs of the user's owned content so we can cascade orphans.
    const [userPosts, userStories, userBlogs, userComments] = await Promise.all([
        PostModel.find({ author: userId }).select('_id').lean(),
        StoryModel.find({ author: userId }).select('_id').lean(),
        BlogModel.find({ author: userId }).select('_id').lean(),
        CommentModel.find({ author: userId }).select('_id').lean(),
    ]);
    const userPostIds = userPosts.map((p) => p._id);
    const userStoryIds = userStories.map((s) => s._id);
    const userBlogIds = userBlogs.map((b) => b._id);
    const userCommentIds = userComments.map((c) => c._id);
    // 2) Cascade on content owned by this user (other users' interactions).
    if (userPostIds.length > 0) {
        await PostLikeModel.deleteMany({ post: { $in: userPostIds } });
        await CommentModel.deleteMany({ post: { $in: userPostIds } });
        await ReportModel.deleteMany({
            targetKind: 'post',
            targetId: { $in: userPostIds },
        });
    }
    if (userStoryIds.length > 0) {
        await StoryViewModel.deleteMany({ story: { $in: userStoryIds } });
        await StoryReactionModel.deleteMany({ story: { $in: userStoryIds } });
        await ReportModel.deleteMany({
            targetKind: 'story',
            targetId: { $in: userStoryIds },
        });
    }
    if (userBlogIds.length > 0) {
        await BlogFavoriteModel.deleteMany({ blog: { $in: userBlogIds } });
    }
    if (userCommentIds.length > 0) {
        await ReportModel.deleteMany({
            targetKind: 'comment',
            targetId: { $in: userCommentIds },
        });
    }
    // 3) Delete the user's own content.
    await PostModel.deleteMany({ author: userId });
    await StoryModel.deleteMany({ author: userId });
    await BlogModel.deleteMany({ author: userId });
    // 4) Delete the user's direct activity on others' content.
    await CommentModel.deleteMany({ author: userId });
    await PostLikeModel.deleteMany({ user: userId });
    await StoryViewModel.deleteMany({ viewer: userId });
    await StoryReactionModel.deleteMany({ user: userId });
    await FollowModel.deleteMany({
        $or: [{ follower: userId }, { followee: userId }],
    });
    await UserBlockModel.deleteMany({
        $or: [{ blocker: userId }, { blocked: userId }],
    });
    await BlogFavoriteModel.deleteMany({ user: userId });
    await MusicTrackFavouriteModel.deleteMany({ user: userId });
    await FeedbackModel.deleteMany({ user: userId });
    await ReportModel.deleteMany({ reporter: userId });
    // 5) Conversations the user is a participant in, and all their messages.
    const convs = await ConversationModel.find({ participants: userId })
        .select('_id')
        .lean();
    const convIds = convs.map((c) => c._id);
    if (convIds.length > 0) {
        await MessageModel.deleteMany({ conversation: { $in: convIds } });
        await ConversationModel.deleteMany({ _id: { $in: convIds } });
    }
    // 6) Finally, delete the user doc itself.
    await UserModel.deleteOne({ _id: userId });
}
/* ------------------------------------------------------------------ */
/*  Posts                                                              */
/* ------------------------------------------------------------------ */
export async function listPosts(page, limit, search, mediaKind) {
    const filter = {};
    if (search) {
        filter.caption = new RegExp(search, 'i');
    }
    if (mediaKind && ['image', 'short_video'].includes(mediaKind)) {
        filter.mediaKind = mediaKind;
    }
    const [rawItems, total] = await Promise.all([
        PostModel.find(filter)
            .select('_id caption media thumbnailUrl mediaKind likesCount commentsCount createdAt')
            .populate('author', 'username fullName avatarUrl')
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
        PostModel.countDocuments(filter),
    ]);
    const items = rawItems.map(({ _id, ...rest }) => ({ id: String(_id), ...rest }));
    return { items, total, page, limit };
}
export async function deletePost(postId) {
    const post = await PostModel.findByIdAndDelete(postId).lean();
    if (!post)
        throw new HttpError(404, 'Post not found', 'POST_NOT_FOUND');
}
/* ------------------------------------------------------------------ */
/*  Blogs                                                              */
/* ------------------------------------------------------------------ */
export async function listBlogs(page, limit, search) {
    const filter = {};
    if (search) {
        filter.title = new RegExp(search, 'i');
    }
    const [rawItems, total] = await Promise.all([
        BlogModel.find(filter)
            .select('_id title description videoUrl thumbnailUrl viewsCount createdAt')
            .populate('author', 'username fullName avatarUrl')
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
        BlogModel.countDocuments(filter),
    ]);
    const items = rawItems.map(({ _id, ...rest }) => ({ id: String(_id), ...rest }));
    return { items, total, page, limit };
}
export async function deleteBlog(blogId) {
    const blog = await BlogModel.findByIdAndDelete(blogId).lean();
    if (!blog)
        throw new HttpError(404, 'Blog not found', 'BLOG_NOT_FOUND');
}
/* ------------------------------------------------------------------ */
/*  Reports                                                            */
/* ------------------------------------------------------------------ */
export async function listReports(page, limit, status) {
    const filter = {};
    if (status) {
        filter.status = status;
    }
    const [rawItems, total] = await Promise.all([
        ReportModel.find(filter)
            .populate('reporter', 'username fullName')
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
        ReportModel.countDocuments(filter),
    ]);
    // Batch-fetch post targets so the admin UI can render them as links.
    const postTargetIds = rawItems
        .filter((r) => r.targetKind === 'post')
        .map((r) => r.targetId);
    const postMap = new Map();
    if (postTargetIds.length > 0) {
        const posts = await PostModel.find({ _id: { $in: postTargetIds } })
            .select('_id caption thumbnailUrl mediaKind media')
            .lean();
        for (const p of posts) {
            postMap.set(String(p._id), {
                id: String(p._id),
                caption: p.caption ?? null,
                thumbnailUrl: p.thumbnailUrl ?? null,
                mediaKind: p.mediaKind,
                media: p.media ? { url: p.media.url ?? null } : null,
            });
        }
    }
    const items = rawItems.map(({ _id, targetId, ...rest }) => ({
        id: String(_id),
        targetId: String(targetId),
        ...rest,
        targetPost: rest.targetKind === 'post' ? postMap.get(String(targetId)) ?? null : null,
    }));
    return { items, total, page, limit };
}
export async function getPostDetail(postId) {
    const post = await PostModel.findById(postId)
        .select('_id caption hashtags musicTitle mediaKind media thumbnailUrl ' +
        'likesCount commentsCount durationSeconds mediaWidth mediaHeight createdAt')
        .populate('author', 'username fullName avatarUrl')
        .lean();
    if (!post)
        throw new HttpError(404, 'Post not found', 'POST_NOT_FOUND');
    const { _id, ...rest } = post;
    return { id: String(_id), ...rest };
}
export async function updateReportStatus(reportId, status) {
    const report = await ReportModel.findByIdAndUpdate(reportId, { status }, { new: true, runValidators: true }).lean();
    if (!report)
        throw new HttpError(404, 'Report not found', 'REPORT_NOT_FOUND');
    return report;
}
/* ------------------------------------------------------------------ */
/*  Music                                                              */
/* ------------------------------------------------------------------ */
export async function createAlbum(body) {
    const artist = await ArtistModel.findById(body.artistId).lean();
    if (!artist) {
        throw new HttpError(404, 'Artist not found', 'ARTIST_NOT_FOUND');
    }
    const album = await MusicAlbumModel.create({
        title: body.title,
        coverArtUrl: body.coverArtUrl,
        featured: body.featured ?? false,
        artist: body.artistId,
        status: body.status ?? 'published',
        sortOrder: body.sortOrder ?? 0,
        publishedAt: body.publishedAt !== undefined
            ? body.publishedAt
                ? new Date(body.publishedAt)
                : null
            : (body.status ?? 'published') === 'published'
                ? new Date()
                : null,
    });
    return album.toObject();
}
export async function createTrack(body) {
    if (body.albumId) {
        const album = await MusicAlbumModel.findById(body.albumId).lean();
        if (!album)
            throw new HttpError(404, 'Album not found', 'ALBUM_NOT_FOUND');
    }
    const artist = await ArtistModel.findById(body.artistId).lean();
    if (!artist) {
        throw new HttpError(404, 'Artist not found', 'ARTIST_NOT_FOUND');
    }
    // Auto-derive duration from the audio file if the admin didn't supply one.
    // Falls back silently to null when the file can't be parsed — the track
    // is still created, the music picker will just show it as unavailable
    // until backfilled.
    let durationSeconds = body.durationSeconds ?? null;
    if (durationSeconds == null) {
        durationSeconds = await extractAudioDurationFromUrl(body.audioUrl);
    }
    const audioKey = sourceKeyFromPublicUrl(body.audioUrl);
    const track = await MusicTrackModel.create({
        album: body.albumId || null,
        title: body.title,
        artist: body.artistId,
        artUrl: body.artUrl,
        audioUrl: body.audioUrl,
        audioKey,
        audioProcessingStatus: audioKey ? 'processing' : 'not_required',
        audioVariants: [],
        audioProcessingError: null,
        durationSeconds,
        sortOrder: body.sortOrder ?? 0,
        status: body.status ?? 'published',
    });
    if (audioKey) {
        enqueueMediaProcessing('music', track._id.toString()).catch(() => {
            void MusicTrackModel.updateOne({ _id: track._id }, { $set: { audioProcessingStatus: 'failed', audioProcessingError: 'Audio processing queue unavailable' } });
        });
    }
    return track.toObject();
}
export async function deleteAlbum(albumId) {
    const album = await MusicAlbumModel.findByIdAndDelete(albumId).lean();
    if (!album)
        throw new HttpError(404, 'Album not found', 'ALBUM_NOT_FOUND');
    await MusicTrackModel.deleteMany({ album: albumId });
}
export async function listTracks(page, limit, search) {
    const filter = {};
    if (search) {
        const regex = new RegExp(search, 'i');
        const matchingArtistIds = await ArtistModel.find({ name: regex })
            .select('_id')
            .lean();
        filter.$or = [
            { title: regex },
            { artist: { $in: matchingArtistIds.map((a) => a._id) } },
        ];
    }
    const [items, total] = await Promise.all([
        MusicTrackModel.find(filter)
            .populate('album', 'title')
            .populate('artist', 'name profileImageUrl')
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
        MusicTrackModel.countDocuments(filter),
    ]);
    return { items, total, page, limit };
}
export async function deleteTrack(trackId) {
    const track = await MusicTrackModel.findByIdAndDelete(trackId).lean();
    if (!track)
        throw new HttpError(404, 'Track not found', 'TRACK_NOT_FOUND');
}
export async function listAlbumsDropdown() {
    const albums = await MusicAlbumModel.find()
        .populate('artist', 'name')
        .select('_id title artist')
        .sort({ title: 1 })
        .lean();
    return albums;
}
export async function listMusic(page, limit, search) {
    const filter = {};
    if (search) {
        const regex = new RegExp(search, 'i');
        const matchingArtistIds = await ArtistModel.find({ name: regex })
            .select('_id')
            .lean();
        filter.$or = [
            { title: regex },
            { artist: { $in: matchingArtistIds.map((a) => a._id) } },
        ];
    }
    const [albums, total] = await Promise.all([
        MusicAlbumModel.find(filter)
            .populate('artist', 'name profileImageUrl')
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
        MusicAlbumModel.countDocuments(filter),
    ]);
    // Attach track counts
    const albumIds = albums.map((a) => a._id);
    const trackCounts = await MusicTrackModel.aggregate([
        { $match: { album: { $in: albumIds } } },
        { $group: { _id: '$album', count: { $sum: 1 } } },
    ]);
    const countMap = new Map(trackCounts.map((t) => [String(t._id), t.count]));
    const items = albums.map((a) => ({
        ...a,
        trackCount: countMap.get(String(a._id)) ?? 0,
    }));
    return { items, total, page, limit };
}
/* ------------------------------------------------------------------ */
/*  Feedback                                                           */
/* ------------------------------------------------------------------ */
export async function listFeedback(page, limit, status) {
    const filter = {};
    if (status) {
        filter.status = status;
    }
    const [items, total] = await Promise.all([
        FeedbackModel.find(filter)
            .populate('user', 'username fullName avatarUrl email')
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
        FeedbackModel.countDocuments(filter),
    ]);
    return { items, total, page, limit };
}
export async function updateFeedbackStatus(feedbackId, body) {
    const update = { status: body.status };
    if (body.adminNotes !== undefined) {
        update.adminNotes = body.adminNotes;
    }
    const feedback = await FeedbackModel.findByIdAndUpdate(feedbackId, update, {
        new: true,
        runValidators: true,
    })
        .populate('user', 'username fullName avatarUrl email')
        .lean();
    if (!feedback)
        throw new HttpError(404, 'Feedback not found', 'FEEDBACK_NOT_FOUND');
    return feedback;
}
/* ------------------------------------------------------------------ */
/*  Ads                                                                */
/* ------------------------------------------------------------------ */
export async function listAds(page, limit, status, placement) {
    const filter = {};
    if (status)
        filter.status = status;
    if (placement)
        filter.placement = placement;
    const [items, total] = await Promise.all([
        AdModel.find(filter)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
        AdModel.countDocuments(filter),
    ]);
    return { items, total, page, limit };
}
export async function createAd(body) {
    const ad = await AdModel.create({
        title: body.title,
        imageUrl: body.imageUrl,
        targetUrl: body.targetUrl,
        placement: body.placement ?? 'feed',
        status: body.status ?? 'draft',
        startDate: body.startDate ? new Date(body.startDate) : null,
        endDate: body.endDate ? new Date(body.endDate) : null,
    });
    return ad.toObject();
}
export async function patchAd(adId, body) {
    const update = { ...body };
    if (body.startDate !== undefined)
        update.startDate = body.startDate ? new Date(body.startDate) : null;
    if (body.endDate !== undefined)
        update.endDate = body.endDate ? new Date(body.endDate) : null;
    const ad = await AdModel.findByIdAndUpdate(adId, update, {
        new: true,
        runValidators: true,
    }).lean();
    if (!ad)
        throw new HttpError(404, 'Ad not found', 'AD_NOT_FOUND');
    return ad;
}
export async function deleteAd(adId) {
    const ad = await AdModel.findByIdAndDelete(adId).lean();
    if (!ad)
        throw new HttpError(404, 'Ad not found', 'AD_NOT_FOUND');
}
/* ------------------------------------------------------------------ */
/*  Earning Rates                                                      */
/* ------------------------------------------------------------------ */
/**
 * List all configured earning rates. Always returns one entry per section
 * (creates a default inactive rate if one is missing) so the admin UI can
 * render the full set without extra logic.
 */
export async function listEarningRates() {
    const existing = await EarningRateModel.find().lean();
    const bySection = new Map(existing.map((r) => [r.section, r]));
    const items = [];
    for (const section of EARNING_SECTIONS) {
        const row = bySection.get(section);
        if (row) {
            items.push(row);
        }
        else {
            const created = await EarningRateModel.create({
                section,
                ratePerMinute: 0,
                isActive: false,
            });
            items.push(created.toObject());
        }
    }
    return { items };
}
/** Update ratePerMinute and/or isActive for a given section. Upserts if missing. */
export async function updateEarningRate(section, body) {
    if (!EARNING_SECTIONS.includes(section)) {
        throw new HttpError(400, 'Invalid section', 'INVALID_SECTION');
    }
    const update = {};
    if (body.ratePerMinute !== undefined)
        update.ratePerMinute = body.ratePerMinute;
    if (body.isActive !== undefined)
        update.isActive = body.isActive;
    const rate = await EarningRateModel.findOneAndUpdate({ section: section }, { $set: update, $setOnInsert: { section } }, { new: true, upsert: true, runValidators: true }).lean();
    return rate;
}
/* ------------------------------------------------------------------ */
/*  Artists                                                            */
/* ------------------------------------------------------------------ */
export async function listArtists(page, limit, search) {
    const filter = {};
    if (search) {
        const regex = new RegExp(search, 'i');
        filter.name = regex;
    }
    const [items, total] = await Promise.all([
        ArtistModel.find(filter)
            .sort({ sortOrder: 1, createdAt: -1, _id: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
        ArtistModel.countDocuments(filter),
    ]);
    return { items, total, page, limit };
}
/** Lightweight list for dropdowns (id + name + image). */
export async function listArtistsDropdown() {
    const items = await ArtistModel.find()
        .select('_id name profileImageUrl status')
        .sort({ name: 1 })
        .lean();
    return items;
}
export async function createArtist(body) {
    const artist = await ArtistModel.create({
        name: body.name,
        bio: body.bio ?? null,
        profileImageUrl: body.profileImageUrl ?? null,
        status: body.status ?? 'published',
        sortOrder: body.sortOrder ?? 0,
    });
    return artist.toObject();
}
export async function patchArtist(artistId, body) {
    const update = {};
    if (body.name !== undefined)
        update.name = body.name;
    if (body.bio !== undefined)
        update.bio = body.bio;
    if (body.profileImageUrl !== undefined)
        update.profileImageUrl = body.profileImageUrl;
    if (body.status !== undefined)
        update.status = body.status;
    if (body.sortOrder !== undefined)
        update.sortOrder = body.sortOrder;
    const artist = await ArtistModel.findByIdAndUpdate(artistId, update, {
        new: true,
        runValidators: true,
    }).lean();
    if (!artist) {
        throw new HttpError(404, 'Artist not found', 'ARTIST_NOT_FOUND');
    }
    return artist;
}
/**
 * Delete an artist. Refuses if the artist still has albums or tracks
 * pointing at them — admin must reassign or delete those first.
 */
export async function deleteArtist(artistId) {
    const artist = await ArtistModel.findById(artistId).select('_id').lean();
    if (!artist) {
        throw new HttpError(404, 'Artist not found', 'ARTIST_NOT_FOUND');
    }
    const [albumCount, trackCount] = await Promise.all([
        MusicAlbumModel.countDocuments({ artist: artistId }),
        MusicTrackModel.countDocuments({ artist: artistId }),
    ]);
    if (albumCount > 0 || trackCount > 0) {
        throw new HttpError(409, `Artist still has ${String(albumCount)} album(s) and ${String(trackCount)} track(s) — reassign or delete those first.`, 'ARTIST_IN_USE');
    }
    await ArtistModel.deleteOne({ _id: artistId });
}
