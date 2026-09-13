import 'dotenv/config';
import { connectDb, disconnectDb } from '../config/db.js';
import { MusicAlbumModel } from '../models/musicAlbum.model.js';
import { MusicTrackModel } from '../models/musicTrack.model.js';
import { MusicTrackFavouriteModel } from '../models/musicTrackFavourite.model.js';

/**
 * One-off migration: wipe all music tracks + albums (and their favourite
 * relationships) so the schema can switch from free-text `artistName` to a
 * required `artist` ObjectId reference cleanly.
 *
 * Run BEFORE deploying the Subtask 2 schema changes:
 *   pnpm tsx src/scripts/wipeMusicData.ts
 *
 * Idempotent: safe to run multiple times — re-runs delete nothing.
 */
async function main(): Promise<void> {
  await connectDb();
  try {
    const [favs, tracks, albums] = await Promise.all([
      MusicTrackFavouriteModel.deleteMany({}),
      MusicTrackModel.deleteMany({}),
      MusicAlbumModel.deleteMany({}),
    ]);
    console.log(
      `wipeMusicData: removed ${String(albums.deletedCount)} album(s), ` +
        `${String(tracks.deletedCount)} track(s), ` +
        `${String(favs.deletedCount)} favourite link(s).`,
    );
  } finally {
    await disconnectDb();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
