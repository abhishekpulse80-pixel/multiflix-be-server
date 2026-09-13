import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { HttpError } from '../lib/httpError.js';
import { ConversationModel, } from '../models/conversation.model.js';
import { MessageModel, } from '../models/message.model.js';
import { UserModel } from '../models/user.model.js';
import { isBlockedBetween, listHiddenUserIds, } from './userBlock.service.js';
// ─── Helpers ─────────────────────────────────────────────────────────────────
function assertOid(id, label) {
    if (!mongoose.isValidObjectId(id)) {
        throw new HttpError(400, `Invalid ${label}`, 'INVALID_ID');
    }
}
function toPostRefDto(ref) {
    if (!ref)
        return null;
    return {
        postId: ref.postId.toString(),
        thumbnailUrl: ref.thumbnailUrl ?? '',
        mediaUrl: ref.mediaUrl ?? '',
        caption: ref.caption ?? '',
        authorId: ref.authorId.toString(),
        authorName: ref.authorName ?? '',
        authorAvatarUrl: ref.authorAvatarUrl ?? null,
        mediaKind: ref.mediaKind ?? 'image',
    };
}
function toStoryRefDto(ref) {
    if (!ref)
        return null;
    return {
        storyId: ref.storyId.toString(),
        thumbnailUrl: ref.thumbnailUrl ?? '',
        mediaUrl: ref.mediaUrl ?? '',
        mediaKind: ref.mediaKind ?? 'image',
        authorId: ref.authorId.toString(),
        authorUsername: ref.authorUsername ?? '',
    };
}
function toProfileRefDto(ref) {
    if (!ref)
        return null;
    return {
        userId: ref.userId.toString(),
        username: ref.username ?? '',
        displayName: ref.displayName ?? '',
        avatarUrl: ref.avatarUrl ?? null,
    };
}
function toReplyRefDto(ref) {
    if (!ref)
        return null;
    return {
        messageId: ref.messageId.toString(),
        senderId: ref.senderId.toString(),
        text: ref.text ?? '',
        kind: ref.kind ?? 'text',
    };
}
function toMediaDto(m) {
    if (!m || !m.url)
        return null;
    return {
        url: m.url,
        kind: m.kind,
        thumbnailUrl: m.thumbnailUrl ?? '',
        width: m.width ?? 0,
        height: m.height ?? 0,
        durationMs: m.durationMs ?? 0,
        sizeBytes: m.sizeBytes ?? 0,
    };
}
function toMessageDto(doc) {
    return {
        id: doc._id.toString(),
        conversationId: doc.conversation.toString(),
        senderId: doc.sender.toString(),
        text: doc.text ?? '',
        postRef: toPostRefDto(doc.postRef),
        storyRef: toStoryRefDto(doc.storyRef),
        profileRef: toProfileRefDto(doc.profileRef),
        media: toMediaDto(doc.media),
        replyTo: toReplyRefDto(doc.replyTo),
        createdAt: doc.createdAt.toISOString(),
    };
}
/** Pick the kind that best represents the original message for the preview. */
function deriveReplyKind(msg) {
    if (msg.media) {
        return msg.media.kind === 'video' ? 'video' : 'image';
    }
    if (msg.postRef)
        return 'post';
    if (msg.storyRef)
        return 'story';
    return 'text';
}
/**
 * Hard-delete conversations (and their messages) that are inactive for the
 * given user. "Inactive" means the last message is older than
 * `env.chatInactiveDays` days, or — for conversations that never received a
 * message — the conversation itself was created that long ago.
 *
 * Best-effort: errors are caught and logged so the caller (list fetch)
 * never fails because of cleanup.
 */
