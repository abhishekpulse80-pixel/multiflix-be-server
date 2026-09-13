import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { HttpError } from '../lib/httpError.js';
import { signAccessToken, signPasswordResetToken, verifyPasswordResetToken, } from '../lib/jwt.js';
import { verifyAppleIdentityToken } from '../lib/verifyAppleIdentityToken.js';
import { verifyGoogleIdToken } from '../lib/verifyGoogleIdToken.js';
import { generateOtp4 } from '../lib/otp.js';
import { sendPasswordResetOtpEmail, shouldLogOtpToConsole, } from './brevoMail.service.js';
import { assignUniqueUsernameForEmail } from '../lib/username.js';
import { isValidUsernameShape } from '../lib/usernameRules.js';
import { UserModel, } from '../models/user.model.js';
import mongoose from 'mongoose';
import { BlogModel } from '../models/blog.model.js';
import { BlogFavoriteModel } from '../models/blogFavorite.model.js';
import { CommentModel } from '../models/comment.model.js';
import { FeedbackModel } from '../models/feedback.model.js';
import { FollowModel } from '../models/follow.model.js';
import { MusicTrackFavouriteModel } from '../models/musicTrackFavourite.model.js';
import { NotificationModel } from '../models/notification.model.js';
import { PostModel } from '../models/post.model.js';
import { PostLikeModel } from '../models/postLike.model.js';
import { ReportModel } from '../models/report.model.js';
import { StoryModel } from '../models/story.model.js';
import { StoryReactionModel } from '../models/storyReaction.model.js';
import { StoryViewModel } from '../models/storyView.model.js';
import { TransactionModel } from '../models/transaction.model.js';
import { UserBlockModel } from '../models/userBlock.model.js';
import { WithdrawalRequestModel } from '../models/withdrawalRequest.model.js';
const PASSWORD_COST = 12;
const OTP_COST = 8;
const OTP_TTL_MS = 10 * 60 * 1000;
function assertNotBlocked(user) {
    if (user.isBlocked) {
        throw new HttpError(403, 'This account has been blocked', 'ACCOUNT_BLOCKED');
    }
}
/** A username can be changed at most once per this window. */
const USERNAME_CHANGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const GENDERS = new Set([
    'male',
    'female',
    'other',
    'prefer_not_to_say',
]);
function readNullableString(v) {
    if (v === null || v === undefined) {
        return null;
    }
    const s = String(v).trim();
    return s.length > 0 ? s : null;
}
function toPublicUser(user) {
    const rawGender = user.gender;
    const gender = typeof rawGender === 'string' && GENDERS.has(rawGender)
        ? rawGender
        : null;
    const interests = Array.isArray(user.interests)
        ? [...user.interests].map((s) => String(s).trim()).filter(Boolean)
        : [];
    const dob = user.dateOfBirth;
    const dateOfBirth = dob instanceof Date && !Number.isNaN(dob.getTime())
        ? dob.toISOString().slice(0, 10)
        : null;
    return {
        id: user.id,
        email: user.email,
        username: user.username,
        usernameUpdatedAt: user.usernameUpdatedAt
            ? user.usernameUpdatedAt.toISOString()
            : null,
        createdAt: user.createdAt.toISOString(),
        isOnboarded: Boolean(user.isOnboarded),
        hasPassword: Boolean(user.passwordHash),
        interests,
        gender,
        dateOfBirth,
        fullName: readNullableString(user.fullName),
        phone: readNullableString(user.phone),
        address: readNullableString(user.address),
        avatarUrl: readNullableString(user.avatarUrl),
        isFollowersListPrivate: Boolean(user.isFollowersListPrivate),
        notificationsEnabled: user.notificationsEnabled !== false,
    };
}
async function createUserWithUniqueUsername(fields) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const username = await assignUniqueUsernameForEmail(fields.email);
        try {
            return await UserModel.create({ ...fields, username });
        }
        catch (err) {
            if (isMongoDuplicateKey(err) && isUsernameDuplicateKey(err)) {
                continue;
            }
            throw err;
        }
    }
    throw new HttpError(503, 'Could not assign username', 'USERNAME_ASSIGN_FAILED');
}
function isUsernameDuplicateKey(err) {
    if (typeof err !== 'object' || err === null) {
        return false;
    }
    const e = err;
    return Boolean((e.keyPattern && 'username' in e.keyPattern) ||
        (e.keyValue && 'username' in e.keyValue));
}
export async function register(username, password) {
    const passwordHash = await bcrypt.hash(password, PASSWORD_COST);
    try {
        // Sign-up only takes username + password. Email is null until the user
        // provides it during onboarding. Username uniqueness is enforced by its
        // unique index; a collision becomes a 409.
        const user = await UserModel.create({ username, passwordHash });
        const accessToken = signAccessToken(user.id, user.email);
        return { user: toPublicUser(user), accessToken };
    }
    catch (err) {
        if (isMongoDuplicateKey(err) && isUsernameDuplicateKey(err)) {
            throw new HttpError(409, 'Username is already taken', 'USERNAME_IN_USE');
        }
        throw err;
    }
}
/**
 * Resolve the login identifier (email / username / phone) to a User doc.
 * Returns `null` when nothing matches — caller throws a generic 401 so
 * we don't leak which field the user got wrong.
 */
