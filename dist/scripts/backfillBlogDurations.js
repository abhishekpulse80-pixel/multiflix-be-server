import 'dotenv/config';
import { connectDb, disconnectDb } from '../config/db.js';
import { extractVideoDurationFromUrl, isFfprobeAvailable, } from '../lib/videoDuration.js';
import { BlogModel } from '../models/blog.model.js';
/**
 * One-off migration: populate `durationSeconds` for Blog rows created before
 * the app started sending the video duration on upload. Those rows have
 * `durationSeconds: null`, so their blog-listing / profile "duration" pill is
 * missing.
 *
 * Strategy: stream rows whose duration is null/absent, probe each `videoUrl`
 * with ffprobe (metadata only — no full download) and `$set` the result. Rows
 * whose video can't be probed (404, no url, corrupt) are skipped and counted —
 * one bad row never fails the whole run. Idempotent: only touches rows still
 * missing a duration, so it is safe to re-run.
 *
 * Pass `--dry-run` to report what WOULD change without writing anything.
 *
 * Run with: `pnpm backfill:blog-durations`
 *   preview: `pnpm backfill:blog-durations -- --dry-run`
 */
async function main() {
    const dryRun = process.argv.includes('--dry-run');
    if (!(await isFfprobeAvailable())) {
        console.error('ffprobe not found on PATH. Install ffmpeg (it bundles ffprobe) on this host before running the backfill.');
        process.exit(1);
    }
    await connectDb();
    const cursor = BlogModel.find({
        $or: [{ durationSeconds: null }, { durationSeconds: { $exists: false } }],
    })
        .select('_id title videoUrl')
        .cursor();
    let scanned = 0;
    let updated = 0;
    let skipped = 0;
    for await (const doc of cursor) {
        scanned += 1;
        const url = doc.videoUrl;
        if (!url) {
            skipped += 1;
            console.log(`  skip ${doc._id.toString()} "${doc.title}" — no videoUrl`);
            continue;
        }
        const duration = await extractVideoDurationFromUrl(url);
        if (duration == null) {
            skipped += 1;
            console.log(`  skip ${doc._id.toString()} "${doc.title}" — could not probe video`);
            continue;
        }
        if (dryRun) {
            updated += 1;
            console.log(`  dry  ${doc._id.toString()} "${doc.title}" → would set ${String(duration)}s`);
            continue;
        }
        await BlogModel.updateOne({ _id: doc._id }, { $set: { durationSeconds: duration } });
        updated += 1;
        console.log(`  ok   ${doc._id.toString()} "${doc.title}" → ${String(duration)}s`);
    }
    console.log(`Backfill blog durations${dryRun ? ' (dry-run)' : ''} — scanned: ${String(scanned)}, ${dryRun ? 'would update' : 'updated'}: ${String(updated)}, skipped: ${String(skipped)}.`);
    await disconnectDb();
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
