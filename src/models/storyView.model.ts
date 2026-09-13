import mongoose, { Schema, type Model, type Types } from 'mongoose';

export interface IStoryView {
  story: Types.ObjectId;
  viewer: Types.ObjectId;
  createdAt: Date;
}

const storyViewSchema = new Schema<IStoryView>(
  {
    story: {
      type: Schema.Types.ObjectId,
      ref: 'Story',
      required: true,
      index: true,
    },
    viewer: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

/** Each viewer is recorded at most once per story. */
storyViewSchema.index({ story: 1, viewer: 1 }, { unique: true });

export const StoryViewModel: Model<IStoryView> =
  (mongoose.models.StoryView as Model<IStoryView> | undefined) ??
  mongoose.model<IStoryView>('StoryView', storyViewSchema);
