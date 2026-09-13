import mongoose from 'mongoose';
import { getFirebaseAdmin } from '../lib/firebase.js';
import { HttpError } from '../lib/httpError.js';
import { NotificationModel, } from '../models/notification.model.js';
import { PostModel } from '../models/post.model.js';
import { UserModel } from '../models/user.model.js';
/**
 * Send an FCM push to a specific device token. Best-effort:
 * errors are caught and logged so callers never fail because of a bad token.
 * Returns `true` if delivered, `false` otherwise.
 */
export async function sendToToken(token, payload) {
    if (!token)
        return false;
    const firebase = getFirebaseAdmin();
    if (!firebase)
        return false;
    try {
        await firebase.messaging().send({
            token,
            notification: {
                title: payload.title,
                body: payload.body,
            },
            data: {
                type: payload.type,
                ...(payload.data ?? {}),
            },
            android: {
                priority: 'high',
                notification: { sound: 'default' },
            },
            apns: {
                payload: {
                    aps: { sound: 'default', badge: 1 },
                },
            },
        });
        return true;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        const code = typeof err === 'object' && err !== null && 'code' in err
            ? String(err.code)
            : '';
        console.warn('[push] send failed:', code || msg);
        // If the token is invalid/unregistered, clear it so we stop trying.
        if (code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/invalid-argument') {
            try {
                await UserModel.updateMany({ fcmToken: token }, { $set: { fcmToken: null } });
            }
            catch {
                // swallow — cleanup is best-effort
            }
        }
        return false;
    }
}
/**
 * FCM topic every authenticated mobile client subscribes to on launch.
 * Used by `sendBroadcast` for admin-initiated announcements.
 */
export const BROADCAST_TOPIC = 'all_users';
/**
 * Send a plain title+body push to every device subscribed to `BROADCAST_TOPIC`.
 * Returns `true` if FCM accepted the message, `false` if FCM is unconfigured
 * or the call failed. Admin caller should surface the boolean in the UI.
 */
export async function sendBroadcast(title, body) {
    const firebase = getFirebaseAdmin();
    if (!firebase) {
        console.warn('[push] sendBroadcast: Firebase admin not configured');
        return false;
    }
    try {
        await firebase.messaging().send({
            topic: BROADCAST_TOPIC,
            notification: { title, body },
            data: { type: 'broadcast' },
            android: {
                priority: 'high',
                notification: { sound: 'default' },
            },
            apns: {
                payload: { aps: { sound: 'default' } },
            },
        });
        return true;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        console.warn('[push] sendBroadcast failed:', msg);
        return false;
    }
}
/**
 * Convenience: load the recipient user, pull their `fcmToken`, and send.
 * No-op if the user has no token or FCM is not configured.
 */
export async function sendToUser(userId, payload) {
    try {
        const user = await UserModel.findById(userId)
            .select('fcmToken notificationsEnabled')
            .lean();
        if (!user?.fcmToken)
            return false;
        // Respect the user's notifications toggle.
        if (user.notificationsEnabled === false)
            return false;
        return await sendToToken(user.fcmToken, payload);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        console.warn('[push] sendToUser failed:', msg);
        return false;
    }
}
// ----------------------------------------------------------------------------
// Inbox (DB-backed notifications) — list, mark-read, unread-count.
// ----------------------------------------------------------------------------
function assertObjectId(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new HttpError(400, 'Invalid id', 'INVALID_ID');
    }
}
/**
 * Notification types where there should only ever be ONE row per
 * (recipient, actor, post). These are toggleable actions — a user can
 * unlike→re-like a post, or unfollow→re-follow — so naively inserting on
 * every trigger spams the inbox with duplicates. For these we upsert and
 * "bump" the single existing row instead.
 */
const COLLAPSIBLE_TYPES = new Set([
    'post_like',
    'new_follower',
    'blog_like',
    'story_reaction',
]);
/**
 * Persist a notification. Best-effort: swallows errors so callers
 * (post like, follow, comment, withdrawal decisions) never fail because
 * of a notification write. Skips self-notifications when an actor is set
 * and matches the recipient.
 *
 * Returns `true` only when a brand-new row was inserted. For collapsible
 * types (likes, follows) a repeat trigger bumps the existing row to the top
 * (and marks it unread) and returns `false` — callers use this to avoid
 * re-sending a push on every unlike→re-like cycle.
 */
