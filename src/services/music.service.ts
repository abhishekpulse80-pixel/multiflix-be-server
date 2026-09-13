import mongoose, { type Types } from 'mongoose';
import { HttpError } from '../lib/httpError.js';
import { ArtistModel } from '../models/artist.model.js';
import { MusicAlbumModel } from '../models/musicAlbum.model.js';
import { MusicTrackModel } from '../models/musicTrack.model.js';
import { MusicTrackFavouriteModel } from '../models/musicTrackFavourite.model.js';
import type {
  MusicListQuery,
  MusicSearchQuery,
} from '../schemas/music.schemas.js';

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: number }).code === 11000
  );
}

export type MusicArtistInfoDto = {
  id: string;
  name: string;
  profileImageUrl: string | null;
};

export type MusicAlbumListItemDto = {
  id: string;
  title: string;
  coverArtUrl: string;
  featured: boolean;
};

export type MusicTrackPublicDto = {
  id: string;
  albumId: string;
  title: string;
  artUrl: string;
  audioUrl: string;
  streamsCount: number;
  /** Denormalised artist name (kept for older clients). */
  artistName: string;
  /** Full artist block — Subtask 2. Tap-target for ArtistProfile screen. */
  artist: MusicArtistInfoDto | null;
  durationSeconds: number | null;
  favouritedByViewer: boolean;
};

export type MusicAlbumDetailDto = {
  id: string;
  title: string;
  coverArtUrl: string;
  featured: boolean;
  /** Denormalised artist name (kept for older clients). */
  artistName: string;
  artistBio: string | null;
  artistProfileImageUrl: string | null;
  artistEmail: string | null;
  membership: string | null;
  /** Full artist block — Subtask 2. */
  artist: MusicArtistInfoDto | null;
  publishedAt: string | null;
  tracks: MusicTrackPublicDto[];
};

export type MusicAlbumListResponse = {
  items: MusicAlbumListItemDto[];
};

export type MusicTrackListResponse = {
  items: MusicTrackPublicDto[];
};

export type MusicTrackDetailResponse = {
  track: MusicTrackPublicDto;
};

type ArtistLean = {
  _id: Types.ObjectId;
  name: string;
  profileImageUrl: string | null;
  bio?: string | null;
};

function assertAlbumObjectId(id: string): void {
  if (!mongoose.isValidObjectId(id)) {
    throw new HttpError(400, 'Invalid album id', 'INVALID_ALBUM_ID');
  }
}

function assertTrackObjectId(id: string): void {
  if (!mongoose.isValidObjectId(id)) {
    throw new HttpError(400, 'Invalid track id', 'INVALID_TRACK_ID');
  }
}

function assertArtistObjectId(id: string): void {
  if (!mongoose.isValidObjectId(id)) {
    throw new HttpError(400, 'Invalid artist id', 'INVALID_ARTIST_ID');
  }
}

function artistInfoFromLean(a: ArtistLean | null): MusicArtistInfoDto | null {
  if (!a) {
    return null;
  }
  return {
    id: String(a._id),
    name: a.name,
    profileImageUrl: a.profileImageUrl ?? null,
  };
}

async function getFavouritedTrackIdSet(
  viewerUserId: string | null | undefined,
  trackIds: Types.ObjectId[],
): Promise<Set<string>> {
  if (
    !viewerUserId ||
    !mongoose.isValidObjectId(viewerUserId) ||
    trackIds.length === 0
  ) {
    return new Set();
  }
  type FavLean = { track: Types.ObjectId };
  const rows = (await MusicTrackFavouriteModel.find({
    user: viewerUserId,
    track: { $in: trackIds },
  })
    .select('track')
    .lean()) as FavLean[];
  return new Set(rows.map((r) => String(r.track)));
}

/** Strip internal seed marker from stream URLs (same idea as blog video URLs). */
export function playbackMusicAudioUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.searchParams.delete('__seed_music__');
    return u.toString();
  } catch {
    return raw;
  }
}

function toIso(d: Date | null | undefined): string | null {
  if (!d) {
    return null;
  }
  return d.toISOString();
}

