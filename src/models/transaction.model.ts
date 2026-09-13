import mongoose, { Schema, type Model, type Types } from 'mongoose';
import {
  EARNING_SECTIONS,
  type EarningSection,
} from './earningRate.model.js';

export type TransactionType = 'earning' | 'payout' | 'adjustment';

export const TRANSACTION_TYPES: readonly TransactionType[] = [
  'earning',
  'payout',
  'adjustment',
] as const;

export interface ITransaction {
  user: Types.ObjectId;
  type: TransactionType;
  /** Signed amount in currency units. Earnings/adjustments may be positive or negative; payouts are negative. */
  amount: number;
  /** For earnings: which section the time was spent in. Null for payouts/adjustments. */
  section: EarningSection | null;
  /** For earnings: whole minutes that produced this amount. Null otherwise. */
  minutes: number | null;
  /** Optional human-readable note (e.g. payout reference, admin reason). */
  note: string | null;
  createdAt: Date;
}

const transactionSchema = new Schema<ITransaction>(
  {
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
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

transactionSchema.index({ user: 1, createdAt: -1 });

export const TransactionModel: Model<ITransaction> =
  (mongoose.models.Transaction as Model<ITransaction> | undefined) ??
  mongoose.model<ITransaction>('Transaction', transactionSchema);
