import { HttpError } from '../lib/httpError.js';
import { AppSettingModel, type IAppSetting } from '../models/appSetting.model.js';

/** Known setting keys. Extend as new app-wide admin settings are added. */
export const APP_SETTING_KEYS = {
  WITHDRAWAL_MINIMUM_AMOUNT: 'withdrawal.minimum_amount',
  // AdMob behaviour — lets admins turn ads on/off and tune frequency without an
  // app release. Consumed by the app via GET /ads/config (see getAdsConfig).
  ADS_ENABLED: 'ads.enabled',
  ADS_FEED_NATIVE_INTERVAL: 'ads.feed_native_interval',
  ADS_INTERSTITIAL_AFTER_POSTS: 'ads.interstitial_after_posts',
  ADS_INTERSTITIAL_MIN_INTERVAL_SEC: 'ads.interstitial_min_interval_sec',
} as const;

export type AppSettingKey =
  (typeof APP_SETTING_KEYS)[keyof typeof APP_SETTING_KEYS];

const assertBoolean = (label: string) => (v: unknown) => {
  if (typeof v !== 'boolean') {
    throw new HttpError(
      400,
      `${label} must be true or false`,
      'INVALID_SETTING_VALUE',
    );
  }
};

const assertNonNegativeInt = (label: string) => (v: unknown) => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new HttpError(
      400,
      `${label} must be a whole number ≥ 0`,
      'INVALID_SETTING_VALUE',
    );
  }
};

/** Defaults + metadata for each known key. Used to seed missing settings on read. */
const DEFAULTS: Record<
  AppSettingKey,
  { value: unknown; description: string; validate: (v: unknown) => void }
> = {
  [APP_SETTING_KEYS.WITHDRAWAL_MINIMUM_AMOUNT]: {
    value: 100,
    description:
      'Minimum wallet balance (INR) a user must hold to place a withdrawal request.',
    validate: (v: unknown) => {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new HttpError(
          400,
          'Minimum withdrawal must be a non-negative number',
          'INVALID_SETTING_VALUE',
        );
      }
    },
  },
  [APP_SETTING_KEYS.ADS_ENABLED]: {
    value: true,
    description:
      'Master switch for in-app ads (native feed ads + interstitials). Turn off to hide all ads instantly, without an app update.',
    validate: assertBoolean('Ads enabled'),
  },
  [APP_SETTING_KEYS.ADS_FEED_NATIVE_INTERVAL]: {
    value: 6,
    description:
      'Show a native ad in the home feed after every N posts (0 = no feed ads).',
    validate: assertNonNegativeInt('Feed ad interval'),
  },
  [APP_SETTING_KEYS.ADS_INTERSTITIAL_AFTER_POSTS]: {
    value: 12,
    description:
      'Show a full-screen interstitial after the viewer scrolls past this many posts (0 = no interstitials).',
    validate: assertNonNegativeInt('Interstitial after posts'),
  },
  [APP_SETTING_KEYS.ADS_INTERSTITIAL_MIN_INTERVAL_SEC]: {
    value: 180,
    description:
      'Minimum seconds between two interstitials, so users are not spammed.',
    validate: assertNonNegativeInt('Interstitial minimum gap (seconds)'),
  },
};

const KNOWN_KEYS = Object.values(APP_SETTING_KEYS) as AppSettingKey[];

function assertKnownKey(key: string): asserts key is AppSettingKey {
  if (!(KNOWN_KEYS as string[]).includes(key)) {
    throw new HttpError(400, `Unknown setting key: ${key}`, 'UNKNOWN_SETTING_KEY');
  }
}

function toDto(doc: IAppSetting) {
  return {
    key: doc.key,
    value: doc.value,
    description: doc.description,
    updatedAt: doc.updatedAt,
  };
}

/** Read a setting, seeding its default row if missing. */
async function readOrSeed(key: AppSettingKey): Promise<IAppSetting> {
  const existing = await AppSettingModel.findOne({ key }).lean();
  if (existing) return existing;
  const def = DEFAULTS[key];
  const created = await AppSettingModel.create({
    key,
    value: def.value,
    description: def.description,
  });
  return created.toObject();
}

/** Convenience: typed read for the min withdrawal amount. */
export async function getMinimumWithdrawalAmount(): Promise<number> {
  const row = await readOrSeed(APP_SETTING_KEYS.WITHDRAWAL_MINIMUM_AMOUNT);
  const v = row.value;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

export interface AdsConfigDto {
  enabled: boolean;
  feedNativeAdInterval: number;
  interstitialAfterPosts: number;
  interstitialMinIntervalSec: number;
}

/** The AdMob behaviour the app reads at startup (seeds defaults on first read). */
export async function getAdsConfig(): Promise<AdsConfigDto> {
  const [enabled, interval, afterPosts, minSec] = await Promise.all([
    readOrSeed(APP_SETTING_KEYS.ADS_ENABLED),
    readOrSeed(APP_SETTING_KEYS.ADS_FEED_NATIVE_INTERVAL),
    readOrSeed(APP_SETTING_KEYS.ADS_INTERSTITIAL_AFTER_POSTS),
    readOrSeed(APP_SETTING_KEYS.ADS_INTERSTITIAL_MIN_INTERVAL_SEC),
  ]);
  return {
    enabled: typeof enabled.value === 'boolean' ? enabled.value : true,
    feedNativeAdInterval: numOr(interval.value, 6),
    interstitialAfterPosts: numOr(afterPosts.value, 12),
    interstitialMinIntervalSec: numOr(minSec.value, 180),
  };
}

/** Admin: list all known settings (seeds missing ones with their defaults). */
export async function listAppSettings() {
  const items = await Promise.all(KNOWN_KEYS.map((k) => readOrSeed(k)));
  return { items: items.map(toDto) };
}

/** Admin: update a single known setting after validating the value's type. */
export async function updateAppSetting(key: string, value: unknown) {
  assertKnownKey(key);
  DEFAULTS[key].validate(value);

  const updated = await AppSettingModel.findOneAndUpdate(
    { key },
    {
      $set: { value },
      $setOnInsert: { description: DEFAULTS[key].description },
    },
    { new: true, upsert: true, runValidators: true },
  ).lean();

  return toDto(updated);
}
