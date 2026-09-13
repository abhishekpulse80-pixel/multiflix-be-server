import mongoose, { type HydratedDocument, type Types } from 'mongoose';
import { mediaCategory } from '../lib/allowedMediaMime.js';
import { HttpError } from '../lib/httpError.js';
import type { IStory, StoryMediaKind } from '../models/story.model.js';
import { FollowModel } from '../models/follow.model.js';
import { StoryModel } from '../models/story.model.js';
import { StoryReactionModel, type ReactionType } from '../models/storyReaction.model.js';
import { StoryViewModel } from '../models/storyView.model.js';
import { MusicTrackModel } from '../models/musicTrack.model.js';
import { ArtistModel } from '../models/artist.model.js';
import { UserModel } from '../models/user.model.js';
import { createNotification, sendToUser } from './notification.service.js';
import type {
  CreateStoryBody,
  StoryFeedQuery,
} from '../schemas/stories.schemas.js';
import { isBlockedBetween, listHiddenUserIds } from './userBlock.service.js';

// ─── DTOs ────────────────────────────────────────────────────────────────────

export type StoryMediaDto = {
  key: string;
  bucket: string;
  contentType: string;
  size: number;
  originalName: string;
  url: string | null;
};

/**
 * Music attachment populated for client-side dual playback. The mobile
 * player loads the video muted (or shows the image) and plays `audioUrl`
 * starting at `trimStartMs` for a fixed 15-second window.
 */
export type StoryMusicDto = {
  trackId: string;
  title: string;
  artistName: string | null;
  audioUrl: string;
  artUrl: string;
  durationSeconds: number | null;
  trimStartMs: number;
};

export type StoryDto = {
  id: string;
  authorId: string;
  authorUsername: string;
  /** Author display fields — client shows fullName → username. */
  authorFullName: string | null;
  mediaKind: StoryMediaKind;
  media: StoryMediaDto;
  soundTitle: string | null;
  /** Populated music attachment, or null when none was selected. */
  music: StoryMusicDto | null;
  caption: string | null;
  mediaWidth: number | null;
  mediaHeight: number | null;
  durationSeconds: number | null;
  viewsCount: number;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  showInTrending: boolean;
  textOverlays: StoryTextOverlayDto[];
  /** Pinch/pan transform applied to the media in the editor. Null = identity. */
  mediaTransform: StoryMediaTransformDto | null;
};

/** Mirrors `IStoryMediaTransform` on the model. */
export type StoryMediaTransformDto = {
  scale: number;
  translateX: number;
  translateY: number;
};

export type StoryTextOverlayDto = {
  text: string;
  x: number;
  y: number;
  color: string;
  fontSize: number;
};

