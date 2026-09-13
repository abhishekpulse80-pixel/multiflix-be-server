import { parseBuffer } from 'music-metadata';
/**
 * Extract the duration (in seconds) of an audio file from its raw buffer.
 *
 * Returns `null` when the buffer can't be parsed (corrupt file, unsupported
 * codec, missing metadata, etc.). Never throws — duration extraction must
 * not block uploads.
 */
export async function extractAudioDurationFromBuffer(buffer, contentType) {
    try {
        const meta = await parseBuffer(buffer, contentType ? { mimeType: contentType } : undefined, { duration: true, skipCovers: true });
        const d = meta.format.duration;
        if (typeof d === 'number' && Number.isFinite(d) && d > 0) {
            return Math.round(d);
        }
        return null;
    }
    catch {
        return null;
    }
}
/**
 * Fetch a remote audio URL and extract its duration. Used by the admin
 * createTrack fallback (when the client didn't pass duration) and by the
 * one-off backfill script.
 *
 * Caps the download size to avoid hammering memory if someone passes a
 * huge or non-audio URL by mistake.
 */
const MAX_FETCH_BYTES = 50 * 1024 * 1024; // 50 MB
export async function extractAudioDurationFromUrl(url) {
    try {
        const res = await fetch(url);
        if (!res.ok || !res.body) {
            return null;
        }
        const contentType = res.headers.get('content-type') ?? undefined;
        const lengthHeader = res.headers.get('content-length');
        if (lengthHeader && Number(lengthHeader) > MAX_FETCH_BYTES) {
            return null;
        }
        const arrayBuffer = await res.arrayBuffer();
        if (arrayBuffer.byteLength > MAX_FETCH_BYTES) {
            return null;
        }
        return extractAudioDurationFromBuffer(Buffer.from(arrayBuffer), contentType);
    }
    catch {
        return null;
    }
}
