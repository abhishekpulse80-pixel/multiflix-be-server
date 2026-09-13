import 'dotenv/config';
import { connectDb, disconnectDb } from '../config/db.js';
import { extractAudioDurationFromUrl } from '../lib/audioDuration.js';
import { MusicTrackModel } from '../models/musicTrack.model.js';
/**
 * One-off migration: populate `durationSeconds` for any MusicTrack rows that
 * were created before the upload pipeline started auto-extracting duration.
 *
 * Strategy: stream the existing rows, fetch each `audioUrl`, parse it with
 * `music-metadata`, save the result. Tracks whose audio can't be parsed
 * (404, corrupt file, etc.) are skipped and counted — the script never
 * fails the whole run for one bad row.
 *
 * Run with: `pnpm backfill:music-durations`
 */
async function main() {
    await connectDb();
    const cursor = MusicTrackModel.find({
        $or: [{ durationSeconds: null }, { durationSeconds: { $exists: false } }],
    })
        .select('_id title audioUrl')
        .cursor();
    let scanned = 0;
    let updated = 0;
    let skipped = 0;
    for await (const doc of cursor) {
        scanned += 1;
        const url = doc.audioUrl;
        if (!url) {
            skipped += 1;
            console.log(`  skip ${doc._id.toString()} "${doc.title}" — no audioUrl`);
            continue;
        }
        const duration = await extractAudioDurationFromUrl(url);
        if (duration == null) {
            skipped += 1;
            console.log(`  skip ${doc._id.toString()} "${doc.title}" — could not parse audio`);
            continue;
        }
        await MusicTrackModel.updateOne({ _id: doc._id }, { $set: { durationSeconds: duration } });
        updated += 1;
        console.log(`  ok   ${doc._id.toString()} "${doc.title}" → ${String(duration)}s`);
    }
    console.log(`Backfill music durations — scanned: ${String(scanned)}, updated: ${String(updated)}, skipped: ${String(skipped)}.`);
    await disconnectDb();
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
