import mongoose, { Schema } from 'mongoose';
const adSchema = new Schema({
    title: {
        type: String,
        required: true,
        trim: true,
        maxlength: 200,
    },
    imageUrl: {
        type: String,
        required: true,
        trim: true,
    },
    targetUrl: {
        type: String,
        required: true,
        trim: true,
    },
    placement: {
        type: String,
        enum: ['feed', 'stories', 'blog', 'banner'],
        default: 'feed',
        index: true,
    },
    status: {
        type: String,
        enum: ['draft', 'active', 'paused', 'expired'],
        default: 'draft',
        index: true,
    },
    impressions: {
        type: Number,
        default: 0,
        min: 0,
    },
    clicks: {
        type: Number,
        default: 0,
        min: 0,
    },
    startDate: {
        type: Date,
        default: null,
    },
    endDate: {
        type: Date,
        default: null,
    },
}, { timestamps: true });
export const AdModel = mongoose.models.Ad ??
    mongoose.model('Ad', adSchema);
