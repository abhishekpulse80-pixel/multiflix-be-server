import mongoose, { Schema, type Model } from 'mongoose';

/** Admin-curated artist (not a User account — display only). */
export type ArtistStatus = 'draft' | 'published';

export interface IArtist {
  name: string;
  bio: string | null;
  /** Square avatar / portrait URL. */
  profileImageUrl: string | null;
  status: ArtistStatus;
  /** Lower sorts first in admin lists. */
  sortOrder: number;
  /**
   * Set only by seed scripts so re-runs can replace the same rows safely.
   * Production admin uploads should omit this field.
   */
  seedKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const artistSchema = new Schema<IArtist>(
  {
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
  },
  { timestamps: true },
);

artistSchema.index({ status: 1, sortOrder: 1, _id: 1 });
/**
 * Unique only when `seedKey` is an actual string. Mirrors the same
 * partial-index pattern we use on MusicTrack / MusicAlbum.
 */
artistSchema.index(
  { seedKey: 1 },
  {
    unique: true,
    partialFilterExpression: { seedKey: { $type: 'string' } },
  },
);

export const ArtistModel: Model<IArtist> =
  (mongoose.models.Artist as Model<IArtist> | undefined) ??
  mongoose.model<IArtist>('Artist', artistSchema);
