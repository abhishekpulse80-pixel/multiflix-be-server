import mongoose, { Schema, type Model, type Types } from 'mongoose';

export interface IMusicTrackFavourite {
  user: Types.ObjectId;
  track: Types.ObjectId;
  createdAt: Date;
}

const musicTrackFavouriteSchema = new Schema<IMusicTrackFavourite>(
  {
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
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

musicTrackFavouriteSchema.index({ user: 1, track: 1 }, { unique: true });
musicTrackFavouriteSchema.index({ user: 1, createdAt: -1 });

export const MusicTrackFavouriteModel: Model<IMusicTrackFavourite> =
  (mongoose.models.MusicTrackFavourite as
    | Model<IMusicTrackFavourite>
    | undefined) ??
  mongoose.model<IMusicTrackFavourite>(
    'MusicTrackFavourite',
    musicTrackFavouriteSchema,
  );
