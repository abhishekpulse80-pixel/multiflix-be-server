import { Worker } from 'bullmq';
import { connectDb, disconnectDb } from './config/db.js';
import { redisConnectionOptions } from './lib/redis.js';
import { SOUND_EXTRACTION_QUEUE, } from './queues/soundExtraction.queue.js';
import { extractSoundForPost } from './services/soundExtraction.service.js';
import { MEDIA_PROCESSING_QUEUE, } from './queues/mediaProcessing.queue.js';
import { PostModel } from './models/post.model.js';
import { BlogModel } from './models/blog.model.js';
import { StoryModel } from './models/story.model.js';
import { OriginalSoundModel } from './models/originalSound.model.js';
import { MusicTrackModel } from './models/musicTrack.model.js';
import { transcodeAudioToVariants, transcodeVideoToHls } from './services/transcoding.service.js';
/**
 * Background worker entry. Runs in its own pm2 process (`multiflix-worker`)
 * so ffmpeg CPU bursts can't starve the API. Shares the same .env, the same
 * Mongo connection bootstrap, and the same Redis as the producer.
 */
async function main() {
    await connectDb();
    const worker = new Worker(SOUND_EXTRACTION_QUEUE, async (job) => {
        const { postId } = job.data;
        // eslint-disable-next-line no-console
        console.log(`[sound-extraction] start postId=${postId} jobId=${job.id ?? '?'}`);
        const soundId = await extractSoundForPost(postId);
        // eslint-disable-next-line no-console
        console.log(`[sound-extraction] done postId=${postId} soundId=${soundId ?? 'skipped'}`);
        return { soundId };
    }, {
        connection: redisConnectionOptions,
        // One ffmpeg at a time on a small box keeps CPU + memory predictable.
        // Bump on bigger instances if backlog grows.
        concurrency: 1,
    });
    const mediaWorker = new Worker(MEDIA_PROCESSING_QUEUE, async (job) => {
        const mediaType = job.data.mediaType ?? (job.data.postId ? 'post' : undefined);
        const mediaId = job.data.mediaId ?? job.data.postId;
        if (!mediaType || !mediaId)
            return;
        if (mediaType === 'sound' || mediaType === 'music') {
            const audioSource = mediaType === 'sound'
                ? await OriginalSoundModel.findById(mediaId).select('audioKey')
                : await MusicTrackModel.findById(mediaId).select('audioKey');
            if (!audioSource?.audioKey)
                return;
            try {
                const variants = await transcodeAudioToVariants({
                    sourceKey: audioSource.audioKey,
                    outputKeyPrefix: `${mediaType === 'sound' ? 'sounds' : 'music'}/${mediaId}/variants`,
                });
                const update = { $set: { audioProcessingStatus: 'ready', audioVariants: variants, audioProcessingError: null } };
                if (mediaType === 'sound')
                    await OriginalSoundModel.updateOne({ _id: mediaId }, update);
                if (mediaType === 'music')
                    await MusicTrackModel.updateOne({ _id: mediaId }, update);
            }
            catch (error) {
                const failure = { $set: { audioProcessingStatus: 'failed', audioProcessingError: error instanceof Error ? error.message : 'Audio processing failed' } };
                if (mediaType === 'sound')
                    await OriginalSoundModel.updateOne({ _id: mediaId }, failure);
                if (mediaType === 'music')
                    await MusicTrackModel.updateOne({ _id: mediaId }, failure);
                throw error;
            }
            return;
        }
        let sourceKey = null;
        let authorId = null;
        if (mediaType === 'post') {
            const post = await PostModel.findById(mediaId).select('media author mediaKind');
            if (!post || post.mediaKind !== 'short_video')
                return;
            sourceKey = post.media.key;
            authorId = post.author.toString();
        }
        else if (mediaType === 'blog') {
            const blog = await BlogModel.findById(mediaId).select('videoKey author');
            if (!blog || !blog.videoKey)
                return;
            sourceKey = blog.videoKey;
            authorId = blog.author.toString();
        }
        else {
            const story = await StoryModel.findById(mediaId).select('media author mediaKind');
            if (!story || story.mediaKind !== 'short_video')
                return;
            sourceKey = story.media.key;
            authorId = story.author.toString();
        }
        if (sourceKey === null || authorId === null)
            return;
        try {
            const manifest = await transcodeVideoToHls({
                userId: authorId,
                sourceKey,
            });
            const update = {
                $set: {
                    mediaProcessingStatus: 'ready',
                    hlsUrl: manifest.masterUrl,
                    hlsVariants: manifest.variants,
                    mediaProcessingError: null,
                },
            };
            if (mediaType === 'post')
                await PostModel.updateOne({ _id: mediaId }, update);
            if (mediaType === 'blog')
                await BlogModel.updateOne({ _id: mediaId }, update);
            if (mediaType === 'story')
                await StoryModel.updateOne({ _id: mediaId }, update);
        }
        catch (error) {
            const failure = {
                $set: {
                    mediaProcessingStatus: 'failed',
                    mediaProcessingError: error instanceof Error ? error.message : 'HLS processing failed',
                },
            };
            if (mediaType === 'post')
                await PostModel.updateOne({ _id: mediaId }, failure);
            if (mediaType === 'blog')
                await BlogModel.updateOne({ _id: mediaId }, failure);
            if (mediaType === 'story')
                await StoryModel.updateOne({ _id: mediaId }, failure);
            throw error;
        }
    }, { connection: redisConnectionOptions, concurrency: 1 });
    worker.on('failed', (job, err) => {
        // eslint-disable-next-line no-console
        console.error(`[sound-extraction] failed postId=${job?.data.postId ?? '?'} attempts=${String(job?.attemptsMade ?? '?')}:`, err.message);
    });
    worker.on('error', err => {
        // eslint-disable-next-line no-console
        console.error('[sound-extraction] worker error:', err.message);
    });
    mediaWorker.on('error', err => {
        // eslint-disable-next-line no-console
        console.error('[media-processing] worker error:', err.message);
    });
    // eslint-disable-next-line no-console
    console.log('Workers listening on queues:', SOUND_EXTRACTION_QUEUE, MEDIA_PROCESSING_QUEUE);
    const shutdown = async (signal) => {
        // eslint-disable-next-line no-console
        console.log(`Received ${signal}, draining worker…`);
        await worker.close();
        await mediaWorker.close();
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
main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
});
