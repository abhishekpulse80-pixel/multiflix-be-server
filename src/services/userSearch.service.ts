import mongoose, { type Types } from 'mongoose';
import { HttpError } from '../lib/httpError.js';
import { UserModel } from '../models/user.model.js';
import { listHiddenUserIds } from './userBlock.service.js';

export type UserSearchItemDto = {
  id: string;
  username: string;
  fullName: string | null;
  avatarUrl: string | null;
};

export type UserSearchResponse = {
  items: UserSearchItemDto[];
};

function assertObjectId(id: string): void {
  if (!mongoose.isValidObjectId(id)) {
    throw new HttpError(400, 'Invalid user id', 'INVALID_USER_ID');
  }
}

/**
 * Case-insensitive substring match on username or fullName.
 * Only onboarded users; excludes the viewer.
 */
export async function searchUsers(
  viewerId: string,
  rawQuery: string,
  limit: number,
): Promise<UserSearchResponse> {
  assertObjectId(viewerId);
  const q = rawQuery.trim();
  if (q.length === 0) {
    return { items: [] };
  }
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escaped, 'i');

  type Lean = {
    _id: Types.ObjectId;
    username: string;
    fullName: string | null;
    avatarUrl: string | null;
  };

  const hiddenIds = await listHiddenUserIds(viewerId);
  const excludeOids = [
    new mongoose.Types.ObjectId(viewerId),
    ...hiddenIds.map((id) => new mongoose.Types.ObjectId(id)),
  ];

  const docs = (await UserModel.find({
    isOnboarded: true,
    role: { $ne: 'admin' },
    _id: { $nin: excludeOids },
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
