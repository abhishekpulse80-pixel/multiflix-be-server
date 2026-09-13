import mongoose, { Schema } from 'mongoose';
const mediaSchema = new Schema({
    key: { type: String, required: true },
    bucket: { type: String, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true, min: 0 },
    originalName: { type: String, required: true },
    url: { type: String, default: null },
}, { _id: false });
const postSchema = new Schema({
    author: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    mediaKind: {
        type: String,
        required: true,
        enum: ['image', 'short_video'],
    },
    media: { type: mediaSchema, required: true },
    thumbnailUrl: { type: String, default: null },
    caption: { type: String, default: null, maxlength: 4000 },
    hashtags: { type: String, default: null, maxlength: 2000 },
    musicTitle: { type: String, default: null, maxlength: 512 },
    musicTrack: {
        type: Schema.Types.ObjectId,
        ref: 'MusicTrack',
        default: null,
        index: true,
    },
    musicTrimStartMs: { type: Number, default: null, min: 0 },
    originalAudioMuted: { type: Boolean, default: false },
    originalSoundId: {
        type: Schema.Types.ObjectId,
        ref: 'OriginalSound',
        default: null,
        index: true,
    },
    attachedOriginalSound: {
        type: Schema.Types.ObjectId,
        ref: 'OriginalSound',
        default: null,
        index: true,
    },
    mediaWidth: { type: Number, default: null, min: 1 },
    mediaHeight: { type: Number, default: null, min: 1 },
    durationSeconds: { type: Number, default: null, min: 0 },
    likesCount: { type: Number, default: 0, min: 0 },
    savesCount: { type: Number, default: 0, min: 0 },
    commentsCount: { type: Number, default: 0, min: 0 },
}, { timestamps: true });
postSchema.index({ createdAt: -1, _id: -1 });
postSchema.index({ author: 1, createdAt: -1 });
postSchema.pre('validate', function (next) {
    if (this.mediaKind === 'image' && this.durationSeconds != null) {
        this.invalidate('durationSeconds', 'durationSeconds must be unset for image posts');
    }
    if (this.musicTrack != null && this.attachedOriginalSound != null) {
        this.invalidate('attachedOriginalSound', 'A post can attach a curated track or an OriginalSound, not both');
    }
    next();
});
export const PostModel = mongoose.models.Post ??
    mongoose.model('Post', postSchema);
