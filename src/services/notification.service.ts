import mongoose, { type Types } from 'mongoose';
import { getFirebaseAdmin } from '../lib/firebase.js';
import { HttpError } from '../lib/httpError.js';
import {
  NotificationModel,
  type NotificationType,
} from '../models/notification.model.js';
import { PostModel } from '../models/post.model.js';
import { UserModel } from '../models/user.model.js';

/**
 * Types of push notifications the backend can send. The client uses the
 * `type` in `data` to decide which screen to deep-link to.
 */
export type PushType =
  | 'chat_message'
  | 'new_follower'
  | 'post_like'
  | 'post_comment'
  | 'blog_like'
  | 'story_reaction'
  | 'withdrawal_approved'
  | 'withdrawal_rejected';

export type PushPayload = {
  type: PushType;
  title: string;
  body: string;
  /** Arbitrary string-valued payload used by the client for deep-linking. */
  data?: Record<string, string>;
};

/**
 * Send an FCM push to a specific device token. Best-effort:
 * errors are caught and logged so callers never fail because of a bad token.
 * Returns `true` if delivered, `false` otherwise.
 */
export async function sendToToken(
  token: string,
  payload: PushPayload,
): Promise<boolean> {
  if (!token) return false;
  const firebase = getFirebaseAdmin();
  if (!firebase) return false;

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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code?: unknown }).code)
        : '';
    console.warn('[push] send failed:', code || msg);

    // If the token is invalid/unregistered, clear it so we stop trying.
    if (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token' ||
      code === 'messaging/invalid-argument'
    ) {
      try {
        await UserModel.updateMany(
          { fcmToken: token },
          { $set: { fcmToken: null } },
        );
      } catch {
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
export async function sendBroadcast(
  title: string,
  body: string,
): Promise<boolean> {
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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.warn('[push] sendBroadcast failed:', msg);
    return false;
  }
}

/**
 * Convenience: load the recipient user, pull their `fcmToken`, and send.
 * No-op if the user has no token or FCM is not configured.
 */
export async function sendToUser(
  userId: string,
  payload: PushPayload,
): Promise<boolean> {
  try {
    const user = await UserModel.findById(userId)
      .select('fcmToken notificationsEnabled')
      .lean<{ fcmToken: string | null; notificationsEnabled?: boolean }>();
    if (!user?.fcmToken) return false;
    // Respect the user's notifications toggle.
    if (user.notificationsEnabled === false) return false;
    return await sendToToken(user.fcmToken, payload);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.warn('[push] sendToUser failed:', msg);
    return false;
  }
}

// ----------------------------------------------------------------------------
// Inbox (DB-backed notifications) — list, mark-read, unread-count.
// ----------------------------------------------------------------------------

function assertObjectId(id: string): void {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new HttpError(400, 'Invalid id', 'INVALID_ID');
  }
}

export type CreateNotificationInput = {
  recipient: string;
  /** Omit for system notifications (e.g. withdrawal decisions). */
  actor?: string;
  type: NotificationType;
  post?: string;
  comment?: string;
  /** Set for blog_like. */
  blog?: string;
  /** Set for story_reaction. */
  story?: string;
  /** Generic payload for system notifications (e.g. `{ amount, requestId }`). */
  meta?: Record<string, unknown>;
};

/**
 * Notification types where there should only ever be ONE row per
 * (recipient, actor, post). These are toggleable actions — a user can
 * unlike→re-like a post, or unfollow→re-follow — so naively inserting on
 * every trigger spams the inbox with duplicates. For these we upsert and
 * "bump" the single existing row instead.
 */
