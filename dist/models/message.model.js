import mongoose, { Schema } from 'mongoose';
const postRefSchema = new Schema({
    postId: { type: Schema.Types.ObjectId, ref: 'Post', required: true },
    thumbnailUrl: { type: String, default: '' },
    mediaUrl: { type: String, default: '' },
    caption: { type: String, default: '' },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    authorName: { type: String, default: '' },
    authorAvatarUrl: { type: String, default: null },
    mediaKind: { type: String, enum: ['image', 'video'], default: 'image' },
}, { _id: false });
const storyRefSchema = new Schema({
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
}, { _id: false });
const profileRefSchema = new Schema({
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, default: '' },
    displayName: { type: String, default: '' },
    avatarUrl: { type: String, default: null },
}, { _id: false });
const replyToSchema = new Schema({
    messageId: { type: Schema.Types.ObjectId, ref: 'Message', required: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, default: '', maxlength: 200 },
    kind: {
        type: String,
        enum: ['text', 'image', 'video', 'post', 'story'],
        default: 'text',
    },
}, { _id: false });
const mediaSchema = new Schema({
    url: { type: String, required: true },
    kind: { type: String, enum: ['image', 'video'], required: true },
    thumbnailUrl: { type: String, default: '' },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    durationMs: { type: Number, default: 0 },
    sizeBytes: { type: Number, default: 0 },
}, { _id: false });
const messageSchema = new Schema({
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
}, { timestamps: true });
/** Paginated message fetch: newest first within a conversation. */
messageSchema.index({ conversation: 1, createdAt: -1, _id: -1 });
export const MessageModel = mongoose.models.Message ??
    mongoose.model('Message', messageSchema);
