import mongoose, { Schema } from 'mongoose';
const artistSchema = new Schema({
    name: { type: String, required: true, trim: true, maxlength: 120 },
    bio: { type: String, default: null, maxlength: 2000 },
    profileImageUrl: {
        type: String,
        default: null,
        trim: true,
        maxlength: 2048,
    },
    status: {
        type: String,
        required: true,
        enum: ['draft', 'published'],
        default: 'published',
        index: true,
    },
    sortOrder: { type: Number, required: true, default: 0 },
    seedKey: {
        type: String,
        default: null,
        trim: true,
        maxlength: 64,
    },
}, { timestamps: true });
artistSchema.index({ status: 1, sortOrder: 1, _id: 1 });
/**
 * Unique only when `seedKey` is an actual string. Mirrors the same
 * partial-index pattern we use on MusicTrack / MusicAlbum.
 */
artistSchema.index({ seedKey: 1 }, {
    unique: true,
    partialFilterExpression: { seedKey: { $type: 'string' } },
});
export const ArtistModel = mongoose.models.Artist ??
    mongoose.model('Artist', artistSchema);
