import mongoose from 'mongoose';
import { HttpError } from '../lib/httpError.js';
import { UserModel } from '../models/user.model.js';
import { listHiddenUserIds } from './userBlock.service.js';
function assertObjectId(id) {
    if (!mongoose.isValidObjectId(id)) {
        throw new HttpError(400, 'Invalid user id', 'INVALID_USER_ID');
    }
}
/**
 * Case-insensitive substring match on username or fullName.
 * Only onboarded users; excludes the viewer.
 */
export async function searchUsers(viewerId, rawQuery, limit) {
    assertObjectId(viewerId);
    const q = rawQuery.trim();
    if (q.length === 0) {
        return { items: [] };
    }
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');
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
        .exec());
    return {
        items: docs.map((d) => ({
            id: d._id.toString(),
            username: d.username,
            fullName: d.fullName ?? null,
            avatarUrl: d.avatarUrl ?? null,
        })),
    };
}
