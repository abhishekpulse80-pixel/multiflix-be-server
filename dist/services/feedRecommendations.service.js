import mongoose, { Types } from 'mongoose';
import { FollowModel } from '../models/follow.model.js';
import { UserModel } from '../models/user.model.js';
import { listHiddenUserIds } from './userBlock.service.js';
function sanitizeHandlePart(s) {
    const t = s.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_');
    return t.replace(/^_|_$/g, '') || 'user';
}
export function displayHandleFromUser(doc) {
    const local = doc.email.split('@')[0]?.trim() ?? '';
    if (local) {
        const h = sanitizeHandlePart(local).slice(0, 24);
        return h.length > 0 ? h : `user_${doc._id.toString().slice(-6)}`;
    }
    const fn = doc.fullName?.trim();
    if (fn) {
        return sanitizeHandlePart(fn.replace(/\s+/g, '_')).slice(0, 30);
    }
    return `user_${doc._id.toString().slice(-6)}`;
}
/**
 * Suggested accounts for the home feed: real users, excluding self and people already followed.
 */
export async function listFeedRecommendationUsers(viewerUserId, limit) {
    if (!mongoose.isValidObjectId(viewerUserId) || limit <= 0) {
        return [];
    }
    const viewerOid = new Types.ObjectId(viewerUserId);
    const followRows = (await FollowModel.find({ follower: viewerUserId })
        .select('followee')
        .lean());
    const excludeIds = [viewerOid];
    for (const r of followRows) {
        excludeIds.push(r.followee);
    }
    const hiddenIds = await listHiddenUserIds(viewerUserId);
    for (const id of hiddenIds) {
        excludeIds.push(new Types.ObjectId(id));
    }
    const rows = await UserModel.aggregate([
        { $match: { _id: { $nin: excludeIds } } },
        { $sample: { size: limit } },
        {
            $project: {
                email: 1,
                fullName: 1,
                avatarUrl: 1,
            },
        },
    ]);
    // Which of the sampled users already follow the viewer → "Follow Back".
    const recIds = rows.map((u) => u._id);
    const followsViewer = recIds.length > 0
        ? (await FollowModel.find({
            follower: { $in: recIds },
            followee: viewerOid,
        })
            .select('follower')
            .lean())
        : [];
    const followsYouSet = new Set(followsViewer.map((f) => f.follower.toString()));
    return rows.map((u) => {
        const avatar = typeof u.avatarUrl === 'string' && u.avatarUrl.trim().length > 0
            ? u.avatarUrl.trim()
            : null;
        return {
            id: u._id.toString(),
            handle: displayHandleFromUser(u),
            avatarUrl: avatar,
            followsYou: followsYouSet.has(u._id.toString()),
        };
    });
}
