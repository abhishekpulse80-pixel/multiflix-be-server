import mongoose, { Schema, type Model, type Types } from 'mongoose';

export type ReportTargetKind = 'post' | 'comment' | 'story';
export type ReportStatus = 'pending' | 'reviewed' | 'resolved';

export interface IReport {
  reporter: Types.ObjectId;
  targetKind: ReportTargetKind;
  targetId: Types.ObjectId;
  reason: string;
  status: ReportStatus;
  createdAt: Date;
}

const reportSchema = new Schema<IReport>(
  {
    reporter: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    targetKind: {
      type: String,
      enum: ['post', 'comment', 'story'],
      required: true,
    },
    targetId: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    reason: {
      type: String,
      required: true,
      maxlength: 1000,
    },
    status: {
      type: String,
      enum: ['pending', 'reviewed', 'resolved'],
      default: 'pending',
    },
  },
  { timestamps: true },
);

/** One user can only report a given target once. */
reportSchema.index({ reporter: 1, targetKind: 1, targetId: 1 }, { unique: true });
reportSchema.index({ targetKind: 1, targetId: 1 });

export const ReportModel: Model<IReport> =
  (mongoose.models.Report as Model<IReport> | undefined) ??
  mongoose.model<IReport>('Report', reportSchema);
