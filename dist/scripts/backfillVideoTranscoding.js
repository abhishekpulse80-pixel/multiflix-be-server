import { connectDb, disconnectDb } from '../config/db.js';
import { PostModel } from '../models/post.model.js';
import { enqueueVideoTranscoding } from '../queues/videoTranscoding.queue.js';
async function main() {
    await connectDb();
    const posts = await PostModel.find({
        mediaKind: 'short_video',
        $or: [
            { 'media.variants.fast': { $exists: false } },
            { 'media.variants.normal': { $exists: false } },
            { 'media.variants.fast': null },
            { 'media.variants.normal': null },
        ],
    }).select('_id').lean();
    for (const post of posts) {
        await enqueueVideoTranscoding(post._id.toString());
    }
    console.log(`Queued ${String(posts.length)} video transcoding jobs.`);
    await disconnectDb();
}
main().catch(async (error) => {
    console.error(error);
    await disconnectDb();
    process.exitCode = 1;
});