function trackToDto(
  doc: {
    _id: Types.ObjectId;
    album: Types.ObjectId | null;
    title: string;
    artUrl: string;
    audioUrl: string;
    streamsCount: number;
    durationSeconds: number | null;
  },
  artist: ArtistLean | null,
  favouritedByViewer: boolean,
): MusicTrackPublicDto {
  return {
    id: String(doc._id),
    albumId: doc.album ? String(doc.album) : '',
    title: doc.title,
    artUrl: doc.artUrl,
    audioUrl: playbackMusicAudioUrl(doc.audioUrl),
    streamsCount: doc.streamsCount,
    artistName: artist?.name ?? '',
    artist: artistInfoFromLean(artist),
    durationSeconds: doc.durationSeconds,
    favouritedByViewer,
  };
}

export async function listPublishedMusicAlbums(
  query: MusicListQuery,
): Promise<MusicAlbumListResponse> {
  const skip = query.page * query.limit;
  const rows = await MusicAlbumModel.find({ status: 'published' })
    .sort({ sortOrder: 1, _id: 1 })
    .skip(skip)
    .limit(query.limit)
    .select('title coverArtUrl featured')
    .lean();

  const items: MusicAlbumListItemDto[] = rows.map((a) => ({
    id: String(a._id),
    title: a.title,
    coverArtUrl: a.coverArtUrl,
    featured: a.featured,
  }));

  return { items };
}

export async function listRecommendedMusicTracks(
  query: MusicListQuery,
  viewerUserId?: string | null,
): Promise<MusicTrackListResponse> {
  const skip = query.page * query.limit;
  const rows = await MusicTrackModel.find({ status: 'published' })
    .populate({ path: 'artist', select: 'name profileImageUrl' })
    .populate({ path: 'album', select: 'status' })
    .sort({ streamsCount: -1, _id: 1 })
    .skip(skip)
    .limit(query.limit)
    .lean();

  const kept: Array<{
    doc: (typeof rows)[number];
    artist: ArtistLean | null;
  }> = [];
  for (const t of rows) {
    const album = t.album as unknown as
      | { _id: Types.ObjectId; status: string }
      | null;
    // If track is on an album, the album must be published.
    if (album && album.status !== 'published') {
      continue;
    }
    const artist = (t.artist as unknown as ArtistLean | null) ?? null;
    kept.push({ doc: t, artist });
  }

  const favSet = await getFavouritedTrackIdSet(
    viewerUserId,
    kept.map((k) => k.doc._id),
  );

  const items: MusicTrackPublicDto[] = kept.map(({ doc, artist }) =>
    trackToDto(
      {
        _id: doc._id,
        album: doc.album as Types.ObjectId | null,
        title: doc.title,
        artUrl: doc.artUrl,
        audioUrl: doc.audioUrl,
        streamsCount: doc.streamsCount,
        durationSeconds: doc.durationSeconds ?? null,
      },
      artist,
      favSet.has(String(doc._id)),
    ),
  );

  return { items };
}

/**
 * Single track by id, with the viewer's favourite flag. Authoritative source
 * for the Now Playing heart regardless of which list the track was opened
 * from (favourites pagination, recommended, search, etc.).
 * `GET /music/tracks/:trackId`
 */
export async function getMusicTrackById(
  trackId: string,
  viewerUserId?: string | null,
): Promise<MusicTrackDetailResponse> {
  if (!mongoose.isValidObjectId(trackId)) {
    throw new HttpError(400, 'Invalid track id', 'INVALID_TRACK_ID');
  }
  const doc = await MusicTrackModel.findById(trackId)
    .populate({ path: 'artist', select: 'name profileImageUrl' })
    .lean();
  if (!doc) {
    throw new HttpError(404, 'Track not found', 'TRACK_NOT_FOUND');
  }
  const artist = (doc.artist as unknown as ArtistLean | null) ?? null;
  const favSet = await getFavouritedTrackIdSet(viewerUserId, [doc._id]);
  const track = trackToDto(
    {
      _id: doc._id,
      album: doc.album as Types.ObjectId | null,
      title: doc.title,
      artUrl: doc.artUrl,
      audioUrl: doc.audioUrl,
      streamsCount: doc.streamsCount,
      durationSeconds: doc.durationSeconds ?? null,
    },
    artist,
    favSet.has(String(doc._id)),
  );
  return { track };
}

