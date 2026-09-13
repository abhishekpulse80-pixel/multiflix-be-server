import mongoose from 'mongoose';
import { HttpError } from '../lib/httpError.js';
import { UserModel } from '../models/user.model.js';
import { PostModel } from '../models/post.model.js';
import { PostLikeModel } from '../models/postLike.model.js';
import { PostSaveModel } from '../models/postSave.model.js';
import { BlogModel } from '../models/blog.model.js';
import { MusicTrackModel } from '../models/musicTrack.model.js';
import { ArtistModel } from '../models/artist.model.js';
import { OriginalSoundModel } from '../models/originalSound.model.js';
import { countFollowers, countFollowing, isFollowing, } from './follow.service.js';
import { isBlockedBetween } from './userBlock.service.js';
const GENDERS = new Set([
    'male',
    'female',
    'other',
    'prefer_not_to_say',
]);
function readNullableString(v) {
    if (v === null || v === undefined) {
        return null;
    }
    if (typeof v !== 'string') {
        return null;
    }
    const s = v.trim();
    return s.length > 0 ? s : null;
}
function isGender(value) {
    return GENDERS.has(value);
}
function assertObjectId(id) {
    if (!mongoose.isValidObjectId(id)) {
        throw new HttpError(400, 'Invalid user id', 'INVALID_USER_ID');
    }
}
/**
 * Resolve a @username to its userId — used to open a shared profile deep link
 * (multiflix.in/u/<username>) inside the app, which navigates by userId.
 * Case-insensitive exact match.
 */
