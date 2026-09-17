import mongoose from 'mongoose';
import { mediaCategory } from '../lib/allowedMediaMime.js';
import { HttpError } from '../lib/httpError.js';
import { FollowModel } from '../models/follow.model.js';
import { StoryModel } from '../models/story.model.js';
import { StoryReactionModel } from '../models/storyReaction.model.js';
import { StoryViewModel } from '../models/storyView.model.js';
import { MusicTrackModel } from '../models/musicTrack.model.js';
import { ArtistModel } from '../models/artist.model.js';
import { UserModel } from '../models/user.model.js';
import { createNotification, sendToUser } from './notification.service.js';
import { isBlockedBetween, listHiddenUserIds } from './userBlock.service.js';
import { enqueueMediaProcessing } from '../queues/mediaProcessing.queue.js';
// ─── Helpers ─────────────────────────────────────────────────────────────────
const STORY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
function authorIdStr(author) {
    return typeof author === 'string' ? author : author.toString();
}
function fallbackUsername(authorId) {
    return `user_${authorId.slice(-6)}`;
}
async function authorInfoFor(authorId) {
    if (!mongoose.isValidObjectId(authorId)) {
        return { username: fallbackUsername(authorId), fullName: null };
    }
    const row = (await UserModel.findById(authorId)
        .select('username fullName')
        .lean());
    const u = row?.username;
    return {
        username: typeof u === 'string' && u.trim().length > 0
            ? u.trim().toLowerCase()
            : fallbackUsername(authorId),
        fullName: row?.fullName ?? null,
    };
}
async function mapAuthorIdsToInfo(authorIds) {
    const map = new Map();
    const unique = [
        ...new Set(authorIds.filter(id => mongoose.isValidObjectId(id))),
    ];
    if (unique.length === 0) {
        return map;
    }
    const rows = (await UserModel.find({ _id: { $in: unique } })
        .select('_id username fullName')
        .lean());
    for (const r of rows) {
        const id = r._id.toString();
        map.set(id, {
            username: typeof r.username === 'string' && r.username.trim().length > 0
                ? r.username.trim().toLowerCase()
                : fallbackUsername(id),
            fullName: r.fullName ?? null,
        });
    }
    return map;
}
async function mapAuthorIdsToUsernames(authorIds) {
    const map = new Map();
    const unique = [
        ...new Set(authorIds.filter((id) => mongoose.isValidObjectId(id))),
    ];
    if (unique.length === 0) {
        return map;
    }
    const rows = (await UserModel.find({ _id: { $in: unique } })
        .select('_id username')
        .lean());
    for (const r of rows) {
        const id = r._id.toString();
        const u = typeof r.username === 'string' && r.username.trim().length > 0
            ? r.username.trim().toLowerCase()
            : fallbackUsername(id);
        map.set(id, u);
    }
    for (const id of unique) {
        if (!map.has(id)) {
            map.set(id, fallbackUsername(id));
        }
    }
    return map;
}
/**
 * Batch-fetch music tracks (and their artists) referenced by a list of
 * stories, returning a `trackId → MusicLite` lookup map. Two queries total
 * regardless of how many stories are passed in.
 */
async function buildMusicMap(trackIds) {
    const unique = [...new Set(trackIds.map((id) => id.toString()))];
    if (unique.length === 0) {
        return new Map();
    }
    const tracks = (await MusicTrackModel.find({ _id: { $in: unique } })
        .select('title audioUrl artUrl durationSeconds artist')
        .lean());
    const artistIds = [...new Set(tracks.map((t) => t.artist.toString()))];
    const artists = artistIds.length > 0
        ? (await ArtistModel.find({ _id: { $in: artistIds } })
            .select('name')
            .lean())
        : [];
    const artistName = new Map(artists.map((a) => [a._id.toString(), a.name]));
    return new Map(tracks.map((t) => [
        t._id.toString(),
        {
            title: t.title,
            artistName: artistName.get(t.artist.toString()) ?? null,
            audioUrl: t.audioUrl,
            artUrl: t.artUrl,
            durationSeconds: t.durationSeconds,
        },
    ]));
}
/** Collect the set of music track ObjectIds referenced by a list of stories. */
function collectMusicTrackIds(docs) {
    const out = [];
    for (const d of docs) {
        if (d.musicTrack) {
            out.push(d.musicTrack);
        }
    }
    return out;
}
/**
 * Build the populated `music` field for a single story DTO. Returns null
 * when the story has no music attached or when the map doesn't have the
 * track (track was deleted or not fetched).
 */
