import { randomInt } from 'node:crypto';
import { UserModel } from '../models/user.model.js';
import { isValidUsernameShape } from './usernameRules.js';
const RESERVED_USERNAMES = new Set([
    'admin',
    'administrator',
    'help',
    'support',
    'multiflix',
    'official',
    'team',
    'staff',
    'security',
    'api',
    'www',
    'mail',
    'root',
    'system',
    'null',
    'undefined',
    'user',
    'users',
].map((s) => s.toLowerCase()));
const MAX_LEN = 30;
/** Leave room for `_` + 4-digit suffix on collision. */
const MAX_BASE_LEN = 22;
/**
 * Derive a handle-like base from an email local part (before @ and + alias).
 */
export function usernameBaseFromEmail(email) {
    const normalized = email.trim().toLowerCase();
    const at = normalized.indexOf('@');
    const local = (at === -1 ? normalized : normalized.slice(0, at)).split('+')[0] ?? 'user';
    let s = local.replace(/[^a-z0-9._]+/g, '_');
    s = s.replace(/_{2,}/g, '_').replace(/\.{2,}/g, '.');
    s = s.replace(/^[._]+/g, '').replace(/[._]+$/g, '');
    if (s.length < 3) {
        s = `usr${String(randomInt(100, 999))}`;
    }
    s = s.slice(0, MAX_BASE_LEN).replace(/[._]+$/g, '');
    if (s.length < 3) {
        s = `u${String(randomInt(1_000, 99_999))}`;
    }
    if (RESERVED_USERNAMES.has(s)) {
        s = `${s}_${String(randomInt(10, 99))}`;
        s = s.slice(0, MAX_BASE_LEN);
    }
    return s;
}
/**
 * Picks a unique username; tries base, then base + random numeric suffix.
 */
export async function assignUniqueUsernameForEmail(email) {
    const base = usernameBaseFromEmail(email);
    for (let attempt = 0; attempt < 80; attempt += 1) {
        const suffix = attempt === 0 ? '' : `_${String(randomInt(1_000, 99_999))}`;
        let candidate = `${base}${suffix}`;
        if (candidate.length > MAX_LEN) {
            candidate = candidate.slice(0, MAX_LEN).replace(/[._]+$/g, '');
        }
        if (!isValidUsernameShape(candidate)) {
            continue;
        }
        if (RESERVED_USERNAMES.has(candidate)) {
            continue;
        }
        const taken = await UserModel.exists({ username: candidate });
        if (!taken) {
            return candidate;
        }
    }
    const fallback = `u${String(randomInt(1_000_000, 10_000_000_000))}`;
    const short = fallback.slice(0, MAX_LEN);
    if (!(await UserModel.exists({ username: short }))) {
        return short;
    }
    throw new Error('assignUniqueUsernameForEmail: exhausted retries');
}