async function findUserByIdentifier(rawIdentifier) {
    const identifier = rawIdentifier.trim();
    if (identifier.includes('@')) {
        // Looks like an email.
        return UserModel.findOne({ email: identifier.toLowerCase() });
    }
    // Phone heuristic: digits with optional leading + and spaces/dashes.
    const phoneCandidate = identifier.replace(/[\s-]/g, '');
    if (/^\+?\d{6,}$/.test(phoneCandidate)) {
        // Try with and without leading `+` for tolerance — registration
        // doesn't enforce a specific format.
        const variants = [phoneCandidate];
        if (phoneCandidate.startsWith('+')) {
            variants.push(phoneCandidate.slice(1));
        }
        else {
            variants.push(`+${phoneCandidate}`);
        }
        const byPhone = await UserModel.findOne({ phone: { $in: variants } });
        if (byPhone)
            return byPhone;
        // Fall through to username lookup as a last resort (numeric-only
        // usernames are technically allowed by USERNAME_REGEX).
    }
    // Username (case-insensitive, since usernames are stored lowercase).
    return UserModel.findOne({ username: identifier.toLowerCase() });
}
export async function login(identifier, password) {
    const user = await findUserByIdentifier(identifier);
    if (!user) {
        throw new HttpError(401, 'Invalid credentials', 'INVALID_CREDENTIALS');
    }
    if (!user.passwordHash) {
        throw new HttpError(401, 'This account uses Google or Apple sign-in', 'USE_SOCIAL_SIGN_IN');
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
        throw new HttpError(401, 'Invalid credentials', 'INVALID_CREDENTIALS');
    }
    assertNotBlocked(user);
    const accessToken = signAccessToken(user.id, user.email);
    return { user: toPublicUser(user), accessToken };
}
function isGoogleEmailVerified(v) {
    return v === true || v === 'true';
}
/**
 * Verifies a Google ID token, then signs the user in or registers them.
 * Links an existing email/password account when the email matches and is verified by Google.
 */
