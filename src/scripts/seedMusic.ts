import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import { ArtistModel, type IArtist } from '../models/artist.model.js';
import type { IMusicAlbum } from '../models/musicAlbum.model.js';
import { MusicAlbumModel } from '../models/musicAlbum.model.js';
import type { IMusicTrack } from '../models/musicTrack.model.js';
import { MusicTrackModel } from '../models/musicTrack.model.js';

/** Re-seed idempotently: only documents with this prefix are removed. */
const SEED_KEY_PREFIX = 'v1:';

const art = (id: string) =>
  `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=240&q=80`;
const albumArt = (id: string) =>
  `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=400&q=80`;
const profileArt = (id: string) =>
  `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=360&q=80`;

/** Royalty-free sample MP3s (public demos). */
const SAMPLE_MP3 = [
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-7.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-9.mp3',
] as const;

type ArtistBlueprint = Omit<IArtist, 'createdAt' | 'updatedAt'>;

const ARTIST_BLUEPRINTS: ArtistBlueprint[] = [
  {
    name: 'Sarwar Jahan',
    bio: 'Love Music and I am not an Musician .',
    profileImageUrl: profileArt('1560250097-9b9350f76eae'),
    status: 'published',
    sortOrder: 0,
    seedKey: `${SEED_KEY_PREFIX}artist:sarwar-jahan`,
  },
];

type AlbumBlueprint = Omit<IMusicAlbum, 'createdAt' | 'updatedAt'>;

type AlbumBlueprintRow = Omit<AlbumBlueprint, 'artist'> & {
  artistSeedKey: string;
};

const ALBUM_BLUEPRINTS: AlbumBlueprintRow[] = [
  {
    title: 'The triangle',
    coverArtUrl: albumArt('1557672172-298e090bd0f1'),
    featured: false,
    artistSeedKey: `${SEED_KEY_PREFIX}artist:sarwar-jahan`,
    status: 'published',
    publishedAt: new Date('2026-01-10T12:00:00.000Z'),
    sortOrder: 0,
    seedKey: `${SEED_KEY_PREFIX}album:triangle`,
  },
  {
    title: 'Dune Of Visa',
    coverArtUrl: albumArt('1614146169518-8877aa79594a'),
    featured: true,
    artistSeedKey: `${SEED_KEY_PREFIX}artist:sarwar-jahan`,
    status: 'published',
    publishedAt: new Date('2026-01-15T14:00:00.000Z'),
    sortOrder: 1,
    seedKey: `${SEED_KEY_PREFIX}album:dune`,
  },
  {
    title: 'Riskitall',
    coverArtUrl: albumArt('1511671782779-c831b6a0d9c9'),
    featured: false,
    artistSeedKey: `${SEED_KEY_PREFIX}artist:sarwar-jahan`,
    status: 'published',
    publishedAt: new Date('2026-01-20T09:30:00.000Z'),
    sortOrder: 2,
    seedKey: `${SEED_KEY_PREFIX}album:riskitall`,
  },
];

type TrackRow = {
  seedKey: string;
  albumSeedKey: string;
  artistSeedKey: string;
  title: string;
  artUrl: string;
  audioSampleIndex: number;
  durationSeconds: number | null;
  streamsCount: number;
  sortOrder: number;
};

/**
 * Rows mirror the RN mock loosely (tracks can repeat per album like the UI mock).
 */
const TRACK_ROWS: TrackRow[] = [
  {
    seedKey: `${SEED_KEY_PREFIX}track:triangle-0`,
    albumSeedKey: `${SEED_KEY_PREFIX}album:triangle`,
    artistSeedKey: `${SEED_KEY_PREFIX}artist:sarwar-jahan`,
    title: 'Take care of you',
    artUrl: art('1529626455594-4ff0802cfb7e'),
    audioSampleIndex: 0,
    durationSeconds: 214,
    streamsCount: 114_000,
    sortOrder: 0,
  },
  {
    seedKey: `${SEED_KEY_PREFIX}track:triangle-1`,
    albumSeedKey: `${SEED_KEY_PREFIX}album:triangle`,
    artistSeedKey: `${SEED_KEY_PREFIX}artist:sarwar-jahan`,
    title: 'The stranger inside you',
    artUrl: art('1618005182384-a83a8bd57fbe'),
    audioSampleIndex: 1,
    durationSeconds: 198,
    streamsCount: 60_500,
    sortOrder: 1,
  },
  {
    seedKey: `${SEED_KEY_PREFIX}track:triangle-2`,
    albumSeedKey: `${SEED_KEY_PREFIX}album:triangle`,
    artistSeedKey: `${SEED_KEY_PREFIX}artist:sarwar-jahan`,
    title: 'Edwall of beauty mind',
    artUrl: art('1557682250-96663c8be802'),
    audioSampleIndex: 2,
    durationSeconds: 245,
    streamsCount: 44_300,
    sortOrder: 2,
  },
  {
    seedKey: `${SEED_KEY_PREFIX}track:dune-0`,
    albumSeedKey: `${SEED_KEY_PREFIX}album:dune`,
    artistSeedKey: `${SEED_KEY_PREFIX}artist:sarwar-jahan`,
    title: 'Ophelia',
    artUrl: art('1514525253161-7a46d19cd819'),
    audioSampleIndex: 3,
    durationSeconds: 268,
    streamsCount: 892_000,
    sortOrder: 0,
  },
  {
    seedKey: `${SEED_KEY_PREFIX}track:dune-1`,
    albumSeedKey: `${SEED_KEY_PREFIX}album:dune`,
    artistSeedKey: `${SEED_KEY_PREFIX}artist:sarwar-jahan`,
    title: 'Take care of you',
    artUrl: art('1529626455594-4ff0802cfb7e'),
    audioSampleIndex: 4,
    durationSeconds: 214,
    streamsCount: 114_000,
    sortOrder: 1,
  },
  {
    seedKey: `${SEED_KEY_PREFIX}track:dune-2`,
    albumSeedKey: `${SEED_KEY_PREFIX}album:dune`,
    artistSeedKey: `${SEED_KEY_PREFIX}artist:sarwar-jahan`,
    title: 'The stranger inside you',
    artUrl: art('1618005182384-a83a8bd57fbe'),
    audioSampleIndex: 5,
    durationSeconds: 198,
    streamsCount: 60_500,
    sortOrder: 2,
  },
  {
    seedKey: `${SEED_KEY_PREFIX}track:risk-0`,
    albumSeedKey: `${SEED_KEY_PREFIX}album:riskitall`,
    artistSeedKey: `${SEED_KEY_PREFIX}artist:sarwar-jahan`,
    title: 'The stranger inside you',
    artUrl: art('1618005182384-a83a8bd57fbe'),
    audioSampleIndex: 6,
    durationSeconds: 198,
    streamsCount: 60_500,
    sortOrder: 0,
  },
  {
    seedKey: `${SEED_KEY_PREFIX}track:risk-1`,
    albumSeedKey: `${SEED_KEY_PREFIX}album:riskitall`,
    artistSeedKey: `${SEED_KEY_PREFIX}artist:sarwar-jahan`,
    title: 'Edwall of beauty mind',
    artUrl: art('1557682250-96663c8be802'),
    audioSampleIndex: 7,
    durationSeconds: 245,
    streamsCount: 44_300,
    sortOrder: 1,
  },
  {
    seedKey: `${SEED_KEY_PREFIX}track:risk-2`,
    albumSeedKey: `${SEED_KEY_PREFIX}album:riskitall`,
    artistSeedKey: `${SEED_KEY_PREFIX}artist:sarwar-jahan`,
    title: 'Coastal pulse',
    artUrl: art('1470225626910-e08b093001cc'),
    audioSampleIndex: 8,
    durationSeconds: 201,
    streamsCount: 31_200,
    sortOrder: 2,
  },
];

