import 'dotenv/config';
import { connectDb, disconnectDb } from '../config/db.js';
import { assignUniqueUsernameForEmail } from '../lib/username.js';
import { UserModel } from '../models/user.model.js';
/**
 * One-off migration: assign a unique username to users missing one.
 * Run after deploying the username field (before or alongside first app release that requires it).
 */
async function main() {
    await connectDb();
    const query = {
        $or: [
            { username: { $exists: false } },
            { username: null },
            { username: '' },
        ],
    };
    const cursor = UserModel.find(query);
    let updated = 0;
    for await (const doc of cursor) {
        // Email may now be null (collected during onboarding); fall back to the
        // user id as the seed so this legacy backfill still produces a handle.
        const username = await assignUniqueUsernameForEmail(doc.email ?? doc.id);
        doc.username = username;
        await doc.save();
        updated += 1;
    }
    console.log(`Backfill usernames: updated ${String(updated)} user(s).`);
    await disconnectDb();
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