export type StoryFeedResponse = {
  items: StoryDto[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const STORY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

type AuthorRef = Types.ObjectId | string | { toString(): string };

function authorIdStr(author: AuthorRef): string {
  return typeof author === 'string' ? author : author.toString();
}

function fallbackUsername(authorId: string): string {
  return `user_${authorId.slice(-6)}`;
}

type AuthorInfo = {
  username: string;
  fullName: string | null;
};

async function authorInfoFor(authorId: string): Promise<AuthorInfo> {
  if (!mongoose.isValidObjectId(authorId)) {
    return { username: fallbackUsername(authorId), fullName: null };
  }
  const row = (await UserModel.findById(authorId)
    .select('username fullName')
    .lean()) as
    | { username?: string | null; fullName?: string | null }
    | null;
  const u = row?.username;
  return {
    username:
      typeof u === 'string' && u.trim().length > 0
        ? u.trim().toLowerCase()
        : fallbackUsername(authorId),
    fullName: row?.fullName ?? null,
  };
}

async function mapAuthorIdsToInfo(
  authorIds: string[],
): Promise<Map<string, AuthorInfo>> {
  const map = new Map<string, AuthorInfo>();
  const unique = [
    ...new Set(authorIds.filter(id => mongoose.isValidObjectId(id))),
  ];
  if (unique.length === 0) {
    return map;
  }
  type UserLean = {
    _id: Types.ObjectId;
    username?: string | null;
    fullName?: string | null;
  };
  const rows = (await UserModel.find({ _id: { $in: unique } })
    .select('_id username fullName')
    .lean()) as UserLean[];
  for (const r of rows) {
    const id = r._id.toString();
    map.set(id, {
      username:
        typeof r.username === 'string' && r.username.trim().length > 0
          ? r.username.trim().toLowerCase()
          : fallbackUsername(id),
      fullName: r.fullName ?? null,
    });
  }
  return map;
}

async function mapAuthorIdsToUsernames(
  authorIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = [
    ...new Set(authorIds.filter((id) => mongoose.isValidObjectId(id))),
  ];
  if (unique.length === 0) {
    return map;
  }
  type UserLean = { _id: Types.ObjectId; username?: string | null };
  const rows = (await UserModel.find({ _id: { $in: unique } })
    .select('_id username')
    .lean()) as UserLean[];
  for (const r of rows) {
    const id = r._id.toString();
    const u =
      typeof r.username === 'string' && r.username.trim().length > 0
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

/** Lite track row used while building the music DTO. */
type MusicLite = {
  title: string;
  artistName: string | null;
  audioUrl: string;
  artUrl: string;
  durationSeconds: number | null;
};

/**
 * Batch-fetch music tracks (and their artists) referenced by a list of
 * stories, returning a `trackId → MusicLite` lookup map. Two queries total
 * regardless of how many stories are passed in.
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

/** Collect the set of music track ObjectIds referenced by a list of stories. */
function collectMusicTrackIds(
  docs: ReadonlyArray<IStory & { _id: Types.ObjectId }>,
): Types.ObjectId[] {
  const out: Types.ObjectId[] = [];
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
function buildStoryMusicDto(
  doc: HydratedDocument<IStory> | (IStory & { _id: Types.ObjectId }),
  musicByTrackId?: Map<string, MusicLite>,
): StoryMusicDto | null {
  if (doc.musicTrack == null || doc.musicTrimStartMs == null) {
    return null;
  }
  const trackId = (doc.musicTrack as { toString(): string }).toString();
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

function toStoryDto(
  doc: HydratedDocument<IStory> | (IStory & { _id: Types.ObjectId }),
  authorUsername: string,
  musicByTrackId?: Map<string, MusicLite>,
  authorName?: { fullName: string | null },
): StoryDto {
  const createdAt =
    doc.createdAt instanceof Date
      ? doc.createdAt
      : new Date(String(doc.createdAt));
  const updatedAt =
    doc.updatedAt instanceof Date
      ? doc.updatedAt
      : new Date(String(doc.updatedAt));
  return {
    id: doc._id.toString(),
    authorId: authorIdStr(doc.author as AuthorRef),
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
    },
    soundTitle: doc.soundTitle,
    music: buildStoryMusicDto(doc, musicByTrackId),
    caption: doc.caption,
    mediaWidth: doc.mediaWidth,
    mediaHeight: doc.mediaHeight,
    durationSeconds: doc.durationSeconds,
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
export async function createStory(
  userId: string,
  body: CreateStoryBody,
): Promise<StoryDto> {
  // Validate file ownership
  const prefix = `uploads/${userId}/`;
  if (!body.file.key.startsWith(prefix)) {
    throw new HttpError(
      403,
      'File key does not belong to this user',
      'FORBIDDEN_MEDIA',
    );
  }

  // Validate MIME against declared mediaKind
  const baseMime =
    body.file.contentType.toLowerCase().split(';')[0]?.trim() ?? '';
  const cat = mediaCategory(baseMime);
  if (cat === null || cat === 'audio') {
    throw new HttpError(
      400,
      'Only image or video files can be attached to a story',
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
      'durationSeconds must be omitted for image stories',
      'VALIDATION_ERROR',
    );
  }

  // Validate optional music attachment and resolve display title.
  let resolvedSoundTitle: string | null = body.soundTitle ?? null;
  let musicTrackOid: mongoose.Types.ObjectId | null = null;
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
    // The music window length now matches the story's media duration
    // (image stories use a viewer-side default), so we just sanity-check
    // that the start offset is within the track itself. The viewer
    // gracefully loops if the chosen window happens to exceed the track.
    if (
      track.durationSeconds != null &&
      (body.musicTrimStartMs ?? 0) >= Math.floor(track.durationSeconds * 1000)
    ) {
      throw new HttpError(
        400,
        'Music trim start exceeds track duration',
        'MUSIC_TRIM_OUT_OF_RANGE',
      );
    }
    musicTrackOid = track._id;
    // Auto-derive display title from track + artist when client didn't supply one.
    if (!resolvedSoundTitle) {
      const artist = (await ArtistModel.findById(track.artist)
        .select('name')
        .lean()) as { name: string } | null;
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
    },
    soundTitle: resolvedSoundTitle,
    musicTrack: musicTrackOid,
    musicTrimStartMs: musicTrackOid != null ? body.musicTrimStartMs ?? 0 : null,
    caption: body.caption ?? null,
    mediaWidth: body.mediaWidth ?? null,
    mediaHeight: body.mediaHeight ?? null,
    durationSeconds: body.durationSeconds ?? null,
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

  const info = await authorInfoFor(userId);
  const musicMap = doc.musicTrack
    ? await buildMusicMap([doc.musicTrack])
    : new Map<string, MusicLite>();
  return toStoryDto(doc, info.username, musicMap, info);
}

/**
 * Paginated feed of all active (non-expired) stories, newest first.
 * `GET /api/v1/stories/feed?page=&limit=`
 */
export async function listStoryFeed(
  query: StoryFeedQuery,
  viewerId?: string,
): Promise<StoryFeedResponse> {
  const { page, limit } = query;
  const skip = page * limit;
  const now = new Date();

  const hiddenIds =
    viewerId && mongoose.isValidObjectId(viewerId)
      ? await listHiddenUserIds(viewerId)
      : [];
  const baseFilter: Record<string, unknown> = { expiresAt: { $gt: now } };
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

  const leanDocs = docs as (IStory & { _id: Types.ObjectId })[];
  const authorIds = leanDocs.map((d) => authorIdStr(d.author as AuthorRef));
  const [infoByAuthorId, musicMap] = await Promise.all([
    mapAuthorIdsToInfo(authorIds),
    buildMusicMap(collectMusicTrackIds(leanDocs)),
  ]);

  const items = leanDocs.map((d) => {
    const aid = authorIdStr(d.author as AuthorRef);
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
export async function listUserStories(
  authorId: string,
  viewerId?: string,
): Promise<{ items: StoryDto[] }> {
  if (!mongoose.isValidObjectId(authorId)) {
    throw new HttpError(400, 'Invalid user id', 'INVALID_USER_ID');
  }
  if (
    viewerId &&
    viewerId !== authorId &&
    (await isBlockedBetween(viewerId, authorId))
  ) {
    return { items: [] };
  }
  const now = new Date();
  const docs = (await StoryModel.find({
    author: authorId,
    expiresAt: { $gt: now },
  })
    .sort({ createdAt: -1, _id: -1 })
    .lean()) as (IStory & { _id: Types.ObjectId })[];

  const [info, musicMap] = await Promise.all([
    authorInfoFor(authorId),
    buildMusicMap(collectMusicTrackIds(docs)),
  ]);
  const items = docs.map((d) => toStoryDto(d, info.username, musicMap, info));
  return { items };
}

// ─── Connection stories (users the caller follows / who follow the caller) ──

export type ConnectionStoryAuthor = {
  userId: string;
  username: string;
  fullName: string | null;
  avatarUrl: string | null;
  stories: StoryDto[];
  /** True when the viewer has NOT seen every one of this author's active
   * stories — drives the coloured (vs grayed-out) story ring, Instagram-style. */
  hasUnseen: boolean;
};

export type ConnectionStoriesResponse = {
  authors: ConnectionStoryAuthor[];
};

/**
 * Set of story-id strings (among `storyIds`) that `viewerId` has already
 * viewed. Used to decide whether an author's ring is coloured or grayed out.
 */
async function viewedStoryIdSet(
  viewerId: string | undefined,
  storyIds: mongoose.Types.ObjectId[],
): Promise<Set<string>> {
  if (!viewerId || !mongoose.isValidObjectId(viewerId) || storyIds.length === 0) {
    return new Set<string>();
  }
  const views = (await StoryViewModel.find({
    viewer: new mongoose.Types.ObjectId(viewerId),
    story: { $in: storyIds },
  })
    .select('story')
    .lean()) as { story: mongoose.Types.ObjectId }[];
  return new Set(views.map((v) => v.story.toString()));
}

/**
 * Active stories from users in the caller's follow network
 * (people I follow OR who follow me), grouped by author, newest first.
 * `GET /api/v1/stories/connections`
 */
export async function listConnectionStories(
  viewerId: string,
): Promise<ConnectionStoriesResponse> {
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
  const followingSet = new Set<string>();
  for (const d of followingDocs) followingSet.add(d.followee.toString());
  const connectedIdSet = new Set<string>();
  for (const d of followerDocs) {
    const followerId = d.follower.toString();
    if (followingSet.has(followerId)) connectedIdSet.add(followerId);
  }
  // exclude self
  connectedIdSet.delete(viewerId);

  if (connectedIdSet.size === 0) {
    return { authors: [] };
  }

  const connectedIds = [...connectedIdSet].map(
    (id) => new mongoose.Types.ObjectId(id),
  );

  const now = new Date();
  const stories = (await StoryModel.find({
    author: { $in: connectedIds },
    expiresAt: { $gt: now },
  })
    .sort({ createdAt: -1, _id: -1 })
    .lean()) as (IStory & { _id: mongoose.Types.ObjectId })[];

  if (stories.length === 0) {
    return { authors: [] };
  }

  // Group stories by author
  const byAuthor = new Map<string, (IStory & { _id: mongoose.Types.ObjectId })[]>();
  for (const s of stories) {
    const aid = authorIdStr(s.author as AuthorRef);
    const list = byAuthor.get(aid) ?? [];
    list.push(s);
    byAuthor.set(aid, list);
  }

  // Fetch author profiles
  const authorIds = [...byAuthor.keys()];
  const usernameMap = await mapAuthorIdsToUsernames(authorIds);
  type UserLean = {
    _id: mongoose.Types.ObjectId;
    username?: string | null;
    fullName?: string | null;
    avatarUrl?: string | null;
  };
  const [userRows, musicMap] = await Promise.all([
    UserModel.find({ _id: { $in: authorIds } })
      .select('_id username fullName avatarUrl')
      .lean() as Promise<UserLean[]>,
    buildMusicMap(collectMusicTrackIds(stories)),
  ]);
  const userMap = new Map(userRows.map((u) => [u._id.toString(), u]));

  // Which of these stories has the viewer already seen? (grays the ring)
  const viewedSet = await viewedStoryIdSet(
    viewerId,
    stories.map((s) => s._id),
  );

  const authors: ConnectionStoryAuthor[] = authorIds.map((aid) => {
    const user = userMap.get(aid);
    const authorUsername = usernameMap.get(aid) ?? fallbackUsername(aid);
    const authorName = {
      fullName: (user?.fullName as string | null) ?? null,
    };
    const authorDocs = byAuthor.get(aid) ?? [];
    return {
      userId: aid,
      username: authorUsername,
      fullName: authorName.fullName,
      avatarUrl: (user?.avatarUrl as string | null) ?? null,
      stories: authorDocs.map((d) =>
        toStoryDto(d, authorUsername, musicMap, authorName),
      ),
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
export async function listTrendingStories(
  limit = 20,
  viewerId?: string,
): Promise<ConnectionStoriesResponse> {
  const now = new Date();
  const hiddenIds =
    viewerId && mongoose.isValidObjectId(viewerId)
      ? await listHiddenUserIds(viewerId)
      : [];
  const trendingFilter: Record<string, unknown> = {
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
    .lean()) as (IStory & { _id: mongoose.Types.ObjectId })[];

  if (stories.length === 0) {
    return { authors: [] };
  }

  // Group by author, preserving viewsCount-desc order for ranking.
  const byAuthor = new Map<string, (IStory & { _id: mongoose.Types.ObjectId })[]>();
  const authorOrder: string[] = [];
  for (const s of stories) {
    const aid = authorIdStr(s.author as AuthorRef);
    if (!byAuthor.has(aid)) {
      byAuthor.set(aid, []);
      authorOrder.push(aid);
    }
    byAuthor.get(aid)!.push(s);
  }

  const topAuthorIds = authorOrder.slice(0, limit);

  const usernameMap = await mapAuthorIdsToUsernames(topAuthorIds);
  type UserLean = {
    _id: mongoose.Types.ObjectId;
    username?: string | null;
    fullName?: string | null;
    avatarUrl?: string | null;
  };
  // Restrict music population to the top-N authors actually returned.
  const topAuthorIdSet = new Set(topAuthorIds);
  const topStories = stories.filter((s) =>
    topAuthorIdSet.has(authorIdStr(s.author as AuthorRef)),
  );
  const [userRows, musicMap] = await Promise.all([
    UserModel.find({ _id: { $in: topAuthorIds } })
      .select('_id username fullName avatarUrl')
      .lean() as Promise<UserLean[]>,
    buildMusicMap(collectMusicTrackIds(topStories)),
  ]);
  const userMap = new Map(userRows.map((u) => [u._id.toString(), u]));

  // Which of these stories has the viewer already seen? (grays the ring)
  const viewedSet = await viewedStoryIdSet(
    viewerId,
    topStories.map((s) => s._id),
  );

  const authors: ConnectionStoryAuthor[] = topAuthorIds.map((aid) => {
    const user = userMap.get(aid);
    const authorUsername = usernameMap.get(aid) ?? fallbackUsername(aid);
    const authorName = {
      fullName: (user?.fullName as string | null) ?? null,
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
      avatarUrl: (user?.avatarUrl as string | null) ?? null,
      stories: authorStories.map((d) =>
        toStoryDto(d, authorUsername, musicMap, authorName),
      ),
      hasUnseen: authorStories.some((d) => !viewedSet.has(d._id.toString())),
    };
  });

  return { authors };
}

/**
 * Fetch a single story by ID (must not be expired).
 * `GET /api/v1/stories/:storyId`
 */
export async function getStory(
  storyId: string,
  viewerId?: string,
): Promise<StoryDto> {
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
  const authorId = authorIdStr(doc.author as AuthorRef);
  if (
    viewerId &&
    viewerId !== authorId &&
    (await isBlockedBetween(viewerId, authorId))
  ) {
    throw new HttpError(404, 'Story not found or has expired', 'STORY_NOT_FOUND');
  }
  const [info, musicMap] = await Promise.all([
    authorInfoFor(authorId),
    doc.musicTrack
      ? buildMusicMap([doc.musicTrack])
      : Promise.resolve(new Map<string, MusicLite>()),
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
export async function recordStoryView(
  storyId: string,
  viewerId: string,
): Promise<{ viewsCount: number }> {
  if (!mongoose.isValidObjectId(storyId)) {
    throw new HttpError(400, 'Invalid story id', 'INVALID_STORY_ID');
  }

  const now = new Date();
  const story = await StoryModel.findOne(
    { _id: storyId, expiresAt: { $gt: now } },
    { author: 1, viewsCount: 1 },
  ).lean() as { _id: mongoose.Types.ObjectId; author: mongoose.Types.ObjectId; viewsCount?: number } | null;

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
    const updated = await StoryModel.findByIdAndUpdate(
      storyId,
      { $inc: { viewsCount: 1 } },
      { new: true, select: 'viewsCount' },
    ).lean() as { viewsCount?: number } | null;

    return { viewsCount: updated?.viewsCount ?? 0 };
  } catch (err: unknown) {
    // Duplicate key = viewer already recorded — return current count
    if (
      err instanceof Error &&
      'code' in err &&
      (err as { code: number }).code === 11000
    ) {
      return { viewsCount: story.viewsCount ?? 0 };
    }
    throw err;
  }
}

/**
 * Delete the caller's own story.
 * `DELETE /api/v1/stories/:storyId`
 */
export async function deleteStory(
  userId: string,
  storyId: string,
): Promise<void> {
  if (!mongoose.isValidObjectId(storyId)) {
    throw new HttpError(400, 'Invalid story id', 'INVALID_STORY_ID');
  }
  const doc = await StoryModel.findById(storyId).select('author').lean() as
    | { author: Types.ObjectId }
    | null;
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

export type StoryViewerDto = {
  id: string;
  username: string;
  fullName: string | null;
  avatarUrl: string | null;
  viewedAt: string;
};

/**
 * List distinct viewers of a story — only the story author may call this.
 */
export async function getStoryViewers(
  storyId: string,
  requesterId: string,
): Promise<{ viewers: StoryViewerDto[] }> {
  if (!mongoose.isValidObjectId(storyId)) {
    throw new HttpError(400, 'Invalid story id', 'INVALID_STORY_ID');
  }

  const story = await StoryModel.findById(storyId)
    .select('author')
    .lean() as { author: Types.ObjectId } | null;

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
  const users = await UserModel.find(
    { _id: { $in: viewerIds } },
    { username: 1, fullName: 1, avatarUrl: 1 },
  )
    .lean()
    .exec();

  const userMap = new Map(
    users.map(u => [u._id.toString(), u]),
  );

  const viewers: StoryViewerDto[] = views
    .map(v => {
      const u = userMap.get(v.viewer.toString());
      if (!u) return null;
      return {
        id: u._id.toString(),
        username: (u as { username?: string }).username ?? '',
        fullName: (u as { fullName?: string | null }).fullName ?? null,
        avatarUrl: (u as { avatarUrl?: string | null }).avatarUrl ?? null,
        viewedAt: v.createdAt.toISOString(),
      };
    })
    .filter((x): x is StoryViewerDto => x !== null);

  return { viewers };
}

// ─── Story Reactions ─────────────────────────────────────────────────────────

export type ReactionCountDto = {
  reaction: ReactionType;
  count: number;
};

export type StoryReactionsDto = {
  counts: ReactionCountDto[];
  viewerReaction: ReactionType | null;
};

/**
 * Add or change the viewer's reaction on a story (one per user).
 * If `reaction` is the same as the existing one, remove it (toggle off).
 */
export async function reactToStory(
  storyId: string,
  userId: string,
  reaction: ReactionType,
): Promise<{ viewerReaction: ReactionType | null }> {
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
  }).lean() as { reaction: ReactionType } | null;

  if (existing?.reaction === reaction) {
    // Toggle off — remove reaction
    await StoryReactionModel.deleteOne({ story: storyId, user: userId });
    return { viewerReaction: null };
  }

  // Upsert the reaction
  await StoryReactionModel.findOneAndUpdate(
    { story: new mongoose.Types.ObjectId(storyId), user: new mongoose.Types.ObjectId(userId) },
    { reaction },
    { upsert: true, new: true },
  );

  // Notify the story owner. Collapsible per (recipient, actor, story) so
  // changing the reaction bumps the single row instead of spamming.
  void (async () => {
    try {
      const story = (await StoryModel.findById(storyId)
        .select('author')
        .lean()) as { author: Types.ObjectId } | null;
      const ownerId = story?.author?.toString();
      if (!ownerId || ownerId === userId) return;
      const reactor = await UserModel.findById(userId)
        .select('fullName username')
        .lean<{
          fullName: string | null;
          username: string;
        }>();
      const name =
        reactor?.fullName?.trim() ||
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      console.warn('[story] reaction push dispatch failed:', msg);
    }
  })();

  return { viewerReaction: reaction };
}

/**
 * Get aggregated reaction counts for a story + the viewer's own reaction.
 */
export async function getStoryReactions(
  storyId: string,
  viewerId: string,
): Promise<StoryReactionsDto> {
  if (!mongoose.isValidObjectId(storyId)) {
    throw new HttpError(400, 'Invalid story id', 'INVALID_STORY_ID');
  }

  const [countsRaw, viewerDoc] = await Promise.all([
    StoryReactionModel.aggregate<{ _id: string; count: number }>([
      { $match: { story: new mongoose.Types.ObjectId(storyId) } },
      { $group: { _id: '$reaction', count: { $sum: 1 } } },
    ]),
    StoryReactionModel.findOne({ story: storyId, user: viewerId })
      .select('reaction')
      .lean() as Promise<{ reaction: ReactionType } | null>,
  ]);

  const counts: ReactionCountDto[] = countsRaw.map(r => ({
    reaction: r._id as ReactionType,
    count: r.count,
  }));

  return {
    counts,
    viewerReaction: viewerDoc?.reaction ?? null,
  };
}
