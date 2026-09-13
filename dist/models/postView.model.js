import mongoose, { Schema } from 'mongoose';
const postViewSchema = new Schema({
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
postViewSchema.index({ user: 1, post: 1 }, { unique: true });
export const PostViewModel = mongoose.models.PostView ??
    mongoose.model('PostView', postViewSchema);