function buildStoryMusicDto(doc, musicByTrackId) {
    if (doc.musicTrack == null || doc.musicTrimStartMs == null) {
        return null;
    }
    const trackId = doc.musicTrack.toString();
    const lite = musicByTrackId?.get(trackId);
    if (!lite) {
        return null;
    }
    return {
        trackId,
        title: lite.title,
        artistName: lite.artistName,
        audioUrl: lite.audioUrl,
        artUrl: lite.artUrl,
        durationSeconds: lite.durationSeconds,
        trimStartMs: doc.musicTrimStartMs,
    };
}
function toStoryDto(doc, authorUsername, musicByTrackId, authorName) {
    const createdAt = doc.createdAt instanceof Date
        ? doc.createdAt
        : new Date(String(doc.createdAt));
    const updatedAt = doc.updatedAt instanceof Date
        ? doc.updatedAt
        : new Date(String(doc.updatedAt));
    return {
        id: doc._id.toString(),
        authorId: authorIdStr(doc.author),
        authorUsername,
        authorFullName: authorName?.fullName ?? null,
        mediaKind: doc.mediaKind,
        media: {
            key: doc.media.key,
            bucket: doc.media.bucket,
            contentType: doc.media.contentType,
            size: doc.media.size,
            originalName: doc.media.originalName,
            url: doc.media.url,
            imageVariants: doc.media.imageVariants ?? [],
        },
        soundTitle: doc.soundTitle,
        music: buildStoryMusicDto(doc, musicByTrackId),
        caption: doc.caption,
        mediaWidth: doc.mediaWidth,
        mediaHeight: doc.mediaHeight,
        durationSeconds: doc.durationSeconds,
        mediaProcessingStatus: doc.mediaProcessingStatus ?? 'not_required',
        hlsUrl: doc.hlsUrl ?? null,
        hlsVariants: doc.hlsVariants ?? [],
        mediaProcessingError: doc.mediaProcessingError ?? null,
        viewsCount: doc.viewsCount,
        expiresAt: doc.expiresAt.toISOString(),
        createdAt: createdAt.toISOString(),
        updatedAt: updatedAt.toISOString(),
        showInTrending: doc.showInTrending ?? true,
        mediaTransform: doc.mediaTransform
            ? {
                scale: doc.mediaTransform.scale,
                translateX: doc.mediaTransform.translateX,
                translateY: doc.mediaTransform.translateY,
            }
            : null,
        textOverlays: (doc.textOverlays ?? []).map((o) => ({
            text: o.text,
            x: o.x,
            y: o.y,
            color: o.color ?? '#FFFFFF',
            fontSize: o.fontSize ?? 24,
        })),
    };
}
// ─── Service functions ────────────────────────────────────────────────────────
/**
 * Create a new story for the authenticated user.
 * `POST /api/v1/stories`
 */