export async function signInWithGoogleIdToken(idToken) {
    const payload = await verifyGoogleIdToken(idToken);
    const emailRaw = payload.email?.trim().toLowerCase();
    if (!emailRaw) {
        throw new HttpError(400, 'Google account has no email', 'GOOGLE_NO_EMAIL');
    }
    if (!isGoogleEmailVerified(payload.email_verified)) {
        throw new HttpError(403, 'Verify your Google email before signing in', 'GOOGLE_EMAIL_NOT_VERIFIED');
    }
    let user = await UserModel.findOne({ googleSub: payload.sub });
    if (user) {
        assertNotBlocked(user);
        const accessToken = signAccessToken(user.id, user.email);
        return { user: toPublicUser(user), accessToken };
    }
    user = await UserModel.findOne({ email: emailRaw });
    if (user) {
        assertNotBlocked(user);
        if (user.googleSub && user.googleSub !== payload.sub) {
            throw new HttpError(409, 'This email is linked to a different Google account', 'GOOGLE_ACCOUNT_MISMATCH');
        }
        user.googleSub = payload.sub;
        if (!readNullableString(user.avatarUrl) && payload.picture) {
            user.avatarUrl = payload.picture.trim() || null;
        }
        if (!readNullableString(user.fullName) && payload.name) {
            user.fullName = payload.name.trim() || null;
        }
        await user.save();
        const accessToken = signAccessToken(user.id, user.email);
        return { user: toPublicUser(user), accessToken };
    }
    try {
        const created = await createUserWithUniqueUsername({
            email: emailRaw,
            passwordHash: null,
            googleSub: payload.sub,
            avatarUrl: readNullableString(payload.picture),
            fullName: readNullableString(payload.name),
        });
        const accessToken = signAccessToken(created.id, created.email);
        return { user: toPublicUser(created), accessToken };
    }
    catch (err) {
        if (isMongoDuplicateKey(err)) {
            throw new HttpError(409, 'Email is already registered', 'EMAIL_IN_USE');
        }
        throw err;
    }
}
function syntheticAppleEmail(sub) {
    const h = createHash('sha256').update(sub).digest('hex');
    return `apple-${h}@signin.multiflix.placeholder`;
}
function canTrustAppleEmail(payload) {
    const email = payload.email?.trim();
    if (!email) {
        return false;
    }
    const v = payload.email_verified;
    if (v === false || v === 'false') {
        return false;
    }
    return true;
}
/**
 * Verifies an Apple identity token and signs the user in or registers them.
 * Email may be absent on later sign-ins; `sub` is always stable.
 */
