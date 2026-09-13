import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { connectDb, disconnectDb } from '../config/db.js';
import { UserModel } from '../models/user.model.js';
/** Same work factor as `auth.service.ts` */
const BCRYPT_COST = 12;
/** Shared password for every seeded account (dev / staging only). */
const SEED_PLAIN_PASSWORD = 'MultiflixSeed!2026';
const GENDERS = [
    'male',
    'female',
    'other',
    'prefer_not_to_say',
];
const INTEREST_SETS = [
    ['Action', 'Thriller', 'Crime'],
    ['Comedy', 'Romance'],
    ['Sci-Fi', 'Fantasy', 'Animation'],
    ['Documentary', 'History'],
    ['Horror', 'Mystery'],
    ['Drama', 'Biography'],
    ['Anime', 'Fantasy'],
    ['Sports', 'Reality TV'],
];
const FIRST_NAMES = [
    'Aarav',
    'Zara',
    'Noah',
    'Mia',
    'Leo',
    'Sofia',
    'Arjun',
    'Elena',
    'Kai',
    'Amara',
    'Rohan',
    'Lina',
    'Theo',
    'Priya',
    'Felix',
    'Nora',
];
const SEED_COUNT = 16;
function buildSeedRow(index) {
    const i = index + 1;
    const email = `multiflix.seed.${String(i).padStart(2, '0')}@multiflix.test`;
    const first = FIRST_NAMES[index] ?? 'User';
    const hasAvatar = index % 2 === 0;
    const avatarUrl = hasAvatar
        ? `https://picsum.photos/seed/multiflix-seed-${String(i).padStart(2, '0')}/400/400`
        : null;
    const gender = GENDERS[index % GENDERS.length];
    const interests = INTEREST_SETS[index % INTEREST_SETS.length];
    const y = 1988 + (index % 12);
    const m = index % 12;
    const d = 1 + (index % 28);
    const dateOfBirth = new Date(Date.UTC(y, m, d));
    const isOnboarded = index % 5 !== 0;
    return {
        email: email.toLowerCase(),
        username: `multiflix_seed_${String(i).padStart(2, '0')}`,
        fullName: `${first} Demo`,
        phone: `+1555000${String(1000 + i).slice(1)}`,
        address: `${String(100 + i)} Seed Street, Demo City`,
        gender,
        dateOfBirth,
        interests,
        isOnboarded,
        avatarUrl,
    };
}
async function main() {
    await connectDb();
    const passwordHash = await bcrypt.hash(SEED_PLAIN_PASSWORD, BCRYPT_COST);
    let created = 0;
    let updated = 0;
    for (let index = 0; index < SEED_COUNT; index += 1) {
        const row = buildSeedRow(index);
        const before = await UserModel.findOne({ email: row.email }).lean();
        await UserModel.findOneAndUpdate({ email: row.email }, {
            $set: {
                email: row.email,
                username: row.username,
                passwordHash,
                isOnboarded: row.isOnboarded,
                interests: row.interests,
                gender: row.gender,
                dateOfBirth: row.dateOfBirth,
                fullName: row.fullName,
                phone: row.phone,
                address: row.address,
                avatarUrl: row.avatarUrl,
                passwordResetOtpHash: null,
                passwordResetOtpExpiresAt: null,
            },
        }, { upsert: true, new: true, runValidators: true });
        if (before) {
            updated += 1;
        }
        else {
            created += 1;
        }
    }
    console.log(`Seed users done: ${String(created)} inserted, ${String(updated)} updated (${String(SEED_COUNT)} total).`);
    console.log(`Login with any ${String(SEED_COUNT)} emails matching multiflix.seed.**@multiflix.test`);
    console.log(`Password for all: ${SEED_PLAIN_PASSWORD}`);
    await disconnectDb();
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
