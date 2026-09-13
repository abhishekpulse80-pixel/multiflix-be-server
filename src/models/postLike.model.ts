import mongoose, { Schema, type Model, type Types } from 'mongoose';

export interface IPostLike {
  user: Types.ObjectId;
  post: Types.ObjectId;
  createdAt: Date;
}

const postLikeSchema = new Schema<IPostLike>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    post: {
      type: Schema.Types.ObjectId,
      ref: 'Post',
      required: true,
      index: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

postLikeSchema.index({ user: 1, post: 1 }, { unique: true });

export const PostLikeModel: Model<IPostLike> =
  (mongoose.models.PostLike as Model<IPostLike> | undefined) ??
  mongoose.model<IPostLike>('PostLike', postLikeSchema);
