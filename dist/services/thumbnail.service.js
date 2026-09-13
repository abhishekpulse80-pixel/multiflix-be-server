import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { s3Env, isS3Configured } from '../config/s3Env.js';
let s3Client = null;
function getS3Client() {
    if (!s3Client) {
        s3Client = new S3Client({
            region: s3Env.region,
            credentials: {
                accessKeyId: s3Env.accessKeyId,
                secretAccessKey: s3Env.secretAccessKey,
            },
            ...(s3Env.endpoint
                ? { endpoint: s3Env.endpoint, forcePathStyle: true }
                : {}),
        });
    }
    return s3Client;
}
function publicUrlForKey(key) {
    if (!s3Env.publicBaseUrl) {
        return null;
    }
    const path = key.split('/').map(encodeURIComponent).join('/');
    return `${s3Env.publicBaseUrl}/${path}`;
}
/**
 * Extract the first frame of a video stored in S3, upload the JPEG
 * thumbnail back to S3, and return its public URL.
 *
 * Returns `null` when:
 * - S3 is not configured
 * - ffmpeg is not installed on the host
 * - Any step fails (non-critical — post creation still succeeds)
 */
export async function generateVideoThumbnail(videoKey, userId) {
    if (!isS3Configured()) {
        return null;
    }
    const workDir = join(tmpdir(), `mfx-thumb-${randomUUID()}`);
    const videoPath = join(workDir, 'input.mp4');
    const thumbPath = join(workDir, 'thumb.jpg');
    try {
        await mkdir(workDir, { recursive: true });
        // 1. Download video from S3
        const client = getS3Client();
        const res = await client.send(new GetObjectCommand({ Bucket: s3Env.bucket, Key: videoKey }));
        if (!res.Body) {
            return null;
        }
        const chunks = [];
        for await (const chunk of res.Body) {
            chunks.push(chunk);
        }
        const { writeFile } = await import('node:fs/promises');
        await writeFile(videoPath, Buffer.concat(chunks));
        // 2. Extract first frame with ffmpeg
        await new Promise((resolve, reject) => {
            execFile('ffmpeg', [
                '-i', videoPath,
                '-vframes', '1',
                '-q:v', '2', // high quality JPEG
                '-y', // overwrite
                thumbPath,
            ], { timeout: 30_000 }, (err) => {
                if (err)
                    reject(err);
                else
                    resolve();
            });
        });
        // 3. Upload thumbnail to S3
        const thumbBuffer = await readFile(thumbPath);
        const thumbKey = `uploads/${userId}/thumb-${randomUUID()}.jpg`;
        await client.send(new PutObjectCommand({
            Bucket: s3Env.bucket,
            Key: thumbKey,
            Body: thumbBuffer,
            ContentType: 'image/jpeg',
            CacheControl: 'public, max-age=31536000, immutable',
            ...(s3Env.objectAcl ? { ACL: s3Env.objectAcl } : {}),
        }));
        return publicUrlForKey(thumbKey);
    }
    catch {
        // Non-critical: post creation should not fail if thumbnail generation fails
        return null;
    }
    finally {
        // Clean up temp files
        rm(workDir, { recursive: true, force: true }).catch(() => { });
    }
}
