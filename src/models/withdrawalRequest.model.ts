import mongoose, { Schema, type Model, type Types } from 'mongoose';

export type WithdrawalRequestStatus = 'pending' | 'approved' | 'rejected';

export const WITHDRAWAL_REQUEST_STATUSES: readonly WithdrawalRequestStatus[] = [
  'pending',
  'approved',
  'rejected',
] as const;

/** Bank details captured at request time (admin can still verify later). */
export interface IWithdrawalBankSnapshot {
  holderName: string;
  accountNumber: string;
  ifscCode: string;
}

export interface IWithdrawalRequest {
  user: Types.ObjectId;
  /** Amount (INR) the user asked for. */
  amount: number;
  status: WithdrawalRequestStatus;
  /** Snapshot of user.bankAccount at the moment the request was placed. */
  bankSnapshot: IWithdrawalBankSnapshot;
  /** Optional admin note (e.g. rejection reason, payout reference). */
  adminNote: string | null;
  /** When admin acted on the request (approved or rejected). */
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const bankSnapshotSchema = new Schema<IWithdrawalBankSnapshot>(
  {
    holderName: { type: String, required: true, trim: true },
    accountNumber: { type: String, required: true, trim: true },
    ifscCode: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const withdrawalRequestSchema = new Schema<IWithdrawalRequest>(
  {
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
  },
  { timestamps: true },
);

/** Newest-first listing per user. */
withdrawalRequestSchema.index({ user: 1, createdAt: -1 });
/** Admin inbox: pending first. */
withdrawalRequestSchema.index({ status: 1, createdAt: -1 });

export const WithdrawalRequestModel: Model<IWithdrawalRequest> =
  (mongoose.models.WithdrawalRequest as
    | Model<IWithdrawalRequest>
    | undefined) ??
  mongoose.model<IWithdrawalRequest>(
    'WithdrawalRequest',
    withdrawalRequestSchema,
  );