/** `GET /music/search` response shape. */
export type MusicSearchResponse = {
  tracks: MusicTrackPublicDto[];
  albums: MusicAlbumListItemDto[];
};

/**
 * Case-insensitive search across published tracks + albums.
 * Matches on title or artist name. Same `limit` applies to each list.
 */
export async function searchMusic(
  query: MusicSearchQuery,
  viewerUserId?: string | null,
): Promise<MusicSearchResponse> {
  const escaped = query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escaped, 'i');

  const matchingArtists = await ArtistModel.find({ name: regex })
    .select('_id')
    .lean();
  const matchingArtistIds = matchingArtists.map((a) => a._id);

  const [albumRows, trackRows] = await Promise.all([
    MusicAlbumModel.find({
      status: 'published',
      $or: [{ title: regex }, { artist: { $in: matchingArtistIds } }],
    })
      .sort({ sortOrder: 1, _id: 1 })
      .limit(query.limit)
      .select('title coverArtUrl featured')
      .lean(),
    MusicTrackModel.find({
      status: 'published',
      $or: [{ title: regex }, { artist: { $in: matchingArtistIds } }],
    })
      .populate({ path: 'artist', select: 'name profileImageUrl' })
      .populate({ path: 'album', select: 'status' })
      .sort({ streamsCount: -1, _id: 1 })
      .limit(query.limit)
      .lean(),
  ]);

  const albums: MusicAlbumListItemDto[] = albumRows.map((a) => ({
    id: String(a._id),
    title: a.title,
    coverArtUrl: a.coverArtUrl,
    featured: a.featured,
  }));

  const keptTracks: Array<{
    doc: (typeof trackRows)[number];
    artist: ArtistLean | null;
  }> = [];
  for (const t of trackRows) {
    const album = t.album as unknown as
      | { _id: Types.ObjectId; status: string }
      | null;
    if (album && album.status !== 'published') continue;
    const artist = (t.artist as unknown as ArtistLean | null) ?? null;
    keptTracks.push({ doc: t, artist });
  }

  const favSet = await getFavouritedTrackIdSet(
    viewerUserId,
    keptTracks.map((k) => k.doc._id),
  );

  const tracks: MusicTrackPublicDto[] = keptTracks.map(({ doc, artist }) =>
    trackToDto(
      {
        _id: doc._id,
        album: doc.album as Types.ObjectId | null,
        title: doc.title,
        artUrl: doc.artUrl,
        audioUrl: doc.audioUrl,
        streamsCount: doc.streamsCount,
        durationSeconds: doc.durationSeconds ?? null,
      },
      artist,
      favSet.has(String(doc._id)),
    ),
  );

  return { tracks, albums };
}

export async function getPublishedMusicAlbumById(
  albumId: string,
  viewerUserId?: string | null,
): Promise<MusicAlbumDetailDto> {
  assertAlbumObjectId(albumId);
  const album = await MusicAlbumModel.findOne({
    _id: albumId,
    status: 'published',
  })
    .populate({ path: 'artist', select: 'name profileImageUrl bio' })
    .select('title coverArtUrl featured artist publishedAt')
    .lean();

  if (!album) {
    throw new HttpError(404, 'Album not found', 'ALBUM_NOT_FOUND');
  }

  const albumArtist = (album.artist as unknown as ArtistLean | null) ?? null;

  const trackDocs = await MusicTrackModel.find({
    album: album._id,
    status: 'published',
  })
    .populate({ path: 'artist', select: 'name profileImageUrl' })
    .sort({ sortOrder: 1, _id: 1 })
    .lean();

  const favSet = await getFavouritedTrackIdSet(
    viewerUserId,
    trackDocs.map((d) => d._id),
  );

  const tracks = trackDocs.map((doc) => {
    const trackArtist = (doc.artist as unknown as ArtistLean | null) ?? null;
    return trackToDto(
      {
        _id: doc._id,
        album: doc.album,
        title: doc.title,
        artUrl: doc.artUrl,
        audioUrl: doc.audioUrl,
        streamsCount: doc.streamsCount,
        durationSeconds: doc.durationSeconds ?? null,
      },
      trackArtist,
      favSet.has(String(doc._id)),
    );
  });

  return {
    id: String(album._id),
    title: album.title,
    coverArtUrl: album.coverArtUrl,
    featured: album.featured,
    artistName: albumArtist?.name ?? '',
    artistBio: albumArtist?.bio ?? null,
    artistProfileImageUrl: albumArtist?.profileImageUrl ?? null,
    artistEmail: null,
    membership: null,
    artist: artistInfoFromLean(albumArtist),
    publishedAt: toIso(album.publishedAt),
    tracks,
  };
}