async function cleanupInactiveConversationsForUser(userId) {
    try {
        const days = env.chatInactiveDays;
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const oid = new mongoose.Types.ObjectId(userId);
        const inactive = (await ConversationModel.find({
            participants: oid,
            $or: [
                { lastMessageAt: { $lt: cutoff } },
                // lastMessageAt null OR missing (no messages ever sent)
                { lastMessageAt: null, createdAt: { $lt: cutoff } },
            ],
        })
            .select('_id')
            .lean());
        if (inactive.length === 0)
            return;
        const convIds = inactive.map((c) => c._id);
        // Delete messages first, then the conversation docs themselves.
        await MessageModel.deleteMany({ conversation: { $in: convIds } });
        await ConversationModel.deleteMany({ _id: { $in: convIds } });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        console.warn('[chat] inactive cleanup failed:', msg);
    }
}
// ─── Service functions ───────────────────────────────────────────────────────
/**
 * Get or create a 1-on-1 conversation between two users.
 * Participants are stored in sorted order to guarantee uniqueness.
 */
export async function getOrCreateConversation(userA, userB) {
    assertOid(userA, 'userId');
    assertOid(userB, 'userId');
    if (userA === userB) {
        throw new HttpError(400, 'Cannot chat with yourself', 'SELF_CHAT');
    }
    if (await isBlockedBetween(userA, userB)) {
        throw new HttpError(403, 'Cannot start a chat with this user', 'USER_BLOCKED');
    }
    const sorted = [userA, userB].sort();
    const oids = sorted.map((id) => new mongoose.Types.ObjectId(id));
    const existing = await ConversationModel.findOne({
        participants: { $all: oids, $size: 2 },
    })
        .select('_id')
        .lean();
    if (existing) {
        const existingId = existing._id;
        // Reopening a chat the requester previously deleted resurfaces it in their
        // list (clearedAt still hides pre-delete history), so an opened thread is
        // never "visible on screen but missing from the list".
        await ConversationModel.updateOne({ _id: existingId }, { $pull: { deletedFor: new mongoose.Types.ObjectId(userA) } });
        return existingId.toString();
    }
    const doc = await ConversationModel.create({
        participants: oids,
    });
    return doc._id.toString();
}
/**
 * List conversations for a user, newest activity first. By default returns
 * conversations the user has NOT hidden; pass `{ hidden: true }` for the
 * "Hidden chats" screen.
 */
export async function listConversations(userId, opts) {
    assertOid(userId, 'userId');
    const oid = new mongoose.Types.ObjectId(userId);
    const wantHidden = opts?.hidden === true;
    // Drop conversations that have been inactive ≥ CHAT_INACTIVE_DAYS.
    await cleanupInactiveConversationsForUser(userId);
    const hiddenIds = new Set(await listHiddenUserIds(userId));
    // Default: `hiddenFor: { $ne: oid }` matches conversations the user has NOT
    // hidden (and ones with no hiddenFor). Hidden view: `hiddenFor: oid`.
    // A new message clears hiddenFor so the thread reappears in the main list.
    // `deletedFor: { $ne: oid }` on BOTH views hides conversations the user has
    // deleted (a deleted chat belongs in neither the main nor the hidden list).
    const rawConvs = (await ConversationModel.find({
        participants: oid,
        hiddenFor: wantHidden ? oid : { $ne: oid },
        deletedFor: { $ne: oid },
    })
        .sort({ lastMessageAt: -1, createdAt: -1 })
        .lean());
    // Drop conversations whose other participant is blocked either way.
    const convs = rawConvs.filter((c) => {
        const other = c.participants.find((p) => p.toString() !== userId);
        return other ? !hiddenIds.has(other.toString()) : false;
    });
    if (convs.length === 0)
        return [];
    // Gather all "other" user IDs
    const otherIds = convs.map((c) => {
        const other = c.participants.find((p) => p.toString() !== userId);
        return other.toString();
    });
    const users = (await UserModel.find({ _id: { $in: otherIds } })
        .select('_id username fullName avatarUrl')
        .lean());
    const userMap = new Map(users.map((u) => [u._id.toString(), u]));
    // Gather last messages
    const msgIds = convs
        .filter((c) => c.lastMessage)
        .map((c) => c.lastMessage);
    const msgs = (await MessageModel.find({ _id: { $in: msgIds } })
        .select('_id text sender createdAt postRef media profileRef')
        .lean());
    const msgMap = new Map(msgs.map((m) => [m._id.toString(), m]));
    return convs.map((c) => {
        const otherId = c.participants
            .find((p) => p.toString() !== userId)
            .toString();
        const u = userMap.get(otherId);
        const msg = c.lastMessage ? msgMap.get(c.lastMessage.toString()) : null;
        // Unread = has a lastMessage AND the current user is NOT in readBy
        const isUnread = !!c.lastMessage &&
            !c.readBy?.some((rid) => rid.toString() === userId);
        const otherLastRead = c.lastReads?.find((r) => r.user.toString() === otherId)?.at ?? null;
        return {
            id: c._id.toString(),
            otherUser: {
                id: otherId,
                username: u?.username ?? '',
                fullName: u?.fullName ?? null,
                avatarUrl: u?.avatarUrl ?? null,
            },
            lastMessage: msg
                ? {
                    text: msg.text && msg.text.length > 0
                        ? msg.text
                        : msg.media
                            ? msg.media.kind === 'video'
                                ? 'Video'
                                : 'Photo'
                            : msg.postRef
                                ? 'Shared a post'
                                : msg.profileRef
                                    ? 'Shared a profile'
                                    : '',
                    senderId: msg.sender.toString(),
                    createdAt: msg.createdAt.toISOString(),
                }
                : null,
            isUnread,
            otherUserLastReadAt: otherLastRead ? otherLastRead.toISOString() : null,
        };
    });
}
/**
 * Paginated messages for a conversation (newest first).
 */
