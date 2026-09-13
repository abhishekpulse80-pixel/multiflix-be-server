import mongoose, { Schema } from 'mongoose';
import { USERNAME_REGEX } from '../lib/usernameRules.js';
const userSchema = new Schema({
    email: {
        type: String,
        // Collected during onboarding, not at sign-up — nullable. Uniqueness is
        // enforced by a PARTIAL index (below) that applies only to real string
        // emails, so many `email: null` users can coexist (a plain sparse+unique
        // index would still collide on explicit null — same trap as seedKey).
        required: false,
        default: null,
        lowercase: true,
        trim: true,
        maxlength: 320,
    },
    username: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
        match: USERNAME_REGEX,
    },
    usernameUpdatedAt: { type: Date, default: null },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    passwordHash: { type: String, default: null },
    googleSub: {
        type: String,
        required: false,
        sparse: true,
        unique: true,
        trim: true,
    },
    appleSub: {
        type: String,
        required: false,
        sparse: true,
        unique: true,
        trim: true,
    },
    isOnboarded: { type: Boolean, default: false },
    isBlocked: { type: Boolean, default: false },
    isFollowersListPrivate: { type: Boolean, default: false },
    notificationsEnabled: { type: Boolean, default: true },
    interests: { type: [String], default: [] },
    gender: { type: String, default: null },
    dateOfBirth: { type: Date, default: null },
    fullName: { type: String, default: null },
    phone: { type: String, default: null },
    address: { type: String, default: null },
    avatarUrl: { type: String, default: null },
    passwordResetOtpHash: { type: String, default: null },
    passwordResetOtpExpiresAt: { type: Date, default: null },
    bankAccount: {
        type: new Schema({
            holderName: { type: String, required: true, trim: true },
            accountNumber: { type: String, required: true, trim: true },
            ifscCode: { type: String, required: true, trim: true },
            bankName: { type: String, required: true, trim: true, maxlength: 200 },
            upiId: { type: String, default: null, trim: true, maxlength: 100 },
        }, { _id: false }),
        default: null,
    },
    fcmToken: { type: String, default: null },
    walletBalance: { type: Number, default: 0, min: 0 },
}, { timestamps: true });
// Unique email ONLY among real string emails — null/absent emails (users still
// in onboarding) are exempt, so they don't collide on the unique constraint.
userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
export const UserModel = mongoose.models.User ??
    mongoose.model('User', userSchema);
