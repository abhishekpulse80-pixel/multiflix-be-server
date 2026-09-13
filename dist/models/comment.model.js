import mongoose, { Schema } from 'mongoose';
const commentSchema = new Schema({
    post: {
        type: Schema.Types.ObjectId,
        ref: 'Post',
        required: true,
        index: true,
    },
    author: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    text: {
        type: String,
        required: true,
        trim: true,
        minlength: 1,
        maxlength: 2000,
    },
}, { timestamps: true });
/** Chronological thread: oldest first for offset pagination. */
commentSchema.index({ post: 1, createdAt: 1, _id: 1 });
export const CommentModel = mongoose.models.Comment ??
    mongoose.model('Comment', commentSchema);