export async function getMessages(conversationId, userId, page = 0, limit = 30) {
    assertOid(conversationId, 'conversationId');
    assertOid(userId, 'userId');
    // Verify user is a participant
    const conv = await ConversationModel.findById(conversationId)
        .select('participants lastReads clearedAt')
        .lean();
    if (!conv) {
        throw new HttpError(404, 'Conversation not found', 'NOT_FOUND');
    }
    const typedConv = conv;
    const isParticipant = typedConv.participants.some((p) => p.toString() === userId);
    if (!isParticipant) {
        throw new HttpError(403, 'Not a participant', 'FORBIDDEN');
    }
    // If the user "deleted" (cleared) this chat, only show messages newer than
    // the cutoff — without affecting what the other participant sees.
    const clearedCutoff = typedConv.clearedAt?.find((c) => c.user.toString() === userId)?.at ?? null;
    // Hide the thread entirely if the pair is blocked either way.
    const other = typedConv.participants.find((p) => p.toString() !== userId);
    if (other && (await isBlockedBetween(userId, other.toString()))) {
        throw new HttpError(404, 'Conversation not found', 'NOT_FOUND');
    }
    const otherId = other?.toString() ?? null;
    const otherLastRead = otherId
        ? (typedConv.lastReads?.find((r) => r.user.toString() === otherId)?.at ??
            null)
        : null;
    const skip = page * limit;
    const msgFilter = { conversation: conversationId };
    if (clearedCutoff) {
        msgFilter.createdAt = { $gt: clearedCutoff };
    }
    const docs = (await MessageModel.find(msgFilter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit + 1)
        .lean());
    const hasMore = docs.length > limit;
    const items = docs.slice(0, limit).reverse().map(toMessageDto);
    return {
        items,
        page,
        limit,
        hasMore,
        otherUserLastReadAt: otherLastRead ? otherLastRead.toISOString() : null,
    };
}
/**
 * Send a text message — or a shared-post message when `postRef` is provided,
 * or a media message (image/video) when `mediaInput` is provided.
 * Returns the created MessageDto and updates conversation's lastMessage.
 */
