import { env } from '../config/env.js';
/**
 * BullMQ ships its own pinned ioredis. To avoid two ioredis instances in the
 * type graph (and on the wire), we hand BullMQ a *connection options* object
 * and let it construct its own Redis instance. The producer's `Queue` and the
 * worker's `Worker` each open their own connection on boot — this matches
 * BullMQ's own recommendation for separate read/write traffic.
 *
 * BullMQ requires `maxRetriesPerRequest: null` and `enableReadyCheck: false`
 * — if either is wrong its blocking commands either time out forever or
 * never enter the blocking state.
 */
function parseRedisUrl(url) {
    // Hand-parse so we don't need ioredis loaded just to read a URL.
    const u = new URL(url);
    const out = {
        host: u.hostname || '127.0.0.1',
        port: u.port ? Number(u.port) : 6379,
    };
    if (u.username)
        out.username = decodeURIComponent(u.username);
    if (u.password)
        out.password = decodeURIComponent(u.password);
    return out;
}
/**
 * Survive Redis being briefly unreachable (e.g. apt upgrade restart) without
 * dumping a connection trace 10×/sec. ioredis calls `retryStrategy` after
 * each failed connect with the retry attempt number; we back off quickly to
 * a 30-second ceiling and stop entirely after 20 attempts (~10 minutes)
 * so a dead Redis doesn't keep the API process busy forever.
 */
function retryStrategy(times) {
    if (times > 20) {
        return null; // give up; subsequent .add() calls throw → fire-and-forget swallows
    }
    // 200 ms, 400 ms, 800 ms, … capped at 30 s
    return Math.min(times * 200, 30_000);
}
/**
 * Reconnect on transient READONLY / connection-lost errors so a Redis HA
 * failover doesn't permanently break the queue. Anything else is bubbled
 * up so a real config bug is visible.
 */
function reconnectOnError(err) {
    const msg = err.message || '';
    return (msg.includes('READONLY') ||
        msg.includes('ECONNRESET') ||
        msg.includes('ETIMEDOUT'));
}
export const redisConnectionOptions = {
    ...parseRedisUrl(env.redisUrl),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy,
    reconnectOnError,
    // Stop ioredis from spamming `connection_lost` etc. to the logger every
    // attempt — we already log once via the BullMQ Queue's 'error' event.
    showFriendlyErrorStack: false,
};
