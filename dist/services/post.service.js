import mongoose from 'mongoose';
import { mediaCategory } from '../lib/allowedMediaMime.js';
import { HttpError } from '../lib/httpError.js';
import { PostModel } from '../models/post.model.js';
import { UserModel } from '../models/user.model.js';
import { PostLikeModel } from '../models/postLike.model.js';
import { PostSaveModel } from '../models/postSave.model.js';
import { PostViewModel } from '../models/postView.model.js';
import { ArtistModel } from '../models/artist.model.js';
import { MusicTrackModel } from '../models/musicTrack.model.js';
import { AdModel } from '../models/ad.model.js';
import { listFeedRecommendationUsers, } from './feedRecommendations.service.js';
import { countFollowing, listFolloweeIds, listFollowerIds, } from './follow.service.js';
import { createNotification, sendToUser } from './notification.service.js';
import { generateVideoThumbnail } from './thumbnail.service.js';
import { enqueueSoundExtraction } from '../queues/soundExtraction.queue.js';
import { enqueueMediaProcessing } from '../queues/mediaProcessing.queue.js';
import { OriginalSoundModel } from '../models/originalSound.model.js';
import { listHiddenUserIds } from './userBlock.service.js';
function uploadKeyPrefix(userId) {
    return `uploads/${userId}/`;
}
function authorIdString(author) {
    if (typeof author === 'string') {
        return author;
    }
    return author.toString();
}
function fallbackAuthorUsername(authorId) {
    return `user_${authorId.slice(-6)}`;
}
async function mapAuthorIdsToInfo(authorIds) {
    const map = new Map();
    const unique = [
        ...new Set(authorIds.filter((id) => mongoose.isValidObjectId(id))),
    ];
    if (unique.length === 0) {
        return map;
    }
    const rows = (await UserModel.find({ _id: { $in: unique } })
        .select('_id username fullName avatarUrl')
        .lean());
    for (const r of rows) {
        const id = r._id.toString();
        const u = typeof r.username === 'string' && r.username.trim().length > 0
            ? r.username.trim().toLowerCase()
            : fallbackAuthorUsername(id);
        // Display name: fullName → username (system-wide convention).
        const fn = typeof r.fullName === 'string' && r.fullName.trim().length > 0
            ? r.fullName.trim()
            : u;
        const av = typeof r.avatarUrl === 'string' && r.avatarUrl.trim().length > 0
            ? r.avatarUrl.trim()
            : null;
        map.set(id, { username: u, fullName: fn, avatarUrl: av });
    }
    for (const id of unique) {
        if (!map.has(id)) {
            const fb = fallbackAuthorUsername(id);
            map.set(id, { username: fb, fullName: fb, avatarUrl: null });
        }
    }
    return map;
}
async function infoForAuthorId(authorId) {
    const fb = fallbackAuthorUsername(authorId);
    if (!mongoose.isValidObjectId(authorId)) {
        return { username: fb, fullName: fb, avatarUrl: null };
    }
    const row = (await UserModel.findById(authorId)
        .select('username fullName avatarUrl')
        .lean());
    const u = typeof row?.username === 'string' && row.username.trim().length > 0
        ? row.username.trim().toLowerCase()
        : fb;
    // Display name: fullName → username (system-wide convention).
    const fn = typeof row?.fullName === 'string' && row.fullName.trim().length > 0
        ? row.fullName.trim()
        : u;
    const av = typeof row?.avatarUrl === 'string' && row.avatarUrl.trim().length > 0
        ? row.avatarUrl.trim()
        : null;
    return { username: u, fullName: fn, avatarUrl: av };
}
/**
 * Batch-fetch tracks (and their artists) referenced by a list of posts.
 * Two queries total regardless of input size. Mirrors the story-service
 * helper of the same name.
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
/** Collect the music track ObjectIds referenced by a list of posts. */
function collectMusicTrackIds(docs) {
    const out = [];
    for (const d of docs) {
        if (d.musicTrack) {
            out.push(d.musicTrack);
        }
    }
    return out;
}
/** Collect the OriginalSound ObjectIds attached to a list of posts. */
function collectAttachedOriginalSoundIds(docs) {
    const out = [];
    for (const d of docs) {
        if (d.attachedOriginalSound) {
            out.push(d.attachedOriginalSound);
        }
    }
    return out;
}
/** Collect the OriginalSound ids that posts were extracted INTO. */
function collectOwnOriginalSoundIds(docs) {
    const out = [];
    for (const d of docs) {
        if (d.originalSoundId) {
            out.push(d.originalSoundId);
        }
    }
    return out;
}
/**
 * Batch-fetch a post's OWN original sounds for the attribution label.
 * Only `ready` sounds are returned — a pending/failed extraction shows
 * no label. One query for sounds, one for owner usernames.
 */
async function buildOwnSoundMap(soundIds) {
    const unique = [...new Set(soundIds.map(id => id.toString()))];
    if (unique.length === 0) {
        return new Map();
    }
    const sounds = (await OriginalSoundModel.find({
        _id: { $in: unique },
        status: 'ready',
    })
        .select('title ownerUser status')
        .lean());
    if (sounds.length === 0) {
        return new Map();
    }
    const ownerIds = [...new Set(sounds.map(s => s.ownerUser.toString()))];
    const owners = (await UserModel.find({ _id: { $in: ownerIds } })
        .select('username')
        .lean());
    const usernameByOwnerId = new Map(owners.map(o => [o._id.toString(), o.username]));
    return new Map(sounds.map(s => [
        s._id.toString(),
        {
            soundId: s._id.toString(),
            title: s.title,
            ownerUsername: usernameByOwnerId.get(s.ownerUser.toString()) ?? '',
        },
    ]));
}
/**
 * Batch-fetch OriginalSound rows + their source-post thumbnails in one
 * shot (plus a single per-author username lookup for the `artistName`
 * field — yes, we reuse the music DTO's "artist" slot for the creator's
 * @handle so the mobile player UI doesn't need any branching).
 */
