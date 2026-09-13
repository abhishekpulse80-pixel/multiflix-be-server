import 'dotenv/config';
import { connectDb, disconnectDb } from '../config/db.js';
import {
  EARNING_SECTIONS,
  EarningRateModel,
  type EarningSection,
} from '../models/earningRate.model.js';

/**
 * Seed default per-minute earning rates for each tracked section.
 * Safe to re-run — upserts by `section`, preserves any existing values.
 */
const DEFAULTS: Record<EarningSection, number> = {
  feed: 0.01,
  music: 0.02,
  blogging: 0.02,
};

async function main(): Promise<void> {
  await connectDb();

  for (const section of EARNING_SECTIONS) {
    const res = await EarningRateModel.findOneAndUpdate(
      { section },
      {
        $setOnInsert: {
          section,
          ratePerMinute: DEFAULTS[section],
          isActive: true,
        },
      },
      { upsert: true, new: true, runValidators: true },
    );
    console.log(
      `[seed] ${section.padEnd(8)} rate=${res.ratePerMinute}/min active=${res.isActive}`,
    );
  }

  await disconnectDb();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
