import mongoose, { Schema } from 'mongoose';
const blogSchema = new Schema({
    author: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: null, maxlength: 8000 },
    viewsCount: { type: Number, required: true, min: 0, default: 0 },
    thumbnailUrl: { type: String, required: true, trim: true, maxlength: 2048 },
    videoUrl: { type: String, required: true, trim: true, maxlength: 2048 },
    videoKey: { type: String, required: true, trim: true, maxlength: 1024 },
    durationSeconds: { type: Number, default: null, min: 0 },
    mediaProcessingStatus: {
        type: String,
        enum: ['not_required', 'processing', 'ready', 'failed'],
        default: 'processing',
        index: true,
    },
    hlsUrl: { type: String, default: null },
    hlsVariants: {
        type: [
            {
                _id: false,
                quality: { type: String, required: true },
                width: { type: Number, required: true },
                height: { type: Number, required: true },
                bitrateKbps: { type: Number, required: true },
                playlistUrl: { type: String, required: true },
            },
        ],
        default: [],
    },
    mediaProcessingError: { type: String, default: null },
    tags: { type: [String], default: [] },
    status: {
        type: String,
        required: true,
        enum: ['draft', 'published'],
        default: 'published',
        index: true,
    },
    publishedAt: { type: Date, default: null, index: true },
}, { timestamps: true });
blogSchema.index({ status: 1, publishedAt: -1, _id: -1 });
blogSchema.index({ author: 1, createdAt: -1 });
export const BlogModel = mongoose.models.Blog ??
    mongoose.model('Blog', blogSchema);
