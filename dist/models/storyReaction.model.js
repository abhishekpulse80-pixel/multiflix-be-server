import mongoose, { Schema } from 'mongoose';
export const REACTION_TYPES = [
    'happy',
    'funny',
    'thrilled',
    'angry',
    'sad',
    'wow',
];
const storyReactionSchema = new Schema({
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
}, { timestamps: true });
/** One reaction per user per story. */
storyReactionSchema.index({ story: 1, user: 1 }, { unique: true });
export const StoryReactionModel = mongoose.models.StoryReaction ??
    mongoose.model('StoryReaction', storyReactionSchema);
