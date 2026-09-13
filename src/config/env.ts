import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

/**
 * Load `.env` from the app root (folder that contains `dist/`), not `process.cwd()`.
 * PM2 often runs with a different cwd, which breaks the default `dotenv/config` lookup.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');
dotenv.config({ path: path.join(projectRoot, '.env') });

function required(name: string): string {
  const v = process.env[name];
  if (!v?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v.trim();
}

/** Number of reverse-proxy hops Express should trust (0 = off). Set TRUST_PROXY=1 behind one LB/nginx. */
function parseTrustProxyHops(): number {
  const raw = process.env.TRUST_PROXY?.trim();
  if (!raw) return 0;
  const lower = raw.toLowerCase();
  if (lower === 'false' || lower === 'no' || lower === '0') return 0;
  if (lower === 'true' || lower === 'yes') return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(32, Math.floor(n));
}

function parseGoogleSignInClientIds(): string[] {
  const raw = process.env.GOOGLE_SIGN_IN_CLIENT_IDS?.trim();
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Native iOS Sign in with Apple uses the app bundle id as JWT `aud` (e.g. com.multiflix). */
function parseAppleSignInAudiences(): string[] {
  const raw = process.env.APPLE_SIGN_IN_AUDIENCES?.trim();
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Brevo (Sendinblue) transactional email — optional; forgot-password falls back to console in dev. */
function optionalTrim(name: string): string {
  return process.env[name]?.trim() ?? '';
}

/** Days of inactivity after which a conversation is hard-deleted. Min 1. */
function parseChatInactiveDays(): number {
  const raw = process.env.CHAT_INACTIVE_DAYS?.trim();
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 30;
  return Math.floor(n);
}

/**
 * Firebase Admin service-account credentials.
 * Loaded from `multiflix-1833c-firebase-adminsdk.json` in the backend root (same folder as
 * `package.json`). Missing file disables push notifications (useful in dev).
 */
export type FirebaseServiceAccount = {
  project_id?: string;
  client_email?: string;
  private_key?: string;
  [k: string]: unknown;
};

function parseFirebaseServiceAccount(): FirebaseServiceAccount | null {
  const filePath = path.join(projectRoot, 'multiflix-1833c-firebase-adminsdk.json');
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as FirebaseServiceAccount;
    // Defensive: in case anyone hand-edits the file with literal `\n`.
    if (typeof parsed.private_key === 'string') {
      parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    }
    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.warn('[env] multiflix-1833c-firebase-adminsdk.json is not valid JSON:', msg);
    return null;
  }
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT) || 4000,
  mongodbUri: required('MONGODB_URI'),
  jwtSecret: required('JWT_SECRET'),
  // Long-lived access token so users stay signed in across weeks of
  // inactivity — matching the UX of Instagram/TikTok. There's no refresh
  // endpoint, so a short TTL forced users back to the login screen after
  // 4–7 days. Override per-environment via JWT_EXPIRES_IN if needed.
  jwtExpiresIn: process.env.JWT_EXPIRES_IN?.trim() || '365d',
  passwordResetJwtExpiresIn:
    process.env.PASSWORD_RESET_JWT_EXPIRES_IN?.trim() || '15m',
  trustProxyHops: parseTrustProxyHops(),
  /** OAuth 2.0 client IDs allowed as `aud` on Google ID tokens (usually Web client + iOS if needed). */
  googleSignInClientIds: parseGoogleSignInClientIds(),
  /** Bundle IDs (or Services IDs) allowed as `aud` on Apple identity tokens. */
  appleSignInAudiences: parseAppleSignInAudiences(),
  /** https://app.brevo.com → SMTP & API → API keys */
  brevoApiKey: optionalTrim('BREVO_API_KEY'),
  /** Verified sender in Brevo (same domain as DNS/auth if required). */
  brevoSenderEmail: optionalTrim('BREVO_SENDER_EMAIL'),
  brevoSenderName: optionalTrim('BREVO_SENDER_NAME') || 'Multiflix',
  /** Admin seed credentials (used by `seedAdmin` script). */
  adminEmail: optionalTrim('ADMIN_EMAIL'),
  adminPassword: optionalTrim('ADMIN_PASSWORD'),
  adminUsername: optionalTrim('ADMIN_USERNAME') || 'admin',
  /** Conversations inactive this many days are hard-deleted on next user list-fetch. */
  chatInactiveDays: parseChatInactiveDays(),
  /** Parsed Firebase Admin service-account JSON. `null` disables FCM push. */
  firebaseServiceAccount: parseFirebaseServiceAccount(),
  /**
   * BullMQ / ioredis target. Defaults to localhost for the standard
   * "API + Redis on same EC2 box" deploy. Override in `.env` for
   * managed Redis (ElastiCache, Upstash, etc.).
   */
  redisUrl: process.env.REDIS_URL?.trim() || 'redis://127.0.0.1:6379',
} as const;

export const isProd = env.nodeEnv === 'production';
