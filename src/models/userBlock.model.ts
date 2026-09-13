import mongoose, { Schema, type Model, type Types } from 'mongoose';

/**
 * A user-initiated block between two users.
 * `blocker` hides `blocked` across the app (feed, search, profile, chat, stories, etc.).
 * The relationship is asymmetric in storage but enforced symmetrically at read time:
 * if A blocks B OR B blocks A, neither can see the other.
 */
export interface IUserBlock {
  blocker: Types.ObjectId;
  blocked: Types.ObjectId;
  createdAt: Date;
}

const userBlockSchema = new Schema<IUserBlock>(
  {
    blocker: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    blocked: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

userBlockSchema.index({ blocker: 1, blocked: 1 }, { unique: true });

export const UserBlockModel: Model<IUserBlock> =
  (mongoose.models.UserBlock as Model<IUserBlock> | undefined) ??
  mongoose.model<IUserBlock>('UserBlock', userBlockSchema);
