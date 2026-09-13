import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { connectDb, disconnectDb } from '../config/db.js';
import { env } from '../config/env.js';
import { UserModel } from '../models/user.model.js';
const BCRYPT_COST = 12;
async function main() {
    const { adminEmail, adminPassword, adminUsername } = env;
    if (!adminEmail || !adminPassword) {
        console.error('Missing ADMIN_EMAIL or ADMIN_PASSWORD in .env — cannot seed admin.');
        process.exit(1);
    }
    await connectDb();
    const passwordHash = await bcrypt.hash(adminPassword, BCRYPT_COST);
    const result = await UserModel.findOneAndUpdate({ email: adminEmail.toLowerCase() }, {
        $set: {
            email: adminEmail.toLowerCase(),
            username: adminUsername.toLowerCase(),
            passwordHash,
            role: 'admin',
            isOnboarded: true,
            fullName: 'Admin',
            passwordResetOtpHash: null,
            passwordResetOtpExpiresAt: null,
        },
    }, { upsert: true, new: true, runValidators: true });
    console.log(`Admin user seeded successfully.`);
    console.log(`  ID:       ${String(result._id)}`);
    console.log(`  Email:    ${adminEmail}`);
    console.log(`  Username: ${adminUsername}`);
    console.log(`  Role:     admin`);
    await disconnectDb();
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