export async function sendMessage(conversationId, senderId, text, postRefInput, mediaInput, storyRefInput, replyToMessageId, profileRefInput) {
    assertOid(conversationId, 'conversationId');
    assertOid(senderId, 'senderId');
    const trimmed = (text ?? '').trim();
    const hasPostRef = !!postRefInput && !!postRefInput.postId;
    const hasMedia = !!mediaInput && !!mediaInput.url;
    const hasStoryRef = !!storyRefInput && !!storyRefInput.storyId;
    const hasProfileRef = !!profileRefInput && !!profileRefInput.userId;
    if (trimmed.length === 0 &&
        !hasPostRef &&
        !hasMedia &&
        !hasStoryRef &&
        !hasProfileRef) {
        throw new HttpError(400, 'Message text is required', 'EMPTY_MESSAGE');
    }
    if (trimmed.length > 5000) {
        throw new HttpError(400, 'Message too long (max 5000)', 'MESSAGE_TOO_LONG');
    }
    let postRefDoc = null;
    if (hasPostRef) {
        assertOid(postRefInput.postId, 'postId');
        assertOid(postRefInput.authorId, 'authorId');
        postRefDoc = {
            postId: new mongoose.Types.ObjectId(postRefInput.postId),
            thumbnailUrl: postRefInput.thumbnailUrl ?? '',
            mediaUrl: postRefInput.mediaUrl ?? '',
            caption: postRefInput.caption ?? '',
            authorId: new mongoose.Types.ObjectId(postRefInput.authorId),
            authorName: postRefInput.authorName ?? '',
            authorAvatarUrl: postRefInput.authorAvatarUrl ?? null,
            mediaKind: postRefInput.mediaKind ?? 'image',
        };
    }
    let storyRefDoc = null;
    if (hasStoryRef) {
        assertOid(storyRefInput.storyId, 'storyId');
        assertOid(storyRefInput.authorId, 'authorId');
        storyRefDoc = {
            storyId: new mongoose.Types.ObjectId(storyRefInput.storyId),
            thumbnailUrl: storyRefInput.thumbnailUrl ?? '',
            mediaUrl: storyRefInput.mediaUrl ?? '',
            mediaKind: storyRefInput.mediaKind ?? 'image',
            authorId: new mongoose.Types.ObjectId(storyRefInput.authorId),
            authorUsername: storyRefInput.authorUsername ?? '',
        };
    }
    let profileRefDoc = null;
    if (hasProfileRef) {
        assertOid(profileRefInput.userId, 'profileRef.userId');
        profileRefDoc = {
            userId: new mongoose.Types.ObjectId(profileRefInput.userId),
            username: profileRefInput.username ?? '',
            displayName: profileRefInput.displayName ?? '',
            avatarUrl: profileRefInput.avatarUrl ?? null,
        };
    }
    let mediaDoc = null;
    if (hasMedia) {
        const kind = mediaInput.kind;
        if (kind !== 'image' && kind !== 'video') {
            throw new HttpError(400, 'Invalid media kind', 'INVALID_MEDIA_KIND');
        }
        mediaDoc = {
            url: mediaInput.url,
            kind,
            thumbnailUrl: mediaInput.thumbnailUrl ?? '',
            width: mediaInput.width ?? 0,
            height: mediaInput.height ?? 0,
            durationMs: mediaInput.durationMs ?? 0,
            sizeBytes: mediaInput.sizeBytes ?? 0,
        };
    }
    // Verify participant
    const conv = await ConversationModel.findById(conversationId)
        .select('participants')
        .lean();
    if (!conv) {
        throw new HttpError(404, 'Conversation not found', 'NOT_FOUND');
    }
    const typedConv = conv;
    const isParticipant = typedConv.participants.some((p) => p.toString() === senderId);
    if (!isParticipant) {
        throw new HttpError(403, 'Not a participant', 'FORBIDDEN');
    }
    // Reject sends when either side of the pair has blocked the other.
    const other = typedConv.participants.find((p) => p.toString() !== senderId);
    if (other && (await isBlockedBetween(senderId, other.toString()))) {
        throw new HttpError(403, 'You cannot send messages to this user', 'USER_BLOCKED');
    }
    // Build a denormalized snapshot of the message being replied to (if any).
    // The snapshot keeps the bubble preview intact even if the original is later deleted.
    let replyToDoc = null;
    if (replyToMessageId) {
        assertOid(replyToMessageId, 'replyToMessageId');
        const original = (await MessageModel.findById(replyToMessageId)
            .select('conversation sender text postRef storyRef media')
            .lean());
        if (!original) {
            throw new HttpError(404, 'Original message not found', 'REPLY_TARGET_NOT_FOUND');
        }
        if (original.conversation.toString() !== conversationId) {
            throw new HttpError(400, 'Cannot reply across conversations', 'REPLY_WRONG_CONVERSATION');
        }
        const snippet = (original.text ?? '').slice(0, 200);
        replyToDoc = {
            messageId: original._id,
            senderId: original.sender,
            text: snippet,
            kind: deriveReplyKind(original),
        };
    }
    const doc = await MessageModel.create({
        conversation: new mongoose.Types.ObjectId(conversationId),
        sender: new mongoose.Types.ObjectId(senderId),
        text: trimmed,
        postRef: postRefDoc,
        storyRef: storyRefDoc,
        profileRef: profileRefDoc,
        media: mediaDoc,
        replyTo: replyToDoc,
    });
    // Update conversation — only the sender has "read" this message. Un-hide
    // ONLY for the sender (they're re-engaging): a hidden/muted thread MUST stay
    // hidden for the RECIPIENT, so an incoming message doesn't drag it back into
    // their main list — it stays in their Hidden list until they unhide it.
    //
    // `deletedFor` is different: a deleted chat has no hidden-list home, so a new
    // message MUST resurface it for whoever deleted it (otherwise the message
    // would be invisible). Pull the participants from deletedFor with an atomic
    // `$pull` (NOT `$set []`, which would clobber a concurrent delete): a later
    // delete's `$addToSet` survives if it lands after this write. The deleter's
    // clearedAt cutoff keeps old history hidden after the thread resurfaces.
    await ConversationModel.findByIdAndUpdate(conversationId, {
        $set: {
            lastMessage: doc._id,
            lastMessageAt: doc.createdAt,
            readBy: [new mongoose.Types.ObjectId(senderId)],
        },
        $pull: {
            hiddenFor: new mongoose.Types.ObjectId(senderId),
            deletedFor: { $in: typedConv.participants },
        },
    });
    return toMessageDto(doc.toObject());
}
/**
 * Mark a conversation as read by the given user.
 * Adds the userId to `readBy` (for unread-badge logic) AND upserts the
 * per-user `lastReads` timestamp (drives realtime "Seen" receipts).
 * Returns the ISO timestamp that was written so callers can broadcast it.
 */
