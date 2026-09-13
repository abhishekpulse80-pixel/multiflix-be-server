import mongoose, { Schema, type Model, type Types } from 'mongoose';

/** When each participant last opened the conversation (read receipts). */
export interface IConversationLastRead {
  user: Types.ObjectId;
  at: Date;
}

/** Per-participant "cleared history" cutoff — messages at/before this are
 * hidden for that user (drives "Delete chat" without affecting the peer). */
export interface IConversationClearedAt {
  user: Types.ObjectId;
  at: Date;
}

export interface IConversation {
  participants: [Types.ObjectId, Types.ObjectId];
  lastMessage: Types.ObjectId | null;
  lastMessageAt: Date | null;
  /** IDs of participants who have read the latest message. */
  readBy: Types.ObjectId[];
  /** Per-participant last-read timestamp — drives iMessage-style "Seen" label. */
  lastReads: IConversationLastRead[];
  /** Participants who hid this conversation from their list. Cleared (for
   * both) when a new message arrives, so the thread reappears on activity. */
  hiddenFor: Types.ObjectId[];
  /** Participants who DELETED this conversation — removed from BOTH their main
   * and hidden lists (unlike hiddenFor, which keeps a Hidden-list home). A new
   * message clears it for everyone so the thread resurfaces on activity. */
  deletedFor: Types.ObjectId[];
  /** Per-participant cleared-history cutoff (see IConversationClearedAt). */
  clearedAt: IConversationClearedAt[];
  createdAt: Date;
  updatedAt: Date;
}

const lastReadSchema = new Schema<IConversationLastRead>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    at: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const clearedAtSchema = new Schema<IConversationClearedAt>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    at: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const conversationSchema = new Schema<IConversation>(
  {
    participants: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      required: true,
      validate: {
        validator: (v: Types.ObjectId[]) => v.length === 2,
        message: 'A conversation must have exactly 2 participants',
      },
    },
    lastMessage: {
      type: Schema.Types.ObjectId,
      ref: 'Message',
      default: null,
    },
    lastMessageAt: { type: Date, default: null },
    readBy: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: [],
    },
    lastReads: {
      type: [lastReadSchema],
      default: [],
    },
    hiddenFor: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: [],
    },
    deletedFor: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: [],
    },
    clearedAt: {
      type: [clearedAtSchema],
      default: [],
    },
  },
  { timestamps: true },
);

/** Fast lookup: find conversations for a given user. */
conversationSchema.index({ participants: 1 });

/** Unique pair — prevent duplicate conversations between same two users. */
conversationSchema.index(
  { 'participants.0': 1, 'participants.1': 1 },
  { unique: true },
);

export const ConversationModel: Model<IConversation> =
  (mongoose.models.Conversation as Model<IConversation> | undefined) ??
  mongoose.model<IConversation>('Conversation', conversationSchema);
