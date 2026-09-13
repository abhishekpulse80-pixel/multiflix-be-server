import mongoose, { Schema } from 'mongoose';
import { EARNING_SECTIONS, } from './earningRate.model.js';
export const TRANSACTION_TYPES = [
    'earning',
    'payout',
    'adjustment',
];
const transactionSchema = new Schema({
    user: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    type: { type: String, required: true, enum: TRANSACTION_TYPES },
    amount: { type: Number, required: true },
    section: {
        type: String,
        enum: [...EARNING_SECTIONS, null],
        default: null,
    },
    minutes: { type: Number, default: null, min: 0 },
    note: { type: String, default: null, trim: true, maxlength: 500 },
}, { timestamps: { createdAt: true, updatedAt: false } });
transactionSchema.index({ user: 1, createdAt: -1 });
export const TransactionModel = mongoose.models.Transaction ??
    mongoose.model('Transaction', transactionSchema);
