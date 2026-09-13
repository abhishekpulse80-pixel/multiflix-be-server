import mongoose, { Schema } from 'mongoose';
export const WITHDRAWAL_REQUEST_STATUSES = [
    'pending',
    'approved',
    'rejected',
];
const bankSnapshotSchema = new Schema({
    holderName: { type: String, required: true, trim: true },
    accountNumber: { type: String, required: true, trim: true },
    ifscCode: { type: String, required: true, trim: true },
}, { _id: false });
const withdrawalRequestSchema = new Schema({
    user: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    amount: { type: Number, required: true, min: 0 },
    status: {
        type: String,
        required: true,
        enum: WITHDRAWAL_REQUEST_STATUSES,
        default: 'pending',
        index: true,
    },
    bankSnapshot: { type: bankSnapshotSchema, required: true },
    adminNote: { type: String, default: null, maxlength: 1000 },
    decidedAt: { type: Date, default: null },
}, { timestamps: true });
/** Newest-first listing per user. */
withdrawalRequestSchema.index({ user: 1, createdAt: -1 });
/** Admin inbox: pending first. */
withdrawalRequestSchema.index({ status: 1, createdAt: -1 });
export const WithdrawalRequestModel = mongoose.models.WithdrawalRequest ??
    mongoose.model('WithdrawalRequest', withdrawalRequestSchema);
