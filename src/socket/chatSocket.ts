import type { Server as HttpServer } from 'http';
import { Server, type Socket } from 'socket.io';
import { verifyAccessToken } from '../lib/jwt.js';
import { ConversationModel } from '../models/conversation.model.js';
import { UserModel } from '../models/user.model.js';
import * as chatService from '../services/chat.service.js';
import { sendToUser } from '../services/notification.service.js';

let io: Server | null = null;

export function getIo(): Server | null {
  return io;
}

/** True if any socket belonging to `userId` is currently joined to `conv:<convId>`. */
function isUserInConversationRoom(
  ioInst: Server,
  userId: string,
  convId: string,
): boolean {
  const room = ioInst.sockets.adapter.rooms.get(`conv:${convId}`);
  if (!room) return false;
  for (const sockId of room) {
    const s = ioInst.sockets.sockets.get(sockId) as
      | (Socket & { userId?: string })
      | undefined;
    if (s?.userId === userId) return true;
  }
  return false;
}

/**
 * Attach Socket.io to the HTTP server.
 * Call once after `server = app.listen(...)`.
 */
export function initChatSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: { origin: '*' },
    path: '/socket.io',
  });

  // ─── Auth middleware ─────────────────────────────────────────────────
  io.use((socket, next) => {
    const token =
      (socket.handshake.auth as { token?: string }).token ??
      (socket.handshake.headers.authorization?.replace('Bearer ', '') ?? null);
    if (!token) {
      return next(new Error('AUTH_REQUIRED'));
    }
    try {
      const payload = verifyAccessToken(token);
      (socket as Socket & { userId?: string }).userId = payload.sub;
      next();
    } catch {
      next(new Error('AUTH_INVALID'));
    }
  });

  // ─── Connection handler ──────────────────────────────────────────────
  io.on('connection', (rawSocket) => {
    const socket = rawSocket as Socket & { userId: string };
    const userId = socket.userId;

    // Join a personal room so we can push to the user from anywhere
    void socket.join(`user:${userId}`);

    // ── Join a conversation room ──
    socket.on('join_conversation', (conversationId: string) => {
      void socket.join(`conv:${conversationId}`);
    });

    // ── Leave a conversation room ──
    socket.on('leave_conversation', (conversationId: string) => {
      void socket.leave(`conv:${conversationId}`);
    });

    // ── Send message ──
    socket.on(
      'send_message',
      async (
        data: {
          conversationId: string;
          text?: string;
          postRef?: chatService.MessagePostRefInput | null;
          media?: chatService.MessageMediaInput | null;
          replyToMessageId?: string | null;
        },
        ack?: (res: { ok: boolean; message?: chatService.MessageDto; error?: string }) => void,
      ) => {
        try {
          const message = await chatService.sendMessage(
            data.conversationId,
            userId,
            data.text ?? '',
            data.postRef ?? null,
            data.media ?? null,
            null,
            data.replyToMessageId ?? null,
          );
          // Broadcast to everyone in the conversation room (including sender)
          io!.to(`conv:${data.conversationId}`).emit('new_message', message);
          if (typeof ack === 'function') ack({ ok: true, message });

          // Fire-and-forget push to the recipient (best-effort — don't await).
          void dispatchChatMessagePush(
            data.conversationId,
            userId,
            message,
          );
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : 'Send failed';
          if (typeof ack === 'function') ack({ ok: false, error: errMsg });
        }
      },
    );

    // ── Mark conversation as read (read receipts) ──
    socket.on('mark_read', async (conversationId: string) => {
      if (!conversationId || typeof conversationId !== 'string') return;
      try {
        const result = await chatService.markAsRead(conversationId, userId);
        if (!result) return;
        io!.to(`conv:${conversationId}`).emit('messages_read', {
          conversationId,
          userId,
          at: result.at,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'mark_read failed';
        console.warn('[chatSocket] mark_read error:', msg);
      }
    });

    // ── Typing indicator ──
    socket.on('typing', (conversationId: string) => {
      socket.to(`conv:${conversationId}`).emit('user_typing', {
        conversationId,
        userId,
      });
    });

    socket.on('stop_typing', (conversationId: string) => {
      socket.to(`conv:${conversationId}`).emit('user_stop_typing', {
        conversationId,
        userId,
      });
    });
  });

  console.log('Socket.io chat server initialized');
  return io;
}

/**
 * Resolve the recipient + sender, skip if recipient is actively viewing
 * the conversation, then send a single FCM push. Best-effort.
 */
async function dispatchChatMessagePush(
  conversationId: string,
  senderId: string,
  message: chatService.MessageDto,
): Promise<void> {
  try {
    const conv = await ConversationModel.findById(conversationId)
      .select('participants hiddenFor')
      .lean<{
        participants: Array<{ toString(): string }>;
        hiddenFor?: Array<{ toString(): string }>;
      }>();
    if (!conv) return;
    const recipientId = conv.participants
      .map((p) => p.toString())
      .find((pid) => pid !== senderId);
    if (!recipientId) return;

    // Skip if the recipient currently has this chat open.
    if (io && isUserInConversationRoom(io, recipientId, conversationId)) {
      return;
    }

    // Skip if the recipient has hidden/muted this conversation — muted chats
    // don't push for new messages (the message still arrives in their Hidden list).
    if (conv.hiddenFor?.some((id) => id.toString() === recipientId)) {
      return;
    }

    const sender = await UserModel.findById(senderId)
      .select('fullName username')
      .lean<{
        fullName: string | null;
        username: string;
      }>();
    const senderName =
      sender?.fullName?.trim() ||
      sender?.username ||
      'Someone';

    let body = 'New message';
    if (message.text && message.text.trim().length > 0) {
      body =
        message.text.length > 120
          ? `${message.text.slice(0, 117)}…`
          : message.text;
    } else if (message.media) {
      body = message.media.kind === 'video' ? '🎥 Video' : '📷 Photo';
    } else if (message.postRef) {
      body = 'Shared a post';
    }

    await sendToUser(recipientId, {
      type: 'chat_message',
      title: senderName,
      body,
      data: {
        conversationId,
        senderId,
        messageId: message.id,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.warn('[chatSocket] push dispatch failed:', msg);
  }
}
