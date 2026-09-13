import mongoose, { Schema } from 'mongoose';
const lastReadSchema = new Schema({
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    at: { type: Date, required: true, default: Date.now },
}, { _id: false });
const clearedAtSchema = new Schema({
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    at: { type: Date, required: true, default: Date.now },
}, { _id: false });
const conversationSchema = new Schema({
    participants: {
        type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
        required: true,
        validate: {
            validator: (v) => v.length === 2,
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
}, { timestamps: true });
/** Fast lookup: find conversations for a given user. */
conversationSchema.index({ participants: 1 });
/** Unique pair — prevent duplicate conversations between same two users. */
conversationSchema.index({ 'participants.0': 1, 'participants.1': 1 }, { unique: true });
export const ConversationModel = mongoose.models.Conversation ??
    mongoose.model('Conversation', conversationSchema);