export type MusicArtistListItemDto = {
  id: string;
  name: string;
  profileImageUrl: string | null;
};

export type MusicArtistListResponse = {
  items: MusicArtistListItemDto[];
};

export type MusicArtistDetailDto = {
  id: string;
  name: string;
  bio: string | null;
  profileImageUrl: string | null;
  albums: MusicAlbumListItemDto[];
  tracks: MusicTrackPublicDto[];
};

/** Public horizontal-scroll source for the Music tab (between Trending and Recommend). */
export async function listPublishedArtists(
  query: MusicListQuery,
): Promise<MusicArtistListResponse> {
  const skip = query.page * query.limit;
  const rows = await ArtistModel.find({ status: 'published' })
    .sort({ sortOrder: 1, _id: 1 })
    .skip(skip)
    .limit(query.limit)
    .select('name profileImageUrl')
    .lean();

  const items: MusicArtistListItemDto[] = rows.map((a) => ({
    id: String(a._id),
    name: a.name,
    profileImageUrl: a.profileImageUrl ?? null,
  }));

  return { items };
}

/**
 * Public artist profile: artist info + their published albums + their
 * published tracks (most-streamed first). Backs the mobile ArtistProfile
 * screen (Subtask 5).
 */
export async function getPublishedArtistById(
  artistId: string,
  viewerUserId?: string | null,
): Promise<MusicArtistDetailDto> {
  assertArtistObjectId(artistId);
  const artist = await ArtistModel.findOne({
    _id: artistId,
    status: 'published',
  })
    .select('name bio profileImageUrl')
    .lean();
  if (!artist) {
    throw new HttpError(404, 'Artist not found', 'ARTIST_NOT_FOUND');
  }

  const [albumRows, trackRows] = await Promise.all([
    MusicAlbumModel.find({ artist: artist._id, status: 'published' })
      .sort({ sortOrder: 1, _id: 1 })
      .select('title coverArtUrl featured')
      .lean(),
    MusicTrackModel.find({ artist: artist._id, status: 'published' })
      .populate({ path: 'artist', select: 'name profileImageUrl' })
      .populate({ path: 'album', select: 'status' })
      .sort({ streamsCount: -1, _id: 1 })
      .limit(50)
      .lean(),
  ]);

  const albums: MusicAlbumListItemDto[] = albumRows.map((a) => ({
    id: String(a._id),
    title: a.title,
    coverArtUrl: a.coverArtUrl,
    featured: a.featured,
  }));

  const keptTracks: Array<{
    doc: (typeof trackRows)[number];
    artist: ArtistLean | null;
  }> = [];
  for (const t of trackRows) {
    const album = t.album as unknown as
      | { _id: Types.ObjectId; status: string }
      | null;
    if (album && album.status !== 'published') continue;
    const trackArtist = (t.artist as unknown as ArtistLean | null) ?? null;
    keptTracks.push({ doc: t, artist: trackArtist });
  }

  const favSet = await getFavouritedTrackIdSet(
    viewerUserId,
    keptTracks.map((k) => k.doc._id),
  );

  const tracks: MusicTrackPublicDto[] = keptTracks.map(({ doc, artist: a }) =>
    trackToDto(
      {
        _id: doc._id,
        album: doc.album as Types.ObjectId | null,
        title: doc.title,
        artUrl: doc.artUrl,
        audioUrl: doc.audioUrl,
        streamsCount: doc.streamsCount,
        durationSeconds: doc.durationSeconds ?? null,
      },
      a,
      favSet.has(String(doc._id)),
    ),
  );

  return {
    id: String(artist._id),
    name: artist.name,
    bio: artist.bio ?? null,
    profileImageUrl: artist.profileImageUrl ?? null,
    albums,
    tracks,
  };
}

