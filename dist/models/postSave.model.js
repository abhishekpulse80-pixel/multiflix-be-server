import mongoose, { Schema } from 'mongoose';
const postSaveSchema = new Schema({
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
postSaveSchema.index({ user: 1, post: 1 }, { unique: true });
export const PostSaveModel = mongoose.models.PostSave ??
    mongoose.model('PostSave', postSaveSchema);
