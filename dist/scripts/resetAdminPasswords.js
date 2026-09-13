import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { connectDb, disconnectDb } from '../config/db.js';
import { UserModel } from '../models/user.model.js';
const BCRYPT_COST = 12;
function parsePassword() {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--password' || arg === '-p') {
            return args[i + 1]?.trim() ?? '';
        }
        if (arg.startsWith('--password=')) {
            return arg.slice('--password='.length).trim();
        }
    }
    return process.env.ADMIN_RESET_PASSWORD?.trim() ?? '';
}
async function main() {
    const newPassword = parsePassword();
    if (!newPassword) {
        console.error('Missing new password. Pass it via --password=<value> or ADMIN_RESET_PASSWORD env var.');
        console.error('Example: npm run reset:admin-passwords -- --password=\'NewSecret123!\'');
        process.exit(1);
    }
    if (newPassword.length < 8) {
        console.error('Password must be at least 8 characters long.');
        process.exit(1);
    }
    await connectDb();
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    const admins = await UserModel.find({ role: 'admin' }, { email: 1 }).lean();
    if (admins.length === 0) {
        console.warn('No admin users found. Nothing to reset.');
        await disconnectDb();
        return;
    }
    const result = await UserModel.updateMany({ role: 'admin' }, {
        $set: {
            passwordHash,
            passwordResetOtpHash: null,
            passwordResetOtpExpiresAt: null,
        },
    });
    console.log(`Reset password for ${result.modifiedCount} admin user(s):`);
    for (const admin of admins) {
        console.log(`  - ${admin.email}`);
    }
    await disconnectDb();
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
