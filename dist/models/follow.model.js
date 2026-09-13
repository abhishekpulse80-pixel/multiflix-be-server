import mongoose, { Schema } from 'mongoose';
const followSchema = new Schema({
    follower: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    followee: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
}, { timestamps: { createdAt: true, updatedAt: false } });
followSchema.index({ follower: 1, followee: 1 }, { unique: true });
export const FollowModel = mongoose.models.Follow ??
    mongoose.model('Follow', followSchema);
