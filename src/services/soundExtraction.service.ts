import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { s3Env, isS3Configured } from '../config/s3Env.js';
import { OriginalSoundModel } from '../models/originalSound.model.js';
import { PostModel } from '../models/post.model.js';
import { UserModel } from '../models/user.model.js';

let s3Client: S3Client | null = null;
function getS3Client(): S3Client {
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
  const path = key.split('/').map(encodeURIComponent).join('/');
  return `${s3Env.publicBaseUrl}/${path}`;
}

/**
 * Hard ceiling on a single ffmpeg run. Audio-only extraction is very fast
 * (a 60s clip takes <2s on a t3.small), so anything over 2 minutes means
 * something is wrong — kill the job and let BullMQ retry.
 */
const FFMPEG_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Run the worker pipeline for a single post id:
 *   download video → ffmpeg extract → S3 upload → persist OriginalSound
 *
 * Idempotent: a re-run on a post that already has a `ready` sound is a no-op.
 * On any failure the OriginalSound row is updated to `status: 'failed'` with
 * a short reason — BullMQ will retry the job per the queue's attempts policy.
 *
 * Returns the resulting OriginalSound id (or null when the job is skipped
 * for legitimate reasons like a non-video post or a missing source file).
 */
export async function extractSoundForPost(
  postId: string,
): Promise<string | null> {
  if (!isS3Configured()) {
    throw new Error('S3 is not configured; sound extraction cannot run');
  }

  const post = await PostModel.findById(postId).lean();
  if (!post) {
    // Source post deleted between enqueue and consumption — nothing to do.
    return null;
  }
  if (post.mediaKind !== 'short_video') {
    return null;
  }
  if (post.originalAudioMuted) {
    // Uploader chose to mute; we never extract muted sources.
    return null;
  }
  if (!post.media?.key) {
    return null;
  }

  // Pre-create / look up the OriginalSound row so the UI can surface a
  // "processing" badge if it wants to.
  const owner = await UserModel.findById(post.author)
    .select('username')
    .lean<{ username: string } | null>();
  const username = owner?.username ?? 'creator';
  const title = `Original sound — ${username}`;

  const existing = await OriginalSoundModel.findOne({
    sourcePost: post._id,
  }).lean<{ _id: { toString(): string }; status: string } | null>();
  if (existing?.status === 'ready') {
    return existing._id.toString();
  }

  const soundDoc = existing
    ? await OriginalSoundModel.findOneAndUpdate(
        { sourcePost: post._id },
        {
          $set: {
            status: 'processing',
            failureReason: null,
            title,
          },
        },
        { new: true },
      )
    : await OriginalSoundModel.create({
        sourcePost: post._id,
        ownerUser: post.author,
        title,
        status: 'processing',
        // Visibility piggy-backs on the post until we add per-post privacy.
        isPublic: true,
        usesCount: 0,
      });

  if (!soundDoc) {
    throw new Error('failed to create OriginalSound row');
  }

  const workDir = join(tmpdir(), `mfx-sound-${randomUUID()}`);
  const videoPath = join(workDir, 'input.mp4');
  const audioPath = join(workDir, 'sound.m4a');
  const client = getS3Client();
  const audioKey = `sounds/${post._id.toString()}.m4a`;

  try {
    await mkdir(workDir, { recursive: true });

    // 1. Download the source video from S3 to local tmp.
    const dl = await client.send(
      new GetObjectCommand({
        Bucket: post.media.bucket || s3Env.bucket,
        Key: post.media.key,
      }),
    );
    if (!dl.Body) {
      throw new Error('source video has empty body');
    }
    const chunks: Buffer[] = [];
    for await (const chunk of dl.Body as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    await writeFile(videoPath, Buffer.concat(chunks));

    // 2. Run ffmpeg — audio only, mono, 128 kbps AAC. faststart so the
    //    .m4a starts playing while bytes are still in flight on slow
    //    connections (matches how the curated music catalog is served).
    await new Promise<void>((resolve, reject) => {
      execFile(
        'ffmpeg',
        [
          '-i', videoPath,
          '-vn',                 // drop video
          '-ac', '1',            // mono
          '-c:a', 'aac',
          '-b:a', '128k',
          '-movflags', '+faststart',
          '-y',
          audioPath,
        ],
        { timeout: FFMPEG_TIMEOUT_MS },
        err => {
          if (err) reject(err);
          else resolve();
        },
      );
    });

    // 3. Upload the extracted audio.
    const audioBuffer = await readFile(audioPath);
    await client.send(
      new PutObjectCommand({
        Bucket: s3Env.bucket,
        Key: audioKey,
        Body: audioBuffer,
        ContentType: 'audio/mp4',
        CacheControl: 'public, max-age=31536000, immutable',
        ...(s3Env.objectAcl ? { ACL: s3Env.objectAcl } : {}),
      }),
    );

    const audioUrl = publicUrlForKey(audioKey);

    // 4. Mark sound ready and back-link from the post in one swoop.
    await Promise.all([
      OriginalSoundModel.updateOne(
        { _id: soundDoc._id },
        {
          $set: {
            audioKey,
            audioUrl,
            durationSeconds: post.durationSeconds ?? null,
            status: 'ready',
            failureReason: null,
          },
        },
      ),
      PostModel.updateOne(
        { _id: post._id },
        { $set: { originalSoundId: soundDoc._id } },
      ),
    ]);

    return soundDoc._id.toString();
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : String(err ?? 'unknown error');
    await OriginalSoundModel.updateOne(
      { _id: soundDoc._id },
      {
        $set: {
          status: 'failed',
          failureReason: message.slice(0, 512),
        },
      },
    ).catch(() => undefined);
    // Re-throw so BullMQ counts this as a failed attempt and applies the
    // retry policy from the queue config.
    throw err;
  } finally {
    rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