export async function createStory(userId, body) {
    // Validate file ownership
    const prefix = `uploads/${userId}/`;
    if (!body.file.key.startsWith(prefix)) {
        throw new HttpError(403, 'File key does not belong to this user', 'FORBIDDEN_MEDIA');
    }
    // Validate MIME against declared mediaKind
    const baseMime = body.file.contentType.toLowerCase().split(';')[0]?.trim() ?? '';
    const cat = mediaCategory(baseMime);
    if (cat === null || cat === 'audio') {
        throw new HttpError(400, 'Only image or video files can be attached to a story', 'UNSUPPORTED_MEDIA_TYPE');
    }
    if (body.mediaKind === 'image' && cat !== 'image') {
        throw new HttpError(400, 'mediaKind "image" does not match file content type', 'MEDIA_KIND_MISMATCH');
    }
    if (body.mediaKind === 'short_video' && cat !== 'video') {
        throw new HttpError(400, 'mediaKind "short_video" does not match file content type', 'MEDIA_KIND_MISMATCH');
    }
    if (body.mediaKind === 'image' && body.durationSeconds != null) {
        throw new HttpError(400, 'durationSeconds must be omitted for image stories', 'VALIDATION_ERROR');
    }
    // Validate optional music attachment and resolve display title.
    let resolvedSoundTitle = body.soundTitle ?? null;
    let musicTrackOid = null;
    if (body.musicTrackId != null) {
        const track = (await MusicTrackModel.findById(body.musicTrackId)
            .select('title status durationSeconds artist')
            .lean());
        if (!track || track.status !== 'published') {
            throw new HttpError(404, 'Music track not found or not available', 'MUSIC_TRACK_NOT_FOUND');
        }
        // The music window length now matches the story's media duration
        // (image stories use a viewer-side default), so we just sanity-check
        // that the start offset is within the track itself. The viewer
        // gracefully loops if the chosen window happens to exceed the track.
        if (track.durationSeconds != null &&
            (body.musicTrimStartMs ?? 0) >= Math.floor(track.durationSeconds * 1000)) {
            throw new HttpError(400, 'Music trim start exceeds track duration', 'MUSIC_TRIM_OUT_OF_RANGE');
        }
        musicTrackOid = track._id;
        // Auto-derive display title from track + artist when client didn't supply one.
        if (!resolvedSoundTitle) {
            const artist = (await ArtistModel.findById(track.artist)
                .select('name')
                .lean());
            resolvedSoundTitle = artist?.name
                ? `${track.title} — ${artist.name}`
                : track.title;
        }
    }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + STORY_TTL_MS);
    const doc = await StoryModel.create({
        author: userId,
        mediaKind: body.mediaKind,
        media: {
            key: body.file.key,
            bucket: body.file.bucket,
            contentType: body.file.contentType.split(';')[0]?.trim() ?? body.file.contentType,
            size: body.file.size,
            originalName: body.file.originalName,
            url: body.file.url,
            imageVariants: body.file.imageVariants ?? [],
        },
        soundTitle: resolvedSoundTitle,
        musicTrack: musicTrackOid,
        musicTrimStartMs: musicTrackOid != null ? body.musicTrimStartMs ?? 0 : null,
        caption: body.caption ?? null,
        mediaWidth: body.mediaWidth ?? null,
        mediaHeight: body.mediaHeight ?? null,
        durationSeconds: body.durationSeconds ?? null,
        mediaProcessingStatus: body.mediaKind === 'short_video' ? 'processing' : 'not_required',
        hlsUrl: null,
        hlsVariants: [],
        mediaProcessingError: null,
        expiresAt,
        showInTrending: body.showInTrending ?? true,
        textOverlays: (body.textOverlays ?? []).map((o) => ({
            text: o.text,
            x: o.x,
            y: o.y,
            color: o.color ?? '#FFFFFF',
            fontSize: o.fontSize ?? 24,
        })),
        mediaTransform: body.mediaTransform ?? null,
    });
    if (body.mediaKind === 'short_video') {
        enqueueMediaProcessing('story', doc._id.toString()).catch((err) => {
            void StoryModel.updateOne({ _id: doc._id }, {
                $set: {
                    mediaProcessingStatus: 'failed',
                    mediaProcessingError: 'Media processing queue unavailable',
                },
            });
            console.error(`[stories] enqueueMediaProcessing failed storyId=${doc._id.toString()}:`, err instanceof Error ? err.message : err);
        });
    }
    const info = await authorInfoFor(userId);
    const musicMap = doc.musicTrack
        ? await buildMusicMap([doc.musicTrack])
        : new Map();
    return toStoryDto(doc, info.username, musicMap, info);
}
/**
 * Paginated feed of all active (non-expired) stories, newest first.
 * `GET /api/v1/stories/feed?page=&limit=`
 */
