import mongoose, { Schema, type Model, type Types } from 'mongoose';

export type FeedbackStatus = 'new' | 'read' | 'addressed';

export interface IFeedback {
  user: Types.ObjectId;
  subject: string;
  message: string;
  status: FeedbackStatus;
  adminNotes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const feedbackSchema = new Schema<IFeedback>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    subject: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5000,
    },
    status: {
      type: String,
      enum: ['new', 'read', 'addressed'],
      default: 'new',
      index: true,
    },
    adminNotes: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: '',
    },
  },
  { timestamps: true },
);

export const FeedbackModel: Model<IFeedback> =
  (mongoose.models.Feedback as Model<IFeedback> | undefined) ??
  mongoose.model<IFeedback>('Feedback', feedbackSchema);
