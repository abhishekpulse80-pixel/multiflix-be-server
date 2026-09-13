import mongoose, { type Types } from 'mongoose';
import { HttpError } from '../lib/httpError.js';
import { FollowModel } from '../models/follow.model.js';
import { UserBlockModel } from '../models/userBlock.model.js';
import { UserModel } from '../models/user.model.js';

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

/**
 * `true` if either side has blocked the other. Use this to gate visibility
 * across feed, search, profile, chat, stories, etc.
 */
export async function isBlockedBetween(
  userAId: string,
  userBId: string,
): Promise<boolean> {
  if (!mongoose.isValidObjectId(userAId) || !mongoose.isValidObjectId(userBId)) {
    return false;
  }
  if (userAId === userBId) return false;
  const doc = await UserBlockModel.exists({
    $or: [
      { blocker: userAId, blocked: userBId },
      { blocker: userBId, blocked: userAId },
    ],
  });
  return doc !== null;
}

/** `true` only if `blockerId` has actively blocked `otherId`. */
export async function hasBlocked(
  blockerId: string,
  otherId: string,
): Promise<boolean> {
  if (!mongoose.isValidObjectId(blockerId) || !mongoose.isValidObjectId(otherId)) {
    return false;
  }
  const doc = await UserBlockModel.exists({ blocker: blockerId, blocked: otherId });
  return doc !== null;
}

/**
 * Return the set of user ids the viewer cannot see (either blocked by viewer
 * or users who blocked the viewer). Use to filter lists in a single query.
 */
export async function listHiddenUserIds(viewerId: string): Promise<string[]> {
  if (!mongoose.isValidObjectId(viewerId)) return [];
  type Row = { blocker: Types.ObjectId; blocked: Types.ObjectId };
  const rows = (await UserBlockModel.find({
    $or: [{ blocker: viewerId }, { blocked: viewerId }],
  })
    .select('blocker blocked')
    .lean()) as Row[];
  const ids = new Set<string>();
  for (const r of rows) {
    const blocker = r.blocker.toString();
    const blocked = r.blocked.toString();
    if (blocker === viewerId) ids.add(blocked);
    else ids.add(blocker);
  }
  return [...ids];
}

/**
 * Block `targetId` from the perspective of `blockerId`.
 * Idempotent. Also tears down follow edges in both directions.
 */
export async function blockUser(
  blockerId: string,
  targetId: string,
): Promise<{ blocked: true }> {
  assertObjectId(blockerId);
  assertObjectId(targetId);
  if (blockerId === targetId) {
    throw new HttpError(400, 'Cannot block yourself', 'CANNOT_BLOCK_SELF');
  }
  const targetExists = await UserModel.exists({ _id: targetId });
  if (!targetExists) {
    throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
  }
  try {
    await UserBlockModel.create({ blocker: blockerId, blocked: targetId });
  } catch (err: unknown) {
    if (!isDuplicateKeyError(err)) throw err;
  }
  // Hard break: remove mutual follow edges so counts stay honest.
  await FollowModel.deleteMany({
    $or: [
      { follower: blockerId, followee: targetId },
      { follower: targetId, followee: blockerId },
    ],
  });
  return { blocked: true };
}

/** Unblock. Idempotent. Does NOT restore follow edges. */
export async function unblockUser(
  blockerId: string,
  targetId: string,
): Promise<{ blocked: false }> {
  assertObjectId(blockerId);
  assertObjectId(targetId);
  await UserBlockModel.deleteOne({ blocker: blockerId, blocked: targetId });
  return { blocked: false };
}

export type BlockedUserDto = {
  id: string;
  username: string;
  fullName: string | null;
  avatarUrl: string | null;
  blockedAt: string;
};

/** Users the viewer has blocked (for the "Blocked Users" settings screen). */
export async function listBlockedUsers(
  blockerId: string,
  page = 0,
  limit = 30,
): Promise<{
  items: BlockedUserDto[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}> {
  assertObjectId(blockerId);
  const total = await UserBlockModel.countDocuments({ blocker: blockerId });
  const rows = await UserBlockModel.find({ blocker: blockerId })
    .sort({ createdAt: -1 })
    .skip(page * limit)
    .limit(limit)
    .lean()
    .exec();

  if (rows.length === 0) {
    return { items: [], page, limit, total, hasMore: false };
  }

  type Row = { blocked: Types.ObjectId; createdAt: Date };
  const typedRows = rows as Row[];
  const ids = typedRows.map((r) => r.blocked);

  type UserLean = {
    _id: Types.ObjectId;
    username?: string;
    fullName?: string | null;
    avatarUrl?: string | null;
  };
  const users = (await UserModel.find(
    { _id: { $in: ids } },
    { username: 1, fullName: 1, avatarUrl: 1 },
  )
    .lean()
    .exec()) as UserLean[];
  const userMap = new Map(users.map((u) => [u._id.toString(), u]));

  const items: BlockedUserDto[] = typedRows
    .map((r) => {
      const uid = r.blocked.toString();
      const u = userMap.get(uid);
      if (!u) return null;
      return {
        id: uid,
        username: u.username ?? '',
        fullName: u.fullName ?? null,
        avatarUrl: u.avatarUrl ?? null,
        blockedAt: r.createdAt.toISOString(),
      };
    })
    .filter((x): x is BlockedUserDto => x !== null);

  return {
    items,
    page,
    limit,
    total,
    hasMore: page * limit + rows.length < total,
  };
}