export async function markAsRead(conversationId, userId) {
    assertOid(conversationId, 'conversationId');
    assertOid(userId, 'userId');
    const oid = new mongoose.Types.ObjectId(userId);
    const now = new Date();
    // Verify participant so we don't leak receipts into unrelated threads.
    const conv = await ConversationModel.findById(conversationId)
        .select('participants')
        .lean();
    if (!conv)
        return null;
    const typedConv = conv;
    const isParticipant = typedConv.participants.some((p) => p.toString() === userId);
    if (!isParticipant)
        return null;
    // Try to update an existing lastReads entry; if none, push a new one.
    const updated = await ConversationModel.findOneAndUpdate({ _id: conversationId, 'lastReads.user': oid }, {
        $addToSet: { readBy: oid },
        $set: { 'lastReads.$.at': now },
    }, { new: true });
    if (!updated) {
        await ConversationModel.findByIdAndUpdate(conversationId, {
            $addToSet: { readBy: oid },
            $push: { lastReads: { user: oid, at: now } },
        });
    }
    return { at: now.toISOString() };
}
/**
 * Delete a message. Only the sender may delete their own message. If the
 * deleted message was the conversation's `lastMessage`, the pointer is
 * recomputed to the new newest message (or cleared). Returns the
 * conversationId so the caller can broadcast a realtime `message_deleted`.
 */
