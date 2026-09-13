import 'dotenv/config';
import { connectDb, disconnectDb } from '../config/db.js';
import { UserModel } from '../models/user.model.js';

/**
 * One-off migration: replace the old `email_1` unique index on `users` with a
 * PARTIAL unique index that applies only to real string emails.
 *
 * Background: sign-up no longer collects email (username + password only); it's
 * filled in during onboarding. Users are therefore created with `email: null`.
 * The original `email_1` index was `{ unique: true }` (non-partial), which would
 * reject the second `email: null` row with E11000. The schema now declares a
 * partial unique index (`partialFilterExpression: { email: { $type: 'string' } }`),
 * but Mongoose does NOT drop the existing `email_1` index on schema change, so
 * we drop it here and let `syncIndexes()` recreate the partial one.
 *
 * Idempotent: safe to run multiple times.
 */
async function main(): Promise<void> {
  await connectDb();
  try {
    // Drop the old non-partial unique index if present.
    try {
      await UserModel.collection.dropIndex('email_1');
      console.log('[users] dropped old index "email_1"');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/index not found|ns not found/i.test(msg)) {
        console.log('[users] old index "email_1" already absent');
      } else {
        throw err;
      }
    }

    // Recreate indexes from the (updated) schema → partial unique email index.
    await UserModel.syncIndexes();
    console.log('[users] indexes synced (partial unique email index in place)');
    console.log('migrateEmailPartialIndex: done.');
  } finally {
    await disconnectDb();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
