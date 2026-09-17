import 'dotenv/config';
import { connectDb, disconnectDb } from '../config/db.js';
import { enqueueMediaProcessing } from '../queues/mediaProcessing.queue.js';
import { PostModel } from '../models/post.model.js';
/**
 * Queue legacy short-video posts that never received a media-processing job.
 * Preview by default; pass --apply to update MongoDB and enqueue jobs.
 *
 * Run:
 *   pnpm backfill:video-transcoding
 *   pnpm backfill:video-transcoding -- --apply
 */
async function main() {
    const apply = process.argv.includes('--apply');
    await connectDb();
    const cursor = PostModel.find({
        mediaKind: 'short_video',
        $or: [
            { mediaProcessingStatus: 'not_required' },
            { mediaProcessingStatus: { $exists: false } },
        ],
        hlsUrl: { $in: [null, undefined] },
    })
        .select('_id media originalName mediaProcessingStatus')
        .cursor();
    let scanned = 0;
    let queued = 0;
    let skipped = 0;
    for await (const post of cursor) {
        scanned += 1;
        if (!post.media?.key) {
            skipped += 1;
            console.log(`skip ${post._id.toString()} - source media key missing`);
            continue;
        }
        if (!apply) {
            queued += 1;
            console.log(`would queue ${post._id.toString()} - ${post.media.key}`);
            continue;
        }
        await PostModel.updateOne({ _id: post._id }, {
            $set: {
                mediaProcessingStatus: 'processing',
                hlsUrl: null,
                hlsVariants: [],
                mediaProcessingError: null,
            },
        });
        await enqueueMediaProcessing('post', post._id.toString());
        queued += 1;
        console.log(`queued ${post._id.toString()} - ${post.media.key}`);
    }
    console.log(`Video transcoding backfill${apply ? '' : ' (dry-run)'} — scanned: ${String(scanned)}, ${apply ? 'queued' : 'would queue'}: ${String(queued)}, skipped: ${String(skipped)}.`);
    await disconnectDb();
}
main().catch(async (error) => {
    console.error(error);
    await disconnectDb().catch(() => undefined);
    process.exit(1);
});
