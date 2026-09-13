import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import mongoose from 'mongoose';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { connectDb, disconnectDb } from '../config/db.js';
import { s3Env, isS3Configured } from '../config/s3Env.js';
import { ArtistModel, type IArtist } from '../models/artist.model.js';
import { MusicAlbumModel, type IMusicAlbum } from '../models/musicAlbum.model.js';
import { MusicTrackModel, type IMusicTrack } from '../models/musicTrack.model.js';
import { extractAudioDurationFromBuffer } from '../lib/audioDuration.js';

/**
 * Manifest-driven Open Music seed.
 *
 * For every track:
 *   1. download audio + cover art from the source URLs
 *   2. upload both to our S3 bucket (so the App Store reviewer never sees a
 *      third-party CDN in the playback URL)
 *   3. insert Artist / MusicAlbum / MusicTrack docs pointing at our S3 URLs
 *
 * Idempotent via `seedKey` (`open-music:v1:<key>`). Re-running deletes any
 * prior rows with these keys before re-inserting — safe to run multiple
 * times while iterating on the manifest.
 *
 * Side log: every successful upload is appended to
 * `src/data/openMusicSeed.log.json` with the licensing metadata so we have an
 * audit trail for Apple review.
 */

const SEED_PREFIX = 'open-music:v1:';
const S3_AUDIO_PREFIX = 'music/audio';
const S3_COVER_PREFIX = 'music/cover';

type ArtistRow = {
  key: string;
  name: string;
  bio: string | null;
  profileImageUrl: string | null;
};

type AlbumRow = {
  key: string;
  title: string;
  artistKey: string;
  coverArtSourceUrl: string;
  featured: boolean;
};

type TrackRow = {
  key: string;
  title: string;
  albumKey: string;
  artistKey: string;
  audioSourceUrl: string;
  artSourceUrl: string;
  license: string;
  licenseUrl: string;
  attribution: string;
  sortOrder: number;
};

type Manifest = {
  artists: ArtistRow[];
  albums: AlbumRow[];
  tracks: TrackRow[];
};

type AuditLogEntry = {
  seedKey: string;
  title: string;
  artist: string;
  album: string;
  license: string;
  licenseUrl: string;
  attribution: string;
  sourceUrl: string;
  s3Key: string;
  publicUrl: string | null;
  uploadedAt: string;
};

let s3: S3Client | null = null;
function getS3(): S3Client {
  if (!isS3Configured()) {
    throw new Error(
      'S3 not configured — need AWS_REGION, S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY in .env',
    );
  }
  if (!s3) {
    s3 = new S3Client({
      region: s3Env.region,
      credentials: {
        accessKeyId: s3Env.accessKeyId,
        secretAccessKey: s3Env.secretAccessKey,
      },
      ...(s3Env.endpoint
        ? { endpoint: s3Env.endpoint, forcePathStyle: true as const }
        : {}),
    });
  }
  return s3;
}

function publicUrlForKey(key: string): string | null {
  if (!s3Env.publicBaseUrl) return null;
  const p = key.split('/').map(encodeURIComponent).join('/');
  return `${s3Env.publicBaseUrl}/${p}`;
}

function extFromContentType(ct: string | null): string {
  if (!ct) return 'bin';
  const lower = ct.split(';')[0]?.toLowerCase().trim() ?? '';
  if (lower.includes('mpeg')) return 'mp3';
  if (lower.includes('mp4') || lower.includes('m4a')) return 'm4a';
  if (lower.includes('ogg')) return 'ogg';
  if (lower.includes('wav')) return 'wav';
  if (lower.includes('flac')) return 'flac';
  if (lower.includes('jpeg') || lower.includes('jpg')) return 'jpg';
  if (lower.includes('png')) return 'png';
  if (lower.includes('webp')) return 'webp';
  return 'bin';
}

