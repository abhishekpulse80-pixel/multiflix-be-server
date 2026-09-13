import mongoose, { Schema } from 'mongoose';
const musicTrackSchema = new Schema({
    album: {
        type: Schema.Types.ObjectId,
        ref: 'MusicAlbum',
        default: null,
        index: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    artist: {
        type: Schema.Types.ObjectId,
        ref: 'Artist',
        required: true,
        index: true,
    },
    artUrl: { type: String, required: true, trim: true, maxlength: 2048 },
    audioUrl: { type: String, required: true, trim: true, maxlength: 2048 },
    durationSeconds: { type: Number, default: null, min: 0 },
    streamsCount: { type: Number, required: true, min: 0, default: 0 },
    sortOrder: { type: Number, required: true, min: 0, default: 0 },
    status: {
        type: String,
        required: true,
        enum: ['draft', 'published'],
        default: 'published',
        index: true,
    },
    seedKey: {
        type: String,
        default: null,
        trim: true,
        maxlength: 64,
    },
}, { timestamps: true });
musicTrackSchema.index({ album: 1, sortOrder: 1 });
musicTrackSchema.index({ status: 1, streamsCount: -1 });
/**
 * Unique only when `seedKey` is an actual string. `sparse: true` alone is not
 * enough because Mongoose's `default: null` stores explicit nulls, which a
 * sparse index still considers "present" — causing E11000 on admin inserts.
 */
musicTrackSchema.index({ seedKey: 1 }, {
    unique: true,
    partialFilterExpression: { seedKey: { $type: 'string' } },
});
export const MusicTrackModel = mongoose.models.MusicTrack ??
    mongoose.model('MusicTrack', musicTrackSchema);
