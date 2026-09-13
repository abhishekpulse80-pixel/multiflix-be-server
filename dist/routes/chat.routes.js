import rateLimit from 'express-rate-limit';
import { Router } from 'express';
import { env, isProd } from '../config/env.js';
import { asyncRoute } from '../lib/asyncRoute.js';
import { HttpError } from '../lib/httpError.js';
import { sendData } from '../lib/sendData.js';
import { requireAuth } from '../middleware/requireAuth.js';
import * as chatService from '../services/chat.service.js';
import { getIo } from '../socket/chatSocket.js';
const rateLimitShared = !isProd && env.trustProxyHops === 0
    ? { validate: { xForwardedForHeader: false } }
    : {};
const readLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    ...rateLimitShared,
});
const writeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    ...rateLimitShared,
});
export const chatRouter = Router();
/**
 * Get or create a conversation with another user.
 * `POST /api/v1/chat/conversations`  body: { userId: string }
 */
chatRouter.post('/conversations', writeLimiter, requireAuth, asyncRoute(async (req, res) => {
    if (!req.auth)
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    const { userId } = req.body;
    if (!userId)
        throw new HttpError(400, 'userId is required', 'VALIDATION_ERROR');
    const conversationId = await chatService.getOrCreateConversation(req.auth.userId, userId);
    sendData(res, { conversationId });
}));
/**
 * List all conversations for the authenticated user.
 * `GET /api/v1/chat/conversations`
 */
chatRouter.get('/conversations', readLimiter, requireAuth, asyncRoute(async (req, res) => {
    if (!req.auth)
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    const wantHidden = req.query.hidden === 'true' || req.query.hidden === '1';
    if (wantHidden) {
        const items = await chatService.listConversations(req.auth.userId, {
            hidden: true,
        });
        sendData(res, { items });
        return;
    }
    const [items, hiddenCount] = await Promise.all([
        chatService.listConversations(req.auth.userId),
        chatService.countHiddenConversations(req.auth.userId),
    ]);
    sendData(res, { items, hiddenCount });
}));
/**
 * Get messages for a conversation (paginated, newest first → reversed to asc).
 * `GET /api/v1/chat/conversations/:conversationId/messages?page=0&limit=30`
 */
chatRouter.get('/conversations/:conversationId/messages', readLimiter, requireAuth, asyncRoute(async (req, res) => {
    if (!req.auth)
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    const convId = req.params.conversationId;
    const page = Math.max(0, Number(req.query.page) || 0);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 30));
    const data = await chatService.getMessages(convId, req.auth.userId, page, limit);
    sendData(res, data);
}));
/**
 * Mark a conversation as read by the authenticated user.
 * `PATCH /api/v1/chat/conversations/:conversationId/read`
 */
chatRouter.patch('/conversations/:conversationId/read', writeLimiter, requireAuth, asyncRoute(async (req, res) => {
    if (!req.auth)
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    await chatService.markAsRead(req.params.conversationId, req.auth.userId);
    sendData(res, { success: true });
}));
/**
 * Send a message in a conversation.
 * `POST /api/v1/chat/conversations/:conversationId/messages`
 * body: { text?: string, postRef?: MessagePostRefInput }
 */
chatRouter.post('/conversations/:conversationId/messages', writeLimiter, requireAuth, asyncRoute(async (req, res) => {
    if (!req.auth)
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    const convId = req.params.conversationId;
    const { text, postRef, storyRef, profileRef, replyToMessageId } = req.body;
    if (!text && !postRef && !storyRef && !profileRef) {
        throw new HttpError(400, 'text, postRef, storyRef, or profileRef is required', 'VALIDATION_ERROR');
    }
    const message = await chatService.sendMessage(convId, req.auth.userId, text ?? '', postRef ?? null, null, storyRef ?? null, replyToMessageId ?? null, profileRef ?? null);
    sendData(res, { message }, 201);
}));
/**
 * Hide a conversation from the authenticated user's list (per-user).
 * Reappears when a new message arrives. History is kept.
 * `POST /api/v1/chat/conversations/:conversationId/hide`
 */
chatRouter.post('/conversations/:conversationId/hide', writeLimiter, requireAuth, asyncRoute(async (req, res) => {
    if (!req.auth)
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    await chatService.hideConversation(req.params.conversationId, req.auth.userId);
    sendData(res, { hidden: true });
}));
/**
 * Restore a hidden conversation back to the main list.
 * `DELETE /api/v1/chat/conversations/:conversationId/hide`
 */
chatRouter.delete('/conversations/:conversationId/hide', writeLimiter, requireAuth, asyncRoute(async (req, res) => {
    if (!req.auth)
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    await chatService.unhideConversation(req.params.conversationId, req.auth.userId);
    sendData(res, { hidden: false });
}));
/**
 * "Delete chat" for the authenticated user — hides it and clears its history
 * for this user only (the other participant is unaffected).
 * `DELETE /api/v1/chat/conversations/:conversationId`
 */
chatRouter.delete('/conversations/:conversationId', writeLimiter, requireAuth, asyncRoute(async (req, res) => {
    if (!req.auth)
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    await chatService.deleteConversationForUser(req.params.conversationId, req.auth.userId);
    sendData(res, { deleted: true });
}));
/**
 * Delete a message (sender only).
 * `DELETE /api/v1/chat/messages/:messageId`
 */
chatRouter.delete('/messages/:messageId', writeLimiter, requireAuth, asyncRoute(async (req, res) => {
    if (!req.auth)
        throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
    const messageId = req.params.messageId;
    const result = await chatService.deleteMessage(messageId, req.auth.userId);
    // Broadcast so open chats on both sides drop the message in realtime.
    getIo()
        ?.to(`conv:${result.conversationId}`)
        .emit('message_deleted', result);
    sendData(res, { deleted: true, ...result });
}));
