import { Queue } from 'bullmq';
import { redisConnectionOptions } from '../lib/redis.js';
export const VIDEO_TRANSCODING_QUEUE = 'video-transcoding';
let queue = null;
let lastErrorLoggedAt = 0;
function getQueue() {
    if (queue)
        return queue;
    queue = new Queue(VIDEO_TRANSCODING_QUEUE, {
        connection: redisConnectionOptions,
        defaultJobOptions: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 10_000 },
            removeOnComplete: { age: 24 * 3600, count: 1000 },
            removeOnFail: { age: 7 * 24 * 3600 },
        },
    });
    queue.on('error', err => {
        const now = Date.now();
        if (now - lastErrorLoggedAt > 60_000) {
            lastErrorLoggedAt = now;
            console.error('[video-transcoding queue]', err.message);
        }
    });
    return queue;
}
export async function enqueueVideoTranscoding(postId, opts) {
    await getQueue().add('transcode', { postId }, { jobId: `transcode-${postId}`, ...opts });
}
