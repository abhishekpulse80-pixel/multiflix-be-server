import mongoose, { Schema, type Model, type Types } from 'mongoose';

export interface IPostSave {
  user: Types.ObjectId;
  post: Types.ObjectId;
  createdAt: Date;
}

const postSaveSchema = new Schema<IPostSave>(
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

postSaveSchema.index({ user: 1, post: 1 }, { unique: true });

export const PostSaveModel: Model<IPostSave> =
  (mongoose.models.PostSave as Model<IPostSave> | undefined) ??
  mongoose.model<IPostSave>('PostSave', postSaveSchema);
