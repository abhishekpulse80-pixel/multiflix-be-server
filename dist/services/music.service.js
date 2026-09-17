import mongoose from 'mongoose';
import { HttpError } from '../lib/httpError.js';
import { ArtistModel } from '../models/artist.model.js';
import { MusicAlbumModel } from '../models/musicAlbum.model.js';
import { MusicTrackModel } from '../models/musicTrack.model.js';
import { MusicTrackFavouriteModel } from '../models/musicTrackFavourite.model.js';
function isDuplicateKeyError(err) {
    return (typeof err === 'object' &&
        err !== null &&
        err.code === 11000);
}
function assertAlbumObjectId(id) {
    if (!mongoose.isValidObjectId(id)) {
        throw new HttpError(400, 'Invalid album id', 'INVALID_ALBUM_ID');
    }
}
function assertTrackObjectId(id) {
    if (!mongoose.isValidObjectId(id)) {
        throw new HttpError(400, 'Invalid track id', 'INVALID_TRACK_ID');
    }
}
function assertArtistObjectId(id) {
    if (!mongoose.isValidObjectId(id)) {
        throw new HttpError(400, 'Invalid artist id', 'INVALID_ARTIST_ID');
    }
}
function artistInfoFromLean(a) {
    if (!a) {
        return null;
    }
    return {
        id: String(a._id),
        name: a.name,
        profileImageUrl: a.profileImageUrl ?? null,
    };
}
async function getFavouritedTrackIdSet(viewerUserId, trackIds) {
    if (!viewerUserId ||
        !mongoose.isValidObjectId(viewerUserId) ||
        trackIds.length === 0) {
        return new Set();
    }
    const rows = (await MusicTrackFavouriteModel.find({
        user: viewerUserId,
        track: { $in: trackIds },
    })
        .select('track')
        .lean());
    return new Set(rows.map((r) => String(r.track)));
}
/** Strip internal seed marker from stream URLs (same idea as blog video URLs). */
export function playbackMusicAudioUrl(raw) {
    try {
        const u = new URL(raw);
        u.searchParams.delete('__seed_music__');
        return u.toString();
    }
    catch {
        return raw;
    }
}
function toIso(d) {
    if (!d) {
        return null;
    }
    return d.toISOString();
}
function trackToDto(doc, artist, favouritedByViewer) {
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
        audioProcessingStatus: doc.audioProcessingStatus ?? 'not_required',
        audioVariants: doc.audioVariants ?? [],
        audioProcessingError: doc.audioProcessingError ?? null,
        favouritedByViewer,
    };
}
export async function listPublishedMusicAlbums(query) {
    const skip = query.page * query.limit;
    const rows = await MusicAlbumModel.find({ status: 'published' })
        .sort({ sortOrder: 1, _id: 1 })
        .skip(skip)
        .limit(query.limit)
        .select('title coverArtUrl featured')
        .lean();
    const items = rows.map((a) => ({
        id: String(a._id),
        title: a.title,
        coverArtUrl: a.coverArtUrl,
        featured: a.featured,
    }));
    return { items };
}
export async function listRecommendedMusicTracks(query, viewerUserId) {
    const skip = query.page * query.limit;
    const rows = await MusicTrackModel.find({ status: 'published' })
        .populate({ path: 'artist', select: 'name profileImageUrl' })
        .populate({ path: 'album', select: 'status' })
        .sort({ streamsCount: -1, _id: 1 })
        .skip(skip)
        .limit(query.limit)
        .lean();
    const kept = [];
    for (const t of rows) {
        const album = t.album;
        // If track is on an album, the album must be published.
        if (album && album.status !== 'published') {
            continue;
        }
        const artist = t.artist ?? null;
        kept.push({ doc: t, artist });
    }
    const favSet = await getFavouritedTrackIdSet(viewerUserId, kept.map((k) => k.doc._id));
    const items = kept.map(({ doc, artist }) => trackToDto({
        _id: doc._id,
        album: doc.album,
        title: doc.title,
        artUrl: doc.artUrl,
        audioUrl: doc.audioUrl,
        streamsCount: doc.streamsCount,
        durationSeconds: doc.durationSeconds ?? null,
    }, artist, favSet.has(String(doc._id))));
    return { items };
}
/**
 * Single track by id, with the viewer's favourite flag. Authoritative source
 * for the Now Playing heart regardless of which list the track was opened
 * from (favourites pagination, recommended, search, etc.).
 * `GET /music/tracks/:trackId`
 */
export async function getMusicTrackById(trackId, viewerUserId) {
    if (!mongoose.isValidObjectId(trackId)) {
        throw new HttpError(400, 'Invalid track id', 'INVALID_TRACK_ID');
    }
    const doc = await MusicTrackModel.findById(trackId)
        .populate({ path: 'artist', select: 'name profileImageUrl' })
        .lean();
    if (!doc) {
        throw new HttpError(404, 'Track not found', 'TRACK_NOT_FOUND');
    }
    const artist = doc.artist ?? null;
    const favSet = await getFavouritedTrackIdSet(viewerUserId, [doc._id]);
    const track = trackToDto({
        _id: doc._id,
        album: doc.album,
        title: doc.title,
        artUrl: doc.artUrl,
        audioUrl: doc.audioUrl,
        streamsCount: doc.streamsCount,
        durationSeconds: doc.durationSeconds ?? null,
    }, artist, favSet.has(String(doc._id)));
    return { track };
}
/**
 * Case-insensitive search across published tracks + albums.
 * Matches on title or artist name. Same `limit` applies to each list.
 */
