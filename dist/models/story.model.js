import mongoose, { Schema } from 'mongoose';
const textOverlaySchema = new Schema({
    text: { type: String, required: true, maxlength: 300 },
    x: { type: Number, required: true, min: 0, max: 1 },
    y: { type: Number, required: true, min: 0, max: 1 },
    color: { type: String, default: '#FFFFFF', maxlength: 16 },
    fontSize: { type: Number, default: 24, min: 10, max: 80 },
}, { _id: false });
const storyMediaSchema = new Schema({
    key: { type: String, required: true },
    bucket: { type: String, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true, min: 0 },
    originalName: { type: String, required: true },
    url: { type: String, default: null },
    imageVariants: {
        type: [{ _id: false, quality: { type: String, required: true }, width: { type: Number, required: true }, url: { type: String, required: true } }],
        default: [],
    },
}, { _id: false });
const storySchema = new Schema({
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
    media: { type: storyMediaSchema, required: true },
    soundTitle: { type: String, default: null, maxlength: 512 },
    musicTrack: {
        type: Schema.Types.ObjectId,
        ref: 'MusicTrack',
        default: null,
        index: true,
    },
    musicTrimStartMs: { type: Number, default: null, min: 0 },
    caption: { type: String, default: null, maxlength: 2000 },
    mediaWidth: { type: Number, default: null, min: 1 },
    mediaHeight: { type: Number, default: null, min: 1 },
    durationSeconds: { type: Number, default: null, min: 0 },
    mediaProcessingStatus: {
        type: String,
        enum: ['not_required', 'processing', 'ready', 'failed'],
        default: 'not_required',
        index: true,
    },
    hlsUrl: { type: String, default: null },
    hlsVariants: {
        type: [
            {
                _id: false,
                quality: { type: String, required: true },
                width: { type: Number, required: true },
                height: { type: Number, required: true },
                bitrateKbps: { type: Number, required: true },
                playlistUrl: { type: String, required: true },
            },
        ],
        default: [],
    },
    mediaProcessingError: { type: String, default: null },
    viewsCount: { type: Number, default: 0, min: 0 },
    expiresAt: { type: Date, required: true },
    isActive: { type: Boolean, default: true },
    showInTrending: { type: Boolean, default: true },
    textOverlays: { type: [textOverlaySchema], default: [] },
    mediaTransform: {
        type: new Schema({
            // Sane upper bound so a malicious / buggy client can't ship a
            // transform that breaks the viewer.
            scale: { type: Number, required: true, min: 0.5, max: 5 },
            translateX: { type: Number, required: true, min: -2, max: 2 },
            translateY: { type: Number, required: true, min: -2, max: 2 },
        }, { _id: false }),
        default: null,
    },
}, { timestamps: true });
/** Fast lookup of all active stories for a given author (profile ring). */
storySchema.index({ author: 1, expiresAt: 1, isActive: 1 });
/** Feed ordering: newest active stories first. */
storySchema.index({ expiresAt: 1, createdAt: -1, _id: -1, isActive: 1 });
export const StoryModel = mongoose.models.Story ??
    mongoose.model('Story', storySchema);
