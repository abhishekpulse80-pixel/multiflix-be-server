import 'dotenv/config';
import { connectDb, disconnectDb } from '../config/db.js';
import { MusicAlbumModel } from '../models/musicAlbum.model.js';
import { MusicTrackModel } from '../models/musicTrack.model.js';

/**
 * One-off migration: fix the old `seedKey_1` unique+sparse index on
 * `musictracks` and `musicalbums`.
 *
 * Background: the previous schema used `sparse: true, unique: true` on
 * `seedKey` combined with `default: null`. MongoDB's sparse index still
 * considers an explicit `null` value as "present", so the second admin-created
 * row (which has no seedKey → stored as null by Mongoose default) would fail
 * with E11000 "duplicate key error ... dup key: { seedKey: null }".
 *
 * The schema has been updated to use a partial filter expression
 * (`{ seedKey: { $type: 'string' } }`) so only real string seedKeys are
 * subject to the unique constraint. However, Mongoose does NOT drop the
 * existing `seedKey_1` index on schema change, so we must drop it here.
 *
 * This script is idempotent: safe to run multiple times. It will:
 *   1. Unset `seedKey` on any existing docs where `seedKey === null` so the
 *      new partial index has no ambiguous rows to consider.
 *   2. Drop the old `seedKey_1` index (ignores "index not found").
 *   3. Let Mongoose rebuild the new partial unique index at next server
 *      start via its normal index sync — or you can trigger it right now by
 *      calling `syncIndexes()` on each model, which this script also does.
 */
async function fixCollection(model: {
  modelName: string;
  collection: { dropIndex: (name: string) => Promise<unknown> };
  updateMany: (f: object, u: object) => Promise<{ modifiedCount: number }>;
  syncIndexes: () => Promise<unknown>;
}): Promise<void> {
  const name = model.modelName;

  // 1. Clear out explicit nulls so the new partial index starts clean.
  const unsetRes = await model.updateMany(
    { seedKey: null },
    { $unset: { seedKey: '' } },
  );
  console.log(
    `[${name}] unset seedKey:null on ${String(unsetRes.modifiedCount)} doc(s)`,
  );

  // 2. Drop old index if present.
  try {
    await model.collection.dropIndex('seedKey_1');
    console.log(`[${name}] dropped old index "seedKey_1"`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/index not found|ns not found/i.test(msg)) {
      console.log(`[${name}] old index "seedKey_1" already absent`);
    } else {
      throw err;
    }
  }

  // 3. Rebuild indexes from the (updated) schema.
  await model.syncIndexes();
  console.log(`[${name}] indexes synced`);
}

async function main(): Promise<void> {
  await connectDb();
  try {
    await fixCollection(MusicTrackModel as unknown as Parameters<typeof fixCollection>[0]);
    await fixCollection(MusicAlbumModel as unknown as Parameters<typeof fixCollection>[0]);
    console.log('fixSeedKeyIndex: done.');
  } finally {
    await disconnectDb();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
