import mongoose, { Schema } from 'mongoose';
const storyViewSchema = new Schema({
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
}, { timestamps: { createdAt: true, updatedAt: false } });
/** Each viewer is recorded at most once per story. */
storyViewSchema.index({ story: 1, viewer: 1 }, { unique: true });
export const StoryViewModel = mongoose.models.StoryView ??
    mongoose.model('StoryView', storyViewSchema);
