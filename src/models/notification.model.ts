import mongoose, { Schema, type Model, type Types } from 'mongoose';

export const NOTIFICATION_TYPES = [
  'new_follower',
  'post_like',
  'post_comment',
  'blog_like',
  'story_reaction',
  'withdrawal_approved',
  'withdrawal_rejected',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface INotification {
  /** User who receives the notification (owner of the inbox). */
  recipient: Types.ObjectId;
  /**
   * User who triggered the notification (liker, commenter, follower).
   * `null` for system notifications (e.g. withdrawal decisions).
   */
  actor: Types.ObjectId | null;
  type: NotificationType;
  /** Set for post_like and post_comment. */
  post?: Types.ObjectId;
  /** Set for post_comment. */
  comment?: Types.ObjectId;
  /** Set for blog_like. */
  blog?: Types.ObjectId;
  /** Set for story_reaction. */
  story?: Types.ObjectId;
  /**
   * Generic payload for system notifications (e.g. `{ amount, requestId }`
   * for withdrawal decisions). Kept as Mixed so future types can extend
   * without a schema migration.
   */
  meta?: Record<string, unknown> | null;
  isRead: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    recipient: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    actor: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    type: {
      type: String,
      required: true,
      enum: NOTIFICATION_TYPES,
    },
    post: {
      type: Schema.Types.ObjectId,
      ref: 'Post',
    },
    comment: {
      type: Schema.Types.ObjectId,
      ref: 'Comment',
    },
    blog: {
      type: Schema.Types.ObjectId,
      ref: 'Blog',
    },
    story: {
      type: Schema.Types.ObjectId,
      ref: 'Story',
    },
    meta: {
      type: Schema.Types.Mixed,
      default: null,
    },
    isRead: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  { timestamps: true },
);

/** List a user's inbox newest-first. */
notificationSchema.index({ recipient: 1, createdAt: -1, _id: -1 });
/** Fast unread-count lookup. */
notificationSchema.index({ recipient: 1, isRead: 1 });

export const NotificationModel: Model<INotification> =
  (mongoose.models.Notification as Model<INotification> | undefined) ??
  mongoose.model<INotification>('Notification', notificationSchema);
