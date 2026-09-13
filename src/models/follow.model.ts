import mongoose, { Schema, type Model, type Types } from 'mongoose';

export interface IFollow {
  follower: Types.ObjectId;
  followee: Types.ObjectId;
  createdAt: Date;
}

const followSchema = new Schema<IFollow>(
  {
    follower: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    followee: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

followSchema.index({ follower: 1, followee: 1 }, { unique: true });

export const FollowModel: Model<IFollow> =
  (mongoose.models.Follow as Model<IFollow> | undefined) ??
  mongoose.model<IFollow>('Follow', followSchema);