export async function signInWithAppleIdentityToken(identityToken) {
    const payload = await verifyAppleIdentityToken(identityToken);
    const sub = payload.sub;
    let user = await UserModel.findOne({ appleSub: sub });
    if (user) {
        assertNotBlocked(user);
        const accessToken = signAccessToken(user.id, user.email);
        return { user: toPublicUser(user), accessToken };
    }
    let emailRaw;
    if (canTrustAppleEmail(payload)) {
        emailRaw = payload.email.trim().toLowerCase();
    }
    if (emailRaw) {
        user = await UserModel.findOne({ email: emailRaw });
        if (user) {
            assertNotBlocked(user);
            if (user.appleSub && user.appleSub !== sub) {
                throw new HttpError(409, 'This email is linked to a different Apple account', 'APPLE_ACCOUNT_MISMATCH');
            }
            user.appleSub = sub;
            await user.save();
            const accessToken = signAccessToken(user.id, user.email);
            return { user: toPublicUser(user), accessToken };
        }
    }
    const email = emailRaw ?? syntheticAppleEmail(sub);
    try {
        const created = await createUserWithUniqueUsername({
            email,
            passwordHash: null,
            appleSub: sub,
        });
        const accessToken = signAccessToken(created.id, created.email);
        return { user: toPublicUser(created), accessToken };
    }
    catch (err) {
        if (isMongoDuplicateKey(err)) {
            throw new HttpError(409, 'Email is already registered', 'EMAIL_IN_USE');
        }
        throw err;
    }
}
export async function forgotPassword(email) {
    const user = await UserModel.findOne({ email });
    if (!user) {
        return { ok: true };
    }
    // Social-only accounts cannot reset password
    if (!user.passwordHash && (user.googleSub || user.appleSub)) {
        const provider = user.googleSub ? 'Google' : 'Apple';
        throw new HttpError(400, `This account uses ${provider} sign-in. Please log in with ${provider} instead.`, 'SOCIAL_ACCOUNT');
    }
    const otp = generateOtp4();
    const otpHash = await bcrypt.hash(otp, OTP_COST);
    const expires = new Date(Date.now() + OTP_TTL_MS);
    user.passwordResetOtpHash = otpHash;
    user.passwordResetOtpExpiresAt = expires;
    await user.save();
    void sendPasswordResetOtpEmail(email, otp).catch((err) => {
        console.error('[auth] Brevo password reset email failed:', err);
    });
    if (shouldLogOtpToConsole()) {
        console.log(`[auth] Password reset OTP for ${email}: ${otp}`);
    }
    return { ok: true };
}
export async function verifyForgotOtp(email, code) {
    const user = await UserModel.findOne({ email });
    if (!user?.passwordResetOtpHash ||
        !user.passwordResetOtpExpiresAt ||
        user.passwordResetOtpExpiresAt.getTime() < Date.now()) {
        throw new HttpError(401, 'Invalid or expired code', 'INVALID_OTP');
    }
    const match = await bcrypt.compare(code, user.passwordResetOtpHash);
    if (!match) {
        throw new HttpError(401, 'Invalid or expired code', 'INVALID_OTP');
    }
    user.passwordResetOtpHash = null;
    user.passwordResetOtpExpiresAt = null;
    await user.save();
    const resetToken = signPasswordResetToken(user.id);
    return { resetToken };
}
export async function resetPassword(resetToken, newPassword) {
    const payload = verifyPasswordResetToken(resetToken);
    const user = await UserModel.findById(payload.sub);
    if (!user) {
        throw new HttpError(401, 'Invalid reset token', 'INVALID_RESET_TOKEN');
    }
    assertNotBlocked(user);
    user.passwordHash = await bcrypt.hash(newPassword, PASSWORD_COST);
    user.passwordResetOtpHash = null;
    user.passwordResetOtpExpiresAt = null;
    await user.save();
    const accessToken = signAccessToken(user.id, user.email);
    return { user: toPublicUser(user), accessToken };
}
export async function changePassword(userId, currentPassword, newPassword) {
    const user = await UserModel.findById(userId);
    if (!user) {
        throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
    }
    if (!user.passwordHash) {
        throw new HttpError(400, 'This account does not have a password set. Use Forgot Password to create one.', 'NO_PASSWORD_SET');
    }
    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) {
        throw new HttpError(401, 'Current password is incorrect', 'INVALID_CURRENT_PASSWORD');
    }
    user.passwordHash = await bcrypt.hash(newPassword, PASSWORD_COST);
    await user.save();
    return { ok: true };
}
/* ------------------------------------------------------------------ */
/*  Admin password reset (email OTP)                                   */
/*                                                                     */
/*  Mirrors forgotPassword / verifyForgotOtp / resetPassword but only  */
/*  allows accounts with role === 'admin'. Used by the admin panel.    */
/* ------------------------------------------------------------------ */
export async function adminForgotPassword(email) {
    const user = await UserModel.findOne({ email });
    // Same silent-success behaviour as the public flow — don't leak whether
    // the email belongs to an admin (or exists at all).
    if (!user || user.role !== 'admin') {
        return { ok: true };
    }
    const otp = generateOtp4();
    const otpHash = await bcrypt.hash(otp, OTP_COST);
    const expires = new Date(Date.now() + OTP_TTL_MS);
    user.passwordResetOtpHash = otpHash;
    user.passwordResetOtpExpiresAt = expires;
    await user.save();
    void sendPasswordResetOtpEmail(email, otp).catch((err) => {
        console.error('[admin-auth] Brevo password reset email failed:', err);
    });
    if (shouldLogOtpToConsole()) {
        console.log(`[admin-auth] Password reset OTP for ${email}: ${otp}`);
    }
    return { ok: true };
}
export async function adminVerifyForgotOtp(email, code) {
    const user = await UserModel.findOne({ email });
    if (!user ||
        user.role !== 'admin' ||
        !user.passwordResetOtpHash ||
        !user.passwordResetOtpExpiresAt ||
        user.passwordResetOtpExpiresAt.getTime() < Date.now()) {
        throw new HttpError(401, 'Invalid or expired code', 'INVALID_OTP');
    }
    const match = await bcrypt.compare(code, user.passwordResetOtpHash);
    if (!match) {
        throw new HttpError(401, 'Invalid or expired code', 'INVALID_OTP');
    }
    user.passwordResetOtpHash = null;
    user.passwordResetOtpExpiresAt = null;
    await user.save();
    const resetToken = signPasswordResetToken(user.id);
    return { resetToken };
}
export async function adminResetPassword(resetToken, newPassword) {
    const payload = verifyPasswordResetToken(resetToken);
    const user = await UserModel.findById(payload.sub);
    if (!user || user.role !== 'admin') {
        throw new HttpError(401, 'Invalid reset token', 'INVALID_RESET_TOKEN');
    }
    assertNotBlocked(user);
    user.passwordHash = await bcrypt.hash(newPassword, PASSWORD_COST);
    user.passwordResetOtpHash = null;
    user.passwordResetOtpExpiresAt = null;
    await user.save();
    const accessToken = signAccessToken(user.id, user.email);
    return { user: toPublicUser(user), accessToken };
}
export async function getProfile(userId) {
    const user = await UserModel.findById(userId);
    if (!user) {
        throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
    }
    return { user: toPublicUser(user) };
}
/**
 * Whether `username` can be assigned to `userId` — invalid shape or taken by
 * another user makes it unavailable. The user's own current username is
 * reported as available (so re-saving an unchanged handle is fine).
 */
