import mongoose, { Schema, type Model } from 'mongoose';
import type { AudioProcessingStatus, AudioVariant } from '../types/audioProcessing.js';

/**
 * Extraction lifecycle. A row is inserted in `processing` immediately when
 * `POST /posts` accepts a video with `originalAudioMuted: false`, then flipped
 * to `ready` once the worker finishes, or `failed` if ffmpeg / S3 errors out.
 * `deleted` is set when the source post is removed by the owner.
 */
export type OriginalSoundStatus =
  | 'processing'
  | 'ready'
  | 'failed'
  | 'deleted';

export const ORIGINAL_SOUND_STATUSES: readonly OriginalSoundStatus[] = [
  'processing',
  'ready',
  'failed',
  'deleted',
] as const;

export interface IOriginalSound {
  /** The video post the audio was extracted from. */
  sourcePost: mongoose.Types.ObjectId;
  /** Cached author reference for fast catalog queries. */
  ownerUser: mongoose.Types.ObjectId;

  /**
   * S3 object key for the extracted .m4a (e.g. `sounds/<postId>.m4a`).
   * Public CDN URL is composed at read time via `publicUrlForKey()`.
   */
  audioKey: string | null;
  /** Final CDN/Public URL — denormalised so feed responses don't recompute. */
  audioUrl: string | null;
  audioProcessingStatus: AudioProcessingStatus;
  audioVariants: AudioVariant[];
  audioProcessingError: string | null;
  durationSeconds: number | null;

  /**
   * Human-facing label. Defaults to "Original sound — <username>" but the owner
   * may rename it later via a future settings endpoint.
   */
  title: string;

  /**
   * Mirrors the source post's visibility. Private/friends-only posts produce
   * a sound that is NOT browsable in the public catalog. Future-proofs for
   * when post visibility lands.
   */
  isPublic: boolean;

  status: OriginalSoundStatus;
  /** When ffmpeg or S3 fails — surfaced to admin dashboards if needed. */
  failureReason: string | null;

  /** Aggregate count of posts that reuse this sound. Denormalised for sort. */
  usesCount: number;

  createdAt: Date;
  updatedAt: Date;
}

const originalSoundSchema = new Schema<IOriginalSound>(
  {
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
  },
  { timestamps: true },
);

// Catalog browse: ready + public, hottest first.
originalSoundSchema.index({ status: 1, isPublic: 1, usesCount: -1 });
// Owner profile listing.
originalSoundSchema.index({ ownerUser: 1, createdAt: -1 });

export const OriginalSoundModel: Model<IOriginalSound> =
  (mongoose.models.OriginalSound as Model<IOriginalSound> | undefined) ??
  mongoose.model<IOriginalSound>('OriginalSound', originalSoundSchema);