/**
 * Increment a track's stream count by 1 (called by the client after ~3s of playback).
 * Returns the updated count.
 */
export async function recordMusicTrackPlay(
  trackId: string,
): Promise<{ streamsCount: number }> {
  assertTrackObjectId(trackId);
  const doc = await MusicTrackModel.findOneAndUpdate(
    { _id: trackId, status: 'published' },
    { $inc: { streamsCount: 1 } },
    { new: true, projection: { streamsCount: 1 } },
  ).lean();

  if (!doc) {
    throw new HttpError(404, 'Track not found', 'TRACK_NOT_FOUND');
  }

  return { streamsCount: doc.streamsCount };
}

/** Toggle favourite on a track. Idempotent. */
export async function setMusicTrackFavourite(
  userId: string,
  trackId: string,
  favourited: boolean,
): Promise<{ favourited: boolean }> {
  assertTrackObjectId(trackId);
  if (!mongoose.isValidObjectId(userId)) {
    throw new HttpError(400, 'Invalid user id', 'INVALID_USER_ID');
  }

  const trackExists = await MusicTrackModel.exists({
    _id: trackId,
    status: 'published',
  });
  if (!trackExists) {
    throw new HttpError(404, 'Track not found', 'TRACK_NOT_FOUND');
  }

  if (favourited) {
    try {
      await MusicTrackFavouriteModel.create({ user: userId, track: trackId });
    } catch (err: unknown) {
      if (!isDuplicateKeyError(err)) {
        throw err;
      }
    }
  } else {
    await MusicTrackFavouriteModel.deleteOne({
      user: userId,
      track: trackId,
    });
  }

  return { favourited };
}

/** Paginated list of the viewer's favourited tracks, most-recent first. */
export async function listMusicFavourites(
  userId: string,
  query: MusicListQuery,
): Promise<MusicTrackListResponse> {
  if (!mongoose.isValidObjectId(userId)) {
    throw new HttpError(400, 'Invalid user id', 'INVALID_USER_ID');
  }

  const skip = query.page * query.limit;
  type FavLean = { track: Types.ObjectId; createdAt: Date };
  const favRows = (await MusicTrackFavouriteModel.find({ user: userId })
    .sort({ createdAt: -1, _id: -1 })
    .skip(skip)
    .limit(query.limit)
    .select('track createdAt')
    .lean()) as FavLean[];

  if (favRows.length === 0) {
    return { items: [] };
  }

  const trackIds = favRows.map((f) => f.track);
  const trackDocs = await MusicTrackModel.find({
    _id: { $in: trackIds },
    status: 'published',
  })
    .populate({ path: 'artist', select: 'name profileImageUrl' })
    .populate({ path: 'album', select: 'status' })
    .lean();

  // Preserve the favourited-order (most recent first) from favRows.
  const docsById = new Map<string, (typeof trackDocs)[number]>();
  for (const d of trackDocs) {
    docsById.set(String(d._id), d);
  }

  const items: MusicTrackPublicDto[] = [];
  for (const fav of favRows) {
    const doc = docsById.get(String(fav.track));
    if (!doc) {
      continue;
    }
    const album = doc.album as unknown as
      | { _id: Types.ObjectId; status: string }
      | null;
    if (album && album.status !== 'published') {
      continue;
    }
    const artist = (doc.artist as unknown as ArtistLean | null) ?? null;
    items.push(
      trackToDto(
        {
          _id: doc._id,
          album: doc.album as Types.ObjectId | null,
          title: doc.title,
          artUrl: doc.artUrl,
          audioUrl: doc.audioUrl,
          streamsCount: doc.streamsCount,
          durationSeconds: doc.durationSeconds ?? null,
        },
        artist,
        true,
      ),
    );
  }

  return { items };
}
