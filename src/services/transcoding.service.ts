import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { s3Env, isS3Configured } from '../config/s3Env.js';
import { HttpError } from '../lib/httpError.js';
import type { AudioQuality, AudioVariant } from '../types/audioProcessing.js';

export const TRANSCODE_PRESETS = [
  { quality: '360p', height: 360, crf: 31, bitrateKbps: 500 },
  { quality: '480p', height: 480, crf: 28, bitrateKbps: 900 },
  { quality: '720p', height: 720, crf: 25, bitrateKbps: 1800 },
  { quality: '1080p', height: 1080, crf: 22, bitrateKbps: 3500 },
] as const;

export type TranscodeQuality = (typeof TRANSCODE_PRESETS)[number]['quality'];

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!isS3Configured()) {
    throw new HttpError(
      503,
      'S3 is not configured for transcoding. Set AWS_REGION, S3_BUCKET, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY.',
      'S3_NOT_CONFIGURED',
    );
  }

  if (!s3Client) {
    s3Client = new S3Client({
      region: s3Env.region,
      credentials: {
        accessKeyId: s3Env.accessKeyId,
        secretAccessKey: s3Env.secretAccessKey,
      },
      ...(s3Env.endpoint
        ? { endpoint: s3Env.endpoint, forcePathStyle: true as const }
        : {}),
    });
  }

  return s3Client;
}

function publicUrlForKey(key: string): string | null {
  if (!s3Env.publicBaseUrl) {
    return null;
  }

  const path = key.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `${s3Env.publicBaseUrl}/${path}`;
}

function variantDimensionsForQuality(quality: TranscodeQuality) {
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

async function ensureFfmpegAvailable(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('ffmpeg', ['-version'], { timeout: 10_000 }, (err) => {
      if (err) {
        reject(new HttpError(500, 'ffmpeg is not installed on this backend host', 'FFMPEG_MISSING'));
        return;
      }
      resolve();
    });
  });
}

export async function downloadFromS3ToFile(key: string, filePath: string): Promise<void> {
  const client = getS3Client();
  const result = await client.send(
    new GetObjectCommand({ Bucket: s3Env.bucket, Key: key }),
  );

  if (!result.Body) {
    throw new HttpError(404, `Source object not found in S3: ${key}`, 'SOURCE_NOT_FOUND');
  }

  const chunks: Buffer[] = [];
  for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }

  await writeFile(filePath, Buffer.concat(chunks));
}

export async function uploadBufferToS3(
  body: Buffer,
  key: string,
  contentType: string,
): Promise<string> {
  const client = getS3Client();
  await client.send(
    new PutObjectCommand({
      Bucket: s3Env.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
      ...(s3Env.objectAcl ? { ACL: s3Env.objectAcl } : {}),
    }),
  );
  return publicUrlForKey(key) ?? key;
}

function contentTypeForPath(fileName: string): string {
  if (fileName.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (fileName.endsWith('.ts')) return 'video/mp2t';
  return 'application/octet-stream';
}

export type HlsVariant = {
  quality: TranscodeQuality;
  width: number;
  height: number;
  bitrateKbps: number;
  playlistUrl: string;
};

export type HlsManifest = {
  masterUrl: string;
  variants: HlsVariant[];
};

async function createHlsVariant(
  inputPath: string,
  outputDir: string,
  quality: TranscodeQuality,
  height: number,
  crf: number,
): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  const playlistPath = join(outputDir, 'index.m3u8');
  await new Promise<void>((resolve, reject) => {
    execFile(
      'ffmpeg',
      [
        '-y', '-i', inputPath, '-vf', `scale=-2:${String(height)}`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf),
        '-c:a', 'aac', '-b:a', '128k', '-f', 'hls', '-hls_time', '4',
        '-hls_playlist_type', 'vod', '-hls_segment_filename',
        join(outputDir, `${quality}-%03d.ts`), playlistPath,
      ],
      { timeout: 300_000 },
      (err) => {
        if (err) {
          reject(new HttpError(500, `ffmpeg HLS generation failed: ${err.message}`, 'HLS_TRANSCODE_FAILED'));
          return;
        }
        resolve();
      },
    );
  });
}