async function downloadBuffer(
  url: string,
): Promise<{ buffer: Buffer; contentType: string | null }> {
  const res = await fetch(url, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (compatible; MultiflixSeeder/1.0; +https://multiflix.app)',
      accept: '*/*',
    },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: HTTP ${String(res.status)}`);
  }
  const ab = await res.arrayBuffer();
  return {
    buffer: Buffer.from(ab),
    contentType: res.headers.get('content-type'),
  };
}

async function putObject(params: {
  key: string;
  buffer: Buffer;
  contentType: string;
}): Promise<void> {
  await getS3().send(
    new PutObjectCommand({
      Bucket: s3Env.bucket,
      Key: params.key,
      Body: params.buffer,
      ContentType: params.contentType,
      CacheControl: 'public, max-age=31536000, immutable',
      ...(s3Env.objectAcl ? { ACL: s3Env.objectAcl } : {}),
    }),
  );
}

function defaultManifestPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'data', 'openMusicSeed.json');
}

function resolveManifestPath(): string {
  const arg = process.argv.find((a) => a.startsWith('--manifest='));
  if (arg) return path.resolve(arg.slice('--manifest='.length));
  return defaultManifestPath();
}

async function loadManifest(p: string): Promise<Manifest> {
  const raw = await readFile(p, 'utf8');
  const parsed = JSON.parse(raw) as Partial<Manifest>;
  const artists = parsed.artists ?? [];
  const albums = parsed.albums ?? [];
  const tracks = parsed.tracks ?? [];
  if (artists.length === 0 || tracks.length === 0) {
    throw new Error(
      `Manifest at ${p} has no artists/tracks — populate it before running.`,
    );
  }
  return { artists, albums, tracks };
}

async function appendAuditLog(entries: AuditLogEntry[]): Promise<void> {
  const p = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'data',
    'openMusicSeed.log.json',
  );
  let existing: AuditLogEntry[] = [];
  try {
    existing = JSON.parse(await readFile(p, 'utf8')) as AuditLogEntry[];
  } catch {
    // first run
  }
  await writeFile(p, JSON.stringify([...existing, ...entries], null, 2));
}

async function main(): Promise<void> {
  const manifestPath = resolveManifestPath();
  console.log(`Manifest: ${manifestPath}`);

  const manifest = await loadManifest(manifestPath);
  console.log(
    `  ${String(manifest.artists.length)} artist(s), ${String(manifest.albums.length)} album(s), ${String(manifest.tracks.length)} track(s)`,
  );

  // S3 sanity check before we touch the DB.
  getS3();

  await connectDb();

  const seedRegex = new RegExp(
    `^${SEED_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
  );
  const trackDel = await MusicTrackModel.deleteMany({
    seedKey: { $regex: seedRegex },
  });
  const albumDel = await MusicAlbumModel.deleteMany({
    seedKey: { $regex: seedRegex },
  });
  const artistDel = await ArtistModel.deleteMany({
    seedKey: { $regex: seedRegex },
  });
  console.log(
    `Cleared prior seed: ${String(artistDel.deletedCount)} artist(s), ${String(albumDel.deletedCount)} album(s), ${String(trackDel.deletedCount)} track(s)`,
  );

  // ----- Artists -----
  const artistDocs: Array<Omit<IArtist, 'createdAt' | 'updatedAt'>> =
    manifest.artists.map((a, i) => ({
      name: a.name,
      bio: a.bio,
      profileImageUrl: a.profileImageUrl,
      status: 'published',
      sortOrder: i,
      seedKey: `${SEED_PREFIX}artist:${a.key}`,
    }));
  const insertedArtists = await ArtistModel.insertMany(artistDocs);
  const artistIdByKey = new Map<string, mongoose.Types.ObjectId>();
  manifest.artists.forEach((a, i) => {
    artistIdByKey.set(a.key, insertedArtists[i]._id);
  });
  console.log(`Inserted ${String(insertedArtists.length)} artist(s)`);

  // ----- Albums (with cover-art upload) -----
  const albumIdByKey = new Map<string, mongoose.Types.ObjectId>();
  for (let i = 0; i < manifest.albums.length; i += 1) {
    const a = manifest.albums[i];
    const artistId = artistIdByKey.get(a.artistKey);
    if (!artistId) {
      throw new Error(`album ${a.key} refs missing artist ${a.artistKey}`);
    }
    process.stdout.write(`  album: ${a.title}  cover…`);
    const cover = await downloadBuffer(a.coverArtSourceUrl);
    const coverExt = extFromContentType(cover.contentType);
    const coverKey = `${S3_COVER_PREFIX}/album-${a.key}.${coverExt}`;
    await putObject({
      key: coverKey,
      buffer: cover.buffer,
      contentType: cover.contentType ?? 'application/octet-stream',
    });
    const coverUrl =
      publicUrlForKey(coverKey) ??
      `s3://${s3Env.bucket}/${coverKey}`;
    process.stdout.write(' ok\n');

    const doc: Omit<IMusicAlbum, 'createdAt' | 'updatedAt'> = {
      title: a.title,
      coverArtUrl: coverUrl,
      featured: a.featured,
      artist: artistId,
      status: 'published',
      publishedAt: new Date(),
      sortOrder: i,
      seedKey: `${SEED_PREFIX}album:${a.key}`,
    };
    const inserted = await MusicAlbumModel.create(doc);
    albumIdByKey.set(a.key, inserted._id);
  }
  console.log(`Inserted ${String(albumIdByKey.size)} album(s)`);

  // ----- Tracks (audio + per-track art upload) -----
  const auditEntries: AuditLogEntry[] = [];
  let okCount = 0;
  for (const t of manifest.tracks) {
    const artistId = artistIdByKey.get(t.artistKey);
    if (!artistId) {
      throw new Error(`track ${t.key} refs missing artist ${t.artistKey}`);
    }
    const albumId = albumIdByKey.get(t.albumKey) ?? null;

    process.stdout.write(`  track: ${t.title}  audio…`);
    const audio = await downloadBuffer(t.audioSourceUrl);
    const audioExt = extFromContentType(audio.contentType);
    const audioKey = `${S3_AUDIO_PREFIX}/${t.key}.${audioExt}`;
    await putObject({
      key: audioKey,
      buffer: audio.buffer,
      contentType: audio.contentType ?? 'audio/mpeg',
    });
    const audioUrl =
      publicUrlForKey(audioKey) ?? `s3://${s3Env.bucket}/${audioKey}`;
    process.stdout.write(' art…');

    const art = await downloadBuffer(t.artSourceUrl);
    const artExt = extFromContentType(art.contentType);
    const artKey = `${S3_COVER_PREFIX}/track-${t.key}.${artExt}`;
    await putObject({
      key: artKey,
      buffer: art.buffer,
      contentType: art.contentType ?? 'image/jpeg',
    });
    const artUrl =
      publicUrlForKey(artKey) ?? `s3://${s3Env.bucket}/${artKey}`;
    process.stdout.write(' meta…');

    const durationSeconds = await extractAudioDurationFromBuffer(
      audio.buffer,
      audio.contentType ?? undefined,
    );

    const trackDoc: Omit<IMusicTrack, 'createdAt' | 'updatedAt'> = {
      album: albumId,
      title: t.title,
      artist: artistId,
      artUrl,
      audioUrl,
      durationSeconds,
      streamsCount: 0,
      sortOrder: t.sortOrder,
      status: 'published',
      seedKey: `${SEED_PREFIX}track:${t.key}`,
    };
    await MusicTrackModel.create(trackDoc);
    okCount += 1;
    process.stdout.write(' ok\n');

    auditEntries.push({
      seedKey: `${SEED_PREFIX}track:${t.key}`,
      title: t.title,
      artist:
        manifest.artists.find((a) => a.key === t.artistKey)?.name ??
        t.artistKey,
      album:
        manifest.albums.find((a) => a.key === t.albumKey)?.title ?? t.albumKey,
      license: t.license,
      licenseUrl: t.licenseUrl,
      attribution: t.attribution,
      sourceUrl: t.audioSourceUrl,
      s3Key: audioKey,
      publicUrl: publicUrlForKey(audioKey),
      uploadedAt: new Date().toISOString(),
    });
  }

  await appendAuditLog(auditEntries);
  console.log(
    `Inserted ${String(okCount)} track(s). Audit log appended to src/data/openMusicSeed.log.json`,
  );

  await disconnectDb();
}

main().catch(async (err: unknown) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
