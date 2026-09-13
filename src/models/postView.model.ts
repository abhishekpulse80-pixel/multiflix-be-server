import mongoose, { Schema, type Model, type Types } from 'mongoose';

/**
 * Records that a user has seen a post in their home feed, so the feed can
 * exclude already-seen posts and keep surfacing fresh content on refresh.
 */
export interface IPostView {
  user: Types.ObjectId;
  post: Types.ObjectId;
  createdAt: Date;
}

const postViewSchema = new Schema<IPostView>(
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

postViewSchema.index({ user: 1, post: 1 }, { unique: true });

export const PostViewModel: Model<IPostView> =
  (mongoose.models.PostView as Model<IPostView> | undefined) ??
  mongoose.model<IPostView>('PostView', postViewSchema);
