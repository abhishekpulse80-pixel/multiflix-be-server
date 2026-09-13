import mongoose, { Schema, type Model } from 'mongoose';

/**
 * Generic admin-managed key/value setting. Values are stored as `Mixed`
 * so callers can hold numbers, strings, booleans, or small JSON objects.
 * Known keys + their types are enforced by `appSetting.service.ts`.
 */
export interface IAppSetting {
  key: string;
  value: unknown;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const appSettingSchema = new Schema<IAppSetting>(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      maxlength: 120,
    },
    value: { type: Schema.Types.Mixed, required: true },
    description: { type: String, default: null, maxlength: 500 },
  },
  { timestamps: true },
);

export const AppSettingModel: Model<IAppSetting> =
  (mongoose.models.AppSetting as Model<IAppSetting> | undefined) ??
  mongoose.model<IAppSetting>('AppSetting', appSettingSchema);
