import mongoose, { Schema } from 'mongoose';
const musicTrackFavouriteSchema = new Schema({
    user: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    track: {
        type: Schema.Types.ObjectId,
        ref: 'MusicTrack',
        required: true,
        index: true,
    },
}, { timestamps: { createdAt: true, updatedAt: false } });
musicTrackFavouriteSchema.index({ user: 1, track: 1 }, { unique: true });
musicTrackFavouriteSchema.index({ user: 1, createdAt: -1 });
export const MusicTrackFavouriteModel = mongoose.models.MusicTrackFavourite ??
    mongoose.model('MusicTrackFavourite', musicTrackFavouriteSchema);
