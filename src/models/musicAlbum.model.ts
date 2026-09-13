import mongoose, { Schema, type Model } from 'mongoose';

/** Admin-curated album (no end-user author). */
export type MusicAlbumStatus = 'draft' | 'published';

export interface IMusicAlbum {
  title: string;
  coverArtUrl: string;
  /** Highlight on music home carousel. */
  featured: boolean;
  /** Required: album-level artist (Subtask 2 — was free-text `artistName`). */
  artist: mongoose.Types.ObjectId;
  status: MusicAlbumStatus;
  publishedAt: Date | null;
  /** Lower sorts first when listing published albums. */
  sortOrder: number;
  /**
   * Set only by seed scripts so re-runs can replace the same rows safely.
   * Production admin uploads should omit this field.
   */
  seedKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const musicAlbumSchema = new Schema<IMusicAlbum>(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    coverArtUrl: { type: String, required: true, trim: true, maxlength: 2048 },
    featured: { type: Boolean, required: true, default: false },
    artist: {
      type: Schema.Types.ObjectId,
      ref: 'Artist',
      required: true,
      index: true,
    },
    status: {
      type: String,
      required: true,
      enum: ['draft', 'published'],
      default: 'published',
      index: true,
    },
    publishedAt: { type: Date, default: null, index: true },
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

musicAlbumSchema.index({ status: 1, sortOrder: 1, _id: 1 });
musicAlbumSchema.index({ status: 1, featured: -1, publishedAt: -1 });
/**
 * Unique only when `seedKey` is an actual string. `sparse: true` alone is not
 * enough because Mongoose's `default: null` stores explicit nulls, which a
 * sparse index still considers "present" — causing E11000 on admin inserts.
 */
musicAlbumSchema.index(
  { seedKey: 1 },
  {
    unique: true,
    partialFilterExpression: { seedKey: { $type: 'string' } },
  },
);

export const MusicAlbumModel: Model<IMusicAlbum> =
  (mongoose.models.MusicAlbum as Model<IMusicAlbum> | undefined) ??
  mongoose.model<IMusicAlbum>('MusicAlbum', musicAlbumSchema);
