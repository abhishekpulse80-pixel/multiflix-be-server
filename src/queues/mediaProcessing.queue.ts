import { Queue, type JobsOptions } from 'bullmq';
import { redisConnectionOptions } from '../lib/redis.js';

export const MEDIA_PROCESSING_QUEUE = 'media-processing';

export type MediaProcessingJobData = {
  mediaType?: 'post' | 'blog' | 'story' | 'music' | 'sound';
  mediaId?: string;
  /** Legacy payload retained so pending post jobs survive a worker deploy. */
  postId?: string;
};

let queue: Queue<MediaProcessingJobData> | null = null;

function getQueue(): Queue<MediaProcessingJobData> {
  if (queue) return queue;
  queue = new Queue<MediaProcessingJobData>(MEDIA_PROCESSING_QUEUE, {
    connection: redisConnectionOptions,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });
  return queue;
}

export async function enqueueMediaProcessing(
  mediaType: MediaProcessingJobData['mediaType'],
  mediaId: string,
  opts?: JobsOptions,
): Promise<void> {
  await getQueue().add(
    'transcode-hls',
    { mediaType, mediaId },
    { jobId: `media-${mediaType}-${mediaId}`, ...opts },
  );
}