export async function searchMusic(query, viewerUserId) {
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
    const albums = albumRows.map((a) => ({
        id: String(a._id),
        title: a.title,
        coverArtUrl: a.coverArtUrl,
        featured: a.featured,
    }));
    const keptTracks = [];
    for (const t of trackRows) {
        const album = t.album;
        if (album && album.status !== 'published')
            continue;
        const artist = t.artist ?? null;
        keptTracks.push({ doc: t, artist });
    }
    const favSet = await getFavouritedTrackIdSet(viewerUserId, keptTracks.map((k) => k.doc._id));
    const tracks = keptTracks.map(({ doc, artist }) => trackToDto({
        _id: doc._id,
        album: doc.album,
        title: doc.title,
        artUrl: doc.artUrl,
        audioUrl: doc.audioUrl,
        streamsCount: doc.streamsCount,
        durationSeconds: doc.durationSeconds ?? null,
    }, artist, favSet.has(String(doc._id))));
    return { tracks, albums };
}
export async function getPublishedMusicAlbumById(albumId, viewerUserId) {
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
    const albumArtist = album.artist ?? null;
    const trackDocs = await MusicTrackModel.find({
        album: album._id,
        status: 'published',
    })
        .populate({ path: 'artist', select: 'name profileImageUrl' })
        .sort({ sortOrder: 1, _id: 1 })
        .lean();
    const favSet = await getFavouritedTrackIdSet(viewerUserId, trackDocs.map((d) => d._id));
    const tracks = trackDocs.map((doc) => {
        const trackArtist = doc.artist ?? null;
        return trackToDto({
            _id: doc._id,
            album: doc.album,
            title: doc.title,
            artUrl: doc.artUrl,
            audioUrl: doc.audioUrl,
            streamsCount: doc.streamsCount,
            durationSeconds: doc.durationSeconds ?? null,
        }, trackArtist, favSet.has(String(doc._id)));
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
/** Public horizontal-scroll source for the Music tab (between Trending and Recommend). */
export async function listPublishedArtists(query) {
    const skip = query.page * query.limit;
    const rows = await ArtistModel.find({ status: 'published' })
        .sort({ sortOrder: 1, _id: 1 })
        .skip(skip)
        .limit(query.limit)
        .select('name profileImageUrl')
        .lean();
    const items = rows.map((a) => ({
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
export async function getPublishedArtistById(artistId, viewerUserId) {
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
    const albums = albumRows.map((a) => ({
        id: String(a._id),
        title: a.title,
        coverArtUrl: a.coverArtUrl,
        featured: a.featured,
    }));
    const keptTracks = [];
    for (const t of trackRows) {
        const album = t.album;
        if (album && album.status !== 'published')
            continue;
        const trackArtist = t.artist ?? null;
        keptTracks.push({ doc: t, artist: trackArtist });
    }
    const favSet = await getFavouritedTrackIdSet(viewerUserId, keptTracks.map((k) => k.doc._id));
    const tracks = keptTracks.map(({ doc, artist: a }) => trackToDto({
        _id: doc._id,
        album: doc.album,
        title: doc.title,
        artUrl: doc.artUrl,
        audioUrl: doc.audioUrl,
        streamsCount: doc.streamsCount,
        durationSeconds: doc.durationSeconds ?? null,
    }, a, favSet.has(String(doc._id))));
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
export async function recordMusicTrackPlay(trackId) {
    assertTrackObjectId(trackId);
    const doc = await MusicTrackModel.findOneAndUpdate({ _id: trackId, status: 'published' }, { $inc: { streamsCount: 1 } }, { new: true, projection: { streamsCount: 1 } }).lean();
    if (!doc) {
        throw new HttpError(404, 'Track not found', 'TRACK_NOT_FOUND');
    }
    return { streamsCount: doc.streamsCount };
}
/** Toggle favourite on a track. Idempotent. */
export async function setMusicTrackFavourite(userId, trackId, favourited) {
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
        }
        catch (err) {
            if (!isDuplicateKeyError(err)) {
                throw err;
            }
        }
    }
    else {
        await MusicTrackFavouriteModel.deleteOne({
            user: userId,
            track: trackId,
        });
    }
    return { favourited };
}
/** Paginated list of the viewer's favourited tracks, most-recent first. */
export async function listMusicFavourites(userId, query) {
    if (!mongoose.isValidObjectId(userId)) {
        throw new HttpError(400, 'Invalid user id', 'INVALID_USER_ID');
    }
    const skip = query.page * query.limit;
    const favRows = (await MusicTrackFavouriteModel.find({ user: userId })
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(query.limit)
        .select('track createdAt')
        .lean());
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
    const docsById = new Map();
    for (const d of trackDocs) {
        docsById.set(String(d._id), d);
    }
    const items = [];
    for (const fav of favRows) {
        const doc = docsById.get(String(fav.track));
        if (!doc) {
            continue;
        }
        const album = doc.album;
        if (album && album.status !== 'published') {
            continue;
        }
        const artist = doc.artist ?? null;
        items.push(trackToDto({
            _id: doc._id,
            album: doc.album,
            title: doc.title,
            artUrl: doc.artUrl,
            audioUrl: doc.audioUrl,
            streamsCount: doc.streamsCount,
            durationSeconds: doc.durationSeconds ?? null,
        }, artist, true));
    }
    return { items };
}
