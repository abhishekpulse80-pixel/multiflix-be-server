import { Queue, type JobsOptions } from 'bullmq';
import { redisConnectionOptions } from '../lib/redis.js';

/**
 * Single, well-known queue name. The worker process listens on the same
 * string in `src/worker.ts`.
 */
export const SOUND_EXTRACTION_QUEUE = 'sound-extraction';

/**
 * Payload for a sound-extraction job. We pass only the source post id —
 * the worker re-reads the post (and any associated upload row) from Mongo
 * to avoid working off a stale snapshot if the post is edited between
 * enqueue and consumption.
 */
export type SoundExtractionJobData = {
  postId: string;
};

let queue: Queue<SoundExtractionJobData> | null = null;
let lastErrorLoggedAt = 0;

function getQueue(): Queue<SoundExtractionJobData> {
  if (queue) {
    return queue;
  }
  queue = new Queue<SoundExtractionJobData>(SOUND_EXTRACTION_QUEUE, {
    connection: redisConnectionOptions,
    defaultJobOptions: {
      // Retry transient ffmpeg / S3 hiccups with exponential backoff.
      // After 3 attempts a job is moved to `failed` so a human can
      // investigate (admin dashboard / alerting later).
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      // Keep recent jobs around for debugging; auto-prune older ones so
      // Redis doesn't grow unbounded.
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });
  // Throttle log spam during Redis outages — print the error once per
  // minute instead of every retry tick. Real failures still show up.
  queue.on('error', err => {
    const now = Date.now();
    if (now - lastErrorLoggedAt > 60_000) {
      lastErrorLoggedAt = now;
      // eslint-disable-next-line no-console
      console.error('[sound-extraction queue]', err.message);
    }
  });
  return queue;
}

/**
 * Fire-and-forget enqueue. The API handler calls this immediately after
 * inserting a video post. Resolves once the job is persisted to Redis;
 * callers should still .catch() to swallow Redis-down errors so the API
 * response never fails because of queue trouble.
 */
export async function enqueueSoundExtraction(
  postId: string,
  opts?: JobsOptions,
): Promise<void> {
  await getQueue().add(
    'extract',
    { postId },
    {
      // De-dupe: a re-uploaded post with the same id replaces the prior
      // job so the worker doesn't process the same source twice. BullMQ
      // v5 forbids colons in custom job ids, so use a hyphen delimiter.
      jobId: `extract-${postId}`,
      ...opts,
    },
  );
}
