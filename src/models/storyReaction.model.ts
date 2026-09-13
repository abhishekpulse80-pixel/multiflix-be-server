import mongoose, { Schema, type Model, type Types } from 'mongoose';

export const REACTION_TYPES = [
  'happy',
  'funny',
  'thrilled',
  'angry',
  'sad',
  'wow',
] as const;

export type ReactionType = (typeof REACTION_TYPES)[number];

export interface IStoryReaction {
  story: Types.ObjectId;
  user: Types.ObjectId;
  reaction: ReactionType;
  createdAt: Date;
  updatedAt: Date;
}

const storyReactionSchema = new Schema<IStoryReaction>(
  {
    story: {
      type: Schema.Types.ObjectId,
      ref: 'Story',
      required: true,
      index: true,
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    reaction: {
      type: String,
      required: true,
      enum: REACTION_TYPES,
    },
  },
  { timestamps: true },
);

/** One reaction per user per story. */
storyReactionSchema.index({ story: 1, user: 1 }, { unique: true });

export const StoryReactionModel: Model<IStoryReaction> =
  (mongoose.models.StoryReaction as Model<IStoryReaction> | undefined) ??
  mongoose.model<IStoryReaction>('StoryReaction', storyReactionSchema);