async function buildOriginalSoundMap(soundIds) {
    const unique = [...new Set(soundIds.map(id => id.toString()))];
    if (unique.length === 0) {
        return new Map();
    }
    const sounds = (await OriginalSoundModel.find({ _id: { $in: unique } })
        .select('title audioUrl durationSeconds sourcePost ownerUser')
        .lean());
    if (sounds.length === 0) {
        return new Map();
    }
    // Source-post thumbnails serve as the cover art for the player UI.
    const postIds = [...new Set(sounds.map(s => s.sourcePost.toString()))];
    const postRows = (await PostModel.find({ _id: { $in: postIds } })
        .select('thumbnailUrl media')
        .lean());
    const thumbByPostId = new Map(postRows.map(p => [
        p._id.toString(),
        p.thumbnailUrl ?? p.media?.url ?? '',
    ]));
    // Owner usernames stand in for "artistName" in the existing DTO.
    const ownerIds = [...new Set(sounds.map(s => s.ownerUser.toString()))];
    const owners = (await UserModel.find({ _id: { $in: ownerIds } })
        .select('username')
        .lean());
    const usernameByOwnerId = new Map(owners.map(o => [o._id.toString(), o.username]));
    return new Map(sounds
        // Skip sounds without a usable audio URL (still processing / failed).
        .filter(s => typeof s.audioUrl === 'string' && s.audioUrl.length > 0)
        .map(s => [
        s._id.toString(),
        {
            title: s.title,
            artistName: usernameByOwnerId.get(s.ownerUser.toString())
                ? `@${usernameByOwnerId.get(s.ownerUser.toString()) ?? ''}`
                : null,
            audioUrl: s.audioUrl,
            artUrl: thumbByPostId.get(s.sourcePost.toString()) ?? '',
            durationSeconds: s.durationSeconds,
        },
    ]));
}
/** Build the populated `music` field for a single post DTO. */
function buildPostMusicDto(doc, musicByTrackId, soundsBySoundId) {
    // Curated music track takes precedence (it's mutually exclusive with
    // attachedOriginalSound at the model level; both being set would have
    // been rejected during validation).
    if (doc.musicTrack != null && doc.musicTrimStartMs != null) {
        const trackId = doc.musicTrack.toString();
        const lite = musicByTrackId?.get(trackId);
        if (lite) {
            return {
                trackId,
                source: 'track',
                title: lite.title,
                artistName: lite.artistName,
                audioUrl: lite.audioUrl,
                artUrl: lite.artUrl,
                durationSeconds: lite.durationSeconds,
                trimStartMs: doc.musicTrimStartMs,
            };
        }
    }
    if (doc.attachedOriginalSound != null) {
        const soundId = doc.attachedOriginalSound.toString();
        const lite = soundsBySoundId?.get(soundId);
        if (lite) {
            return {
                trackId: soundId,
                source: 'original_sound',
                title: lite.title,
                artistName: lite.artistName,
                audioUrl: lite.audioUrl,
                artUrl: lite.artUrl,
                durationSeconds: lite.durationSeconds,
                // Trim window honoured the same way as curated tracks — the FE
                // picker lets users choose an offset within the sound.
                trimStartMs: doc.musicTrimStartMs ?? 0,
            };
        }
    }
    return null;
}
function toPostDto(doc, likedByViewer, savedByViewer, authorInfo, musicByTrackId, soundsBySoundId, ownSoundsById) {
    // The post's own extracted sound (attribution label only). We hide it
    // when the post has an *attached* track/sound, since that's what plays.
    const ownSoundId = doc.originalSoundId
        ? doc.originalSoundId.toString()
        : null;
    const ownSound = ownSoundId && doc.musicTrack == null && doc.attachedOriginalSound == null
        ? ownSoundsById?.get(ownSoundId) ?? null
        : null;
    const id = doc._id.toString();
    const createdAt = doc.createdAt instanceof Date
        ? doc.createdAt
        : new Date(String(doc.createdAt));
    const updatedAt = doc.updatedAt instanceof Date
        ? doc.updatedAt
        : new Date(String(doc.updatedAt));
    return {
        id,
        authorId: authorIdString(doc.author),
        authorUsername: authorInfo.username,
        authorFullName: authorInfo.fullName,
        authorAvatarUrl: authorInfo.avatarUrl,
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
        thumbnailUrl: doc.thumbnailUrl ?? null,
        caption: doc.caption,
        hashtags: doc.hashtags,
        musicTitle: doc.musicTitle,
        music: buildPostMusicDto(doc, musicByTrackId, soundsBySoundId),
        originalSound: ownSound,
        originalAudioMuted: doc.originalAudioMuted ?? false,
        mediaWidth: doc.mediaWidth,
        mediaHeight: doc.mediaHeight,
        durationSeconds: doc.durationSeconds,
        mediaProcessingStatus: doc.mediaProcessingStatus ?? 'not_required',
        hlsUrl: doc.hlsUrl ?? null,
        hlsVariants: doc.hlsVariants ?? [],
        mediaProcessingError: doc.mediaProcessingError ?? null,
        likesCount: doc.likesCount,
        savesCount: doc.savesCount ?? 0,
        commentsCount: doc.commentsCount,
        likedByViewer,
        savedByViewer,
        createdAt: createdAt.toISOString(),
        updatedAt: updatedAt.toISOString(),
    };
}
export async function getPostById(postId, viewerUserId) {
    if (!mongoose.isValidObjectId(postId)) {
        throw new HttpError(400, 'Invalid post id', 'INVALID_POST_ID');
    }
    const doc = (await PostModel.findById(postId).lean());
    if (!doc) {
        throw new HttpError(404, 'Post not found', 'POST_NOT_FOUND');
    }
    const authorId = authorIdString(doc.author);
    const validViewerUserId = typeof viewerUserId === 'string' && mongoose.isValidObjectId(viewerUserId)
        ? viewerUserId
        : null;
    const [authorInfo, musicMap, soundMap, ownSoundMap, like, save] = await Promise.all([
        infoForAuthorId(authorId),
        buildMusicMap(collectMusicTrackIds([doc])),
        buildOriginalSoundMap(collectAttachedOriginalSoundIds([doc])),
        buildOwnSoundMap(collectOwnOriginalSoundIds([doc])),
        validViewerUserId
            ? PostLikeModel.exists({ user: validViewerUserId, post: postId })
            : Promise.resolve(null),
        validViewerUserId
            ? PostSaveModel.exists({ user: validViewerUserId, post: postId })
            : Promise.resolve(null),
    ]);
    return toPostDto(doc, Boolean(like), Boolean(save), authorInfo, musicMap, soundMap, ownSoundMap);
}
async function mergeRecommendationsIntoFirstPage(viewerUserId, posts) {
    const following = await countFollowing(viewerUserId);
    const showRec = following < 5;
    if (!showRec || posts.length < 2) {
        return posts.map((post) => ({ type: 'post', post }));
    }
    const users = await listFeedRecommendationUsers(viewerUserId, 6);
    if (users.length === 0) {
        return posts.map((post) => ({ type: 'post', post }));
    }
    const slotAfterIndex = Math.floor(Math.random() * Math.max(1, posts.length - 1));
    const maxAfter = Math.max(0, posts.length - 1);
    const after = Math.min(Math.max(0, slotAfterIndex), maxAfter);
    const rows = posts.map((post) => ({
        type: 'post',
        post,
    }));
    const rec = {
        type: 'recommendations',
        id: 'feed-recommendations',
        users,
    };
    return [...rows.slice(0, after + 1), rec, ...rows.slice(after + 1)];
}
/**
 * Fetch currently-active ads for a placement from the DB and map to
 * `SponsoredAdDto` (the shape the mobile feed already consumes). Active =
 * status 'active' AND (startDate unset OR startDate <= now) AND
 * (endDate unset OR endDate >= now).
 */
