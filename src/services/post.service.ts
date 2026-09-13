import mongoose, { type HydratedDocument, type Types } from 'mongoose';
import { mediaCategory } from '../lib/allowedMediaMime.js';
import { HttpError } from '../lib/httpError.js';
import type { IPost, PostMediaKind } from '../models/post.model.js';
import { PostModel } from '../models/post.model.js';
import { UserModel } from '../models/user.model.js';
import { PostLikeModel } from '../models/postLike.model.js';
import { PostSaveModel } from '../models/postSave.model.js';
import { PostViewModel } from '../models/postView.model.js';
import { ArtistModel } from '../models/artist.model.js';
import { MusicTrackModel } from '../models/musicTrack.model.js';
import type { CreatePostBody, HomeFeedQuery } from '../schemas/posts.schemas.js';
import { AdModel } from '../models/ad.model.js';
import type { SponsoredAdDto } from '../types/feedSponsored.js';
import {
  listFeedRecommendationUsers,
  type FeedRecommendationUserDto,
} from './feedRecommendations.service.js';
import {
  countFollowing,
  listFolloweeIds,
  listFollowerIds,
} from './follow.service.js';
import { createNotification, sendToUser } from './notification.service.js';
import { generateVideoThumbnail } from './thumbnail.service.js';
import { enqueueSoundExtraction } from '../queues/soundExtraction.queue.js';
import { OriginalSoundModel } from '../models/originalSound.model.js';
import { listHiddenUserIds } from './userBlock.service.js';

export type { SponsoredAdDto };

export type PostMediaDto = {
  key: string;
  bucket: string;
  contentType: string;
  size: number;
  originalName: string;
  url: string | null;
};

/**
 * Populated music attachment for a post. Same shape as the story version —
 * mobile plays `audioUrl` from `trimStartMs` while the post is on screen.
 *
 * `source` discriminates between a curated catalog track and a creator's
 * Original Sound. `trackId` carries either kind of id (the FE uses it as
 * a stable React key); deep-link routing inspects `source` to decide
 * which detail screen to open.
 */
export type PostMusicDto = {
  trackId: string;
  source: 'track' | 'original_sound';
  title: string;
  artistName: string | null;
  audioUrl: string;
  artUrl: string;
  durationSeconds: number | null;
  trimStartMs: number;
};

export type PostDto = {
  id: string;
  authorId: string;
  /** Stable unique handle for the author (same as profile `username`). */
  authorUsername: string;
  /** Display name of the author (e.g. "Jane Doe"). */
  authorFullName: string;
  /** Avatar URL of the author, null if unset. */
  authorAvatarUrl: string | null;
  mediaKind: PostMediaKind;
  media: PostMediaDto;
  /** Auto-generated poster image for video posts. */
  thumbnailUrl: string | null;
  caption: string | null;
  hashtags: string | null;
  /** Display label for the attached track (auto-derived when music is set). */
  musicTitle: string | null;
  /** Populated music attachment, or null when none was selected. */
  music: PostMusicDto | null;
  /**
   * The post's OWN extracted Original Sound, when this video's audio was
   * turned into a reusable sound. This is attribution only — the video
   * plays its own audio, so this does NOT mute/overlay anything. Used to
   * show a tappable "Original sound — @owner" label (TikTok-style).
   * Null for image posts, muted posts, or while extraction is pending.
   */
  originalSound: {
    soundId: string;
    title: string;
    ownerUsername: string;
  } | null;
  /** True if the uploader chose to mute the original video audio. */
  originalAudioMuted: boolean;
  mediaWidth: number | null;
  mediaHeight: number | null;
  durationSeconds: number | null;
  likesCount: number;
  savesCount: number;
  commentsCount: number;
  /** Present on feed responses: whether the authenticated viewer has liked this post. */
  likedByViewer: boolean;
  /** Present on feed responses: whether the authenticated viewer has saved (bookmarked) this post. */
  savedByViewer: boolean;
  createdAt: string;
  updatedAt: string;
};

function uploadKeyPrefix(userId: string): string {
  return `uploads/${userId}/`;
}

type PostAuthorRef = Types.ObjectId | string | { toString(): string };

function authorIdString(author: PostAuthorRef): string {
  if (typeof author === 'string') {
    return author;
  }
  return author.toString();
}

function fallbackAuthorUsername(authorId: string): string {
  return `user_${authorId.slice(-6)}`;
}

type AuthorInfo = {
  username: string;
  fullName: string;
  avatarUrl: string | null;
};