const COLLAPSIBLE_TYPES: ReadonlySet<NotificationType> = new Set([
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
export async function createNotification(
  input: CreateNotificationInput,
): Promise<boolean> {
  try {
    if (input.actor && input.recipient === input.actor) return false;

    if (COLLAPSIBLE_TYPES.has(input.type) && input.actor) {
      const filter: Record<string, unknown> = {
        recipient: input.recipient,
        actor: input.actor,
        type: input.type,
      };
      // Keep one row per target: post (likes), blog (favorites), or story
      // (reactions). Follows have none of these → one row per (recipient, actor).
      if (input.post) filter.post = input.post;
      if (input.blog) filter.blog = input.blog;
      if (input.story) filter.story = input.story;
      const now = new Date();
      const res = await NotificationModel.updateOne(
        filter,
        {
          // Bump to the top of the inbox and resurface as unread, but never
          // create a second row for the same (recipient, actor, type, target).
          $set: {
            isRead: false,
            createdAt: now,
            updatedAt: now,
            ...(input.meta ? { meta: input.meta } : {}),
          },
        },
        { upsert: true, timestamps: false },
      );
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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.warn('[notification] create failed:', msg);
    return false;
  }
}

export type NotificationActorDto = {
  id: string;
  username: string;
  fullName: string | null;
  avatarUrl: string | null;
};

export type NotificationPostDto = {
  id: string;
  mediaKind: 'image' | 'short_video';
  mediaUrl: string | null;
  thumbnailUrl: string | null;
};

export type NotificationDto = {
  id: string;
  type: NotificationType;
  isRead: boolean;
  createdAt: string;
  /** `null` for system notifications (e.g. withdrawal decisions). */
  actor: NotificationActorDto | null;
  post: NotificationPostDto | null;
  commentId: string | null;
  /** Set for blog_like — drives "open the blog" navigation. */
  blogId: string | null;
  /** Set for story_reaction — drives "open the story" navigation. */
  storyId: string | null;
  /** Generic payload for system notifications — mirrors `Notification.meta`. */
  meta: Record<string, unknown> | null;
};

export type ListNotificationsResult = {
  items: NotificationDto[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
};

/** Paginated inbox for the authenticated user, newest first. */
export async function listForUser(
  userId: string,
  page: number,
  limit: number,
): Promise<ListNotificationsResult> {
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
  const actorIds = Array.from(
    new Set(
      rows
        .map(r => (r as { actor: Types.ObjectId | null }).actor)
        .filter((a): a is Types.ObjectId => a != null)
        .map(a => a.toString()),
    ),
  );
  const postIds = Array.from(
    new Set(
      rows
        .map(r => (r as { post?: Types.ObjectId }).post?.toString())
        .filter((id): id is string => !!id),
    ),
  );

  const [actors, posts] = await Promise.all([
    UserModel.find(
      { _id: { $in: actorIds } },
      { username: 1, fullName: 1, avatarUrl: 1 },
    )
      .lean()
      .exec(),
    postIds.length > 0
      ? PostModel.find(
          { _id: { $in: postIds } },
          { mediaKind: 1, media: 1, thumbnailUrl: 1 },
        )
          .lean()
          .exec()
      : Promise.resolve([]),
  ]);

  const actorMap = new Map<string, NotificationActorDto>(
    actors.map(u => [
      u._id.toString(),
      {
        id: u._id.toString(),
        username: (u as { username?: string }).username ?? '',
        fullName: (u as { fullName?: string | null }).fullName ?? null,
        avatarUrl: (u as { avatarUrl?: string | null }).avatarUrl ?? null,
      },
    ]),
  );

  const postMap = new Map<string, NotificationPostDto>(
    posts.map(p => {
      const pid = (p as { _id: Types.ObjectId })._id.toString();
      const mediaKind = (p as { mediaKind: 'image' | 'short_video' })
        .mediaKind;
      const mediaUrl =
        (p as { media?: { url?: string | null } }).media?.url ?? null;
      const thumbnailUrl =
        (p as { thumbnailUrl?: string | null }).thumbnailUrl ?? null;
      return [pid, { id: pid, mediaKind, mediaUrl, thumbnailUrl }];
    }),
  );

  const items: NotificationDto[] = rows
    .map(r => {
      const row = r as {
        _id: Types.ObjectId;
        type: NotificationType;
        isRead: boolean;
        createdAt: Date;
        actor: Types.ObjectId | null;
        post?: Types.ObjectId;
        comment?: Types.ObjectId;
        blog?: Types.ObjectId;
        story?: Types.ObjectId;
        meta?: Record<string, unknown> | null;
      };
      let actor: NotificationActorDto | null = null;
      if (row.actor) {
        const mapped = actorMap.get(row.actor.toString());
        if (!mapped) return null; // actor vanished (deleted user) — skip row
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
    .filter((x): x is NotificationDto => x !== null);

  return {
    items,
    page,
    limit,
    total,
    hasMore: page * limit + rows.length < total,
  };
}

export async function getUnreadCount(userId: string): Promise<number> {
  assertObjectId(userId);
  return NotificationModel.countDocuments({
    recipient: userId,
    isRead: false,
  });
}

export async function markAsRead(
  userId: string,
  notificationId: string,
): Promise<void> {
  assertObjectId(userId);
  assertObjectId(notificationId);
  const result = await NotificationModel.updateOne(
    { _id: notificationId, recipient: userId },
    { $set: { isRead: true } },
  );
  if (result.matchedCount === 0) {
    throw new HttpError(404, 'Notification not found', 'NOTIFICATION_NOT_FOUND');
  }
}

export async function markAllAsRead(userId: string): Promise<number> {
  assertObjectId(userId);
  const result = await NotificationModel.updateMany(
    { recipient: userId, isRead: false },
    { $set: { isRead: true } },
  );
  return result.modifiedCount;
}
