import mongoose, { type Types } from 'mongoose';
import { HttpError } from '../lib/httpError.js';
import { FollowModel } from '../models/follow.model.js';
import { UserModel } from '../models/user.model.js';
import { createNotification, sendToUser } from './notification.service.js';

function assertObjectId(id: string): void {
  if (!mongoose.isValidObjectId(id)) {
    throw new HttpError(400, 'Invalid user id', 'INVALID_USER_ID');
  }
}

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 11000
  );
}

export async function countFollowers(userId: string): Promise<number> {
  return FollowModel.countDocuments({ followee: userId });
}

export async function countFollowing(userId: string): Promise<number> {
  return FollowModel.countDocuments({ follower: userId });
}

export async function isFollowing(
  followerId: string,
  followeeId: string,
): Promise<boolean> {
  assertObjectId(followerId);
  assertObjectId(followeeId);
  const doc = await FollowModel.exists({ follower: followerId, followee: followeeId });
  return doc !== null;
}

/** User ids the viewer follows (for blog “following” tab, etc.). */
export async function listFolloweeIds(followerId: string): Promise<string[]> {
  assertObjectId(followerId);
  type Row = { followee: Types.ObjectId };
  const rows = (await FollowModel.find({ follower: followerId })
    .select('followee')
    .lean()) as Row[];
  return rows.map((r) => r.followee.toString());
}

/** Ids of users who follow `userId` (their followers). */
export async function listFollowerIds(userId: string): Promise<string[]> {
  assertObjectId(userId);
  type Row = { follower: Types.ObjectId };
  const rows = (await FollowModel.find({ followee: userId })
    .select('follower')
    .lean()) as Row[];
  return rows.map((r) => r.follower.toString());
}

export type FollowerDto = {
  id: string;
  username: string;
  fullName: string | null;
  avatarUrl: string | null;
  /** Whether the viewer (requester) follows this user back. */
  isFollowedBack: boolean;
  /** Whether this user follows the viewer — drives the "Follow Back" label. */
  followsYou: boolean;
};

/**
 * Paginated list of users who follow `userId`.
 * For each follower, also reports whether the `viewerId` follows them back.
 */
export async function listFollowers(
  userId: string,
  viewerId: string,
  page = 0,
  limit = 30,
): Promise<{ items: FollowerDto[]; page: number; limit: number; total: number; hasMore: boolean }> {
  assertObjectId(userId);

  // Enforce privacy: only the owner can view their followers list when private.
  if (viewerId !== userId) {
    const owner = await UserModel.findById(userId)
      .select('isFollowersListPrivate')
      .lean();
    if (!owner) {
      throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
    }
    if ((owner as { isFollowersListPrivate?: boolean }).isFollowersListPrivate) {
      throw new HttpError(
        403,
        'Followers list is private',
        'FOLLOWERS_LIST_PRIVATE',
      );
    }
  }

  const total = await FollowModel.countDocuments({ followee: userId });
  const rows = await FollowModel.find({ followee: userId })
    .sort({ createdAt: -1 })
    .skip(page * limit)
    .limit(limit)
    .lean()
    .exec();

  if (rows.length === 0) {
    return { items: [], page, limit, total, hasMore: false };
  }

  const followerIds = rows.map(r => (r as { follower: Types.ObjectId }).follower);

  // Batch-fetch user profiles
  const users = await UserModel.find(
    { _id: { $in: followerIds } },
    { username: 1, fullName: 1, avatarUrl: 1 },
  ).lean().exec();

  const userMap = new Map(
    users.map(u => [u._id.toString(), u]),
  );

  // Batch-check which of these users the viewer follows back, and which of
  // them follow the viewer (drives the "Follow Back" label).
  const [viewerFollows, followsViewer] = await Promise.all([
    FollowModel.find({
      follower: viewerId,
      followee: { $in: followerIds },
    }).select('followee').lean().exec(),
    FollowModel.find({
      follower: { $in: followerIds },
      followee: viewerId,
    }).select('follower').lean().exec(),
  ]);

  const followedBackSet = new Set(
    viewerFollows.map(f => (f as { followee: Types.ObjectId }).followee.toString()),
  );
  const followsYouSet = new Set(
    followsViewer.map(f => (f as { follower: Types.ObjectId }).follower.toString()),
  );

  const items: FollowerDto[] = rows
    .map(r => {
      const fId = (r as { follower: Types.ObjectId }).follower.toString();
      const u = userMap.get(fId);
      if (!u) return null;
      return {
        id: fId,
        username: (u as { username?: string }).username ?? '',
        fullName: (u as { fullName?: string | null }).fullName ?? null,
        avatarUrl: (u as { avatarUrl?: string | null }).avatarUrl ?? null,
        isFollowedBack: followedBackSet.has(fId),
        followsYou: followsYouSet.has(fId),
      };
    })
    .filter((x): x is FollowerDto => x !== null);

  return { items, page, limit, total, hasMore: page * limit + rows.length < total };
}

/**
 * Paginated list of users that `userId` follows (i.e. their "following" list).
 * For each user, also reports whether the `viewerId` follows them as well.
 */