function audioUrlForIndex(i: number): string {
  const base = SAMPLE_MP3[i % SAMPLE_MP3.length];
  const join = base.includes('?') ? '&' : '?';
  return `${base}${join}__seed_music__=${String(i)}`;
}

async function main(): Promise<void> {
  await connectDb();

  const seedKeyRegex = new RegExp(
    `^${SEED_KEY_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
  );
  const trackDel = await MusicTrackModel.deleteMany({
    seedKey: { $regex: seedKeyRegex },
  });
  const albumDel = await MusicAlbumModel.deleteMany({
    seedKey: { $regex: seedKeyRegex },
  });
  const artistDel = await ArtistModel.deleteMany({
    seedKey: { $regex: seedKeyRegex },
  });
  console.log(
    `Removed ${String(trackDel.deletedCount)} seed track(s), ${String(
      albumDel.deletedCount,
    )} seed album(s), ${String(artistDel.deletedCount)} seed artist(s).`,
  );

  const insertedArtists = await ArtistModel.insertMany(ARTIST_BLUEPRINTS);
  const artistIdBySeedKey = new Map(
    insertedArtists
      .filter((a) => a.seedKey != null)
      .map((a) => [a.seedKey as string, String(a._id)] as const),
  );

  type AlbumInsert = Omit<IMusicAlbum, 'createdAt' | 'updatedAt'>;
  const albumDocs: AlbumInsert[] = ALBUM_BLUEPRINTS.map((row) => {
    const artistId = artistIdBySeedKey.get(row.artistSeedKey);
    if (artistId === undefined) {
      throw new Error(`Missing artist for seed key ${row.artistSeedKey}`);
    }
    return {
      title: row.title,
      coverArtUrl: row.coverArtUrl,
      featured: row.featured,
      artist: new mongoose.Types.ObjectId(artistId),
      status: row.status,
      publishedAt: row.publishedAt,
      sortOrder: row.sortOrder,
      seedKey: row.seedKey,
    };
  });

  const insertedAlbums = await MusicAlbumModel.insertMany(albumDocs);
  const albumIdBySeedKey = new Map(
    insertedAlbums
      .filter((a) => a.seedKey != null)
      .map((a) => [a.seedKey as string, String(a._id)] as const),
  );

  type TrackInsert = Omit<IMusicTrack, 'createdAt' | 'updatedAt'>;
  const trackDocs: TrackInsert[] = TRACK_ROWS.map((row) => {
    const albumId = albumIdBySeedKey.get(row.albumSeedKey);
    if (albumId === undefined) {
      throw new Error(`Missing album for seed key ${row.albumSeedKey}`);
    }
    const artistId = artistIdBySeedKey.get(row.artistSeedKey);
    if (artistId === undefined) {
      throw new Error(`Missing artist for seed key ${row.artistSeedKey}`);
    }
    return {
      album: new mongoose.Types.ObjectId(albumId),
      title: row.title,
      artist: new mongoose.Types.ObjectId(artistId),
      artUrl: row.artUrl,
      audioUrl: audioUrlForIndex(row.audioSampleIndex),
      durationSeconds: row.durationSeconds,
      streamsCount: row.streamsCount,
      sortOrder: row.sortOrder,
      status: 'published' as const,
      seedKey: row.seedKey,
    };
  });

  const insertedTracks = await MusicTrackModel.insertMany(trackDocs);
  console.log(
    `Inserted ${String(insertedArtists.length)} artist(s), ${String(
      insertedAlbums.length,
    )} album(s), ${String(insertedTracks.length)} track(s).`,
  );

  await disconnectDb();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