export async function checkUsernameAvailability(userId, rawUsername) {
    const username = rawUsername.trim().toLowerCase();
    if (!isValidUsernameShape(username)) {
        return { available: false, reason: 'invalid' };
    }
    const taken = await UserModel.exists({
        username,
        _id: { $ne: userId },
    });
    return taken ? { available: false, reason: 'taken' } : { available: true };
}
export async function fillProfile(userId, body) {
    const user = await UserModel.findById(userId);
    if (!user) {
        throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
    }
    if (body.username !== undefined && body.username !== user.username) {
        if (!isValidUsernameShape(body.username)) {
            throw new HttpError(400, 'Invalid username', 'INVALID_USERNAME');
        }
        // A username can only be changed once per 24 hours.
        const last = user.usernameUpdatedAt;
        if (last instanceof Date) {
            const msSince = Date.now() - last.getTime();
            if (msSince < USERNAME_CHANGE_COOLDOWN_MS) {
                const hours = Math.ceil((USERNAME_CHANGE_COOLDOWN_MS - msSince) / (60 * 60 * 1000));
                throw new HttpError(429, `You can change your username again in ${hours} hour${hours === 1 ? '' : 's'}`, 'USERNAME_CHANGE_COOLDOWN');
            }
        }
        const taken = await UserModel.exists({
            username: body.username,
            _id: { $ne: user._id },
        });
        if (taken) {
            throw new HttpError(409, 'Username is already taken', 'USERNAME_TAKEN');
        }
        user.username = body.username;
        user.usernameUpdatedAt = new Date();
    }
    if (body.email !== undefined && body.email !== user.email) {
        // Email is collected during onboarding; enforce uniqueness among real
        // emails (the partial index would also reject, but this gives a clean 409).
        const taken = await UserModel.exists({
            email: body.email,
            _id: { $ne: user._id },
        });
        if (taken) {
            throw new HttpError(409, 'Email is already registered', 'EMAIL_IN_USE');
        }
        user.email = body.email;
    }
    if (body.fullName !== undefined) {
        user.fullName = body.fullName;
    }
    if (body.phone !== undefined) {
        user.phone = body.phone;
    }
    if (body.address !== undefined) {
        user.address = body.address;
    }
    if (body.avatarUrl !== undefined) {
        user.avatarUrl = body.avatarUrl;
    }
    await user.save();
    return { user: toPublicUser(user) };
}
export async function markOnboardingComplete(userId) {
    const user = await UserModel.findById(userId);
    if (!user) {
        throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
    }
    // Email is mandatory to finish onboarding — it's the account-recovery channel.
    if (!user.email) {
        throw new HttpError(400, 'Add your email before finishing setup', 'EMAIL_REQUIRED');
    }
    user.isOnboarded = true;
    await user.save();
    return { user: toPublicUser(user) };
}
function uniqueTrimmedInterests(interests) {
    const seen = new Set();
    const out = [];
    for (const raw of interests) {
        const s = raw.trim();
        if (!s || seen.has(s)) {
            continue;
        }
        seen.add(s);
        out.push(s);
    }
    return out;
}
export async function updateOnboardingInterests(userId, interests) {
    const user = await UserModel.findById(userId);
    if (!user) {
        throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
    }
    user.interests = uniqueTrimmedInterests(interests);
    await user.save();
    return { user: toPublicUser(user) };
}
export async function updateOnboardingGender(userId, gender) {
    const user = await UserModel.findById(userId);
    if (!user) {
        throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
    }
    user.gender = gender;
    await user.save();
    return { user: toPublicUser(user) };
}
function parseCalendarDateUtc(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!m) {
        throw new HttpError(400, 'Invalid date of birth', 'INVALID_DOB');
    }
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10) - 1;
    const d = parseInt(m[3], 10);
    const dt = new Date(Date.UTC(y, mo, d));
    if (dt.getUTCFullYear() !== y ||
        dt.getUTCMonth() !== mo ||
        dt.getUTCDate() !== d) {
        throw new HttpError(400, 'Invalid date of birth', 'INVALID_DOB');
    }
    const today = new Date();
    const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    if (dt.getTime() > todayUtc) {
        throw new HttpError(400, 'Date of birth cannot be in the future', 'INVALID_DOB');
    }
    if (y < 1900) {
        throw new HttpError(400, 'Date of birth is too far in the past', 'INVALID_DOB');
    }
    return dt;
}
export async function updateOnboardingDob(userId, dateOfBirth) {
    const user = await UserModel.findById(userId);
    if (!user) {
        throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
    }
    user.dateOfBirth = parseCalendarDateUtc(dateOfBirth);
    await user.save();
    return { user: toPublicUser(user) };
}
export async function getBankAccount(userId) {
    const user = await UserModel.findById(userId).select('bankAccount');
    if (!user) {
        throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
    }
    return { bankAccount: user.bankAccount ?? null };
}
export async function saveBankAccount(userId, data) {
    const user = await UserModel.findById(userId);
    if (!user) {
        throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
    }
    user.bankAccount = {
        holderName: data.holderName,
        accountNumber: data.accountNumber,
        ifscCode: data.ifscCode,
        bankName: data.bankName,
        upiId: data.upiId ?? null,
    };
    await user.save();
    return { bankAccount: user.bankAccount };
}
export async function updatePrivacySettings(userId, settings) {
    const user = await UserModel.findById(userId);
    if (!user) {
        throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
    }
    if (typeof settings.isFollowersListPrivate === 'boolean') {
        user.isFollowersListPrivate = settings.isFollowersListPrivate;
    }
    if (typeof settings.notificationsEnabled === 'boolean') {
        user.notificationsEnabled = settings.notificationsEnabled;
    }
    await user.save();
    return { user: toPublicUser(user) };
}
/**
 * Register/refresh the caller's FCM device token. Single-token-per-user
 * model — if the same token already belongs to another user (device was
 * previously used by a different account), clear it there first so only
 * the currently-signed-in user receives pushes to that device.
 */
