import mongoose from 'mongoose';
import { HttpError } from '../lib/httpError.js';
import {
  EarningRateModel,
  type EarningSection,
} from '../models/earningRate.model.js';
import { TransactionModel } from '../models/transaction.model.js';
import { UserModel } from '../models/user.model.js';
import type { RecordScreenTimeBody } from '../schemas/earnings.schemas.js';

/** Rounds to 4 decimal places to avoid float drift in the cached wallet. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export interface RecordScreenTimeResult {
  /** Total credited across all sections in this flush. */
  credited: number;
  /** New cached wallet balance after this flush. */
  walletBalance: number;
  /** Per-section breakdown for debug / UI confirmation. */
  breakdown: Array<{
    section: EarningSection;
    minutes: number;
    ratePerMinute: number;
    amount: number;
  }>;
}

/**
 * Credit earnings for buffered screen-time minutes.
 *
 * - Looks up the active `EarningRate` for each section.
 * - Sections that are inactive or have `ratePerMinute = 0` contribute 0
 *   (no transaction row is created, no wallet change).
 * - Creates one `earning` transaction per non-zero section.
 * - Atomically increments the cached `walletBalance` on User.
 */
export async function recordScreenTime(
  userId: string,
  body: RecordScreenTimeBody,
): Promise<RecordScreenTimeResult> {
  if (!mongoose.isValidObjectId(userId)) {
    throw new HttpError(400, 'Invalid user id', 'INVALID_USER_ID');
  }

  // Collapse duplicate sections in a single payload (client shouldn't, but be safe).
  const merged = new Map<EarningSection, number>();
  for (const entry of body.entries) {
    const section = entry.section as EarningSection;
    merged.set(section, (merged.get(section) ?? 0) + entry.minutes);
  }

  const sections = Array.from(merged.keys());
  const rates = await EarningRateModel.find({ section: { $in: sections } }).lean();
  const rateBySection = new Map<EarningSection, { ratePerMinute: number; isActive: boolean }>();
  for (const r of rates) {
    rateBySection.set(r.section, {
      ratePerMinute: r.ratePerMinute,
      isActive: r.isActive,
    });
  }

  const breakdown: RecordScreenTimeResult['breakdown'] = [];
  const txDocs: Array<{
    user: mongoose.Types.ObjectId;
    type: 'earning';
    amount: number;
    section: EarningSection;
    minutes: number;
  }> = [];
  let totalCredited = 0;

  for (const [section, minutes] of merged) {
    const rate = rateBySection.get(section);
    const ratePerMinute = rate?.isActive ? rate.ratePerMinute : 0;
    const amount = round4(minutes * ratePerMinute);

    breakdown.push({ section, minutes, ratePerMinute, amount });

    if (amount > 0) {
      txDocs.push({
        user: new mongoose.Types.ObjectId(userId),
        type: 'earning',
        amount,
        section,
        minutes,
      });
      totalCredited = round4(totalCredited + amount);
    }
  }

  if (txDocs.length > 0) {
    await TransactionModel.insertMany(txDocs);
  }

  const updated = await UserModel.findByIdAndUpdate(
    userId,
    totalCredited > 0 ? { $inc: { walletBalance: totalCredited } } : {},
    { new: true, projection: { walletBalance: 1 } },
  ).lean<{ walletBalance: number } | null>();

  if (!updated) {
    throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
  }

  return {
    credited: totalCredited,
    walletBalance: round4(updated.walletBalance),
    breakdown,
  };
}

export interface WalletDto {
  walletBalance: number;
}

/** Cached wallet balance for the signed-in user. */
export async function getWallet(userId: string): Promise<WalletDto> {
  if (!mongoose.isValidObjectId(userId)) {
    throw new HttpError(400, 'Invalid user id', 'INVALID_USER_ID');
  }
  const user = await UserModel.findById(userId)
    .select('walletBalance')
    .lean<{ walletBalance: number } | null>();
  if (!user) {
    throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
  }
  return { walletBalance: round4(user.walletBalance) };
}

export interface ScreenTimeDayDto {
  /** UTC calendar date, ISO `YYYY-MM-DD`. */
  date: string;
  /** Single-letter weekday label (S/M/T/W/T/F/S). */
  label: string;
  minutes: number;
}

export interface ScreenTimeBreakdownDto {
  days: ScreenTimeDayDto[];
  totalMinutes: number;
  dailyAverageMinutes: number;
}

/**
 * Per-day screen time for the last `days` (inclusive of today) — aggregated
 * from earning transactions. Returns one entry per day in chronological order,
 * even when a day has zero minutes.
 */
export async function getScreenTime(
  userId: string,
  days: number,
): Promise<ScreenTimeBreakdownDto> {
  if (!mongoose.isValidObjectId(userId)) {
    throw new HttpError(400, 'Invalid user id', 'INVALID_USER_ID');
  }
  const safeDays = Math.max(1, Math.min(30, Math.floor(days)));

  const now = new Date();
  const startOfToday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const windowStart = new Date(
    startOfToday.getTime() - (safeDays - 1) * 24 * 60 * 60 * 1000,
  );

  const rows = (await TransactionModel.aggregate([
    {
      $match: {
        user: new mongoose.Types.ObjectId(userId),
        type: 'earning',
        createdAt: { $gte: windowStart },
      },
    },
    {
      $group: {
        _id: {
          $dateToString: {
            format: '%Y-%m-%d',
            date: '$createdAt',
            timezone: 'UTC',
          },
        },
        minutes: { $sum: { $ifNull: ['$minutes', 0] } },
      },
    },
  ])) as Array<{ _id: string; minutes: number }>;

  const byDate = new Map<string, number>(rows.map((r) => [r._id, r.minutes]));
  const dayLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  const daysArr: ScreenTimeDayDto[] = [];
  let totalMinutes = 0;
  for (let i = 0; i < safeDays; i++) {
    const d = new Date(windowStart.getTime() + i * 24 * 60 * 60 * 1000);
    const iso = d.toISOString().slice(0, 10);
    const minutes = byDate.get(iso) ?? 0;
    totalMinutes += minutes;
    daysArr.push({
      date: iso,
      label: dayLabels[d.getUTCDay()] ?? '',
      minutes,
    });
  }

  return {
    days: daysArr,
    totalMinutes,
    dailyAverageMinutes: Math.round(totalMinutes / safeDays),
  };
}

export interface TransactionDto {
  id: string;
  type: 'earning' | 'payout' | 'adjustment';
  amount: number;
  section: EarningSection | null;
  minutes: number | null;
  note: string | null;
  createdAt: string;
}

export interface ListTransactionsResult {
  items: TransactionDto[];
  total: number;
  page: number;
  limit: number;
}

/** Paginated transaction history, newest first. */
export async function listTransactions(
  userId: string,
  page: number,
  limit: number,
): Promise<ListTransactionsResult> {
  if (!mongoose.isValidObjectId(userId)) {
    throw new HttpError(400, 'Invalid user id', 'INVALID_USER_ID');
  }

  const filter = { user: userId };

  const [rows, total] = await Promise.all([
    TransactionModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    TransactionModel.countDocuments(filter),
  ]);

  const items: TransactionDto[] = rows.map((r) => ({
    id: r._id.toString(),
    type: r.type,
    amount: round4(r.amount),
    section: r.section,
    minutes: r.minutes,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
  }));

  return { items, total, page, limit };
}
