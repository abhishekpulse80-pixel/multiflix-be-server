import mongoose from 'mongoose';
import { HttpError } from '../lib/httpError.js';
import { OriginalSoundModel } from '../models/originalSound.model.js';
import { PostModel } from '../models/post.model.js';
import { UserModel } from '../models/user.model.js';
async function ownersByIds(ids) {
    if (ids.length === 0)
        return new Map();
    const rows = await UserModel.find({ _id: { $in: ids } })
        .select('username fullName avatarUrl')
        .lean();
    const out = new Map();
    for (const r of rows) {
        out.set(r._id.toString(), {
            username: r.username,
            fullName: r.fullName ?? null,
            avatarUrl: r.avatarUrl ?? null,
        });
    }
    return out;
}
function toDto(s, ownerMap) {
    const owner = ownerMap.get(s.ownerUser.toString());
    return {
        id: s._id.toString(),
        sourcePostId: s.sourcePost.toString(),
        ownerUserId: s.ownerUser.toString(),
        ownerUsername: owner?.username ?? 'unknown',
        ownerFullName: owner?.fullName ?? null,
        ownerAvatarUrl: owner?.avatarUrl ?? null,
        title: s.title,
        audioUrl: s.audioUrl,
        audioProcessingStatus: s.audioProcessingStatus ?? 'not_required',
        audioVariants: s.audioVariants ?? [],
        audioProcessingError: s.audioProcessingError ?? null,
        durationSeconds: s.durationSeconds,
        usesCount: s.usesCount,
        status: s.status,
        createdAt: s.createdAt.toISOString(),
    };
}
/**
 * Public catalog: ready+public sounds, hottest first. The `ready` filter
 * keeps still-processing extractions out of the picker so users don't tap
 * a sound whose audioUrl is still null.
 */
export async function listPublishedOriginalSounds(page, limit) {
    const filter = { status: 'ready', isPublic: true };
    const [rows, total] = await Promise.all([
        OriginalSoundModel.find(filter)
            .sort({ usesCount: -1, createdAt: -1 })
            .skip(page * limit)
            .limit(limit)
            .lean(),
        OriginalSoundModel.countDocuments(filter),
    ]);
    const ownerMap = await ownersByIds(rows.map(r => r.ownerUser));
    return {
        items: rows.map(r => toDto(r, ownerMap)),
        page,
        limit,
        total,
        hasMore: (page + 1) * limit < total,
    };
}
export async function getOriginalSoundById(soundId) {
    if (!mongoose.isValidObjectId(soundId)) {
        throw new HttpError(400, 'Invalid sound id', 'INVALID_SOUND_ID');
    }
    const row = await OriginalSoundModel.findById(soundId).lean();
    if (!row || row.status === 'deleted') {
        throw new HttpError(404, 'Sound not found', 'SOUND_NOT_FOUND');
    }
    const ownerMap = await ownersByIds([row.ownerUser]);
    return toDto(row, ownerMap);
}
/**
 * Posts that have reused a given Original Sound. Used by the "Videos using
 * this sound" grid on the now-playing screen.
 */
export async function listPostsUsingOriginalSound(soundId, page, limit) {
    if (!mongoose.isValidObjectId(soundId)) {
        throw new HttpError(400, 'Invalid sound id', 'INVALID_SOUND_ID');
    }
    const soundOid = new mongoose.Types.ObjectId(soundId);
    const sound = await OriginalSoundModel.findById(soundOid)
        .select('_id')
        .lean();
    if (!sound) {
        throw new HttpError(404, 'Sound not found', 'SOUND_NOT_FOUND');
    }
    const filter = { originalSoundId: soundOid };
    const [rows, total] = await Promise.all([
        PostModel.find(filter)
            .sort({ createdAt: -1 })
            .skip(page * limit)
            .limit(limit)
            .select('author thumbnailUrl media likesCount createdAt')
            .lean(),
        PostModel.countDocuments(filter),
    ]);
    const authorMap = await ownersByIds(rows.map(r => r.author));
    return {
        items: rows.map(r => ({
            id: r._id.toString(),
            authorId: r.author.toString(),
            authorUsername: authorMap.get(r.author.toString())?.username ?? 'unknown',
            thumbnailUrl: r.thumbnailUrl ?? null,
            mediaUrl: r.media?.url ?? null,
            likesCount: r.likesCount,
            createdAt: r.createdAt.toISOString(),
        })),
        page,
        limit,
        total,
        hasMore: (page + 1) * limit < total,
        soundId,
    };
}
