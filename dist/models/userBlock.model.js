import mongoose, { Schema } from 'mongoose';
const userBlockSchema = new Schema({
    blocker: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    blocked: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
}, { timestamps: { createdAt: true, updatedAt: false } });
userBlockSchema.index({ blocker: 1, blocked: 1 }, { unique: true });
export const UserBlockModel = mongoose.models.UserBlock ??
    mongoose.model('UserBlock', userBlockSchema);
