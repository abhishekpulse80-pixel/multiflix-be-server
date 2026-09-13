import mongoose, { type Types } from 'mongoose';
import { HttpError } from '../lib/httpError.js';
import type { UserGender } from '../models/user.model.js';
import { UserModel } from '../models/user.model.js';
import { PostModel } from '../models/post.model.js';
import { PostLikeModel } from '../models/postLike.model.js';
import { PostSaveModel } from '../models/postSave.model.js';
import { BlogModel } from '../models/blog.model.js';
import { MusicTrackModel } from '../models/musicTrack.model.js';
import { ArtistModel } from '../models/artist.model.js';
import { OriginalSoundModel } from '../models/originalSound.model.js';
import type { PublicProfileMediaQuery } from '../schemas/profile.schemas.js';
import {
  countFollowers,
  countFollowing,
  isFollowing,
} from './follow.service.js';
import { isBlockedBetween } from './userBlock.service.js';

const GENDERS = new Set<UserGender>([
  'male',
  'female',
  'other',
  'prefer_not_to_say',
]);

function readNullableString(v: unknown): string | null {
  if (v === null || v === undefined) {
    return null;
  }
  if (typeof v !== 'string') {
    return null;
  }
  const s = v.trim();
  return s.length > 0 ? s : null;
}

function isGender(value: string): value is UserGender {
  return (GENDERS as ReadonlySet<string>).has(value);
}

/** Same shape as `PostMusicDto` on the feed endpoints. */
export type PublicRecentPostMusic = {
  /** 'track' (curated catalog) or 'original_sound' (creator-extracted). */
  source: 'track' | 'original_sound';
  trackId: string;
  title: string;
  artistName: string | null;
  audioUrl: string;
  artUrl: string;
  durationSeconds: number | null;
  trimStartMs: number;
};

export type PublicRecentPostThumb = {
  id: string;
  mediaKind: 'image' | 'short_video';
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  caption: string | null;
  hashtags: string | null;
  musicTitle: string | null;
  /** Source video duration (s) — used to size the music window on viewers. */
  durationSeconds: number | null;
  /** Attached music (curated track or original sound), or null. */
  music: PublicRecentPostMusic | null;
  /**
   * This post's OWN extracted sound (attribution label only — the video
   * plays its own audio). Null unless the post's audio became a reusable
   * Original Sound.
   */
  originalSound: {
    soundId: string;
    title: string;
    ownerUsername: string;
  } | null;
  commentsCount: number;
  likesCount: number;
  savesCount: number;
  /** ISO upload timestamp. */
  createdAt: string;
  /** Whether the authenticated viewer has liked this post. */
  likedByViewer: boolean;
  /** Whether the authenticated viewer has saved (bookmarked) this post. */
  savedByViewer: boolean;
};

export type PublicRecentBlogThumb = {
  id: string;
  thumbnailUrl: string;
  viewsCount: number;
  /** Episode title — surfaced on the profile podcasts list. */
  title: string;
  /** Runtime in seconds (null until the upload pipeline fills it). */
  durationSeconds: number | null;
  /** ISO publish timestamp (null for drafts). */
  publishedAt: string | null;
};

export type UserPublicProfileDto = {
  id: string;
  username: string;
  fullName: string | null;
  avatarUrl: string | null;
  isOnboarded: boolean;
  interests: string[];
  gender: UserGender | null;
  /** Feed posts + published blogs (podcasts) — the profile "Posts" stat. */
  postsCount: number;
  likesCount: number;
  followersCount: number;
  followingCount: number;
  /** When the authenticated viewer opens someone else’s profile: whether they follow this user. `null` for own profile or when not applicable. */
  isFollowing: boolean | null;
  /** Whether this user follows the viewer — drives the "Follow Back" label.
   * `null` for own profile or when not applicable. */
  followsYou: boolean | null;
  /** When true, the subject has hidden their followers list from other users. */
  isFollowersListPrivate: boolean;
};