export async function deleteMessage(messageId, userId) {
    assertOid(messageId, 'messageId');
    assertOid(userId, 'userId');
    const msg = (await MessageModel.findById(messageId)
        .select('sender conversation')
        .lean());
    if (!msg) {
        throw new HttpError(404, 'Message not found', 'MESSAGE_NOT_FOUND');
    }
    if (msg.sender.toString() !== userId) {
        throw new HttpError(403, 'You can only delete your own messages', 'FORBIDDEN');
    }
    const conversationId = msg.conversation.toString();
    await MessageModel.deleteOne({ _id: msg._id });
    // If it was the conversation's last message, repoint to the new newest one.
    const conv = (await ConversationModel.findById(conversationId)
        .select('lastMessage')
        .lean());
    if (conv?.lastMessage && conv.lastMessage.toString() === messageId) {
        const newest = (await MessageModel.findOne({ conversation: msg.conversation })
            .sort({ createdAt: -1, _id: -1 })
            .select('_id createdAt')
            .lean());
        await ConversationModel.findByIdAndUpdate(conversationId, {
            lastMessage: newest?._id ?? null,
            lastMessageAt: newest?.createdAt ?? null,
        });
    }
    return { conversationId, messageId };
}
/** Assert the user is a participant of the conversation; return its oid. */
async function assertParticipant(conversationId, userId) {
    const conv = (await ConversationModel.findById(conversationId)
        .select('participants')
        .lean());
    if (!conv) {
        throw new HttpError(404, 'Conversation not found', 'NOT_FOUND');
    }
    if (!conv.participants.some((p) => p.toString() === userId)) {
        throw new HttpError(403, 'Not a participant', 'FORBIDDEN');
    }
    return new mongoose.Types.ObjectId(userId);
}
/**
 * Hide a conversation from the user's list (per-user). It STAYS hidden — even
 * when the other person sends new messages — until the user unhides it (or
 * sends a message themselves, which un-hides only for the sender). History is
 * kept; the thread remains visible in the Hidden list.
 */
export async function hideConversation(conversationId, userId) {
    assertOid(conversationId, 'conversationId');
    assertOid(userId, 'userId');
    const oid = await assertParticipant(conversationId, userId);
    await ConversationModel.findByIdAndUpdate(conversationId, {
        $addToSet: { hiddenFor: oid },
    });
}
/** Restore a hidden conversation back to the user's main list. */
export async function unhideConversation(conversationId, userId) {
    assertOid(conversationId, 'conversationId');
    assertOid(userId, 'userId');
    const oid = await assertParticipant(conversationId, userId);
    await ConversationModel.findByIdAndUpdate(conversationId, {
        $pull: { hiddenFor: oid },
    });
}
/** Number of conversations the user has hidden (for the "Hidden (N)" badge). */
export async function countHiddenConversations(userId) {
    assertOid(userId, 'userId');
    const oid = new mongoose.Types.ObjectId(userId);
    return ConversationModel.countDocuments({
        participants: oid,
        hiddenFor: oid,
        deletedFor: { $ne: oid },
    });
}
/**
 * "Delete chat" for one user: hide it AND clear its history for that user
 * only (a cutoff timestamp). The other participant is unaffected; if a new
 * message arrives the thread reappears showing only messages after the cutoff.
 */
export async function deleteConversationForUser(conversationId, userId) {
    assertOid(conversationId, 'conversationId');
    assertOid(userId, 'userId');
    const oid = await assertParticipant(conversationId, userId);
    const now = new Date();
    // Upsert the per-user clearedAt cutoff, then mark it DELETED for this user —
    // add to `deletedFor` (removes it from both the main and hidden lists) and
    // pull from `hiddenFor` (deleting a hidden chat supersedes the hide).
    const updated = await ConversationModel.findOneAndUpdate({ _id: conversationId, 'clearedAt.user': oid }, {
        $set: { 'clearedAt.$.at': now },
        $addToSet: { deletedFor: oid },
        $pull: { hiddenFor: oid },
    }, { new: true });
    if (!updated) {
        await ConversationModel.findByIdAndUpdate(conversationId, {
            $push: { clearedAt: { user: oid, at: now } },
            $addToSet: { deletedFor: oid },
            $pull: { hiddenFor: oid },
        });
    }
}
