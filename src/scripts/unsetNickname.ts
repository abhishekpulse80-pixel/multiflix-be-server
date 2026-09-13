import 'dotenv/config';
import { connectDb, disconnectDb } from '../config/db.js';
import { UserModel } from '../models/user.model.js';

/**
 * One-off migration: drop the deprecated `nickname` field from all user docs.
 * Run after deploying the build that removes nickname from the schema/model.
 */
async function main(): Promise<void> {
  await connectDb();
  const res = await UserModel.collection.updateMany(
    { nickname: { $exists: true } },
    { $unset: { nickname: '' } },
  );
  console.log(`Unset nickname: modified ${String(res.modifiedCount)} user(s).`);
  await disconnectDb();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