export async function registerPushToken(userId, token) {
    const trimmed = token.trim();
    if (!trimmed) {
        throw new HttpError(400, 'token is required', 'VALIDATION_ERROR');
    }
    // Detach this token from any other user (previous logged-in account).
    await UserModel.updateMany({ _id: { $ne: userId }, fcmToken: trimmed }, { $set: { fcmToken: null } });
    await UserModel.findByIdAndUpdate(userId, { fcmToken: trimmed });
    return { success: true };
}
/** Clear the caller's FCM token (called on logout). */
export async function clearPushToken(userId) {
    await UserModel.findByIdAndUpdate(userId, { fcmToken: null });
    return { success: true };
}
function isMongoDuplicateKey(err) {
    return (typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        err.code === 11000);
}
/**
 * Hard-delete the authenticated user's account.
 *
 * Cascades:
 *  - Owned content: posts, blogs, stories, transactions, withdrawal requests,
 *    feedback, reports the user filed.
 *  - Engagement on the user's owned content: likes/comments on their posts,
 *    views/reactions on their stories, favourites of their blogs.
 *  - Social relationships where the user participates: follows (both
 *    directions), blocks (both directions), post-likes by user, story-views
 *    by user, story-reactions by user, blog/track favourites, notifications.
 *
 * Conversations + messages are intentionally preserved — other users still
 * see the deleted user's messages, attributed to a missing-author state.
 *
 * Irreversible. Caller must confirm + clear their auth on the client.
 */
