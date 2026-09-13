import mongoose, { Schema, type Model } from 'mongoose';
import { USERNAME_REGEX } from '../lib/usernameRules.js';

export type UserRole = 'user' | 'admin';
export type UserGender = 'male' | 'female' | 'other' | 'prefer_not_to_say';

export interface IBankAccount {
  holderName: string;
  accountNumber: string;
  ifscCode: string;
  /** Display name of the bank (e.g. "HDFC Bank"). Required. */
  bankName: string;
  /** Optional UPI VPA (e.g. "user@okicici"). Null when not provided. */
  upiId: string | null;
}

export interface IUser {
  /** Null until collected during onboarding — sign-up only takes username + password. */
  email: string | null;
  /** Unique handle (Instagram-style: a–z, 0–9, periods, underscores; 3–30 chars). */
  username: string;
  /** When the username was last changed — enforces the 24h change cooldown.
   * Null until the user changes it themselves (auto-assigned handle doesn't count). */
  usernameUpdatedAt: Date | null;
  /** 'user' (default) or 'admin'. */
  role: UserRole;
  /** Set when the user registered with email/password; null for Google-only accounts. */
  passwordHash: string | null;
  /** Google account subject (`sub` claim); omitted unless the user signed in with Google. */
  googleSub?: string;
  /** Apple account subject (`sub` from identity token); omitted unless the user signed in with Apple. */
  appleSub?: string;
  /** False until the client finishes onboarding (interests, profile, etc.). */
  isOnboarded: boolean;
  /** When true, the user is blocked — login is rejected. */
  isBlocked: boolean;
  /** When true, the user's followers list is hidden from other users (count remains visible). */
  isFollowersListPrivate: boolean;
  /** When false, the user has turned off push notifications. */
  notificationsEnabled: boolean;
  /** Interest labels chosen during onboarding (e.g. chip titles). */
  interests: string[];
  gender: UserGender | null;
  /** UTC midnight for the calendar day (stored as Date). */
  dateOfBirth: Date | null;
  fullName: string | null;
  phone: string | null;
  address: string | null;
  avatarUrl: string | null;
  passwordResetOtpHash: string | null;
  passwordResetOtpExpiresAt: Date | null;
  bankAccount: IBankAccount | null;
  /** FCM device token for push notifications. Latest login replaces previous. */
  fcmToken: string | null;
  /** Cached wallet balance (sum of Transaction.amount for this user). */
  walletBalance: number;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
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
      type: new Schema<IBankAccount>(
        {
          holderName: { type: String, required: true, trim: true },
          accountNumber: { type: String, required: true, trim: true },
          ifscCode: { type: String, required: true, trim: true },
          bankName: { type: String, required: true, trim: true, maxlength: 200 },
          upiId: { type: String, default: null, trim: true, maxlength: 100 },
        },
        { _id: false },
      ),
      default: null,
    },
    fcmToken: { type: String, default: null },
    walletBalance: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

// Unique email ONLY among real string emails — null/absent emails (users still
// in onboarding) are exempt, so they don't collide on the unique constraint.
userSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } },
);

export const UserModel: Model<IUser> =
  (mongoose.models.User as Model<IUser> | undefined) ??
  mongoose.model<IUser>('User', userSchema);
