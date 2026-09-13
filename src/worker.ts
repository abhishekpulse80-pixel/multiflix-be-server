import { Worker, type Job } from 'bullmq';
import { connectDb, disconnectDb } from './config/db.js';
import { redisConnectionOptions } from './lib/redis.js';
import {
  SOUND_EXTRACTION_QUEUE,
  type SoundExtractionJobData,
} from './queues/soundExtraction.queue.js';
import { extractSoundForPost } from './services/soundExtraction.service.js';

/**
 * Background worker entry. Runs in its own pm2 process (`multiflix-worker`)
 * so ffmpeg CPU bursts can't starve the API. Shares the same .env, the same
 * Mongo connection bootstrap, and the same Redis as the producer.
 */
async function main(): Promise<void> {
  await connectDb();

  const worker = new Worker<SoundExtractionJobData>(
    SOUND_EXTRACTION_QUEUE,
    async (job: Job<SoundExtractionJobData>) => {
      const { postId } = job.data;
      // eslint-disable-next-line no-console
      console.log(`[sound-extraction] start postId=${postId} jobId=${job.id ?? '?'}`);
      const soundId = await extractSoundForPost(postId);
      // eslint-disable-next-line no-console
      console.log(
        `[sound-extraction] done postId=${postId} soundId=${soundId ?? 'skipped'}`,
      );
      return { soundId };
    },
    {
      connection: redisConnectionOptions,
      // One ffmpeg at a time on a small box keeps CPU + memory predictable.
      // Bump on bigger instances if backlog grows.
      concurrency: 1,
    },
  );

  worker.on('failed', (job, err) => {
    // eslint-disable-next-line no-console
    console.error(
      `[sound-extraction] failed postId=${job?.data.postId ?? '?'} attempts=${
        job?.attemptsMade ?? '?'
      }:`,
      err.message,
    );
  });

  worker.on('error', err => {
    // eslint-disable-next-line no-console
    console.error('[sound-extraction] worker error:', err.message);
  });

  // eslint-disable-next-line no-console
  console.log('Sound-extraction worker listening on queue:', SOUND_EXTRACTION_QUEUE);

  const shutdown = async (signal: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`Received ${signal}, draining worker…`);
    await worker.close();
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