export async function listFollowing(
  userId: string,
  viewerId: string,
  page = 0,
  limit = 30,
): Promise<{ items: FollowerDto[]; page: number; limit: number; total: number; hasMore: boolean }> {
  assertObjectId(userId);

  const total = await FollowModel.countDocuments({ follower: userId });
  const rows = await FollowModel.find({ follower: userId })
    .sort({ createdAt: -1 })
    .skip(page * limit)
    .limit(limit)
    .lean()
    .exec();

  if (rows.length === 0) {
    return { items: [], page, limit, total, hasMore: false };
  }

  const followeeIds = rows.map(r => (r as { followee: Types.ObjectId }).followee);

  // Batch-fetch user profiles
  const users = await UserModel.find(
    { _id: { $in: followeeIds } },
    { username: 1, fullName: 1, avatarUrl: 1 },
  ).lean().exec();

  const userMap = new Map(
    users.map(u => [u._id.toString(), u]),
  );

  // Batch-check which of these users the viewer follows, and which follow
  // the viewer (drives the "Follow Back" label).
  const [viewerFollows, followsViewer] = await Promise.all([
    FollowModel.find({
      follower: viewerId,
      followee: { $in: followeeIds },
    }).select('followee').lean().exec(),
    FollowModel.find({
      follower: { $in: followeeIds },
      followee: viewerId,
    }).select('follower').lean().exec(),
  ]);

  const followedBackSet = new Set(
    viewerFollows.map(f => (f as { followee: Types.ObjectId }).followee.toString()),
  );
  const followsYouSet = new Set(
    followsViewer.map(f => (f as { follower: Types.ObjectId }).follower.toString()),
  );

  const items: FollowerDto[] = rows
    .map(r => {
      const fId = (r as { followee: Types.ObjectId }).followee.toString();
      const u = userMap.get(fId);
      if (!u) return null;
      return {
        id: fId,
        username: (u as { username?: string }).username ?? '',
        fullName: (u as { fullName?: string | null }).fullName ?? null,
        avatarUrl: (u as { avatarUrl?: string | null }).avatarUrl ?? null,
        isFollowedBack: followedBackSet.has(fId),
        followsYou: followsYouSet.has(fId),
      };
    })
    .filter((x): x is FollowerDto => x !== null);

  return { items, page, limit, total, hasMore: page * limit + rows.length < total };
}

export type ConnectionSearchItemDto = {
  id: string;
  username: string;
  fullName: string | null;
  avatarUrl: string | null;
};

/**
 * Search users in the caller's follow network (people I follow + who follow me)
 * by username or fullName substring (case-insensitive).
 */
export async function searchConnections(
  viewerId: string,
  rawQuery: string,
  limit = 20,
): Promise<{ items: ConnectionSearchItemDto[] }> {
  assertObjectId(viewerId);
  const q = rawQuery.trim();
  if (q.length === 0) {
    return { items: [] };
  }

  const viewerOid = new mongoose.Types.ObjectId(viewerId);

  // Gather all connected user IDs
  const [followingDocs, followerDocs] = await Promise.all([
    FollowModel.find({ follower: viewerOid }).select('followee').lean(),
    FollowModel.find({ followee: viewerOid }).select('follower').lean(),
  ]);

  const connectedIdSet = new Set<string>();
  for (const d of followingDocs) connectedIdSet.add(d.followee.toString());
  for (const d of followerDocs) connectedIdSet.add(d.follower.toString());
  connectedIdSet.delete(viewerId);

  if (connectedIdSet.size === 0) {
    return { items: [] };
  }

  const connectedIds = [...connectedIdSet].map(
    (id) => new mongoose.Types.ObjectId(id),
  );

  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escaped, 'i');

  type Lean = {
    _id: Types.ObjectId;
    username: string;
    fullName: string | null;
    avatarUrl: string | null;
  };

  const docs = (await UserModel.find({
    _id: { $in: connectedIds },
    $or: [{ username: regex }, { fullName: regex }],
  })
    .select('_id username fullName avatarUrl')
    .sort({ username: 1 })
    .limit(limit)
    .lean()
    .exec()) as Lean[];

  return {
    items: docs.map((d) => ({
      id: d._id.toString(),
      username: d.username,
      fullName: d.fullName ?? null,
      avatarUrl: d.avatarUrl ?? null,
    })),
  };
}

/**
 * Immediate follow (no approval). Idempotent if already following.
 */
export async function followUser(
  followerId: string,
  followeeId: string,
): Promise<{ following: boolean }> {
  assertObjectId(followerId);
  assertObjectId(followeeId);
  if (followerId === followeeId) {
    throw new HttpError(400, 'Cannot follow yourself', 'CANNOT_FOLLOW_SELF');
  }
  const followeeExists = await UserModel.exists({ _id: followeeId });
  if (!followeeExists) {
    throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
  }
  let created = false;
  try {
    await FollowModel.create({
      follower: followerId,
      followee: followeeId,
    });
    created = true;
  } catch (err: unknown) {
    if (isDuplicateKeyError(err)) {
      return { following: true };
    }
    throw err;
  }

  // Fire-and-forget push — only on the first follow, not on idempotent re-calls.
  if (created) {
    void (async () => {
      try {
        const follower = await UserModel.findById(followerId)
          .select('fullName username')
          .lean<{
            fullName: string | null;
            username: string;
          }>();
        const name =
          follower?.fullName?.trim() ||
          follower?.username ||
          'Someone';
        const isNewNotification = await createNotification({
          recipient: followeeId,
          actor: followerId,
          type: 'new_follower',
        });
        // Only push on a brand-new follow notification — re-following (after
        // an unfollow) just bumps the existing inbox row, so don't re-push.
        if (isNewNotification) {
          await sendToUser(followeeId, {
            type: 'new_follower',
            title: 'New follower',
            body: `${name} started following you`,
            data: { followerId },
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        console.warn('[follow] push dispatch failed:', msg);
      }
    })();
  }
  return { following: true };
}

/**
 * Unfollow. Idempotent if not following.
 */
export async function unfollowUser(
  followerId: string,
  followeeId: string,
): Promise<{ following: boolean }> {
  assertObjectId(followerId);
  assertObjectId(followeeId);
  await FollowModel.deleteOne({ follower: followerId, followee: followeeId });
  return { following: false };
}
