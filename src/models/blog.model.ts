import mongoose, { Schema, type Model } from 'mongoose';
import type { MediaProcessingStatus, MediaProcessingVariant } from '../types/mediaProcessing.js';

/**
 * Long-form video blog (podcast-style). Upload pipeline can fill `videoUrl` / `thumbnailUrl` later.
 * Distinct from short `Post` feed items.
 */
export type BlogStatus = 'draft' | 'published';

export interface IBlog {
  author: mongoose.Types.ObjectId;
  title: string;
  /** Short blurb for cards / SEO. */
  description: string | null;
  /** Aggregate total watch opens; no per-viewer tracking. */
  viewsCount: number;
  thumbnailUrl: string;
  /** Main episode URL (MP4, HLS, etc.) after upload. */
  videoUrl: string;
  /** Original S3 object key used by the media worker. */
  videoKey: string;
  durationSeconds: number | null;
  mediaProcessingStatus: MediaProcessingStatus;
  hlsUrl: string | null;
  hlsVariants: MediaProcessingVariant[];
  mediaProcessingError: string | null;
  tags: string[];
  status: BlogStatus;
  /** When the blog went live; null for drafts. */
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const blogSchema = new Schema<IBlog>(
  {
    author: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: null, maxlength: 8000 },
    viewsCount: { type: Number, required: true, min: 0, default: 0 },
    thumbnailUrl: { type: String, required: true, trim: true, maxlength: 2048 },
    videoUrl: { type: String, required: true, trim: true, maxlength: 2048 },
    videoKey: { type: String, required: true, trim: true, maxlength: 1024 },
    durationSeconds: { type: Number, default: null, min: 0 },
    mediaProcessingStatus: {
      type: String,
      enum: ['not_required', 'processing', 'ready', 'failed'],
      default: 'processing',
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
    tags: { type: [String], default: [] },
    status: {
      type: String,
      required: true,
      enum: ['draft', 'published'],
      default: 'published',
      index: true,
    },
    publishedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

blogSchema.index({ status: 1, publishedAt: -1, _id: -1 });
blogSchema.index({ author: 1, createdAt: -1 });

export const BlogModel: Model<IBlog> =
  (mongoose.models.Blog as Model<IBlog> | undefined) ??
  mongoose.model<IBlog>('Blog', blogSchema);