export async function createNotification(input) {
    try {
        if (input.actor && input.recipient === input.actor)
            return false;
        if (COLLAPSIBLE_TYPES.has(input.type) && input.actor) {
            const filter = {
                recipient: input.recipient,
                actor: input.actor,
                type: input.type,
            };
            // Keep one row per target: post (likes), blog (favorites), or story
            // (reactions). Follows have none of these → one row per (recipient, actor).
            if (input.post)
                filter.post = input.post;
            if (input.blog)
                filter.blog = input.blog;
            if (input.story)
                filter.story = input.story;
            const now = new Date();
            const res = await NotificationModel.updateOne(filter, {
                // Bump to the top of the inbox and resurface as unread, but never
                // create a second row for the same (recipient, actor, type, target).
                $set: {
                    isRead: false,
                    createdAt: now,
                    updatedAt: now,
                    ...(input.meta ? { meta: input.meta } : {}),
                },
            }, { upsert: true, timestamps: false });
            return res.upsertedCount === 1;
        }
        await NotificationModel.create({
            recipient: input.recipient,
            actor: input.actor ?? null,
            type: input.type,
            post: input.post,
            comment: input.comment,
            blog: input.blog,
            story: input.story,
            meta: input.meta ?? null,
            isRead: false,
        });
        return true;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        console.warn('[notification] create failed:', msg);
        return false;
    }
}
/** Paginated inbox for the authenticated user, newest first. */
export async function listForUser(userId, page, limit) {
    assertObjectId(userId);
    const filter = { recipient: userId };
    const [rows, total] = await Promise.all([
        NotificationModel.find(filter)
            .sort({ createdAt: -1, _id: -1 })
            .skip(page * limit)
            .limit(limit)
            .lean()
            .exec(),
        NotificationModel.countDocuments(filter),
    ]);
    if (rows.length === 0) {
        return { items: [], page, limit, total, hasMore: false };
    }
    // Batch-fetch actors and posts (system rows have no actor)
    const actorIds = Array.from(new Set(rows
        .map(r => r.actor)
        .filter((a) => a != null)
        .map(a => a.toString())));
    const postIds = Array.from(new Set(rows
        .map(r => r.post?.toString())
        .filter((id) => !!id)));
    const [actors, posts] = await Promise.all([
        UserModel.find({ _id: { $in: actorIds } }, { username: 1, fullName: 1, avatarUrl: 1 })
            .lean()
            .exec(),
        postIds.length > 0
            ? PostModel.find({ _id: { $in: postIds } }, { mediaKind: 1, media: 1, thumbnailUrl: 1 })
                .lean()
                .exec()
            : Promise.resolve([]),
    ]);
    const actorMap = new Map(actors.map(u => [
        u._id.toString(),
        {
            id: u._id.toString(),
            username: u.username ?? '',
            fullName: u.fullName ?? null,
            avatarUrl: u.avatarUrl ?? null,
        },
    ]));
    const postMap = new Map(posts.map(p => {
        const pid = p._id.toString();
        const mediaKind = p
            .mediaKind;
        const mediaUrl = p.media?.url ?? null;
        const thumbnailUrl = p.thumbnailUrl ?? null;
        return [pid, { id: pid, mediaKind, mediaUrl, thumbnailUrl }];
    }));
    const items = rows
        .map(r => {
        const row = r;
        let actor = null;
        if (row.actor) {
            const mapped = actorMap.get(row.actor.toString());
            if (!mapped)
                return null; // actor vanished (deleted user) — skip row
            actor = mapped;
        }
        const post = row.post ? (postMap.get(row.post.toString()) ?? null) : null;
        return {
            id: row._id.toString(),
            type: row.type,
            isRead: row.isRead,
            createdAt: row.createdAt.toISOString(),
            actor,
            post,
            commentId: row.comment ? row.comment.toString() : null,
            blogId: row.blog ? row.blog.toString() : null,
            storyId: row.story ? row.story.toString() : null,
            meta: row.meta ?? null,
        };
    })
        .filter((x) => x !== null);
    return {
        items,
        page,
        limit,
        total,
        hasMore: page * limit + rows.length < total,
    };
}
export async function getUnreadCount(userId) {
    assertObjectId(userId);
    return NotificationModel.countDocuments({
        recipient: userId,
        isRead: false,
    });
}
export async function markAsRead(userId, notificationId) {
    assertObjectId(userId);
    assertObjectId(notificationId);
    const result = await NotificationModel.updateOne({ _id: notificationId, recipient: userId }, { $set: { isRead: true } });
    if (result.matchedCount === 0) {
        throw new HttpError(404, 'Notification not found', 'NOTIFICATION_NOT_FOUND');
    }
}
export async function markAllAsRead(userId) {
    assertObjectId(userId);
    const result = await NotificationModel.updateMany({ recipient: userId, isRead: false }, { $set: { isRead: true } });
    return result.modifiedCount;
}