export async function listStoryFeed(query, viewerId) {
    const { page, limit } = query;
    const skip = page * limit;
    const now = new Date();
    const hiddenIds = viewerId && mongoose.isValidObjectId(viewerId)
        ? await listHiddenUserIds(viewerId)
        : [];
    const baseFilter = { expiresAt: { $gt: now } };
    if (hiddenIds.length > 0) {
        baseFilter.author = {
            $nin: hiddenIds.map((id) => new mongoose.Types.ObjectId(id)),
        };
    }
    const [total, docs] = await Promise.all([
        StoryModel.countDocuments(baseFilter),
        StoryModel.find(baseFilter)
            .sort({ createdAt: -1, _id: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
    ]);
    const leanDocs = docs;
    const authorIds = leanDocs.map((d) => authorIdStr(d.author));
    const [infoByAuthorId, musicMap] = await Promise.all([
        mapAuthorIdsToInfo(authorIds),
        buildMusicMap(collectMusicTrackIds(leanDocs)),
    ]);
    const items = leanDocs.map((d) => {
        const aid = authorIdStr(d.author);
        const info = infoByAuthorId.get(aid) ?? {
            username: fallbackUsername(aid),
            fullName: null,
        };
        return toStoryDto(d, info.username, musicMap, info);
    });
    return {
        items,
        page,
        limit,
        total,
        hasMore: skip + items.length < total,
    };
}
/**
 * All active stories by a specific author (for profile ring display).
 * `GET /api/v1/stories/user/:userId`
 */
export async function listUserStories(authorId, viewerId) {
    if (!mongoose.isValidObjectId(authorId)) {
        throw new HttpError(400, 'Invalid user id', 'INVALID_USER_ID');
    }
    if (viewerId &&
        viewerId !== authorId &&
        (await isBlockedBetween(viewerId, authorId))) {
        return { items: [] };
    }
    const now = new Date();
    const docs = (await StoryModel.find({
        author: authorId,
        expiresAt: { $gt: now },
    })
        .sort({ createdAt: -1, _id: -1 })
        .lean());
    const [info, musicMap] = await Promise.all([
        authorInfoFor(authorId),
        buildMusicMap(collectMusicTrackIds(docs)),
    ]);
    const items = docs.map((d) => toStoryDto(d, info.username, musicMap, info));
    return { items };
}
/**
 * Set of story-id strings (among `storyIds`) that `viewerId` has already
 * viewed. Used to decide whether an author's ring is coloured or grayed out.
 */
async function viewedStoryIdSet(viewerId, storyIds) {
    if (!viewerId || !mongoose.isValidObjectId(viewerId) || storyIds.length === 0) {
        return new Set();
    }
    const views = (await StoryViewModel.find({
        viewer: new mongoose.Types.ObjectId(viewerId),
        story: { $in: storyIds },
    })
        .select('story')
        .lean());
    return new Set(views.map((v) => v.story.toString()));
}
/**
 * Active stories from users in the caller's follow network
 * (people I follow OR who follow me), grouped by author, newest first.
 * `GET /api/v1/stories/connections`
 */
export async function listConnectionStories(viewerId) {
    if (!mongoose.isValidObjectId(viewerId)) {
        throw new HttpError(400, 'Invalid user id', 'INVALID_USER_ID');
    }
    const viewerOid = new mongoose.Types.ObjectId(viewerId);
    // People I follow
    const followingDocs = await FollowModel.find({ follower: viewerOid })
        .select('followee')
        .lean();
    // People who follow me
    const followerDocs = await FollowModel.find({ followee: viewerOid })
        .select('follower')
        .lean();
    // Chat-screen stories are limited to MUTUAL connections — people I follow
    // who also follow me back. A one-way follow (in either direction) is excluded.
    const followingSet = new Set();
    for (const d of followingDocs)
        followingSet.add(d.followee.toString());
    const connectedIdSet = new Set();
    for (const d of followerDocs) {
        const followerId = d.follower.toString();
        if (followingSet.has(followerId))
            connectedIdSet.add(followerId);
    }
    // exclude self
    connectedIdSet.delete(viewerId);
    if (connectedIdSet.size === 0) {
        return { authors: [] };
    }
    const connectedIds = [...connectedIdSet].map((id) => new mongoose.Types.ObjectId(id));
    const now = new Date();
    const stories = (await StoryModel.find({
        author: { $in: connectedIds },
        expiresAt: { $gt: now },
    })
        .sort({ createdAt: -1, _id: -1 })
        .lean());
    if (stories.length === 0) {
        return { authors: [] };
    }
    // Group stories by author
    const byAuthor = new Map();
    for (const s of stories) {
        const aid = authorIdStr(s.author);
        const list = byAuthor.get(aid) ?? [];
        list.push(s);
        byAuthor.set(aid, list);
    }
    // Fetch author profiles
    const authorIds = [...byAuthor.keys()];
    const usernameMap = await mapAuthorIdsToUsernames(authorIds);
    const [userRows, musicMap] = await Promise.all([
        UserModel.find({ _id: { $in: authorIds } })
            .select('_id username fullName avatarUrl')
            .lean(),
        buildMusicMap(collectMusicTrackIds(stories)),
    ]);
    const userMap = new Map(userRows.map((u) => [u._id.toString(), u]));
    // Which of these stories has the viewer already seen? (grays the ring)
    const viewedSet = await viewedStoryIdSet(viewerId, stories.map((s) => s._id));
    const authors = authorIds.map((aid) => {
        const user = userMap.get(aid);
        const authorUsername = usernameMap.get(aid) ?? fallbackUsername(aid);
        const authorName = {
            fullName: user?.fullName ?? null,
        };
        const authorDocs = byAuthor.get(aid) ?? [];
        return {
            userId: aid,
            username: authorUsername,
            fullName: authorName.fullName,
            avatarUrl: user?.avatarUrl ?? null,
            stories: authorDocs.map((d) => toStoryDto(d, authorUsername, musicMap, authorName)),
            hasUnseen: authorDocs.some((d) => !viewedSet.has(d._id.toString())),
        };
    });
    // Sort authors by their newest story (most recent first)
    authors.sort((a, b) => {
        const aTime = new Date(a.stories[0]?.createdAt ?? 0).getTime();
        const bTime = new Date(b.stories[0]?.createdAt ?? 0).getTime();
        return bTime - aTime;
    });
    return { authors };
}
/**
 * Trending active stories — one ring per author, authors ordered by their
 * single most-viewed active story (desc). Stories inside each ring are
 * sorted newest first for viewer playback order.
 * `GET /api/v1/stories/trending`
 */
export async function listTrendingStories(limit = 20, viewerId) {
    const now = new Date();
    const hiddenIds = viewerId && mongoose.isValidObjectId(viewerId)
        ? await listHiddenUserIds(viewerId)
        : [];
    const trendingFilter = {
        expiresAt: { $gt: now },
        showInTrending: { $ne: false },
    };
    if (hiddenIds.length > 0) {
        trendingFilter.author = {
            $nin: hiddenIds.map((id) => new mongoose.Types.ObjectId(id)),
        };
    }
    const stories = (await StoryModel.find(trendingFilter)
        .sort({ viewsCount: -1, createdAt: -1, _id: -1 })
        .lean());
    if (stories.length === 0) {
        return { authors: [] };
    }
    // Group by author, preserving viewsCount-desc order for ranking.
    const byAuthor = new Map();
    const authorOrder = [];
    for (const s of stories) {
        const aid = authorIdStr(s.author);
        if (!byAuthor.has(aid)) {
            byAuthor.set(aid, []);
            authorOrder.push(aid);
        }
        byAuthor.get(aid).push(s);
    }
    const topAuthorIds = authorOrder.slice(0, limit);
    const usernameMap = await mapAuthorIdsToUsernames(topAuthorIds);
    // Restrict music population to the top-N authors actually returned.
    const topAuthorIdSet = new Set(topAuthorIds);
    const topStories = stories.filter((s) => topAuthorIdSet.has(authorIdStr(s.author)));
    const [userRows, musicMap] = await Promise.all([
        UserModel.find({ _id: { $in: topAuthorIds } })
            .select('_id username fullName avatarUrl')
            .lean(),
        buildMusicMap(collectMusicTrackIds(topStories)),
    ]);
    const userMap = new Map(userRows.map((u) => [u._id.toString(), u]));
    // Which of these stories has the viewer already seen? (grays the ring)
    const viewedSet = await viewedStoryIdSet(viewerId, topStories.map((s) => s._id));
    const authors = topAuthorIds.map((aid) => {
        const user = userMap.get(aid);
        const authorUsername = usernameMap.get(aid) ?? fallbackUsername(aid);
        const authorName = {
            fullName: user?.fullName ?? null,
        };
        // Sort each author's stories newest first for playback
        const authorStories = (byAuthor.get(aid) ?? []).slice().sort((a, b) => {
            const at = (a.createdAt instanceof Date ? a.createdAt : new Date(String(a.createdAt))).getTime();
            const bt = (b.createdAt instanceof Date ? b.createdAt : new Date(String(b.createdAt))).getTime();
            return bt - at;
        });
        return {
            userId: aid,
            username: authorUsername,
            fullName: authorName.fullName,
            avatarUrl: user?.avatarUrl ?? null,
            stories: authorStories.map((d) => toStoryDto(d, authorUsername, musicMap, authorName)),
            hasUnseen: authorStories.some((d) => !viewedSet.has(d._id.toString())),
        };
    });
    return { authors };
}
/**
 * Fetch a single story by ID (must not be expired).
 * `GET /api/v1/stories/:storyId`
 */
export async function getStory(storyId, viewerId) {
    if (!mongoose.isValidObjectId(storyId)) {
        throw new HttpError(400, 'Invalid story id', 'INVALID_STORY_ID');
    }
    const now = new Date();
    const doc = await StoryModel.findOne({
        _id: storyId,
        expiresAt: { $gt: now },
    });
    if (!doc) {
        throw new HttpError(404, 'Story not found or has expired', 'STORY_NOT_FOUND');
    }
    const authorId = authorIdStr(doc.author);
    if (viewerId &&
        viewerId !== authorId &&
        (await isBlockedBetween(viewerId, authorId))) {
        throw new HttpError(404, 'Story not found or has expired', 'STORY_NOT_FOUND');
    }
    const [info, musicMap] = await Promise.all([
        authorInfoFor(authorId),
        doc.musicTrack
            ? buildMusicMap([doc.musicTrack])
            : Promise.resolve(new Map()),
    ]);
    return toStoryDto(doc, info.username, musicMap, info);
}
/**
 * Record a distinct story view.
 * - Skips silently if the viewer is the story author.
 * - Uses an upsert on the StoryView collection (unique on story+viewer)
 *   so each user is counted at most once.
 * - Syncs `viewsCount` on the Story document from the actual distinct count.
 */
export async function recordStoryView(storyId, viewerId) {
    if (!mongoose.isValidObjectId(storyId)) {
        throw new HttpError(400, 'Invalid story id', 'INVALID_STORY_ID');
    }
    const now = new Date();
    const story = await StoryModel.findOne({ _id: storyId, expiresAt: { $gt: now } }, { author: 1, viewsCount: 1 }).lean();
    if (!story) {
        throw new HttpError(404, 'Story not found or has expired', 'STORY_NOT_FOUND');
    }
    // Don't log the author as a viewer
    if (story.author.toString() === viewerId) {
        return { viewsCount: story.viewsCount ?? 0 };
    }
    // Upsert — duplicate key is silently ignored via the unique index
    try {
        await StoryViewModel.create({
            story: new mongoose.Types.ObjectId(storyId),
            viewer: new mongoose.Types.ObjectId(viewerId),
        });
        // New viewer was inserted — increment the counter
        const updated = await StoryModel.findByIdAndUpdate(storyId, { $inc: { viewsCount: 1 } }, { new: true, select: 'viewsCount' }).lean();
        return { viewsCount: updated?.viewsCount ?? 0 };
    }
    catch (err) {
        // Duplicate key = viewer already recorded — return current count
        if (err instanceof Error &&
            'code' in err &&
            err.code === 11000) {
            return { viewsCount: story.viewsCount ?? 0 };
        }
        throw err;
    }
}
/**
 * Delete the caller's own story.
 * `DELETE /api/v1/stories/:storyId`
 */
export async function deleteStory(userId, storyId) {
    if (!mongoose.isValidObjectId(storyId)) {
        throw new HttpError(400, 'Invalid story id', 'INVALID_STORY_ID');
    }
    const doc = await StoryModel.findById(storyId).select('author').lean();
    if (!doc) {
        throw new HttpError(404, 'Story not found', 'STORY_NOT_FOUND');
    }
    if (doc.author.toString() !== userId) {
        throw new HttpError(403, 'You can only delete your own stories', 'FORBIDDEN');
    }
    await StoryViewModel.deleteMany({ story: storyId });
    await StoryReactionModel.deleteMany({ story: storyId });
    await StoryModel.deleteOne({ _id: storyId });
}
/**
 * List distinct viewers of a story — only the story author may call this.
 */
export async function getStoryViewers(storyId, requesterId) {
    if (!mongoose.isValidObjectId(storyId)) {
        throw new HttpError(400, 'Invalid story id', 'INVALID_STORY_ID');
    }
    const story = await StoryModel.findById(storyId)
        .select('author')
        .lean();
    if (!story) {
        throw new HttpError(404, 'Story not found', 'STORY_NOT_FOUND');
    }
    if (story.author.toString() !== requesterId) {
        throw new HttpError(403, 'Only the author can view the viewers list', 'FORBIDDEN');
    }
    const views = await StoryViewModel.find({ story: storyId })
        .sort({ createdAt: -1 })
        .lean()
        .exec();
    if (views.length === 0) {
        return { viewers: [] };
    }
    const viewerIds = views.map(v => v.viewer);
    const users = await UserModel.find({ _id: { $in: viewerIds } }, { username: 1, fullName: 1, avatarUrl: 1 })
        .lean()
        .exec();
    const userMap = new Map(users.map(u => [u._id.toString(), u]));
    const viewers = views
        .map(v => {
        const u = userMap.get(v.viewer.toString());
        if (!u)
            return null;
        return {
            id: u._id.toString(),
            username: u.username ?? '',
            fullName: u.fullName ?? null,
            avatarUrl: u.avatarUrl ?? null,
            viewedAt: v.createdAt.toISOString(),
        };
    })
        .filter((x) => x !== null);
    return { viewers };
}
/**
 * Add or change the viewer's reaction on a story (one per user).
 * If `reaction` is the same as the existing one, remove it (toggle off).
 */
export async function reactToStory(storyId, userId, reaction) {
    if (!mongoose.isValidObjectId(storyId)) {
        throw new HttpError(400, 'Invalid story id', 'INVALID_STORY_ID');
    }
    const storyExists = await StoryModel.exists({ _id: storyId });
    if (!storyExists) {
        throw new HttpError(404, 'Story not found', 'STORY_NOT_FOUND');
    }
    const existing = await StoryReactionModel.findOne({
        story: storyId,
        user: userId,
    }).lean();
    if (existing?.reaction === reaction) {
        // Toggle off — remove reaction
        await StoryReactionModel.deleteOne({ story: storyId, user: userId });
        return { viewerReaction: null };
    }
    // Upsert the reaction
    await StoryReactionModel.findOneAndUpdate({ story: new mongoose.Types.ObjectId(storyId), user: new mongoose.Types.ObjectId(userId) }, { reaction }, { upsert: true, new: true });
    // Notify the story owner. Collapsible per (recipient, actor, story) so
    // changing the reaction bumps the single row instead of spamming.
    void (async () => {
        try {
            const story = (await StoryModel.findById(storyId)
                .select('author')
                .lean());
            const ownerId = story?.author?.toString();
            if (!ownerId || ownerId === userId)
                return;
            const reactor = await UserModel.findById(userId)
                .select('fullName username')
                .lean();
            const name = reactor?.fullName?.trim() ||
                reactor?.username ||
                'Someone';
            const isNew = await createNotification({
                recipient: ownerId,
                actor: userId,
                type: 'story_reaction',
                story: storyId,
                meta: { reaction },
            });
            if (isNew) {
                await sendToUser(ownerId, {
                    type: 'story_reaction',
                    title: 'Story reaction',
                    body: `${name} reacted to your story`,
                    data: { storyId, reactorId: userId, reaction },
                });
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'unknown error';
            console.warn('[story] reaction push dispatch failed:', msg);
        }
    })();
    return { viewerReaction: reaction };
}
/**
 * Get aggregated reaction counts for a story + the viewer's own reaction.
 */
export async function getStoryReactions(storyId, viewerId) {
    if (!mongoose.isValidObjectId(storyId)) {
        throw new HttpError(400, 'Invalid story id', 'INVALID_STORY_ID');
    }
    const [countsRaw, viewerDoc] = await Promise.all([
        StoryReactionModel.aggregate([
            { $match: { story: new mongoose.Types.ObjectId(storyId) } },
            { $group: { _id: '$reaction', count: { $sum: 1 } } },
        ]),
        StoryReactionModel.findOne({ story: storyId, user: viewerId })
            .select('reaction')
            .lean(),
    ]);
    const counts = countsRaw.map(r => ({
        reaction: r._id,
        count: r.count,
    }));
    return {
        counts,
        viewerReaction: viewerDoc?.reaction ?? null,
    };
}
