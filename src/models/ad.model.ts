import mongoose, { Schema, type Model } from 'mongoose';

export type AdPlacement = 'feed' | 'stories' | 'blog' | 'banner';
export type AdStatus = 'draft' | 'active' | 'paused' | 'expired';

export interface IAd {
  title: string;
  imageUrl: string;
  targetUrl: string;
  placement: AdPlacement;
  status: AdStatus;
  impressions: number;
  clicks: number;
  startDate?: Date | null;
  endDate?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const adSchema = new Schema<IAd>(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    imageUrl: {
      type: String,
      required: true,
      trim: true,
    },
    targetUrl: {
      type: String,
      required: true,
      trim: true,
    },
    placement: {
      type: String,
      enum: ['feed', 'stories', 'blog', 'banner'],
      default: 'feed',
      index: true,
    },
    status: {
      type: String,
      enum: ['draft', 'active', 'paused', 'expired'],
      default: 'draft',
      index: true,
    },
    impressions: {
      type: Number,
      default: 0,
      min: 0,
    },
    clicks: {
      type: Number,
      default: 0,
      min: 0,
    },
    startDate: {
      type: Date,
      default: null,
    },
    endDate: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

export const AdModel: Model<IAd> =
  (mongoose.models.Ad as Model<IAd> | undefined) ??
  mongoose.model<IAd>('Ad', adSchema);