export async function transcodeVideoToHls(params: {
  userId: string;
  sourceKey: string;
}): Promise<HlsManifest> {
  const sourceKey = params.sourceKey.trim();
  if (!sourceKey) {
    throw new HttpError(400, 'sourceKey is required for HLS transcoding', 'NO_SOURCE_KEY');
  }
  await ensureFfmpegAvailable();
  const workDir = join(tmpdir(), `mfx-hls-${randomUUID()}`);
  const inputPath = join(workDir, 'input-source.mp4');
  const outputRoot = join(workDir, 'hls');

  try {
    await mkdir(outputRoot, { recursive: true });
    await downloadFromS3ToFile(sourceKey, inputPath);
    const variants: HlsVariant[] = [];

    for (const preset of TRANSCODE_PRESETS) {
      const variantDir = join(outputRoot, preset.quality);
      await createHlsVariant(inputPath, variantDir, preset.quality, preset.height, preset.crf);
      const outputKeyPrefix = `uploads/${params.userId}/hls/${randomUUID()}/${preset.quality}`;
      const files = await readdir(variantDir);
      for (const fileName of files) {
        await uploadBufferToS3(
          await readFile(join(variantDir, fileName)),
          `${outputKeyPrefix}/${fileName}`,
          contentTypeForPath(fileName),
        );
      }
      variants.push({
        quality: preset.quality,
        ...variantDimensionsForQuality(preset.quality),
        bitrateKbps: preset.bitrateKbps,
        playlistUrl: publicUrlForKey(`${outputKeyPrefix}/index.m3u8`) ?? `${outputKeyPrefix}/index.m3u8`,
      });
    }

    const masterLines = ['#EXTM3U', '#EXT-X-VERSION:3'];
    for (const variant of variants) {
      masterLines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${String(variant.bitrateKbps * 1000)},RESOLUTION=${String(variant.width)}x${String(variant.height)}`,
        variant.playlistUrl,
      );
    }
    const masterKey = `uploads/${params.userId}/hls/${randomUUID()}/master.m3u8`;
    const masterUrl = await uploadBufferToS3(
      Buffer.from(`${masterLines.join('\n')}\n`),
      masterKey,
      'application/vnd.apple.mpegurl',
    );
    return { masterUrl, variants };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => { });
  }
}
const AUDIO_PRESETS: ReadonlyArray<{ quality: AudioQuality; bitrateKbps: number }> = [
  { quality: 'low', bitrateKbps: 64 },
  { quality: 'medium', bitrateKbps: 128 },
  { quality: 'high', bitrateKbps: 256 },
];

async function createAudioVariant(
  inputPath: string,
  outputPath: string,
  bitrateKbps: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      'ffmpeg',
      [
        '-y', '-i', inputPath, '-vn', '-ac', '2', '-c:a', 'aac',
        '-b:a', `${String(bitrateKbps)}k`, '-movflags', '+faststart', outputPath,
      ],
      { timeout: 240_000 },
      (err) => {
        if (err) {
          reject(new HttpError(500, `ffmpeg audio transcode failed: ${err.message}`, 'AUDIO_TRANSCODE_FAILED'));
          return;
        }
        resolve();
      },
    );
  });
}

export async function transcodeAudioToVariants(params: {
  sourceKey: string;
  outputKeyPrefix: string;
}): Promise<AudioVariant[]> {
  const sourceKey = params.sourceKey.trim();
  if (!sourceKey) {
    throw new HttpError(400, 'sourceKey is required for audio transcoding', 'NO_SOURCE_KEY');
  }
  await ensureFfmpegAvailable();

  const workDir = join(tmpdir(), `mfx-audio-${randomUUID()}`);
  const inputPath = join(workDir, 'input-audio');

  try {
    await mkdir(workDir, { recursive: true });
    await downloadFromS3ToFile(sourceKey, inputPath);
    const variants: AudioVariant[] = [];

    for (const preset of AUDIO_PRESETS) {
      const outputName = `${preset.quality}.m4a`;
      const outputPath = join(workDir, outputName);
      await createAudioVariant(inputPath, outputPath, preset.bitrateKbps);
      const outputKey = `${params.outputKeyPrefix.replace(/\/+$/, '')}/${outputName}`;
      variants.push({
        quality: preset.quality,
        bitrateKbps: preset.bitrateKbps,
        url: await uploadBufferToS3(await readFile(outputPath), outputKey, 'audio/mp4'),
      });
    }

    return variants;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => { });
  }
}

