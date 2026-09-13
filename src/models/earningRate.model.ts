import mongoose, { Schema, type Model } from 'mongoose';

/** Tracked app sections that earn. Keep in sync with the frontend tracker.
 * Stories are intentionally excluded — viewing stories does not earn. */
export type EarningSection = 'feed' | 'music' | 'blogging';

export const EARNING_SECTIONS: readonly EarningSection[] = [
  'feed',
  'music',
  'blogging',
] as const;

export interface IEarningRate {
  /** Unique per active section. */
  section: EarningSection;
  /** Currency units earned per 1 minute spent in this section (e.g. 0.01). */
  ratePerMinute: number;
  /** When false, time tracked in this section earns nothing (rate treated as 0). */
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const earningRateSchema = new Schema<IEarningRate>(
  {
    section: {
      type: String,
      required: true,
      unique: true,
      enum: EARNING_SECTIONS,
    },
    ratePerMinute: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const EarningRateModel: Model<IEarningRate> =
  (mongoose.models.EarningRate as Model<IEarningRate> | undefined) ??
  mongoose.model<IEarningRate>('EarningRate', earningRateSchema);
