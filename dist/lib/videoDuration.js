import { execFile } from 'node:child_process';
/**
 * Extract a remote video's duration (in whole seconds) using `ffprobe`.
 *
 * ffprobe reads only the container metadata over the network (via HTTP range
 * requests) — it does NOT download the whole video. Returns `null` on any
 * failure (ffprobe missing, URL unreachable, unparseable output). Never throws:
 * duration extraction must not break its callers.
 *
 * ffprobe ships with the same ffmpeg the thumbnail pipeline already relies on.
 */
export function extractVideoDurationFromUrl(url, timeoutMs = 60_000) {
    return new Promise((resolve) => {
        execFile('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            url,
        ], { timeout: timeoutMs }, (err, stdout) => {
            if (err) {
                resolve(null);
                return;
            }
            const d = Number.parseFloat(String(stdout).trim());
            if (Number.isFinite(d) && d > 0) {
                resolve(Math.round(d));
                return;
            }
            resolve(null);
        });
    });
}
/**
 * Whether `ffprobe` is callable on this host. Lets callers (e.g. the backfill
 * script) fail fast with a clear message instead of silently skipping every row.
 */
export function isFfprobeAvailable() {
    return new Promise((resolve) => {
        execFile('ffprobe', ['-version'], { timeout: 10_000 }, (err) => {
            resolve(!err);
        });
    });
}
