import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpError } from '../lib/httpError.js';
import { downloadFromS3ToFile, uploadBufferToS3, } from './transcoding.service.js';
const IMAGE_PRESETS = [
    { quality: '360w', width: 360 },
    { quality: '720w', width: 720 },
    { quality: '1080w', width: 1080 },
];
function runFfmpeg(inputPath, outputPath, width) {
    return new Promise((resolve, reject) => {
        execFile('ffmpeg', [
            '-y', '-i', inputPath, '-vf', `scale='min(${String(width)},iw)':-2`,
            '-frames:v', '1', '-q:v', '3', outputPath,
        ], { timeout: 120_000 }, (error) => {
            if (error) {
                reject(new HttpError(500, `Image optimization failed: ${error.message}`, 'IMAGE_PROCESSING_FAILED'));
                return;
            }
            resolve();
        });
    });
}
export async function createImageVariants(params) {
    const sourceKey = params.sourceKey.trim();
    if (!sourceKey) {
        throw new HttpError(400, 'sourceKey is required', 'NO_SOURCE_KEY');
    }
    if (!sourceKey.startsWith(`uploads/${params.userId}/`)) {
        throw new HttpError(403, 'You can only process your own upload', 'UPLOAD_ACCESS_DENIED');
    }
    const workDir = join(tmpdir(), `mfx-image-${randomUUID()}`);
    const inputPath = join(workDir, 'input-source');
    try {
        await mkdir(workDir, { recursive: true });
        await downloadFromS3ToFile(sourceKey, inputPath);
        const variants = [];
        const outputPrefix = `uploads/${params.userId}/images/${randomUUID()}`;
        for (const preset of IMAGE_PRESETS) {
            const outputPath = join(workDir, `${preset.quality}.jpg`);
            await runFfmpeg(inputPath, outputPath, preset.width);
            const outputKey = `${outputPrefix}/${preset.quality}.jpg`;
            variants.push({
                ...preset,
                url: await uploadBufferToS3(await readFile(outputPath), outputKey, 'image/jpeg'),
            });
        }
        return variants;
    }
    finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => { });
    }
}