async function mapAuthorIdsToInfo(
  authorIds: string[],
): Promise<Map<string, AuthorInfo>> {
  const map = new Map<string, AuthorInfo>();
  const unique = [
    ...new Set(authorIds.filter((id) => mongoose.isValidObjectId(id))),
  ];
  if (unique.length === 0) {
    return map;
  }
  type UserLean = {
    _id: Types.ObjectId;
    username?: string | null;
    fullName?: string | null;
    avatarUrl?: string | null;
  };
  const rows = (await UserModel.find({ _id: { $in: unique } })
    .select('_id username fullName avatarUrl')
    .lean()) as UserLean[];
  for (const r of rows) {
    const id = r._id.toString();
    const u =
      typeof r.username === 'string' && r.username.trim().length > 0
        ? r.username.trim().toLowerCase()
        : fallbackAuthorUsername(id);
    // Display name: fullName → username (system-wide convention).
    const fn =
      typeof r.fullName === 'string' && r.fullName.trim().length > 0
        ? r.fullName.trim()
        : u;
    const av =
      typeof r.avatarUrl === 'string' && r.avatarUrl.trim().length > 0
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

async function infoForAuthorId(authorId: string): Promise<AuthorInfo> {
  const fb = fallbackAuthorUsername(authorId);
  if (!mongoose.isValidObjectId(authorId)) {
    return { username: fb, fullName: fb, avatarUrl: null };
  }
  const row = (await UserModel.findById(authorId)
    .select('username fullName avatarUrl')
    .lean()) as {
    username?: string | null;
    fullName?: string | null;
    avatarUrl?: string | null;
  } | null;
  const u =
    typeof row?.username === 'string' && row.username.trim().length > 0
      ? row.username.trim().toLowerCase()
      : fb;
  // Display name: fullName → username (system-wide convention).
  const fn =
    typeof row?.fullName === 'string' && row.fullName.trim().length > 0
      ? row.fullName.trim()
      : u;
  const av =
    typeof row?.avatarUrl === 'string' && row.avatarUrl.trim().length > 0
      ? row.avatarUrl.trim()
      : null;
  return { username: u, fullName: fn, avatarUrl: av };
}

/** Lite track row used while building the music DTO. */
type MusicLite = {
  title: string;
  artistName: string | null;
  audioUrl: string;
  artUrl: string;
  durationSeconds: number | null;
};

/**
 * Batch-fetch tracks (and their artists) referenced by a list of posts.
 * Two queries total regardless of input size. Mirrors the story-service
 * helper of the same name.
 */
async function buildMusicMap(
  trackIds: ReadonlyArray<Types.ObjectId | string>,
): Promise<Map<string, MusicLite>> {
  const unique = [...new Set(trackIds.map((id) => id.toString()))];
  if (unique.length === 0) {
    return new Map();
  }
  type TrackLean = {
    _id: Types.ObjectId;
    title: string;
    audioUrl: string;
    artUrl: string;
    durationSeconds: number | null;
    artist: Types.ObjectId;
  };
  const tracks = (await MusicTrackModel.find({ _id: { $in: unique } })
    .select('title audioUrl artUrl durationSeconds artist')
    .lean()) as TrackLean[];
  const artistIds = [...new Set(tracks.map((t) => t.artist.toString()))];
  type ArtistLean = { _id: Types.ObjectId; name: string };
  const artists =
    artistIds.length > 0
      ? ((await ArtistModel.find({ _id: { $in: artistIds } })
          .select('name')
          .lean()) as ArtistLean[])
      : [];
  const artistName = new Map(artists.map((a) => [a._id.toString(), a.name]));
  return new Map(
    tracks.map((t) => [
      t._id.toString(),
      {
        title: t.title,
        artistName: artistName.get(t.artist.toString()) ?? null,
        audioUrl: t.audioUrl,
        artUrl: t.artUrl,
        durationSeconds: t.durationSeconds,
      },
    ]),
  );
}

/** Collect the music track ObjectIds referenced by a list of posts. */
function collectMusicTrackIds(
  docs: ReadonlyArray<IPost & { _id: Types.ObjectId }>,
): Types.ObjectId[] {
  const out: Types.ObjectId[] = [];
  for (const d of docs) {
    if (d.musicTrack) {
      out.push(d.musicTrack);
    }
  }
  return out;
}

/** Collect the OriginalSound ObjectIds attached to a list of posts. */
function collectAttachedOriginalSoundIds(
  docs: ReadonlyArray<IPost & { _id: Types.ObjectId }>,
): Types.ObjectId[] {
  const out: Types.ObjectId[] = [];
  for (const d of docs) {
    if (d.attachedOriginalSound) {
      out.push(d.attachedOriginalSound);
    }
  }
  return out;
}

/** Light attribution shape for a post's OWN extracted sound. */
type OwnSoundLite = {
  soundId: string;
  title: string;
  ownerUsername: string;
};

/** Collect the OriginalSound ids that posts were extracted INTO. */
function collectOwnOriginalSoundIds(
  docs: ReadonlyArray<IPost & { _id: Types.ObjectId }>,
): Types.ObjectId[] {
  const out: Types.ObjectId[] = [];
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
async function buildOwnSoundMap(
  soundIds: ReadonlyArray<Types.ObjectId | string>,
): Promise<Map<string, OwnSoundLite>> {
  const unique = [...new Set(soundIds.map(id => id.toString()))];
  if (unique.length === 0) {
    return new Map();
  }
  type SoundLean = {
    _id: Types.ObjectId;
    title: string;
    ownerUser: Types.ObjectId;
    status: string;
  };
  const sounds = (await OriginalSoundModel.find({
    _id: { $in: unique },
    status: 'ready',
  })
    .select('title ownerUser status')
    .lean()) as SoundLean[];
  if (sounds.length === 0) {
    return new Map();
  }
  const ownerIds = [...new Set(sounds.map(s => s.ownerUser.toString()))];
  type OwnerLean = { _id: Types.ObjectId; username: string };
  const owners = (await UserModel.find({ _id: { $in: ownerIds } })
    .select('username')
    .lean()) as OwnerLean[];
  const usernameByOwnerId = new Map(
    owners.map(o => [o._id.toString(), o.username]),
  );
  return new Map(
    sounds.map(s => [
      s._id.toString(),
      {
        soundId: s._id.toString(),
        title: s.title,
        ownerUsername: usernameByOwnerId.get(s.ownerUser.toString()) ?? '',
      },
    ]),
  );
}

/**
 * Batch-fetch OriginalSound rows + their source-post thumbnails in one
 * shot (plus a single per-author username lookup for the `artistName`
 * field — yes, we reuse the music DTO's "artist" slot for the creator's
 * @handle so the mobile player UI doesn't need any branching).
 */
async function buildOriginalSoundMap(
  soundIds: ReadonlyArray<Types.ObjectId | string>,
): Promise<Map<string, MusicLite>> {
  const unique = [...new Set(soundIds.map(id => id.toString()))];
  if (unique.length === 0) {
    return new Map();
  }
  type SoundLean = {
    _id: Types.ObjectId;
    title: string;
    audioUrl: string | null;
    durationSeconds: number | null;
    sourcePost: Types.ObjectId;
    ownerUser: Types.ObjectId;
  };
  const sounds = (await OriginalSoundModel.find({ _id: { $in: unique } })
    .select('title audioUrl durationSeconds sourcePost ownerUser')
    .lean()) as SoundLean[];
  if (sounds.length === 0) {
    return new Map();
  }

  // Source-post thumbnails serve as the cover art for the player UI.
  const postIds = [...new Set(sounds.map(s => s.sourcePost.toString()))];
  type PostThumbLean = {
    _id: Types.ObjectId;
    thumbnailUrl: string | null;
    media: { url: string | null };
  };
  const postRows = (await PostModel.find({ _id: { $in: postIds } })
    .select('thumbnailUrl media')
    .lean()) as PostThumbLean[];
  const thumbByPostId = new Map(
    postRows.map(p => [
      p._id.toString(),
      p.thumbnailUrl ?? p.media?.url ?? '',
    ]),
  );

  // Owner usernames stand in for "artistName" in the existing DTO.
  const ownerIds = [...new Set(sounds.map(s => s.ownerUser.toString()))];
  type OwnerLean = { _id: Types.ObjectId; username: string };
  const owners = (await UserModel.find({ _id: { $in: ownerIds } })
    .select('username')
    .lean()) as OwnerLean[];
  const usernameByOwnerId = new Map(
    owners.map(o => [o._id.toString(), o.username]),
  );

  return new Map(
    sounds
      // Skip sounds without a usable audio URL (still processing / failed).
      .filter(s => typeof s.audioUrl === 'string' && s.audioUrl.length > 0)
      .map(s => [
        s._id.toString(),
        {
          title: s.title,
          artistName:
            usernameByOwnerId.get(s.ownerUser.toString())
              ? `@${usernameByOwnerId.get(s.ownerUser.toString()) ?? ''}`
              : null,
          audioUrl: s.audioUrl as string,
          artUrl: thumbByPostId.get(s.sourcePost.toString()) ?? '',
          durationSeconds: s.durationSeconds,
        },
      ]),
  );
}

/** Build the populated `music` field for a single post DTO. */
function buildPostMusicDto(
  doc: HydratedDocument<IPost> | (IPost & { _id: Types.ObjectId }),
  musicByTrackId?: Map<string, MusicLite>,
  soundsBySoundId?: Map<string, MusicLite>,
): PostMusicDto | null {
  // Curated music track takes precedence (it's mutually exclusive with
  // attachedOriginalSound at the model level; both being set would have
  // been rejected during validation).
  if (doc.musicTrack != null && doc.musicTrimStartMs != null) {
    const trackId = (doc.musicTrack as { toString(): string }).toString();
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
    const soundId = (
      doc.attachedOriginalSound as { toString(): string }
    ).toString();
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

function toPostDto(
  doc: HydratedDocument<IPost> | (IPost & { _id: Types.ObjectId }),
  likedByViewer: boolean,
  savedByViewer: boolean,
  authorInfo: AuthorInfo,
  musicByTrackId?: Map<string, MusicLite>,
  soundsBySoundId?: Map<string, MusicLite>,
  ownSoundsById?: Map<string, OwnSoundLite>,
): PostDto {
  // The post's own extracted sound (attribution label only). We hide it
  // when the post has an *attached* track/sound, since that's what plays.
  const ownSoundId = doc.originalSoundId
    ? (doc.originalSoundId as { toString(): string }).toString()
    : null;
  const ownSound =
    ownSoundId && doc.musicTrack == null && doc.attachedOriginalSound == null
      ? ownSoundsById?.get(ownSoundId) ?? null
      : null;
  const id = doc._id.toString();
  const createdAt =
    doc.createdAt instanceof Date
      ? doc.createdAt
      : new Date(String(doc.createdAt));
  const updatedAt =
    doc.updatedAt instanceof Date
      ? doc.updatedAt
      : new Date(String(doc.updatedAt));
  return {
    id,
    authorId: authorIdString(doc.author as PostAuthorRef),
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
    likesCount: doc.likesCount,
    savesCount: doc.savesCount ?? 0,
    commentsCount: doc.commentsCount,
    likedByViewer,
    savedByViewer,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}

export type HomeFeedItemDto =
  | { type: 'post'; post: PostDto }
  | {
      type: 'recommendations';
      id: string;
      users: FeedRecommendationUserDto[];
    }
  | { type: 'sponsored'; ad: SponsoredAdDto };

export type HomeFeedResponse = {
  /** Ordered feed rows (posts plus optional interleaved modules). */
  items: HomeFeedItemDto[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
};

async function mergeRecommendationsIntoFirstPage(
  viewerUserId: string,
  posts: PostDto[],
): Promise<HomeFeedItemDto[]> {
  const following = await countFollowing(viewerUserId);
  const showRec = following < 5;
  if (!showRec || posts.length < 2) {
    return posts.map((post) => ({ type: 'post' as const, post }));
  }
  const users = await listFeedRecommendationUsers(viewerUserId, 6);
  if (users.length === 0) {
    return posts.map((post) => ({ type: 'post' as const, post }));
  }
  const slotAfterIndex = Math.floor(Math.random() * Math.max(1, posts.length - 1));
  const maxAfter = Math.max(0, posts.length - 1);
  const after = Math.min(Math.max(0, slotAfterIndex), maxAfter);
  const rows: HomeFeedItemDto[] = posts.map((post) => ({
    type: 'post' as const,
    post,
  }));
  const rec: HomeFeedItemDto = {
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
async function getActiveAdsForPlacement(
  placement: 'feed' | 'stories' | 'blog' | 'banner',
): Promise<SponsoredAdDto[]> {
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
function mergeSponsoredAds(
  items: HomeFeedItemDto[],
  pool: SponsoredAdDto[],
): HomeFeedItemDto[] {
  if (pool.length === 0) {
    return items;
  }
  const insertAfterPostCounts = [3, 6];
  const result: HomeFeedItemDto[] = [];
  let postOrdinal = 0;
  let sponsoredUsed = 0;

  for (const row of items) {
    result.push(row);
    if (row.type !== 'post') {
      continue;
    }
    postOrdinal++;
    const trigger = insertAfterPostCounts[sponsoredUsed];
    if (
      trigger != null &&
      postOrdinal === trigger &&
      sponsoredUsed < pool.length
    ) {
      result.push({ type: 'sponsored', ad: pool[sponsoredUsed] });
      sponsoredUsed++;
    }
  }
  return result;
}

export async function listHomeFeed(
  query: HomeFeedQuery,
  viewerUserId: string,
): Promise<HomeFeedResponse> {
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
    : [[] as string[], [] as string[]];
  const connectionIds = [...new Set([...followees, ...followers])].filter(
    (id) => !excludeSet.has(id) && mongoose.isValidObjectId(id),
  );
  const connectionOids = connectionIds.map(
    (id) => new mongoose.Types.ObjectId(id),
  );
  const excludeOids = excludeIds
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  // Posts the viewer has already seen — excluded so a refresh keeps surfacing
  // FRESH content instead of the same posts. When all unseen posts run out we
  // fall back to seen ones (last bucket) so the feed never goes empty.
  type ViewLean = { post: Types.ObjectId };
  const seenOids: Types.ObjectId[] = isValidViewer
    ? (
        (await PostViewModel.find({ user: viewerUserId })
          .select('post')
          .lean()) as ViewLean[]
      ).map((r) => r.post)
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

  const feedBuckets: Array<{ filter: Record<string, unknown>; total: number }> =
    [
      { filter: unseenConnectionFilter, total: unseenConnTotal },
      { filter: unseenOthersFilter, total: unseenOthersTotal },
      { filter: seenFallbackFilter, total: seenTotal },
    ];
  const total = unseenConnTotal + unseenOthersTotal + seenTotal;

  // Slice the global window [skip, skip+limit) across the ordered buckets.
  const bucketFetches: Array<Promise<unknown[]>> = [];
  let bucketOffset = 0;
  let cursor = skip;
  let need = limit;
  for (const b of feedBuckets) {
    if (need > 0 && b.total > 0 && cursor < bucketOffset + b.total) {
      const localSkip = Math.max(0, cursor - bucketOffset);
      const localLimit = Math.min(need, b.total - localSkip);
      if (localLimit > 0) {
        bucketFetches.push(
          PostModel.find(b.filter)
            .sort({ createdAt: -1, _id: -1 })
            .skip(localSkip)
            .limit(localLimit)
            .lean() as Promise<unknown[]>,
        );
        need -= localLimit;
        cursor += localLimit;
      }
    }
    bucketOffset += b.total;
  }
  const fetched = await Promise.all(bucketFetches);
  const docs = fetched.flat();
  const postIds = docs.map((d) => (d as IPost & { _id: Types.ObjectId })._id);
  const likedIdSet = new Set<string>();
  const savedIdSet = new Set<string>();
  if (postIds.length > 0 && mongoose.isValidObjectId(viewerUserId)) {
    type LikeLean = { post: Types.ObjectId };
    const [likeRows, saveRows] = await Promise.all([
      PostLikeModel.find({
        user: viewerUserId,
        post: { $in: postIds },
      })
        .select('post')
        .lean() as Promise<LikeLean[]>,
      PostSaveModel.find({
        user: viewerUserId,
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
  const leanDocs = docs as (IPost & { _id: Types.ObjectId })[];
  const authorIds = leanDocs.map((d) =>
    authorIdString(d.author as PostAuthorRef),
  );
  const [infoByAuthorId, musicMap, soundMap, ownSoundMap] = await Promise.all([
    mapAuthorIdsToInfo(authorIds),
    buildMusicMap(collectMusicTrackIds(leanDocs)),
    buildOriginalSoundMap(collectAttachedOriginalSoundIds(leanDocs)),
    buildOwnSoundMap(collectOwnOriginalSoundIds(leanDocs)),
  ]);
  const posts = leanDocs.map((lean) => {
    const id = lean._id.toString();
    const aid = authorIdString(lean.author as PostAuthorRef);
    const fb = fallbackAuthorUsername(aid);
    const info = infoByAuthorId.get(aid) ?? {
      username: fb,
      fullName: fb,
      avatarUrl: null,
    };
    return toPostDto(lean, likedIdSet.has(id), savedIdSet.has(id), info, musicMap, soundMap, ownSoundMap);
  });
  let items: HomeFeedItemDto[] =
    page === 0
      ? await mergeRecommendationsIntoFirstPage(viewerUserId, posts)
      : posts.map((post) => ({ type: 'post' as const, post }));
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
export async function listTrendingPosts(
  viewerUserId: string,
  opts?: { limit?: number },
): Promise<{ items: PostDto[] }> {
  const limit = Math.min(
    TRENDING_POST_MAX,
    Math.max(1, Math.trunc(opts?.limit ?? TRENDING_POST_LIMIT)),
  );
  const hiddenIds = mongoose.isValidObjectId(viewerUserId)
    ? await listHiddenUserIds(viewerUserId)
    : [];
  const trendingFilter =
    hiddenIds.length > 0
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
  ])) as (IPost & { _id: Types.ObjectId })[];
  const postIds = docs.map((d) => d._id);
  const likedIdSet = new Set<string>();
  const savedIdSet = new Set<string>();
  if (postIds.length > 0 && mongoose.isValidObjectId(viewerUserId)) {
    type LikeLean = { post: Types.ObjectId };
    const [likeRows, saveRows] = await Promise.all([
      PostLikeModel.find({
        user: viewerUserId,
        post: { $in: postIds },
      })
        .select('post')
        .lean() as Promise<LikeLean[]>,
      PostSaveModel.find({
        user: viewerUserId,
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
  const authorIds = docs.map((d) =>
    authorIdString(d.author as PostAuthorRef),
  );
  const [infoByAuthorId, musicMap, soundMap, ownSoundMap] = await Promise.all([
    mapAuthorIdsToInfo(authorIds),
    buildMusicMap(collectMusicTrackIds(docs)),
    buildOriginalSoundMap(collectAttachedOriginalSoundIds(docs)),
    buildOwnSoundMap(collectOwnOriginalSoundIds(docs)),
  ]);
  const items = docs.map((lean) => {
    const id = lean._id.toString();
    const aid = authorIdString(lean.author as PostAuthorRef);
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

function assertObjectId(id: string): void {
  if (!mongoose.isValidObjectId(id)) {
    throw new HttpError(400, 'Invalid post id', 'INVALID_POST_ID');
  }
}

/** Escape a string for safe inclusion in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Paginated list of posts whose `caption` or `hashtags` contains `#<tag>`.
 * Tag matching is case-insensitive and word-bounded.
 * `GET /api/v1/posts/hashtag/:tag`
 */
export async function listPostsByHashtag(
  rawTag: string,
  query: { page: number; limit: number },
  viewerUserId: string,
): Promise<{
  items: PostDto[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
  hashtag: string;
}> {
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

  const baseFilter: Record<string, unknown> = {
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

  const leanDocs = docs as (IPost & { _id: Types.ObjectId })[];

  const postIds = leanDocs.map((d) => d._id);
  const likedIdSet = new Set<string>();
  const savedIdSet = new Set<string>();
  if (postIds.length > 0 && mongoose.isValidObjectId(viewerUserId)) {
    type LikeLean = { post: Types.ObjectId };
    const [likeRows, saveRows] = await Promise.all([
      PostLikeModel.find({
        user: viewerUserId,
        post: { $in: postIds },
      })
        .select('post')
        .lean() as Promise<LikeLean[]>,
      PostSaveModel.find({
        user: viewerUserId,
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

  const authorIds = leanDocs.map((d) =>
    authorIdString(d.author as PostAuthorRef),
  );
  const [infoByAuthorId, musicMap, soundMap, ownSoundMap] = await Promise.all([
    mapAuthorIdsToInfo(authorIds),
    buildMusicMap(collectMusicTrackIds(leanDocs)),
    buildOriginalSoundMap(collectAttachedOriginalSoundIds(leanDocs)),
    buildOwnSoundMap(collectOwnOriginalSoundIds(leanDocs)),
  ]);

  const items = leanDocs.map((lean) => {
    const id = lean._id.toString();
    const aid = authorIdString(lean.author as PostAuthorRef);
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
export async function listSavedPosts(
  viewerUserId: string,
  query: { page: number; limit: number },
): Promise<{
  items: PostDto[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}> {
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
      .lean() as Promise<{ post: Types.ObjectId }[]>,
  ]);

  // Post ids in save-recency order (newest save first).
  const orderedIds = saveRows.map((r) => r.post.toString());
  if (orderedIds.length === 0) {
    return { items: [], page, limit, total, hasMore: false };
  }

  const hiddenIds = await listHiddenUserIds(viewerUserId);
  const postFilter: Record<string, unknown> = {
    _id: { $in: saveRows.map((r) => r.post) },
  };
  if (hiddenIds.length > 0) {
    postFilter.author = {
      $nin: hiddenIds.map((id) => new mongoose.Types.ObjectId(id)),
    };
  }

  const docs = (await PostModel.find(postFilter).lean()) as (IPost & {
    _id: Types.ObjectId;
  })[];
  // `$in` does not preserve order — re-map to the saved-recency order and drop
  // posts that were since deleted or whose author is now hidden/blocked.
  const docById = new Map<string, IPost & { _id: Types.ObjectId }>();
  for (const d of docs) {
    docById.set(d._id.toString(), d);
  }
  const leanDocs = orderedIds
    .map((id) => docById.get(id))
    .filter((d): d is IPost & { _id: Types.ObjectId } => d != null);

  // Liked state for this viewer (everything here is saved by definition).
  const postIds = leanDocs.map((d) => d._id);
  const likedIdSet = new Set<string>();
  if (postIds.length > 0) {
    type LikeLean = { post: Types.ObjectId };
    const likeRows = (await PostLikeModel.find({
      user: viewerUserId,
      post: { $in: postIds },
    })
      .select('post')
      .lean()) as LikeLean[];
    for (const row of likeRows) {
      likedIdSet.add(row.post.toString());
    }
  }

  const authorIds = leanDocs.map((d) =>
    authorIdString(d.author as PostAuthorRef),
  );
  const [infoByAuthorId, musicMap, soundMap, ownSoundMap] = await Promise.all([
    mapAuthorIdsToInfo(authorIds),
    buildMusicMap(collectMusicTrackIds(leanDocs)),
    buildOriginalSoundMap(collectAttachedOriginalSoundIds(leanDocs)),
    buildOwnSoundMap(collectOwnOriginalSoundIds(leanDocs)),
  ]);

  const items = leanDocs.map((lean) => {
    const id = lean._id.toString();
    const aid = authorIdString(lean.author as PostAuthorRef);
    const fb = fallbackAuthorUsername(aid);
    const info = infoByAuthorId.get(aid) ?? {
      username: fb,
      fullName: fb,
      avatarUrl: null,
    };
    return toPostDto(
      lean,
      likedIdSet.has(id),
      true,
      info,
      musicMap,
      soundMap,
      ownSoundMap,
    );
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
export async function listPostsByMusicTrack(
  rawTrackId: string,
  query: { page: number; limit: number },
  viewerUserId: string,
): Promise<{
  items: PostDto[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
  musicTrackId: string;
  music: MusicLite | null;
}> {
  if (!mongoose.isValidObjectId(rawTrackId)) {
    throw new HttpError(400, 'Invalid music track id', 'INVALID_MUSIC_TRACK_ID');
  }
  const trackOid = new mongoose.Types.ObjectId(rawTrackId);

  const hiddenIds = mongoose.isValidObjectId(viewerUserId)
    ? await listHiddenUserIds(viewerUserId)
    : [];

  const baseFilter: Record<string, unknown> = { musicTrack: trackOid };
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

  const leanDocs = docs as (IPost & { _id: Types.ObjectId })[];

  const postIds = leanDocs.map((d) => d._id);
  const likedIdSet = new Set<string>();
  const savedIdSet = new Set<string>();
  if (postIds.length > 0 && mongoose.isValidObjectId(viewerUserId)) {
    type LikeLean = { post: Types.ObjectId };
    const [likeRows, saveRows] = await Promise.all([
      PostLikeModel.find({
        user: viewerUserId,
        post: { $in: postIds },
      })
        .select('post')
        .lean() as Promise<LikeLean[]>,
      PostSaveModel.find({
        user: viewerUserId,
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

  const authorIds = leanDocs.map((d) =>
    authorIdString(d.author as PostAuthorRef),
  );
  // This endpoint filters by `musicTrack`, so attachedOriginalSound is
  // never set on these rows — passing an empty soundMap keeps the
  // toPostDto signature uniform.
  const [infoByAuthorId, musicMap] = await Promise.all([
    mapAuthorIdsToInfo(authorIds),
    buildMusicMap([trackOid]),
  ]);
  const emptySoundMap = new Map<string, MusicLite>();

  const items = leanDocs.map((lean) => {
    const id = lean._id.toString();
    const aid = authorIdString(lean.author as PostAuthorRef);
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

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 11000
  );
}

export type PostLikeResult = {
  liked: boolean;
  likesCount: number;
};

/**
 * Like or unlike a post in one call. Idempotent: repeating the same `liked` value is a no-op for counts.
 */
export async function setPostLike(
  userId: string,
  postId: string,
  liked: boolean,
): Promise<PostLikeResult> {
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
    } catch (err: unknown) {
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
            .lean<{ author: Types.ObjectId }>();
          const authorId = post?.author?.toString();
          if (!authorId || authorId === userId) return;
          const liker = await UserModel.findById(userId)
            .select('fullName username')
            .lean<{
              fullName: string | null;
              username: string;
            }>();
          const name =
            liker?.fullName?.trim() ||
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
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'unknown error';
          console.warn('[post] like push dispatch failed:', msg);
        }
      })();
    }
  } else {
    const del = await PostLikeModel.deleteOne({ user: userId, post: postId });
    if (del.deletedCount === 1) {
      await PostModel.updateOne(
        { _id: postId, likesCount: { $gt: 0 } },
        { $inc: { likesCount: -1 } },
      );
    }
  }

  const doc = await PostModel.findById(postId).select('likesCount').lean();
  const likesCount =
    typeof doc?.likesCount === 'number' && doc.likesCount >= 0
      ? doc.likesCount
      : 0;
  return { liked, likesCount };
}

export type PostSaveResult = {
  saved: boolean;
  savesCount: number;
};

/**
 * Save (bookmark) or unsave a post in one call. Idempotent: repeating the same
 * `saved` value is a no-op for counts. No notification is sent — a save is a
 * private bookmark, invisible to the post author.
 */
export async function setPostSave(
  userId: string,
  postId: string,
  saved: boolean,
): Promise<PostSaveResult> {
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
    } catch (err: unknown) {
      if (!isDuplicateKeyError(err)) {
        throw err;
      }
    }
  } else {
    const del = await PostSaveModel.deleteOne({ user: userId, post: postId });
    if (del.deletedCount === 1) {
      await PostModel.updateOne(
        { _id: postId, savesCount: { $gt: 0 } },
        { $inc: { savesCount: -1 } },
      );
    }
  }

  const doc = await PostModel.findById(postId).select('savesCount').lean();
  const savesCount =
    typeof doc?.savesCount === 'number' && doc.savesCount >= 0
      ? doc.savesCount
      : 0;
  return { saved, savesCount };
}

/**
 * Mark posts as SEEN by the viewer (home feed). Idempotent + best-effort:
 * duplicate (user, post) pairs are ignored, batch is capped. These power the
 * "don't show me posts I've already seen" feed exclusion in listHomeFeed.
 */
export async function recordPostViews(
  userId: string,
  postIds: string[],
): Promise<{ recorded: number }> {
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
  } catch (err: unknown) {
    // Concurrent reports can race on the unique (user,post) index — ignore.
    if (isDuplicateKeyError(err)) {
      return { recorded: 0 };
    }
    throw err;
  }
}

export async function createPost(
  userId: string,
  body: CreatePostBody,
): Promise<PostDto> {
  const prefix = uploadKeyPrefix(userId);
  if (!body.file.key.startsWith(prefix)) {
    throw new HttpError(
      403,
      'File key does not belong to this user',
      'FORBIDDEN_MEDIA',
    );
  }

  const baseMime =
    body.file.contentType.toLowerCase().split(';')[0]?.trim() ?? '';
  const cat = mediaCategory(baseMime);
  if (cat === null || cat === 'audio') {
    throw new HttpError(
      400,
      'Only image or video files can be attached to a post',
      'UNSUPPORTED_MEDIA_TYPE',
    );
  }
  if (body.mediaKind === 'image' && cat !== 'image') {
    throw new HttpError(
      400,
      'mediaKind "image" does not match file content type',
      'MEDIA_KIND_MISMATCH',
    );
  }
  if (body.mediaKind === 'short_video' && cat !== 'video') {
    throw new HttpError(
      400,
      'mediaKind "short_video" does not match file content type',
      'MEDIA_KIND_MISMATCH',
    );
  }
  if (body.mediaKind === 'image' && body.durationSeconds != null) {
    throw new HttpError(
      400,
      'durationSeconds must be omitted for image posts',
      'VALIDATION_ERROR',
    );
  }

  // Validate optional music attachment and resolve display title.
  let resolvedMusicTitle: string | null = body.musicTitle ?? null;
  let musicTrackOid: mongoose.Types.ObjectId | null = null;
  let attachedOriginalSoundOid: mongoose.Types.ObjectId | null = null;
  if (body.musicTrackId != null) {
    const track = (await MusicTrackModel.findById(body.musicTrackId)
      .select('title status durationSeconds artist')
      .lean()) as
      | {
          _id: Types.ObjectId;
          title: string;
          status: 'draft' | 'published';
          durationSeconds: number | null;
          artist: Types.ObjectId;
        }
      | null;
    if (!track || track.status !== 'published') {
      throw new HttpError(
        404,
        'Music track not found or not available',
        'MUSIC_TRACK_NOT_FOUND',
      );
    }
    musicTrackOid = track._id;
    if (!resolvedMusicTitle) {
      const artist = (await ArtistModel.findById(track.artist)
        .select('name')
        .lean()) as { name: string } | null;
      resolvedMusicTitle = artist?.name
        ? `${track.title} — ${artist.name}`
        : track.title;
    }
  } else if (body.attachedOriginalSoundId != null) {
    // Validate the original sound is real, ready, and browsable.
    const sound = await OriginalSoundModel.findById(body.attachedOriginalSoundId)
      .select('title status isPublic')
      .lean<{
        _id: Types.ObjectId;
        title: string;
        status: 'processing' | 'ready' | 'failed' | 'deleted';
        isPublic: boolean;
      } | null>();
    if (!sound || sound.status !== 'ready' || !sound.isPublic) {
      throw new HttpError(
        404,
        'Original sound not found or not available',
        'ORIGINAL_SOUND_NOT_FOUND',
      );
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
    },
    caption: body.caption ?? null,
    hashtags: body.hashtags ?? null,
    musicTitle: resolvedMusicTitle,
    musicTrack: musicTrackOid,
    musicTrimStartMs:
      musicTrackOid != null || attachedOriginalSoundOid != null
        ? body.musicTrimStartMs ?? 0
        : null,
    attachedOriginalSound: attachedOriginalSoundOid,
    // Only meaningful for video posts; image posts ignore it client-side.
    originalAudioMuted: body.originalAudioMuted ?? false,
    mediaWidth: body.mediaWidth ?? null,
    mediaHeight: body.mediaHeight ?? null,
    durationSeconds: body.durationSeconds ?? null,
  });

  // Auto-generate thumbnail for video posts (non-blocking for response)
  if (body.mediaKind === 'short_video') {
    generateVideoThumbnail(body.file.key, userId)
      .then(async (thumbUrl) => {
        if (thumbUrl) {
          await PostModel.updateOne(
            { _id: doc._id },
            { $set: { thumbnailUrl: thumbUrl } },
          );
        }
      })
      .catch(() => {});

    // When the uploader kept the original audio, extract it as a reusable
    // Original Sound. Fire-and-forget — a Redis outage must never block
    // post creation, so any enqueue error is logged-and-swallowed (the
    // post still lands; ops can re-enqueue from the failed sound row).
    if (!(body.originalAudioMuted ?? false)) {
      // eslint-disable-next-line no-console
      console.log(
        `[posts] enqueue sound extraction postId=${doc._id.toString()}`,
      );
      enqueueSoundExtraction(doc._id.toString()).catch(err => {
        // eslint-disable-next-line no-console
        console.error(
          `[posts] enqueueSoundExtraction failed postId=${doc._id.toString()}:`,
          err instanceof Error ? err.message : err,
        );
      });
    } else {
      // eslint-disable-next-line no-console
      console.log(
        `[posts] skip sound extraction postId=${doc._id.toString()} (originalAudioMuted=true)`,
      );
    }
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `[posts] skip sound extraction (mediaKind=${body.mediaKind})`,
    );
  }

  // Bump usesCount on the borrowed OriginalSound so the catalog sort
  // reflects reality. Best-effort: if it ever fails, the post still
  // links correctly — the next analytics job (future) can reconcile.
  if (attachedOriginalSoundOid != null) {
    OriginalSoundModel.updateOne(
      { _id: attachedOriginalSoundOid },
      { $inc: { usesCount: 1 } },
    )
      .exec()
      .catch(() => undefined);
  }

  const [authorInfo, musicMap, soundMap] = await Promise.all([
    infoForAuthorId(userId),
    musicTrackOid
      ? buildMusicMap([musicTrackOid])
      : Promise.resolve(new Map<string, MusicLite>()),
    attachedOriginalSoundOid
      ? buildOriginalSoundMap([attachedOriginalSoundOid])
      : Promise.resolve(new Map<string, MusicLite>()),
  ]);
  return toPostDto(doc, false, false, authorInfo, musicMap, soundMap);
}

/**
 * Delete a post. Only the post owner can delete.
 */
export async function deletePost(
  userId: string,
  postId: string,
): Promise<void> {
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
