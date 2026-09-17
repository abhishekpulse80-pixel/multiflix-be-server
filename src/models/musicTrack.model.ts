import mongoose, { Schema, type Model } from 'mongoose';
import type { AudioProcessingStatus, AudioVariant } from '../types/audioProcessing.js';

export type MusicTrackStatus = 'draft' | 'published';

export interface IMusicTrack {
  album: mongoose.Types.ObjectId | null;
  title: string;
  /**
   * Required: track-level artist. Independent of album.artist (a track on
   * an album may credit a different artist — see Subtask 2 pick 2B).
   */
  artist: mongoose.Types.ObjectId;
  artUrl: string;
  /** Stream URL (MP3, etc.) — filled by admin upload pipeline later. */
  audioUrl: string;
  audioKey: string | null;
  audioProcessingStatus: AudioProcessingStatus;
  audioVariants: AudioVariant[];
  audioProcessingError: string | null;
  durationSeconds: number | null;
  /** Aggregate play count (no per-listener detail). */
  streamsCount: number;
  /** Order within the parent album (0-based). */
  sortOrder: number;
  status: MusicTrackStatus;
  seedKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const musicTrackSchema = new Schema<IMusicTrack>(
  {
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
    audioKey: { type: String, default: null, trim: true, maxlength: 1024 },
    audioProcessingStatus: {
      type: String,
      enum: ['not_required', 'processing', 'ready', 'failed'],
      default: 'not_required',
      index: true,
    },
    audioVariants: {
      type: [
        {
          _id: false,
          quality: { type: String, required: true },
          bitrateKbps: { type: Number, required: true },
          url: { type: String, required: true },
        },
      ],
      default: [],
    },
    audioProcessingError: { type: String, default: null },
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
  },
  { timestamps: true },
);

musicTrackSchema.index({ album: 1, sortOrder: 1 });
musicTrackSchema.index({ status: 1, streamsCount: -1 });
/**
 * Unique only when `seedKey` is an actual string. `sparse: true` alone is not
 * enough because Mongoose's `default: null` stores explicit nulls, which a
 * sparse index still considers "present" — causing E11000 on admin inserts.
 */
musicTrackSchema.index(
  { seedKey: 1 },
  {
    unique: true,
    partialFilterExpression: { seedKey: { $type: 'string' } },
  },
);

export const MusicTrackModel: Model<IMusicTrack> =
  (mongoose.models.MusicTrack as Model<IMusicTrack> | undefined) ??
  mongoose.model<IMusicTrack>('MusicTrack', musicTrackSchema);
