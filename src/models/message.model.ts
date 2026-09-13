import mongoose, { Schema, type Model, type Types } from 'mongoose';

/**
 * Snapshot of a shared post. Stored on the message so chat history stays
 * intact even if the original post is later deleted.
 */
export interface IMessagePostRef {
  postId: Types.ObjectId;
  /** Thumbnail (image URL for image posts, poster for videos). */
  thumbnailUrl: string;
  /** Actual media URL used to render the full-screen preview. */
  mediaUrl: string;
  caption: string;
  authorId: Types.ObjectId;
  authorName: string;
  authorAvatarUrl: string | null;
  mediaKind: 'image' | 'video';
}

/**
 * Snapshot of the story this message was sent in reply to. Stored on the
 * message so the chat bubble can still render the preview after the story
 * itself expires (24h TTL on `Story`).
 */
export interface IMessageStoryRef {
  storyId: Types.ObjectId;
  /** Thumbnail / poster URL at the moment the reply was sent. */
  thumbnailUrl: string;
  /** Original media URL — used by the bubble to attempt reopening. */
  mediaUrl: string;
  mediaKind: 'image' | 'short_video';
  authorId: Types.ObjectId;
  authorUsername: string;
}

/**
 * Snapshot of a shared user profile. Stored on the message so the chat card
 * stays intact even if the user later changes their name/avatar.
 */
export interface IMessageProfileRef {
  userId: Types.ObjectId;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * Snapshot of the message this one is a reply to. Stored on the message so
 * the chat bubble can still render the small preview if the original is later
 * deleted. Only carries the bits needed for the preview pill (no full media).
 */
export type MessageReplyKind = 'text' | 'image' | 'video' | 'post' | 'story';

export interface IMessageReplyRef {
  messageId: Types.ObjectId;
  senderId: Types.ObjectId;
  /** Snapshot of the original text (truncated to keep it small). */
  text: string;
  /** What the original message primarily was — drives preview icon/label. */
  kind: MessageReplyKind;
}

/**
 * Media attachment (image/video) sent directly in a chat message.
 * Uploaded via the existing uploads endpoint; we only store the URL + metadata.
 */
export interface IMessageMedia {
  url: string;
  kind: 'image' | 'video';
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  sizeBytes?: number;
}

export interface IMessage {
  conversation: Types.ObjectId;
  sender: Types.ObjectId;
  text: string;
  postRef?: IMessagePostRef | null;
  storyRef?: IMessageStoryRef | null;
  profileRef?: IMessageProfileRef | null;
  media?: IMessageMedia | null;
  replyTo?: IMessageReplyRef | null;
  createdAt: Date;
  updatedAt: Date;
}

const postRefSchema = new Schema<IMessagePostRef>(
  {
    postId: { type: Schema.Types.ObjectId, ref: 'Post', required: true },
    thumbnailUrl: { type: String, default: '' },
    mediaUrl: { type: String, default: '' },
    caption: { type: String, default: '' },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    authorName: { type: String, default: '' },
    authorAvatarUrl: { type: String, default: null },
    mediaKind: { type: String, enum: ['image', 'video'], default: 'image' },
  },
  { _id: false },
);

const storyRefSchema = new Schema<IMessageStoryRef>(
  {
    storyId: { type: Schema.Types.ObjectId, ref: 'Story', required: true },
    thumbnailUrl: { type: String, default: '' },
    mediaUrl: { type: String, default: '' },
    mediaKind: {
      type: String,
      enum: ['image', 'short_video'],
      default: 'image',
    },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    authorUsername: { type: String, default: '' },
  },
  { _id: false },
);

const profileRefSchema = new Schema<IMessageProfileRef>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, default: '' },
    displayName: { type: String, default: '' },
    avatarUrl: { type: String, default: null },
  },
  { _id: false },
);

const replyToSchema = new Schema<IMessageReplyRef>(
  {
    messageId: { type: Schema.Types.ObjectId, ref: 'Message', required: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, default: '', maxlength: 200 },
    kind: {
      type: String,
      enum: ['text', 'image', 'video', 'post', 'story'],
      default: 'text',
    },
  },
  { _id: false },
);

const mediaSchema = new Schema<IMessageMedia>(
  {
    url: { type: String, required: true },
    kind: { type: String, enum: ['image', 'video'], required: true },
    thumbnailUrl: { type: String, default: '' },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    durationMs: { type: Number, default: 0 },
    sizeBytes: { type: Number, default: 0 },
  },
  { _id: false },
);

const messageSchema = new Schema<IMessage>(
  {
    conversation: {
      type: Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
      index: true,
    },
    sender: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    text: { type: String, default: '', maxlength: 5000 },
    postRef: { type: postRefSchema, default: null },
    storyRef: { type: storyRefSchema, default: null },
    profileRef: { type: profileRefSchema, default: null },
    media: { type: mediaSchema, default: null },
    replyTo: { type: replyToSchema, default: null },
  },
  { timestamps: true },
);

/** Paginated message fetch: newest first within a conversation. */
messageSchema.index({ conversation: 1, createdAt: -1, _id: -1 });

export const MessageModel: Model<IMessage> =
  (mongoose.models.Message as Model<IMessage> | undefined) ??
  mongoose.model<IMessage>('Message', messageSchema);
