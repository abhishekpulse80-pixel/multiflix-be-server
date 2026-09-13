import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { s3Env, isS3Configured } from '../config/s3Env.js';
import { HttpError } from '../lib/httpError.js';
export const TRANSCODE_PRESETS = [
    { quality: '360p', height: 360, crf: 31, bitrateKbps: 500 },
    { quality: '480p', height: 480, crf: 28, bitrateKbps: 900 },
    { quality: '720p', height: 720, crf: 25, bitrateKbps: 1800 },
    { quality: '1080p', height: 1080, crf: 22, bitrateKbps: 3500 },
];
let s3Client = null;
function getS3Client() {
    if (!isS3Configured()) {
        throw new HttpError(503, 'S3 is not configured for transcoding. Set AWS_REGION, S3_BUCKET, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY.', 'S3_NOT_CONFIGURED');
    }
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
    const path = key.split('/').map((segment) => encodeURIComponent(segment)).join('/');
    return `${s3Env.publicBaseUrl}/${path}`;
}
function clampNetworkSpeed(value) {
    if (!Number.isFinite(value))
        return 6;
    return Math.min(100, Math.max(0.2, value));
}
export function recommendedTranscodeQuality(networkSpeedMbps) {
    const speed = clampNetworkSpeed(networkSpeedMbps);
    if (speed <= 1.5)
        return '360p';
    if (speed <= 5)
        return '480p';
    if (speed <= 15)
        return '720p';
    return '1080p';
}
function variantDimensionsForQuality(quality) {
    switch (quality) {
        case '360p':
            return { width: 640, height: 360 };
        case '480p':
            return { width: 854, height: 480 };
        case '720p':
            return { width: 1280, height: 720 };
        case '1080p':
            return { width: 1920, height: 1080 };
        default:
            return { width: 1280, height: 720 };
    }
}
async function ensureFfmpegAvailable() {
    await new Promise((resolve, reject) => {
        execFile('ffmpeg', ['-version'], { timeout: 10_000 }, (err) => {
            if (err) {
                reject(new HttpError(500, 'ffmpeg is not installed on this backend host', 'FFMPEG_MISSING'));
                return;
            }
            resolve();
        });
    });
}
async function downloadFromS3ToFile(key, filePath) {
    const client = getS3Client();
    const result = await client.send(new GetObjectCommand({ Bucket: s3Env.bucket, Key: key }));
    if (!result.Body) {
        throw new HttpError(404, `Source object not found in S3: ${key}`, 'SOURCE_NOT_FOUND');
    }
    const chunks = [];
    for await (const chunk of result.Body) {
        chunks.push(Buffer.from(chunk));
    }
    await writeFile(filePath, Buffer.concat(chunks));
}
async function uploadFileToS3(filePath, key) {
    const buffer = await readFile(filePath);
    const client = getS3Client();
    await client.send(new PutObjectCommand({
        Bucket: s3Env.bucket,
        Key: key,
        Body: buffer,
        ContentType: 'video/mp4',
        CacheControl: 'public, max-age=31536000, immutable',
        ...(s3Env.objectAcl ? { ACL: s3Env.objectAcl } : {}),
    }));
    return publicUrlForKey(key) ?? key;
}
async function transcodeOneVariant(inputPath, outputPath, height, crf) {
    await new Promise((resolve, reject) => {
        execFile('ffmpeg', [
            '-y',
            '-i',
            inputPath,
            '-vf',
            `scale=-2:${height}`,
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            String(crf),
            '-c:a',
            'aac',
            '-movflags',
            '+faststart',
            '-pix_fmt',
            'yuv420p',
            outputPath,
        ], { timeout: 240_000 }, (err) => {
            if (err) {
                reject(new HttpError(500, `ffmpeg transcode failed: ${err.message}`, 'TRANSCODE_FAILED'));
                return;
            }
            resolve();
        });
    });
}
export async function transcodeVideoToVariants(params) {
    const sourceKey = params.sourceKey.trim();
    if (!sourceKey) {
        throw new HttpError(400, 'sourceKey is required for video transcoding', 'NO_SOURCE_KEY');
    }
    await ensureFfmpegAvailable();
    const workDir = join(tmpdir(), `mfx-transcode-${randomUUID()}`);
    const inputPath = join(workDir, 'input-source.mp4');
    try {
        await mkdir(workDir, { recursive: true });
        await downloadFromS3ToFile(sourceKey, inputPath);
        const variantRows = [];
        const selectedQuality = recommendedTranscodeQuality(typeof params.networkSpeedMbps === 'number' ? params.networkSpeedMbps : 6);
        for (const preset of TRANSCODE_PRESETS) {
            const outputName = `${randomUUID()}-${preset.quality}.mp4`;
            const outputPath = join(workDir, outputName);
            await transcodeOneVariant(inputPath, outputPath, preset.height, preset.crf);
            const outputKey = `uploads/${params.userId}/transcoded/${preset.quality}/${outputName}`;
            const publicUrl = await uploadFileToS3(outputPath, outputKey);
            const { width, height } = variantDimensionsForQuality(preset.quality);
            variantRows.push({
                quality: preset.quality,
                label: preset.quality,
                url: publicUrl,
                width,
                height,
                bitrateKbps: preset.bitrateKbps,
                preferred: preset.quality === selectedQuality,
            });
        }
        const recommendedVariant = variantRows.find((item) => item.quality === selectedQuality) ?? variantRows[variantRows.length - 1];
        if (!recommendedVariant) {
            throw new HttpError(500, 'No video variants were generated', 'NO_TRANSCODED_VARIANTS');
        }
        const manifest = {
            sourceKey,
            sourceUrl: publicUrlForKey(sourceKey),
            recommendedQuality: recommendedVariant.quality,
            recommendedUrl: recommendedVariant.url,
            variants: variantRows,
        };
        return manifest;
    }
    finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => { });
    }
}
