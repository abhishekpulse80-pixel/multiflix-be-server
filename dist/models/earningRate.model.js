import mongoose, { Schema } from 'mongoose';
export const EARNING_SECTIONS = [
    'feed',
    'music',
    'blogging',
];
const earningRateSchema = new Schema({
    section: {
        type: String,
        required: true,
        unique: true,
        enum: EARNING_SECTIONS,
    },
    ratePerMinute: {
        type: Number,
        required: true,
        min: 0,
        default: 0,
    },
    isActive: { type: Boolean, default: true },
}, { timestamps: true });
export const EarningRateModel = mongoose.models.EarningRate ??
    mongoose.model('EarningRate', earningRateSchema);