async function getActiveAdsForPlacement(placement) {
    const now = new Date();
    const ads = await AdModel.find({
        placement,
        status: 'active',
        $and: [
            { $or: [{ startDate: null }, { startDate: { $lte: now } }] },
            { $or: [{ endDate: null }, { endDate: { $gte: now } }] },
        ],
    })
        .sort({ createdAt: -1 })
        .lean();
    return ads.map((a) => {
        const id = String(a._id);
        const handle = (a.title ?? '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '') || `ad_${id.slice(-6)}`;
        return {
            id,
            imageUrl: a.imageUrl,
            avatarUrl: null,
            brandName: a.title,
            handle,
            caption: a.title,
            hashtags: null,
            targetUrl: a.targetUrl,
            ctaLabel: 'Learn more',
        };
    });
}
/** Insert sponsored cards after the Nth and Mth organic post (first page only). */
function mergeSponsoredAds(items, pool) {
    if (pool.length === 0) {
        return items;
    }
    const insertAfterPostCounts = [3, 6];
    const result = [];
    let postOrdinal = 0;
    let sponsoredUsed = 0;
    for (const row of items) {
        result.push(row);
        if (row.type !== 'post') {
            continue;
        }
        postOrdinal++;
        const trigger = insertAfterPostCounts[sponsoredUsed];
        if (trigger != null &&
            postOrdinal === trigger &&
            sponsoredUsed < pool.length) {
            result.push({ type: 'sponsored', ad: pool[sponsoredUsed] });
            sponsoredUsed++;
        }
    }
    return result;
}
export async function listHomeFeed(query, viewerUserId) {
    const { page, limit } = query;
    const skip = page * limit;
    // Feed composition:
    //   1. Posts from CONNECTIONS — people the viewer follows + people who
    //      follow the viewer — ordered by published (created) date desc.
    //   2. Then TRENDING posts from everyone else — newest first (fresh content, not old high-like posts).
    // Always excludes the viewer's own posts and blocked-either-way users.
    const isValidViewer = mongoose.isValidObjectId(viewerUserId);
    const hiddenIds = isValidViewer ? await listHiddenUserIds(viewerUserId) : [];
    const excludeIds = isValidViewer
        ? [viewerUserId, ...hiddenIds]
        : [...hiddenIds];
    const excludeSet = new Set(excludeIds);
    const [followees, followers] = isValidViewer
        ? await Promise.all([
            listFolloweeIds(viewerUserId),
            listFollowerIds(viewerUserId),
        ])
        : [[], []];
    const connectionIds = [...new Set([...followees, ...followers])].filter((id) => !excludeSet.has(id) && mongoose.isValidObjectId(id));
    const connectionOids = connectionIds.map((id) => new mongoose.Types.ObjectId(id));
    const excludeOids = excludeIds
        .filter((id) => mongoose.isValidObjectId(id))
        .map((id) => new mongoose.Types.ObjectId(id));
    const seenOids = isValidViewer
        ? (await PostViewModel.find({ user: viewerUserId })
            .select('post')
            .lean()).map((r) => r.post)
        : [];
    // Three buckets, concatenated in order; each newest-first:
    //   1. UNSEEN posts from connections
    //   2. UNSEEN posts from everyone else (unfollowed accounts)
    //   3. SEEN posts (any author except self/hidden) — last-resort backfill so
    //      an exhausted feed shows something rather than nothing.
    const unseenConnectionFilter = {
        author: { $in: connectionOids },
        _id: { $nin: seenOids },
    };
    const unseenOthersFilter = {
        author: { $nin: [...excludeOids, ...connectionOids] },
        _id: { $nin: seenOids },
    };
    const seenFallbackFilter = {
        author: { $nin: excludeOids },
        _id: { $in: seenOids },
    };
    const [unseenConnTotal, unseenOthersTotal, seenTotal] = await Promise.all([
        connectionOids.length > 0
            ? PostModel.countDocuments(unseenConnectionFilter)
            : Promise.resolve(0),
        PostModel.countDocuments(unseenOthersFilter),
        seenOids.length > 0
            ? PostModel.countDocuments(seenFallbackFilter)
            : Promise.resolve(0),
    ]);
    const feedBuckets = [
        { filter: unseenConnectionFilter, total: unseenConnTotal },
        { filter: unseenOthersFilter, total: unseenOthersTotal },
        { filter: seenFallbackFilter, total: seenTotal },
    ];
    const total = unseenConnTotal + unseenOthersTotal + seenTotal;
    // Slice the global window [skip, skip+limit) across the ordered buckets.
    const bucketFetches = [];
    let bucketOffset = 0;
    let cursor = skip;
    let need = limit;
    for (const b of feedBuckets) {
        if (need > 0 && b.total > 0 && cursor < bucketOffset + b.total) {
            const localSkip = Math.max(0, cursor - bucketOffset);
            const localLimit = Math.min(need, b.total - localSkip);
            if (localLimit > 0) {
                bucketFetches.push(PostModel.find(b.filter)
                    .sort({ createdAt: -1, _id: -1 })
                    .skip(localSkip)
                    .limit(localLimit)
                    .lean());
                need -= localLimit;
                cursor += localLimit;
            }
        }
        bucketOffset += b.total;
    }
    const fetched = await Promise.all(bucketFetches);
    const docs = fetched.flat();
    const postIds = docs.map((d) => d._id);
    const likedIdSet = new Set();
    const savedIdSet = new Set();
    if (postIds.length > 0 && mongoose.isValidObjectId(viewerUserId)) {
        const [likeRows, saveRows] = await Promise.all([
            PostLikeModel.find({
                user: viewerUserId,
                post: { $in: postIds },
            })
                .select('post')
                .lean(),
            PostSaveModel.find({
                user: viewerUserId,
                post: { $in: postIds },
            })
                .select('post')
                .lean(),
        ]);
        for (const row of likeRows) {
            likedIdSet.add(row.post.toString());
        }
        for (const row of saveRows) {
            savedIdSet.add(row.post.toString());
        }
    }
    const leanDocs = docs;
    const authorIds = leanDocs.map((d) => authorIdString(d.author));
    const [infoByAuthorId, musicMap, soundMap, ownSoundMap] = await Promise.all([
        mapAuthorIdsToInfo(authorIds),
        buildMusicMap(collectMusicTrackIds(leanDocs)),
        buildOriginalSoundMap(collectAttachedOriginalSoundIds(leanDocs)),
        buildOwnSoundMap(collectOwnOriginalSoundIds(leanDocs)),
    ]);
    const posts = leanDocs.map((lean) => {
        const id = lean._id.toString();
        const aid = authorIdString(lean.author);
        const fb = fallbackAuthorUsername(aid);
        const info = infoByAuthorId.get(aid) ?? {
            username: fb,
            fullName: fb,
            avatarUrl: null,
        };
        return toPostDto(lean, likedIdSet.has(id), savedIdSet.has(id), info, musicMap, soundMap, ownSoundMap);
    });
    let items = page === 0
        ? await mergeRecommendationsIntoFirstPage(viewerUserId, posts)
        : posts.map((post) => ({ type: 'post', post }));
    if (page === 0) {
        const adPool = await getActiveAdsForPlacement('feed');
        items = mergeSponsoredAds(items, adPool);
    }
    return {
        items,
        page,
        limit,
        total,
        hasMore: skip + posts.length < total,
    };
}
const TRENDING_POST_LIMIT = 30;
/** Upper bound the Trending screen can request in one call (10 strips × 10). */
const TRENDING_POST_MAX = 100;
/** Freshness bonus added to a post's like count so new posts can surface on
 * Trending. Worth ~18 "likes" when brand-new, decaying by 1 every 4 hours so
 * it's gone after ~3 days (after which ranking is pure like count). */
const TRENDING_FRESHNESS_BONUS = 18;
const TRENDING_FRESHNESS_DECAY_MS_PER_POINT = 4 * 60 * 60 * 1000;
/** Trending posts: like count blended with a decaying freshness bonus, so
 * popular posts rank high but new posts still get visibility. */
export async function listTrendingPosts(viewerUserId, opts) {
    const limit = Math.min(TRENDING_POST_MAX, Math.max(1, Math.trunc(opts?.limit ?? TRENDING_POST_LIMIT)));
    const hiddenIds = mongoose.isValidObjectId(viewerUserId)
        ? await listHiddenUserIds(viewerUserId)
        : [];
    const trendingFilter = hiddenIds.length > 0
        ? {
            author: {
                $nin: hiddenIds.map((id) => new mongoose.Types.ObjectId(id)),
            },
        }
        : {};
    const docs = (await PostModel.aggregate([
        { $match: trendingFilter },
        {
            $addFields: {
                _trendScore: {
                    $add: [
                        { $ifNull: ['$likesCount', 0] },
                        {
                            // Freshness bonus, clamped at 0 once it has fully decayed.
                            $max: [
                                0,
                                {
                                    $subtract: [
                                        TRENDING_FRESHNESS_BONUS,
                                        {
                                            $divide: [
                                                { $subtract: ['$$NOW', '$createdAt'] },
                                                TRENDING_FRESHNESS_DECAY_MS_PER_POINT,
                                            ],
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            },
        },
        { $sort: { _trendScore: -1, _id: -1 } },
        { $limit: limit },
    ]));
    const postIds = docs.map((d) => d._id);
    const likedIdSet = new Set();
    const savedIdSet = new Set();
    if (postIds.length > 0 && mongoose.isValidObjectId(viewerUserId)) {
        const [likeRows, saveRows] = await Promise.all([
            PostLikeModel.find({
                user: viewerUserId,
                post: { $in: postIds },
            })
                .select('post')
                .lean(),
            PostSaveModel.find({
                user: viewerUserId,
                post: { $in: postIds },
            })
                .select('post')
                .lean(),
        ]);
        for (const row of likeRows) {
            likedIdSet.add(row.post.toString());
        }
        for (const row of saveRows) {
            savedIdSet.add(row.post.toString());
        }
    }
    const authorIds = docs.map((d) => authorIdString(d.author));
    const [infoByAuthorId, musicMap, soundMap, ownSoundMap] = await Promise.all([
        mapAuthorIdsToInfo(authorIds),
        buildMusicMap(collectMusicTrackIds(docs)),
        buildOriginalSoundMap(collectAttachedOriginalSoundIds(docs)),
        buildOwnSoundMap(collectOwnOriginalSoundIds(docs)),
    ]);
    const items = docs.map((lean) => {
        const id = lean._id.toString();
        const aid = authorIdString(lean.author);
        const fb = fallbackAuthorUsername(aid);
        const info = infoByAuthorId.get(aid) ?? {
            username: fb,
            fullName: fb,
            avatarUrl: null,
        };
        return toPostDto(lean, likedIdSet.has(id), savedIdSet.has(id), info, musicMap, soundMap, ownSoundMap);
    });
    return { items };
}
function assertObjectId(id) {
    if (!mongoose.isValidObjectId(id)) {
        throw new HttpError(400, 'Invalid post id', 'INVALID_POST_ID');
    }
}
/** Escape a string for safe inclusion in a RegExp. */
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * Paginated list of posts whose `caption` or `hashtags` contains `#<tag>`.
 * Tag matching is case-insensitive and word-bounded.
 * `GET /api/v1/posts/hashtag/:tag`
 */
export async function listPostsByHashtag(rawTag, query, viewerUserId) {
    const tag = (rawTag ?? '').trim().replace(/^#/, '');
    if (tag.length === 0) {
        throw new HttpError(400, 'Invalid hashtag', 'INVALID_HASHTAG');
    }
    const escaped = escapeRegExp(tag);
    // Match `#tag` followed by a non-tag character (or end-of-string).
    const re = new RegExp(`#${escaped}(?![A-Za-z0-9_])`, 'i');
    const hiddenIds = mongoose.isValidObjectId(viewerUserId)
        ? await listHiddenUserIds(viewerUserId)
        : [];
    const baseFilter = {
        $or: [{ hashtags: re }, { caption: re }],
    };
    if (hiddenIds.length > 0) {
        baseFilter.author = {
            $nin: hiddenIds.map((id) => new mongoose.Types.ObjectId(id)),
        };
    }
    const { page, limit } = query;
    const skip = page * limit;
    const [total, docs] = await Promise.all([
        PostModel.countDocuments(baseFilter),
        PostModel.find(baseFilter)
            .sort({ createdAt: -1, _id: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
    ]);
    const leanDocs = docs;
    const postIds = leanDocs.map((d) => d._id);
    const likedIdSet = new Set();
    const savedIdSet = new Set();
    if (postIds.length > 0 && mongoose.isValidObjectId(viewerUserId)) {
        const [likeRows, saveRows] = await Promise.all([
            PostLikeModel.find({
                user: viewerUserId,
                post: { $in: postIds },
            })
                .select('post')
                .lean(),
            PostSaveModel.find({
                user: viewerUserId,
                post: { $in: postIds },
            })
                .select('post')
                .lean(),
        ]);
        for (const row of likeRows) {
            likedIdSet.add(row.post.toString());
        }
        for (const row of saveRows) {
            savedIdSet.add(row.post.toString());
        }
    }
    const authorIds = leanDocs.map((d) => authorIdString(d.author));
    const [infoByAuthorId, musicMap, soundMap, ownSoundMap] = await Promise.all([
        mapAuthorIdsToInfo(authorIds),
        buildMusicMap(collectMusicTrackIds(leanDocs)),
        buildOriginalSoundMap(collectAttachedOriginalSoundIds(leanDocs)),
        buildOwnSoundMap(collectOwnOriginalSoundIds(leanDocs)),
    ]);
    const items = leanDocs.map((lean) => {
        const id = lean._id.toString();
        const aid = authorIdString(lean.author);
        const fb = fallbackAuthorUsername(aid);
        const info = infoByAuthorId.get(aid) ?? {
            username: fb,
            fullName: fb,
            avatarUrl: null,
        };
        return toPostDto(lean, likedIdSet.has(id), savedIdSet.has(id), info, musicMap, soundMap, ownSoundMap);
    });
    return {
        items,
        page,
        limit,
        total,
        hasMore: skip + leanDocs.length < total,
        hashtag: tag,
    };
}
/**
 * Paginated list of the posts the viewer has saved (bookmarked), newest save
 * first. `GET /api/v1/posts/saved`
 */
export async function listSavedPosts(viewerUserId, query) {
    const { page, limit } = query;
    if (!mongoose.isValidObjectId(viewerUserId)) {
        throw new HttpError(400, 'Invalid user id', 'INVALID_USER_ID');
    }
    const skip = page * limit;
    const [total, saveRows] = await Promise.all([
        PostSaveModel.countDocuments({ user: viewerUserId }),
        PostSaveModel.find({ user: viewerUserId })
            .sort({ createdAt: -1, _id: -1 })
            .skip(skip)
            .limit(limit)
            .select('post')
            .lean(),
    ]);
    // Post ids in save-recency order (newest save first).
    const orderedIds = saveRows.map((r) => r.post.toString());
    if (orderedIds.length === 0) {
        return { items: [], page, limit, total, hasMore: false };
    }
    const hiddenIds = await listHiddenUserIds(viewerUserId);
    const postFilter = {
        _id: { $in: saveRows.map((r) => r.post) },
    };
    if (hiddenIds.length > 0) {
        postFilter.author = {
            $nin: hiddenIds.map((id) => new mongoose.Types.ObjectId(id)),
        };
    }
    const docs = (await PostModel.find(postFilter).lean());
    // `$in` does not preserve order — re-map to the saved-recency order and drop
    // posts that were since deleted or whose author is now hidden/blocked.
    const docById = new Map();
    for (const d of docs) {
        docById.set(d._id.toString(), d);
    }
    const leanDocs = orderedIds
        .map((id) => docById.get(id))
        .filter((d) => d != null);
    // Liked state for this viewer (everything here is saved by definition).
    const postIds = leanDocs.map((d) => d._id);
    const likedIdSet = new Set();
    if (postIds.length > 0) {
        const likeRows = (await PostLikeModel.find({
            user: viewerUserId,
            post: { $in: postIds },
        })
            .select('post')
            .lean());
        for (const row of likeRows) {
            likedIdSet.add(row.post.toString());
        }
    }
    const authorIds = leanDocs.map((d) => authorIdString(d.author));
    const [infoByAuthorId, musicMap, soundMap, ownSoundMap] = await Promise.all([
        mapAuthorIdsToInfo(authorIds),
        buildMusicMap(collectMusicTrackIds(leanDocs)),
        buildOriginalSoundMap(collectAttachedOriginalSoundIds(leanDocs)),
        buildOwnSoundMap(collectOwnOriginalSoundIds(leanDocs)),
    ]);
    const items = leanDocs.map((lean) => {
        const id = lean._id.toString();
        const aid = authorIdString(lean.author);
        const fb = fallbackAuthorUsername(aid);
        const info = infoByAuthorId.get(aid) ?? {
            username: fb,
            fullName: fb,
            avatarUrl: null,
        };
        return toPostDto(lean, likedIdSet.has(id), true, info, musicMap, soundMap, ownSoundMap);
    });
    return {
        items,
        page,
        limit,
        total,
        // Raw-vs-raw on purpose: `total` and `saveRows` both count *save rows*
        // (unfiltered), so this is false exactly on the last page of saves.
        // Do NOT switch to `leanDocs.length` — that's the post-hidden-filter
        // count and, compared against the raw `total`, would report hasMore=true
        // on the final page whenever a tile was dropped (deleted/hidden author).
        hasMore: skip + saveRows.length < total,
    };
}
/**
 * Paginated list of posts that use a given music track.
 * `GET /api/v1/posts/music/:trackId`
 */
export async function listPostsByMusicTrack(rawTrackId, query, viewerUserId) {
    if (!mongoose.isValidObjectId(rawTrackId)) {
        throw new HttpError(400, 'Invalid music track id', 'INVALID_MUSIC_TRACK_ID');
    }
    const trackOid = new mongoose.Types.ObjectId(rawTrackId);
    const hiddenIds = mongoose.isValidObjectId(viewerUserId)
        ? await listHiddenUserIds(viewerUserId)
        : [];
    const baseFilter = { musicTrack: trackOid };
    if (hiddenIds.length > 0) {
        baseFilter.author = {
            $nin: hiddenIds.map((id) => new mongoose.Types.ObjectId(id)),
        };
    }
    const { page, limit } = query;
    const skip = page * limit;
    const [total, docs] = await Promise.all([
        PostModel.countDocuments(baseFilter),
        PostModel.find(baseFilter)
            .sort({ createdAt: -1, _id: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
    ]);
    const leanDocs = docs;
    const postIds = leanDocs.map((d) => d._id);
    const likedIdSet = new Set();
    const savedIdSet = new Set();
    if (postIds.length > 0 && mongoose.isValidObjectId(viewerUserId)) {
        const [likeRows, saveRows] = await Promise.all([
            PostLikeModel.find({
                user: viewerUserId,
                post: { $in: postIds },
            })
                .select('post')
                .lean(),
            PostSaveModel.find({
                user: viewerUserId,
                post: { $in: postIds },
            })
                .select('post')
                .lean(),
        ]);
        for (const row of likeRows) {
            likedIdSet.add(row.post.toString());
        }
        for (const row of saveRows) {
            savedIdSet.add(row.post.toString());
        }
    }
    const authorIds = leanDocs.map((d) => authorIdString(d.author));
    // This endpoint filters by `musicTrack`, so attachedOriginalSound is
    // never set on these rows — passing an empty soundMap keeps the
    // toPostDto signature uniform.
    const [infoByAuthorId, musicMap] = await Promise.all([
        mapAuthorIdsToInfo(authorIds),
        buildMusicMap([trackOid]),
    ]);
    const emptySoundMap = new Map();
    const items = leanDocs.map((lean) => {
        const id = lean._id.toString();
        const aid = authorIdString(lean.author);
        const fb = fallbackAuthorUsername(aid);
        const info = infoByAuthorId.get(aid) ?? {
            username: fb,
            fullName: fb,
            avatarUrl: null,
        };
        return toPostDto(lean, likedIdSet.has(id), savedIdSet.has(id), info, musicMap, emptySoundMap);
    });
    return {
        items,
        page,
        limit,
        total,
        hasMore: skip + leanDocs.length < total,
        musicTrackId: trackOid.toString(),
        music: musicMap.get(trackOid.toString()) ?? null,
    };
}
function isDuplicateKeyError(err) {
    return (typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        err.code === 11000);
}
/**
 * Like or unlike a post in one call. Idempotent: repeating the same `liked` value is a no-op for counts.
 */
export async function setPostLike(userId, postId, liked) {
    assertObjectId(postId);
    if (!mongoose.isValidObjectId(userId)) {
        throw new HttpError(400, 'Invalid user id', 'INVALID_USER_ID');
    }
    const postExists = await PostModel.exists({ _id: postId });
    if (!postExists) {
        throw new HttpError(404, 'Post not found', 'POST_NOT_FOUND');
    }
    if (liked) {
        let created = false;
        try {
            await PostLikeModel.create({ user: userId, post: postId });
            await PostModel.updateOne({ _id: postId }, { $inc: { likesCount: 1 } });
            created = true;
        }
        catch (err) {
            if (!isDuplicateKeyError(err)) {
                throw err;
            }
        }
        // Fire-and-forget push — only on the first like, not on idempotent re-calls.
        if (created) {
            void (async () => {
                try {
                    const post = await PostModel.findById(postId)
                        .select('author')
                        .lean();
                    const authorId = post?.author?.toString();
                    if (!authorId || authorId === userId)
                        return;
                    const liker = await UserModel.findById(userId)
                        .select('fullName username')
                        .lean();
                    const name = liker?.fullName?.trim() ||
                        liker?.username ||
                        'Someone';
                    const isNewNotification = await createNotification({
                        recipient: authorId,
                        actor: userId,
                        type: 'post_like',
                        post: postId,
                    });
                    // Only push on a brand-new like notification — re-liking (after an
                    // unlike) just bumps the existing inbox row, so don't re-push.
                    if (isNewNotification) {
                        await sendToUser(authorId, {
                            type: 'post_like',
                            title: 'New like',
                            body: `${name} liked your post`,
                            data: { postId, likerId: userId },
                        });
                    }
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : 'unknown error';
                    console.warn('[post] like push dispatch failed:', msg);
                }
            })();
        }
    }
    else {
        const del = await PostLikeModel.deleteOne({ user: userId, post: postId });
        if (del.deletedCount === 1) {
            await PostModel.updateOne({ _id: postId, likesCount: { $gt: 0 } }, { $inc: { likesCount: -1 } });
        }
    }
    const doc = await PostModel.findById(postId).select('likesCount').lean();
    const likesCount = typeof doc?.likesCount === 'number' && doc.likesCount >= 0
        ? doc.likesCount
        : 0;
    return { liked, likesCount };
}
/**
 * Save (bookmark) or unsave a post in one call. Idempotent: repeating the same
 * `saved` value is a no-op for counts. No notification is sent — a save is a
 * private bookmark, invisible to the post author.
 */
export async function setPostSave(userId, postId, saved) {
    assertObjectId(postId);
    if (!mongoose.isValidObjectId(userId)) {
        throw new HttpError(400, 'Invalid user id', 'INVALID_USER_ID');
    }
    const postExists = await PostModel.exists({ _id: postId });
    if (!postExists) {
        throw new HttpError(404, 'Post not found', 'POST_NOT_FOUND');
    }
    if (saved) {
        try {
            await PostSaveModel.create({ user: userId, post: postId });
            await PostModel.updateOne({ _id: postId }, { $inc: { savesCount: 1 } });
        }
        catch (err) {
            if (!isDuplicateKeyError(err)) {
                throw err;
            }
        }
    }
    else {
        const del = await PostSaveModel.deleteOne({ user: userId, post: postId });
        if (del.deletedCount === 1) {
            await PostModel.updateOne({ _id: postId, savesCount: { $gt: 0 } }, { $inc: { savesCount: -1 } });
        }
    }
    const doc = await PostModel.findById(postId).select('savesCount').lean();
    const savesCount = typeof doc?.savesCount === 'number' && doc.savesCount >= 0
        ? doc.savesCount
        : 0;
    return { saved, savesCount };
}
/**
 * Mark posts as SEEN by the viewer (home feed). Idempotent + best-effort:
 * duplicate (user, post) pairs are ignored, batch is capped. These power the
 * "don't show me posts I've already seen" feed exclusion in listHomeFeed.
 */
export async function recordPostViews(userId, postIds) {
    if (!mongoose.isValidObjectId(userId)) {
        throw new HttpError(400, 'Invalid user id', 'INVALID_USER_ID');
    }
    const user = new mongoose.Types.ObjectId(userId);
    const ids = [...new Set(postIds)]
        .filter((id) => mongoose.isValidObjectId(id))
        .slice(0, 200)
        .map((id) => new mongoose.Types.ObjectId(id));
    if (ids.length === 0) {
        return { recorded: 0 };
    }
    const ops = ids.map((post) => ({
        updateOne: {
            filter: { user, post },
            update: { $setOnInsert: { user, post } },
            upsert: true,
        },
    }));
    try {
        const res = await PostViewModel.bulkWrite(ops, { ordered: false });
        return { recorded: res.upsertedCount ?? 0 };
    }
    catch (err) {
        // Concurrent reports can race on the unique (user,post) index — ignore.
        if (isDuplicateKeyError(err)) {
            return { recorded: 0 };
        }
        throw err;
    }
}
export async function createPost(userId, body) {
    const prefix = uploadKeyPrefix(userId);
    if (!body.file.key.startsWith(prefix)) {
        throw new HttpError(403, 'File key does not belong to this user', 'FORBIDDEN_MEDIA');
    }
    const baseMime = body.file.contentType.toLowerCase().split(';')[0]?.trim() ?? '';
    const cat = mediaCategory(baseMime);
    if (cat === null || cat === 'audio') {
        throw new HttpError(400, 'Only image or video files can be attached to a post', 'UNSUPPORTED_MEDIA_TYPE');
    }
    if (body.mediaKind === 'image' && cat !== 'image') {
        throw new HttpError(400, 'mediaKind "image" does not match file content type', 'MEDIA_KIND_MISMATCH');
    }
    if (body.mediaKind === 'short_video' && cat !== 'video') {
        throw new HttpError(400, 'mediaKind "short_video" does not match file content type', 'MEDIA_KIND_MISMATCH');
    }
    if (body.mediaKind === 'image' && body.durationSeconds != null) {
        throw new HttpError(400, 'durationSeconds must be omitted for image posts', 'VALIDATION_ERROR');
    }
    // Validate optional music attachment and resolve display title.
    let resolvedMusicTitle = body.musicTitle ?? null;
    let musicTrackOid = null;
    let attachedOriginalSoundOid = null;
    if (body.musicTrackId != null) {
        const track = (await MusicTrackModel.findById(body.musicTrackId)
            .select('title status durationSeconds artist')
            .lean());
        if (!track || track.status !== 'published') {
            throw new HttpError(404, 'Music track not found or not available', 'MUSIC_TRACK_NOT_FOUND');
        }
        musicTrackOid = track._id;
        if (!resolvedMusicTitle) {
            const artist = (await ArtistModel.findById(track.artist)
                .select('name')
                .lean());
            resolvedMusicTitle = artist?.name
                ? `${track.title} — ${artist.name}`
                : track.title;
        }
    }
    else if (body.attachedOriginalSoundId != null) {
        // Validate the original sound is real, ready, and browsable.
        const sound = await OriginalSoundModel.findById(body.attachedOriginalSoundId)
            .select('title status isPublic')
            .lean();
        if (!sound || sound.status !== 'ready' || !sound.isPublic) {
            throw new HttpError(404, 'Original sound not found or not available', 'ORIGINAL_SOUND_NOT_FOUND');
        }
        attachedOriginalSoundOid = sound._id;
        if (!resolvedMusicTitle) {
            resolvedMusicTitle = sound.title;
        }
    }
    const doc = await PostModel.create({
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
        caption: body.caption ?? null,
        hashtags: body.hashtags ?? null,
        musicTitle: resolvedMusicTitle,
        musicTrack: musicTrackOid,
        musicTrimStartMs: musicTrackOid != null || attachedOriginalSoundOid != null
            ? body.musicTrimStartMs ?? 0
            : null,
        attachedOriginalSound: attachedOriginalSoundOid,
        // Only meaningful for video posts; image posts ignore it client-side.
        originalAudioMuted: body.originalAudioMuted ?? false,
        mediaWidth: body.mediaWidth ?? null,
        mediaHeight: body.mediaHeight ?? null,
        durationSeconds: body.durationSeconds ?? null,
        mediaProcessingStatus: body.mediaKind === 'short_video' ? 'processing' : 'not_required',
    });
    // Auto-generate thumbnail for video posts (non-blocking for response)
    if (body.mediaKind === 'short_video') {
        enqueueMediaProcessing('post', doc._id.toString()).catch((err) => {
            void PostModel.updateOne({ _id: doc._id }, { $set: { mediaProcessingStatus: 'failed', mediaProcessingError: 'Media processing queue unavailable' } });
            // eslint-disable-next-line no-console
            console.error(`[posts] enqueueMediaProcessing failed postId=${doc._id.toString()}:`, err instanceof Error ? err.message : err);
        });
        generateVideoThumbnail(body.file.key, userId)
            .then(async (thumbUrl) => {
            if (thumbUrl) {
                await PostModel.updateOne({ _id: doc._id }, { $set: { thumbnailUrl: thumbUrl } });
            }
        })
            .catch(() => { });
        // When the uploader kept the original audio, extract it as a reusable
        // Original Sound. Fire-and-forget — a Redis outage must never block
        // post creation, so any enqueue error is logged-and-swallowed (the
        // post still lands; ops can re-enqueue from the failed sound row).
        if (!(body.originalAudioMuted ?? false)) {
            // eslint-disable-next-line no-console
            console.log(`[posts] enqueue sound extraction postId=${doc._id.toString()}`);
            enqueueSoundExtraction(doc._id.toString()).catch((err) => {
                // eslint-disable-next-line no-console
                console.error(`[posts] enqueueSoundExtraction failed postId=${doc._id.toString()}:`, err instanceof Error ? err.message : err);
            });
        }
        else {
            // eslint-disable-next-line no-console
            console.log(`[posts] skip sound extraction postId=${doc._id.toString()} (originalAudioMuted=true)`);
        }
    }
    else {
        // eslint-disable-next-line no-console
        console.log(`[posts] skip sound extraction (mediaKind=${body.mediaKind})`);
    }
    // Bump usesCount on the borrowed OriginalSound so the catalog sort
    // reflects reality. Best-effort: if it ever fails, the post still
    // links correctly — the next analytics job (future) can reconcile.
    if (attachedOriginalSoundOid != null) {
        OriginalSoundModel.updateOne({ _id: attachedOriginalSoundOid }, { $inc: { usesCount: 1 } })
            .exec()
            .catch(() => undefined);
    }
    const [authorInfo, musicMap, soundMap] = await Promise.all([
        infoForAuthorId(userId),
        musicTrackOid
            ? buildMusicMap([musicTrackOid])
            : Promise.resolve(new Map()),
        attachedOriginalSoundOid
            ? buildOriginalSoundMap([attachedOriginalSoundOid])
            : Promise.resolve(new Map()),
    ]);
    return toPostDto(doc, false, false, authorInfo, musicMap, soundMap);
}
/**
 * Delete a post. Only the post owner can delete.
 */
export async function deletePost(userId, postId) {
    const doc = await PostModel.findById(postId);
    if (!doc) {
        throw new HttpError(404, 'Post not found', 'POST_NOT_FOUND');
    }
    if (doc.author.toString() !== userId) {
        throw new HttpError(403, 'Not authorised to delete this post', 'FORBIDDEN');
    }
    // Field is `post` (not `postId`) — the prior `{ postId }` filter matched
    // nothing and orphaned likes on delete.
    await Promise.all([
        PostLikeModel.deleteMany({ post: doc._id }),
        PostSaveModel.deleteMany({ post: doc._id }),
        PostViewModel.deleteMany({ post: doc._id }),
    ]);
    await PostModel.deleteOne({ _id: doc._id });
}
