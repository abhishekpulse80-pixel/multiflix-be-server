import mongoose, { Schema } from 'mongoose';
const blogFavoriteSchema = new Schema({
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
}, { timestamps: { createdAt: true, updatedAt: false } });
blogFavoriteSchema.index({ user: 1, blog: 1 }, { unique: true });
export const BlogFavoriteModel = mongoose.models.BlogFavorite ??
    mongoose.model('BlogFavorite', blogFavoriteSchema);
