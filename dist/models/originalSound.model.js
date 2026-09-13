import mongoose, { Schema } from 'mongoose';
export const ORIGINAL_SOUND_STATUSES = [
    'processing',
    'ready',
    'failed',
    'deleted',
];
const originalSoundSchema = new Schema({
    sourcePost: {
        type: Schema.Types.ObjectId,
        ref: 'Post',
        required: true,
        unique: true,
        index: true,
    },
    ownerUser: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    audioKey: { type: String, default: null, trim: true, maxlength: 1024 },
    audioUrl: { type: String, default: null, trim: true, maxlength: 2048 },
    durationSeconds: { type: Number, default: null, min: 0 },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    isPublic: { type: Boolean, default: true, index: true },
    status: {
        type: String,
        required: true,
        enum: ORIGINAL_SOUND_STATUSES,
        default: 'processing',
        index: true,
    },
    failureReason: {
        type: String,
        default: null,
        trim: true,
        maxlength: 512,
    },
    usesCount: { type: Number, required: true, min: 0, default: 0 },
}, { timestamps: true });
// Catalog browse: ready + public, hottest first.
originalSoundSchema.index({ status: 1, isPublic: 1, usesCount: -1 });
// Owner profile listing.
originalSoundSchema.index({ ownerUser: 1, createdAt: -1 });
export const OriginalSoundModel = mongoose.models.OriginalSound ??
    mongoose.model('OriginalSound', originalSoundSchema);
