import mongoose from 'mongoose';
import { HttpError } from '../lib/httpError.js';
import { TransactionModel } from '../models/transaction.model.js';
import { UserModel } from '../models/user.model.js';
import {
  WithdrawalRequestModel,
  type IWithdrawalRequest,
  type WithdrawalRequestStatus,
} from '../models/withdrawalRequest.model.js';
import { getMinimumWithdrawalAmount } from './appSetting.service.js';
import { createNotification, sendToUser } from './notification.service.js';

function assertObjectId(id: string): void {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new HttpError(400, 'Invalid id', 'INVALID_ID');
  }
}

export interface WithdrawalRequestDto {
  id: string;
  amount: number;
  status: WithdrawalRequestStatus;
  bankSnapshot: {
    holderName: string;
    accountNumber: string;
    ifscCode: string;
  };
  adminNote: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toDto(doc: IWithdrawalRequest & { _id: unknown }): WithdrawalRequestDto {
  return {
    id: String(doc._id),
    amount: doc.amount,
    status: doc.status,
    bankSnapshot: {
      holderName: doc.bankSnapshot.holderName,
      accountNumber: doc.bankSnapshot.accountNumber,
      ifscCode: doc.bankSnapshot.ifscCode,
    },
    adminNote: doc.adminNote,
    decidedAt: doc.decidedAt ? doc.decidedAt.toISOString() : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** Settings payload the mobile client needs to render the withdraw flow. */
export async function getWithdrawalSettings(): Promise<{
  minimumAmount: number;
}> {
  return { minimumAmount: await getMinimumWithdrawalAmount() };
}

/**
 * User places a withdrawal request. Validates:
 *  - user has bank details
 *  - no existing pending request
 *  - amount >= admin minimum
 *  - amount <= current wallet balance
 * Wallet balance is NOT deducted yet — admin approval creates the payout
 * transaction and debits the wallet.
 */
export async function createWithdrawalRequest(
  userId: string,
  amount: number,
): Promise<WithdrawalRequestDto> {
  assertObjectId(userId);

  const user = await UserModel.findById(userId)
    .select('bankAccount walletBalance')
    .lean<{
      bankAccount: {
        holderName: string;
        accountNumber: string;
        ifscCode: string;
      } | null;
      walletBalance: number;
    } | null>();
  if (!user) {
    throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
  }
  if (!user.bankAccount) {
    throw new HttpError(
      400,
      'Add your bank details before placing a withdrawal request.',
      'BANK_ACCOUNT_MISSING',
    );
  }

  const minimumAmount = await getMinimumWithdrawalAmount();
  if (amount < minimumAmount) {
    throw new HttpError(
      400,
      `Minimum withdrawal is ₹${String(minimumAmount)}.`,
      'AMOUNT_BELOW_MINIMUM',
    );
  }
  if (amount > user.walletBalance) {
    throw new HttpError(
      400,
      'Requested amount exceeds your current wallet balance.',
      'AMOUNT_EXCEEDS_BALANCE',
    );
  }

  const existingPending = await WithdrawalRequestModel.exists({
    user: userId,
    status: 'pending',
  });
  if (existingPending) {
    throw new HttpError(
      409,
      'You already have a pending withdrawal request.',
      'WITHDRAWAL_PENDING_EXISTS',
    );
  }

  const doc = await WithdrawalRequestModel.create({
    user: userId,
    amount,
    status: 'pending',
    bankSnapshot: {
      holderName: user.bankAccount.holderName,
      accountNumber: user.bankAccount.accountNumber,
      ifscCode: user.bankAccount.ifscCode,
    },
  });

  return toDto(doc.toObject());
}

/** Paginated list of the caller's own withdrawal requests, newest first. */
export async function listMyWithdrawalRequests(
  userId: string,
  page: number,
  limit: number,
): Promise<{
  items: WithdrawalRequestDto[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}> {
  assertObjectId(userId);

  const filter = { user: userId };
  const [rows, total] = await Promise.all([
    WithdrawalRequestModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(page * limit)
      .limit(limit)
      .lean(),
    WithdrawalRequestModel.countDocuments(filter),
  ]);

  return {
    items: rows.map((r) => toDto(r as IWithdrawalRequest & { _id: unknown })),
    total,
    page,
    limit,
    hasMore: page * limit + rows.length < total,
  };
}

// ----------------------------------------------------------------------------
// Admin — list, approve, reject.
// ----------------------------------------------------------------------------

/** Shape returned to the admin panel (user info populated inline). */
export interface AdminWithdrawalListItemDto extends WithdrawalRequestDto {
  user: {
    id: string;
    username: string;
    email: string;
    fullName: string | null;
    avatarUrl: string | null;
  } | null;
}

/** Paginated admin list, newest first, optionally filtered by status. */
export async function listWithdrawalRequests(
  page: number,
  limit: number,
  status?: WithdrawalRequestStatus,
): Promise<{
  items: AdminWithdrawalListItemDto[];
  total: number;
  page: number;
  limit: number;
}> {
  const filter: Record<string, unknown> = {};
  if (status) filter.status = status;

  const [rows, total] = await Promise.all([
    WithdrawalRequestModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('user', 'username email fullName avatarUrl')
      .lean(),
    WithdrawalRequestModel.countDocuments(filter),
  ]);

  const items: AdminWithdrawalListItemDto[] = rows.map((r) => {
    const base = toDto(r as unknown as IWithdrawalRequest & { _id: unknown });
    const u = (r as { user: unknown }).user as
      | {
          _id: mongoose.Types.ObjectId;
          username?: string;
          email?: string;
          fullName?: string | null;
          avatarUrl?: string | null;
        }
      | null;
    return {
      ...base,
      user: u
        ? {
            id: String(u._id),
            username: u.username ?? '',
            email: u.email ?? '',
            fullName: u.fullName ?? null,
            avatarUrl: u.avatarUrl ?? null,
          }
        : null,
    };
  });

  return { items, total, page, limit };
}

/**
 * Approve a pending request:
 *  - re-check wallet ≥ amount
 *  - create a `payout` transaction (negative amount)
 *  - atomically $inc walletBalance by -amount (only if still sufficient)
 *  - mark status=approved, decidedAt=now, adminNote
 * Only pending requests can be approved (returns 409 otherwise).
 */
export async function approveWithdrawalRequest(
  requestId: string,
  adminNote?: string,
): Promise<WithdrawalRequestDto> {
  assertObjectId(requestId);

  const reqDoc = await WithdrawalRequestModel.findById(requestId);
  if (!reqDoc) {
    throw new HttpError(
      404,
      'Withdrawal request not found',
      'WITHDRAWAL_NOT_FOUND',
    );
  }
  if (reqDoc.status !== 'pending') {
    throw new HttpError(
      409,
      'Only pending requests can be approved.',
      'WITHDRAWAL_NOT_PENDING',
    );
  }

  const amount = reqDoc.amount;
  const userId = reqDoc.user;

  // Atomic conditional debit: only succeeds when balance is still >= amount.
  const updatedUser = await UserModel.findOneAndUpdate(
    { _id: userId, walletBalance: { $gte: amount } },
    { $inc: { walletBalance: -amount } },
    { new: true, projection: { walletBalance: 1 } },
  ).lean<{ walletBalance: number } | null>();

  if (!updatedUser) {
    throw new HttpError(
      400,
      'User wallet no longer has sufficient balance for this request.',
      'INSUFFICIENT_BALANCE',
    );
  }

  // Record the payout transaction (amount stored as negative).
  await TransactionModel.create({
    user: userId,
    type: 'payout',
    amount: -amount,
    note: adminNote ?? null,
  });

  reqDoc.status = 'approved';
  reqDoc.decidedAt = new Date();
  if (adminNote !== undefined) {
    reqDoc.adminNote = adminNote.length > 0 ? adminNote : null;
  }
  await reqDoc.save();

  // Fire-and-forget notification + push. Never blocks the approval response.
  void (async () => {
    try {
      await createNotification({
        recipient: userId.toString(),
        type: 'withdrawal_approved',
        meta: {
          amount,
          requestId: String(reqDoc._id),
          ...(reqDoc.adminNote ? { note: reqDoc.adminNote } : {}),
        },
      });
      await sendToUser(userId.toString(), {
        type: 'withdrawal_approved',
        title: 'Withdrawal approved',
        body: `Your withdrawal of ₹${String(amount)} was approved.`,
        data: { requestId: String(reqDoc._id), amount: String(amount) },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      console.warn('[withdrawal] approve notify failed:', msg);
    }
  })();

  return toDto(reqDoc.toObject());
}

/**
 * Reject a pending request. No wallet change. Optional admin note
 * (e.g. reason for rejection).
 */
export async function rejectWithdrawalRequest(
  requestId: string,
  adminNote?: string,
): Promise<WithdrawalRequestDto> {
  assertObjectId(requestId);

  const reqDoc = await WithdrawalRequestModel.findById(requestId);
  if (!reqDoc) {
    throw new HttpError(
      404,
      'Withdrawal request not found',
      'WITHDRAWAL_NOT_FOUND',
    );
  }
  if (reqDoc.status !== 'pending') {
    throw new HttpError(
      409,
      'Only pending requests can be rejected.',
      'WITHDRAWAL_NOT_PENDING',
    );
  }

  reqDoc.status = 'rejected';
  reqDoc.decidedAt = new Date();
  if (adminNote !== undefined) {
    reqDoc.adminNote = adminNote.length > 0 ? adminNote : null;
  }
  await reqDoc.save();

  const amount = reqDoc.amount;
  const recipientId = reqDoc.user.toString();
  const reqIdStr = String(reqDoc._id);
  const note = reqDoc.adminNote;

  // Fire-and-forget notification + push. Never blocks the reject response.
  void (async () => {
    try {
      await createNotification({
        recipient: recipientId,
        type: 'withdrawal_rejected',
        meta: {
          amount,
          requestId: reqIdStr,
          ...(note ? { note } : {}),
        },
      });
      await sendToUser(recipientId, {
        type: 'withdrawal_rejected',
        title: 'Withdrawal rejected',
        body: note
          ? `Your withdrawal of ₹${String(amount)} was rejected: ${note}`
          : `Your withdrawal of ₹${String(amount)} was rejected.`,
        data: { requestId: reqIdStr, amount: String(amount) },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      console.warn('[withdrawal] reject notify failed:', msg);
    }
  })();

  return toDto(reqDoc.toObject());
}
