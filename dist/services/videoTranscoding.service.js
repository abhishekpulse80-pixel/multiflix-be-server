import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { s3Env, isS3Configured } from '../config/s3Env.js';
import { PostModel } from '../models/post.model.js';
const settings = {
    fast: { width: 720, height: 1280, bitrate: '900k' },
    normal: { width: 1080, height: 1920, bitrate: '2500k' },
};
let s3Client = null;
function getS3Client() {
    if (!s3Client) {
        s3Client = new S3Client({
            region: s3Env.region,
            credentials: {
                accessKeyId: s3Env.accessKeyId,
                secretAccessKey: s3Env.secretAccessKey,
            },
            ...(s3Env.endpoint ? { endpoint: s3Env.endpoint, forcePathStyle: true } : {}),
        });
    }
    return s3Client;
}
function publicUrlForKey(key) {
    if (!s3Env.publicBaseUrl)
        return null;
    return `${s3Env.publicBaseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`;
}
async function downloadObject(key, path) {
    const response = await getS3Client().send(new GetObjectCommand({ Bucket: s3Env.bucket, Key: key }));
    if (!response.Body)
        throw new Error('S3 video has no body');
    const chunks = [];
    for await (const chunk of response.Body)
        chunks.push(chunk);
    await writeFile(path, Buffer.concat(chunks));
}
function runFfmpeg(inputPath, outputPath, rendition) {
    const { width, height, bitrate } = settings[rendition];
    return new Promise((resolve, reject) => {
        execFile('ffmpeg', [
            '-nostdin', '-i', inputPath,
            '-vf', `scale=w='min(iw,${String(width)})':h='min(ih,${String(height)})':force_original_aspect_ratio=decrease`,
            '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', bitrate,
            '-maxrate', bitrate, '-bufsize', `${bitrate.replace('k', '')}k`,
            '-c:a', 'aac', '-b:a', rendition === 'fast' ? '96k' : '128k',
            '-movflags', '+faststart', '-y', outputPath,
        ], { timeout: 10 * 60 * 1000 }, (err, _stdout, stderr) => {
            if (err) {
                const detail = stderr.trim().split('\n').slice(-8).join('\n');
                reject(new Error(`ffmpeg ${rendition} failed: ${detail || err.message}`));
                return;
            }
            resolve();
        });
    });
}
function runHlsFfmpeg(inputPath, outputDir, rendition) {
    const { width, height, bitrate } = settings[rendition];
    const playlistPath = join(outputDir, `${rendition}.m3u8`);
    const segmentPattern = join(outputDir, `${rendition}-%05d.ts`);
    return new Promise((resolve, reject) => {
        execFile('ffmpeg', [
            '-nostdin', '-i', inputPath,
            '-vf', `scale=w='min(iw,${String(width)})':h='min(ih,${String(height)})':force_original_aspect_ratio=decrease`,
            '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', bitrate,
            '-maxrate', bitrate, '-bufsize', `${bitrate.replace('k', '')}k`,
            '-c:a', 'aac', '-b:a', rendition === 'fast' ? '96k' : '128k',
            '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod',
            '-hls_segment_filename', segmentPattern, '-y', playlistPath,
        ], { timeout: 10 * 60 * 1000 }, (err, _stdout, stderr) => {
            if (err) {
                const detail = stderr.trim().split('\n').slice(-8).join('\n');
                reject(new Error(`ffmpeg HLS ${rendition} failed: ${detail || err.message}`));
                return;
            }
            resolve();
        });
    });
}
async function uploadFile(key, path, contentType) {
    await getS3Client().send(new PutObjectCommand({
        Bucket: s3Env.bucket,
        Key: key,
        Body: await readFile(path),
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
        ...(s3Env.objectAcl ? { ACL: s3Env.objectAcl } : {}),
    }));
}
export async function transcodeVideoForPost(postId) {
    if (!isS3Configured())
        throw new Error('S3 is not configured');
    const post = await PostModel.findById(postId).select('_id author media mediaKind').lean();
    if (!post || post.mediaKind !== 'short_video')
        return;
    const workDir = join(tmpdir(), `mfx-transcode-${randomUUID()}`);
    try {
        await mkdir(workDir, { recursive: true });
        const inputPath = join(workDir, 'input');
        await downloadObject(post.media.key, inputPath);
        const userId = post.author.toString();
        const updates = {};
        const hlsRoot = join(workDir, 'hls');
        await mkdir(hlsRoot, { recursive: true });
        for (const rendition of ['fast', 'normal']) {
            const outputPath = join(workDir, `${rendition}.mp4`);
            await runFfmpeg(inputPath, outputPath, rendition);
            const key = `transcoded/${userId}/${postId}/${rendition}.mp4`;
            await uploadFile(key, outputPath, 'video/mp4');
            updates[`media.variants.${rendition}`] = publicUrlForKey(key);
            const renditionDir = join(hlsRoot, rendition);
            await mkdir(renditionDir, { recursive: true });
            await runHlsFfmpeg(inputPath, renditionDir, rendition);
            for (const file of await readdir(renditionDir)) {
                const contentType = file.endsWith('.m3u8')
                    ? 'application/vnd.apple.mpegurl'
                    : 'video/mp2t';
                await uploadFile(`transcoded/${userId}/${postId}/hls/${rendition}/${file}`, join(renditionDir, file), contentType);
            }
        }
        const masterKey = `transcoded/${userId}/${postId}/hls/master.m3u8`;
        const master = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=1100000\nfast/fast.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2900000\nnormal/normal.m3u8\n';
        const masterPath = join(hlsRoot, 'master.m3u8');
        await writeFile(masterPath, master);
        await uploadFile(masterKey, masterPath, 'application/vnd.apple.mpegurl');
        updates['media.masterUrl'] = publicUrlForKey(masterKey);
        updates['media.transcodingStatus'] = 'ready';
        await PostModel.updateOne({ _id: postId }, { $set: updates });
    }
    finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
}
