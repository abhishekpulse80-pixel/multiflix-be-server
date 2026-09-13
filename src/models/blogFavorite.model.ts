import mongoose, { Schema, type Model, type Types } from 'mongoose';

export interface IBlogFavorite {
  user: Types.ObjectId;
  blog: Types.ObjectId;
  createdAt: Date;
}

const blogFavoriteSchema = new Schema<IBlogFavorite>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    blog: {
      type: Schema.Types.ObjectId,
      ref: 'Blog',
      required: true,
      index: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

blogFavoriteSchema.index({ user: 1, blog: 1 }, { unique: true });

export const BlogFavoriteModel: Model<IBlogFavorite> =
  (mongoose.models.BlogFavorite as Model<IBlogFavorite> | undefined) ??
  mongoose.model<IBlogFavorite>('BlogFavorite', blogFavoriteSchema);