export async function deleteAccount(userId) {
    if (!mongoose.isValidObjectId(userId)) {
        throw new HttpError(400, 'Invalid user id', 'INVALID_USER_ID');
    }
    const user = await UserModel.findById(userId).select('_id').lean();
    if (!user) {
        throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
    }
    // 1. Capture the IDs of content owned by the user — needed to cascade-delete
    //    engagement on those rows (likes on their posts, views on their stories).
    const [ownedPostIds, ownedStoryIds, ownedBlogIds] = await Promise.all([
        PostModel.find({ author: userId }).select('_id').lean(),
        StoryModel.find({ author: userId }).select('_id').lean(),
        BlogModel.find({ author: userId }).select('_id').lean(),
    ]);
    const postIds = ownedPostIds.map((p) => p._id);
    const storyIds = ownedStoryIds.map((s) => s._id);
    const blogIds = ownedBlogIds.map((b) => b._id);
    // 2. Run all deletions in parallel. Best-effort: errors here would leave
    //    orphans, but cascades are idempotent — re-running deleteAccount cleans
    //    them up. Wrapped in a single try so a partial failure doesn't break
    //    the request handler — caller still sees ok:true.
    await Promise.all([
        // Engagement on the user's owned posts/stories/blogs
        postIds.length > 0
            ? PostLikeModel.deleteMany({ post: { $in: postIds } })
            : Promise.resolve(),
        postIds.length > 0
            ? CommentModel.deleteMany({ post: { $in: postIds } })
            : Promise.resolve(),
        storyIds.length > 0
            ? StoryViewModel.deleteMany({ story: { $in: storyIds } })
            : Promise.resolve(),
        storyIds.length > 0
            ? StoryReactionModel.deleteMany({ story: { $in: storyIds } })
            : Promise.resolve(),
        blogIds.length > 0
            ? BlogFavoriteModel.deleteMany({ blog: { $in: blogIds } })
            : Promise.resolve(),
        // Social/engagement made BY the user
        PostLikeModel.deleteMany({ user: userId }),
        CommentModel.deleteMany({ author: userId }),
        StoryViewModel.deleteMany({ viewer: userId }),
        StoryReactionModel.deleteMany({ user: userId }),
        BlogFavoriteModel.deleteMany({ user: userId }),
        MusicTrackFavouriteModel.deleteMany({ user: userId }),
        FollowModel.deleteMany({
            $or: [{ follower: userId }, { followee: userId }],
        }),
        UserBlockModel.deleteMany({
            $or: [{ blocker: userId }, { blocked: userId }],
        }),
        NotificationModel.deleteMany({
            $or: [{ recipient: userId }, { actor: userId }],
        }),
        ReportModel.deleteMany({ reporter: userId }),
        TransactionModel.deleteMany({ user: userId }),
        WithdrawalRequestModel.deleteMany({ user: userId }),
        FeedbackModel.deleteMany({ user: userId }),
        // Owned content itself
        PostModel.deleteMany({ author: userId }),
        BlogModel.deleteMany({ author: userId }),
        StoryModel.deleteMany({ author: userId }),
    ]);
    // 3. Finally, the user document itself.
    await UserModel.deleteOne({ _id: userId });
    return { ok: true };
}
