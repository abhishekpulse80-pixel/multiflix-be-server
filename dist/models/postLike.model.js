import mongoose, { Schema } from 'mongoose';
const postLikeSchema = new Schema({
    user: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    post: {
        type: Schema.Types.ObjectId,
        ref: 'Post',
        required: true,
        index: true,
    },
}, { timestamps: { createdAt: true, updatedAt: false } });
postLikeSchema.index({ user: 1, post: 1 }, { unique: true });
export const PostLikeModel = mongoose.models.PostLike ??
    mongoose.model('PostLike', postLikeSchema);