export async function getUserIdByUsername(username) {
    const handle = username.trim().replace(/^@+/, '');
    if (!handle) {
        throw new HttpError(400, 'username is required', 'VALIDATION_ERROR');
    }
    // Anchored, case-insensitive exact match (escape regex metacharacters).
    const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const user = (await UserModel.findOne({
        username: new RegExp(`^${escaped}$`, 'i'),
    })
        .select('_id')
        .lean());
    if (!user) {
        throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
    }
    return { userId: user._id.toString() };
}
export async function getUserPublicProfile(userId, viewerId) {
    assertObjectId(userId);
    if (viewerId &&
        viewerId !== userId &&
        (await isBlockedBetween(viewerId, userId))) {
        throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
    }
    const user = await UserModel.findById(userId).select('-passwordHash -passwordResetOtpHash -passwordResetOtpExpiresAt');
    if (!user) {
        throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
    }
    const rawGender = user.gender;
    const gender = typeof rawGender === 'string' && isGender(rawGender) ? rawGender : null;
    const interests = Array.isArray(user.interests)
        ? [...user.interests]
            .map((s) => (typeof s === 'string' ? s.trim() : ''))
            .filter(Boolean)
        : [];
    const [feedPostsCount, publishedBlogsCount, likesAgg, followersCount, profileFollowingCount,] = await Promise.all([
        PostModel.countDocuments({ author: userId }),
        // Published blogs (podcasts) — same filter as the blogs tab listing, so the
        // "Posts" stat agrees with the two tabs shown on the profile.
        BlogModel.countDocuments({ author: userId, status: 'published' }),
        PostModel.aggregate([
            {
                $match: {
                    $or: [
                        { author: new mongoose.Types.ObjectId(userId) },
                        { author: userId },
                    ],
                },
            },
            {
                $group: {
                    _id: null,
                    likesCount: { $sum: { $ifNull: ['$likesCount', 0] } },
                },
            },
        ]),
        countFollowers(userId),
        countFollowing(userId),
    ]);
    // Profile "Posts" count includes both feed posts and published blogs.
    const postsCount = feedPostsCount + publishedBlogsCount;
    const likesCount = likesAgg[0]?.likesCount != null && likesAgg[0].likesCount > 0
        ? likesAgg[0].likesCount
        : 0;
    let viewerFollowsSubject = null;
    let subjectFollowsViewer = null;
    if (viewerId &&
        mongoose.isValidObjectId(viewerId) &&
        viewerId !== user._id.toString()) {
        const subjectId = user._id.toString();
        [viewerFollowsSubject, subjectFollowsViewer] = await Promise.all([
            isFollowing(viewerId, subjectId),
            isFollowing(subjectId, viewerId),
        ]);
    }
    return {
        id: user._id.toString(),
        username: user.username,
        fullName: readNullableString(user.fullName),
        avatarUrl: readNullableString(user.avatarUrl),
        isOnboarded: user.isOnboarded,
        interests,
        gender,
        postsCount,
        likesCount,
        followersCount,
        followingCount: profileFollowingCount,
        isFollowing: viewerFollowsSubject,
        followsYou: subjectFollowsViewer,
        isFollowersListPrivate: Boolean(user.isFollowersListPrivate),
    };
}
export async function listUserPublicPosts(userId, query, viewerId) {
    assertObjectId(userId);
    if (viewerId &&
        viewerId !== userId &&
        (await isBlockedBetween(viewerId, userId))) {
        throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
    }
    const { page, limit } = query;
    const skip = page * limit;
    const [total, docs] = await Promise.all([
        PostModel.countDocuments({ author: userId }),
        PostModel.find({ author: userId })
            .sort({ createdAt: -1, _id: -1 })
            .skip(skip)
            .limit(limit)
            .select('mediaKind media caption hashtags musicTitle musicTrack musicTrimStartMs attachedOriginalSound originalSoundId durationSeconds commentsCount likesCount savesCount thumbnailUrl createdAt')
            .lean(),
    ]);
    const rows = docs;
    const postIds = rows.map((p) => p._id);
    const trackIdStrings = [
        ...new Set(rows
            .map((r) => r.musicTrack?.toString())
            .filter((id) => typeof id === 'string')),
    ];
    const trackById = new Map();
    const artistNameById = new Map();
    if (trackIdStrings.length > 0) {
        const tracks = (await MusicTrackModel.find({
            _id: { $in: trackIdStrings },
        })
            .select('title audioUrl artUrl durationSeconds artist')
            .lean());
        for (const t of tracks) {
            trackById.set(t._id.toString(), t);
        }
        const artistIds = [...new Set(tracks.map((t) => t.artist.toString()))];
        if (artistIds.length > 0) {
            const artists = (await ArtistModel.find({ _id: { $in: artistIds } })
                .select('name')
                .lean());
            for (const a of artists) {
                artistNameById.set(a._id.toString(), a.name);
            }
        }
    }
    const soundIdStrings = [
        ...new Set(rows
            .flatMap((r) => [
            r.attachedOriginalSound?.toString(),
            r.originalSoundId?.toString(),
        ])
            .filter((id) => typeof id === 'string')),
    ];
    const soundById = new Map();
    const soundOwnerUsername = new Map();
    const soundThumbByPostId = new Map();
    if (soundIdStrings.length > 0) {
        const sounds = (await OriginalSoundModel.find({
            _id: { $in: soundIdStrings },
            status: 'ready',
        })
            .select('title audioUrl durationSeconds sourcePost ownerUser status')
            .lean());
        for (const s of sounds) {
            soundById.set(s._id.toString(), s);
        }
        const ownerIds = [...new Set(sounds.map((s) => s.ownerUser.toString()))];
        if (ownerIds.length > 0) {
            const owners = (await UserModel.find({ _id: { $in: ownerIds } })
                .select('username')
                .lean());
            for (const o of owners) {
                soundOwnerUsername.set(o._id.toString(), o.username);
            }
        }
        // Source-post thumbnail = cover art for attached-sound playback.
        const srcPostIds = [...new Set(sounds.map((s) => s.sourcePost.toString()))];
        if (srcPostIds.length > 0) {
            const srcPosts = (await PostModel.find({ _id: { $in: srcPostIds } })
                .select('thumbnailUrl media')
                .lean());
            for (const sp of srcPosts) {
                soundThumbByPostId.set(sp._id.toString(), sp.thumbnailUrl ?? sp.media?.url ?? '');
            }
        }
    }
    const likedIdSet = new Set();
    const savedIdSet = new Set();
    if (postIds.length > 0 && viewerId && mongoose.isValidObjectId(viewerId)) {
        const [likeRows, saveRows] = await Promise.all([
            PostLikeModel.find({
                user: viewerId,
                post: { $in: postIds },
            })
                .select('post')
                .lean(),
            PostSaveModel.find({
                user: viewerId,
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
    const items = rows.map((p) => {
        const id = p._id.toString();
        let music = null;
        if (p.musicTrack && p.musicTrimStartMs != null) {
            const track = trackById.get(p.musicTrack.toString());
            if (track) {
                music = {
                    source: 'track',
                    trackId: track._id.toString(),
                    title: track.title,
                    artistName: artistNameById.get(track.artist.toString()) ?? null,
                    audioUrl: track.audioUrl,
                    artUrl: track.artUrl,
                    durationSeconds: track.durationSeconds,
                    trimStartMs: p.musicTrimStartMs,
                };
            }
        }
        else if (p.attachedOriginalSound) {
            const sound = soundById.get(p.attachedOriginalSound.toString());
            if (sound?.audioUrl) {
                const uname = soundOwnerUsername.get(sound.ownerUser.toString());
                music = {
                    source: 'original_sound',
                    trackId: sound._id.toString(),
                    title: sound.title,
                    artistName: uname ? `@${uname}` : null,
                    audioUrl: sound.audioUrl,
                    artUrl: soundThumbByPostId.get(sound.sourcePost.toString()) ?? '',
                    durationSeconds: sound.durationSeconds,
                    trimStartMs: p.musicTrimStartMs ?? 0,
                };
            }
        }
        // Own extracted sound (attribution only) — only when nothing's attached.
        let originalSound = null;
        if (!music && p.originalSoundId) {
            const own = soundById.get(p.originalSoundId.toString());
            if (own) {
                originalSound = {
                    soundId: own._id.toString(),
                    title: own.title,
                    ownerUsername: soundOwnerUsername.get(own.ownerUser.toString()) ?? '',
                };
            }
        }
        return {
            id,
            mediaKind: p.mediaKind,
            mediaUrl: p.media.url,
            thumbnailUrl: p.thumbnailUrl ?? null,
            caption: p.caption ?? null,
            hashtags: p.hashtags ?? null,
            musicTitle: p.musicTitle ?? null,
            durationSeconds: p.durationSeconds ?? null,
            music,
            originalSound,
            commentsCount: p.commentsCount ?? 0,
            likesCount: p.likesCount ?? 0,
            savesCount: p.savesCount ?? 0,
            createdAt: p.createdAt instanceof Date
                ? p.createdAt.toISOString()
                : String(p.createdAt ?? ''),
            likedByViewer: likedIdSet.has(id),
            savedByViewer: savedIdSet.has(id),
        };
    });
    return {
        items,
        page,
        limit,
        total,
        hasMore: skip + items.length < total,
    };
}
export async function listUserPublicBlogs(userId, query, viewerId) {
    assertObjectId(userId);
    if (viewerId &&
        viewerId !== userId &&
        (await isBlockedBetween(viewerId, userId))) {
        throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
    }
    const { page, limit } = query;
    const skip = page * limit;
    const [total, docs] = await Promise.all([
        BlogModel.countDocuments({ author: userId, status: 'published' }),
        BlogModel.find({ author: userId, status: 'published' })
            .sort({ publishedAt: -1, _id: -1 })
            .skip(skip)
            .limit(limit)
            .select('thumbnailUrl viewsCount title durationSeconds publishedAt')
            .lean(),
    ]);
    const items = docs.map((b) => ({
        id: b._id.toString(),
        thumbnailUrl: b.thumbnailUrl,
        viewsCount: b.viewsCount ?? 0,
        title: b.title ?? '',
        durationSeconds: b.durationSeconds ?? null,
        publishedAt: b.publishedAt ? b.publishedAt.toISOString() : null,
    }));
    return {
        items,
        page,
        limit,
        total,
        hasMore: skip + items.length < total,
    };
}