export type UserPublicPostsResponse = {
  items: PublicRecentPostThumb[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
};

export type UserPublicBlogsResponse = {
  items: PublicRecentBlogThumb[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
};

function assertObjectId(id: string): void {
  if (!mongoose.isValidObjectId(id)) {
    throw new HttpError(400, 'Invalid user id', 'INVALID_USER_ID');
  }
}

/**
 * Resolve a @username to its userId — used to open a shared profile deep link
 * (multiflix.in/u/<username>) inside the app, which navigates by userId.
 * Case-insensitive exact match.
 */
export async function getUserIdByUsername(
  username: string,
): Promise<{ userId: string }> {
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
    .lean()) as { _id: { toString(): string } } | null;
  if (!user) {
    throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
  }
  return { userId: user._id.toString() };
}

export async function getUserPublicProfile(
  userId: string,
  viewerId?: string | null,
): Promise<UserPublicProfileDto> {
  assertObjectId(userId);
  if (
    viewerId &&
    viewerId !== userId &&
    (await isBlockedBetween(viewerId, userId))
  ) {
    throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
  }
  const user = await UserModel.findById(userId).select(
    '-passwordHash -passwordResetOtpHash -passwordResetOtpExpiresAt',
  );
  if (!user) {
    throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
  }

  const rawGender = user.gender;
  const gender =
    typeof rawGender === 'string' && isGender(rawGender) ? rawGender : null;
  const interests = Array.isArray(user.interests)
    ? [...user.interests]
        .map((s: unknown) => (typeof s === 'string' ? s.trim() : ''))
        .filter(Boolean)
    : [];

  const [
    feedPostsCount,
    publishedBlogsCount,
    likesAgg,
    followersCount,
    profileFollowingCount,
  ] = await Promise.all([
    PostModel.countDocuments({ author: userId }),
    // Published blogs (podcasts) — same filter as the blogs tab listing, so the
    // "Posts" stat agrees with the two tabs shown on the profile.
    BlogModel.countDocuments({ author: userId, status: 'published' }),
    PostModel.aggregate<{ _id: null; likesCount: number }>([
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
  const likesCount =
    likesAgg[0]?.likesCount != null && likesAgg[0].likesCount > 0
      ? likesAgg[0].likesCount
      : 0;

  let viewerFollowsSubject: boolean | null = null;
  let subjectFollowsViewer: boolean | null = null;
  if (
    viewerId &&
    mongoose.isValidObjectId(viewerId) &&
    viewerId !== user._id.toString()
  ) {
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

export async function listUserPublicPosts(
  userId: string,
  query: PublicProfileMediaQuery,
  viewerId?: string | null,
): Promise<UserPublicPostsResponse> {
  assertObjectId(userId);
  if (
    viewerId &&
    viewerId !== userId &&
    (await isBlockedBetween(viewerId, userId))
  ) {
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
      .select(
        'mediaKind media caption hashtags musicTitle musicTrack musicTrimStartMs attachedOriginalSound originalSoundId durationSeconds commentsCount likesCount savesCount thumbnailUrl createdAt',
      )
      .lean(),
  ]);

  type RecentLean = {
    _id: Types.ObjectId;
    mediaKind: 'image' | 'short_video';
    media: { url: string | null };
    thumbnailUrl?: string | null;
    caption: string | null;
    hashtags: string | null;
    musicTitle: string | null;
    musicTrack?: Types.ObjectId | null;
    musicTrimStartMs?: number | null;
    attachedOriginalSound?: Types.ObjectId | null;
    originalSoundId?: Types.ObjectId | null;
    durationSeconds?: number | null;
    commentsCount?: number;
    likesCount?: number;
    savesCount?: number;
    createdAt?: Date | string;
  };

  const rows = docs as RecentLean[];
  const postIds = rows.map((p) => p._id);

  // Resolve attached music tracks (and their artists) for any rows that
  // have one. Two queries total regardless of how many rows.
  type TrackLean = {
    _id: Types.ObjectId;
    title: string;
    audioUrl: string;
    artUrl: string;
    durationSeconds: number | null;
    artist: Types.ObjectId;
  };
  type ArtistLean = { _id: Types.ObjectId; name: string };
  const trackIdStrings = [
    ...new Set(
      rows
        .map((r) => r.musicTrack?.toString())
        .filter((id): id is string => typeof id === 'string'),
    ),
  ];
  const trackById = new Map<string, TrackLean>();
  const artistNameById = new Map<string, string>();
  if (trackIdStrings.length > 0) {
    const tracks = (await MusicTrackModel.find({
      _id: { $in: trackIdStrings },
    })
      .select('title audioUrl artUrl durationSeconds artist')
      .lean()) as TrackLean[];
    for (const t of tracks) {
      trackById.set(t._id.toString(), t);
    }
    const artistIds = [...new Set(tracks.map((t) => t.artist.toString()))];
    if (artistIds.length > 0) {
      const artists = (await ArtistModel.find({ _id: { $in: artistIds } })
        .select('name')
        .lean()) as ArtistLean[];
      for (const a of artists) {
        artistNameById.set(a._id.toString(), a.name);
      }
    }
  }

  // Resolve original sounds referenced by these rows — both attached
  // (plays as `music`) and own (shows as `originalSound` attribution).
  // One sounds query + one owner-username query, total.
  type SoundLean = {
    _id: Types.ObjectId;
    title: string;
    audioUrl: string | null;
    durationSeconds: number | null;
    sourcePost: Types.ObjectId;
    ownerUser: Types.ObjectId;
    status: string;
  };
  const soundIdStrings = [
    ...new Set(
      rows
        .flatMap((r) => [
          r.attachedOriginalSound?.toString(),
          r.originalSoundId?.toString(),
        ])
        .filter((id): id is string => typeof id === 'string'),
    ),
  ];
  const soundById = new Map<string, SoundLean>();
  const soundOwnerUsername = new Map<string, string>();
  const soundThumbByPostId = new Map<string, string>();
  if (soundIdStrings.length > 0) {
    const sounds = (await OriginalSoundModel.find({
      _id: { $in: soundIdStrings },
      status: 'ready',
    })
      .select('title audioUrl durationSeconds sourcePost ownerUser status')
      .lean()) as SoundLean[];
    for (const s of sounds) {
      soundById.set(s._id.toString(), s);
    }
    const ownerIds = [...new Set(sounds.map((s) => s.ownerUser.toString()))];
    if (ownerIds.length > 0) {
      const owners = (await UserModel.find({ _id: { $in: ownerIds } })
        .select('username')
        .lean()) as { _id: Types.ObjectId; username: string }[];
      for (const o of owners) {
        soundOwnerUsername.set(o._id.toString(), o.username);
      }
    }
    // Source-post thumbnail = cover art for attached-sound playback.
    const srcPostIds = [...new Set(sounds.map((s) => s.sourcePost.toString()))];
    if (srcPostIds.length > 0) {
      const srcPosts = (await PostModel.find({ _id: { $in: srcPostIds } })
        .select('thumbnailUrl media')
        .lean()) as {
        _id: Types.ObjectId;
        thumbnailUrl?: string | null;
        media: { url: string | null };
      }[];
      for (const sp of srcPosts) {
        soundThumbByPostId.set(
          sp._id.toString(),
          sp.thumbnailUrl ?? sp.media?.url ?? '',
        );
      }
    }
  }

  const likedIdSet = new Set<string>();
  const savedIdSet = new Set<string>();
  if (postIds.length > 0 && viewerId && mongoose.isValidObjectId(viewerId)) {
    type LikeLean = { post: Types.ObjectId };
    const [likeRows, saveRows] = await Promise.all([
      PostLikeModel.find({
        user: viewerId,
        post: { $in: postIds },
      })
        .select('post')
        .lean() as Promise<LikeLean[]>,
      PostSaveModel.find({
        user: viewerId,
        post: { $in: postIds },
      })
        .select('post')
        .lean() as Promise<LikeLean[]>,
    ]);
    for (const row of likeRows) {
      likedIdSet.add(row.post.toString());
    }
    for (const row of saveRows) {
      savedIdSet.add(row.post.toString());
    }
  }

  const items: PublicRecentPostThumb[] = rows.map((p) => {
    const id = p._id.toString();
    let music: PublicRecentPostMusic | null = null;
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
    } else if (p.attachedOriginalSound) {
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
    let originalSound: PublicRecentPostThumb['originalSound'] = null;
    if (!music && p.originalSoundId) {
      const own = soundById.get(p.originalSoundId.toString());
      if (own) {
        originalSound = {
          soundId: own._id.toString(),
          title: own.title,
          ownerUsername:
            soundOwnerUsername.get(own.ownerUser.toString()) ?? '',
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
      createdAt:
        p.createdAt instanceof Date
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

export async function listUserPublicBlogs(
  userId: string,
  query: PublicProfileMediaQuery,
  viewerId?: string | null,
): Promise<UserPublicBlogsResponse> {
  assertObjectId(userId);
  if (
    viewerId &&
    viewerId !== userId &&
    (await isBlockedBetween(viewerId, userId))
  ) {
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

  type RecentBlogLean = {
    _id: Types.ObjectId;
    thumbnailUrl: string;
    viewsCount?: number;
    title?: string;
    durationSeconds?: number | null;
    publishedAt?: Date | null;
  };

  const items: PublicRecentBlogThumb[] = (docs as RecentBlogLean[]).map((b) => ({
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
