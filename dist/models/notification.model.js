import mongoose, { Schema } from 'mongoose';
export const NOTIFICATION_TYPES = [
    'new_follower',
    'post_like',
    'post_comment',
    'blog_like',
    'story_reaction',
    'withdrawal_approved',
    'withdrawal_rejected',
];
const notificationSchema = new Schema({
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
}, { timestamps: true });
/** List a user's inbox newest-first. */
notificationSchema.index({ recipient: 1, createdAt: -1, _id: -1 });
/** Fast unread-count lookup. */
notificationSchema.index({ recipient: 1, isRead: 1 });
export const NotificationModel = mongoose.models.Notification ??
    mongoose.model('Notification', notificationSchema);
