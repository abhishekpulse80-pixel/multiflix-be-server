import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { s3Env, isS3Configured } from '../config/s3Env.js';
import { HttpError } from '../lib/httpError.js';
import { assertAllowedUploadMime, mediaCategory, } from '../lib/allowedMediaMime.js';
import { extractAudioDurationFromBuffer } from '../lib/audioDuration.js';
let s3Client = null;
function getS3Client() {
    if (!isS3Configured()) {
        throw new HttpError(503, 'File upload is not configured. Set AWS_REGION, S3_BUCKET, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY (optional: S3_ENDPOINT, S3_PUBLIC_BASE_URL).', 'S3_NOT_CONFIGURED');
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
function sanitizeOriginalName(name) {
    const base = name.replace(/[/\\]/g, '').replace(/\0/g, '').trim() || 'file';
    return base.length > 180 ? base.slice(0, 180) : base;
}
function publicUrlForKey(key) {
    if (!s3Env.publicBaseUrl) {
        return null;
    }
    const path = key.split('/').map(encodeURIComponent).join('/');
    return `${s3Env.publicBaseUrl}/${path}`;
}
export async function uploadOneBuffer(params) {
    assertAllowedUploadMime(params.contentType);
    const category = mediaCategory(params.contentType);
    if (!category) {
        throw new HttpError(500, 'MIME validation mismatch', 'INTERNAL');
    }
    const safeName = sanitizeOriginalName(params.originalName);
    const key = `uploads/${params.userId}/${randomUUID()}-${safeName}`;
    const contentType = params.contentType.split(';')[0]?.trim() ?? params.contentType;
    const client = getS3Client();
    try {
        await client.send(new PutObjectCommand({
            Bucket: s3Env.bucket,
            Key: key,
            Body: params.buffer,
            ContentType: contentType,
            // Keys are UUID-unique and content never changes, so the object is
            // immutable — let CloudFront + clients cache it for a year. This is
            // the single biggest win for repeat media loads.
            CacheControl: 'public, max-age=31536000, immutable',
            ...(s3Env.objectAcl ? { ACL: s3Env.objectAcl } : {}),
        }));
    }
    catch (e) {
        const name = e && typeof e === 'object' && 'name' in e
            ? String(e.name)
            : '';
        const msg = e instanceof Error ? e.message : 'S3 upload failed';
        throw new HttpError(502, msg, name === 'CredentialsProviderError' ? 'S3_AUTH' : 'S3_UPLOAD_FAILED');
    }
    // Audio uploads: try to read duration from the buffer in parallel-safe
    // fashion (extract is sync-on-buffer and never throws).
    const durationSeconds = category === 'audio'
        ? await extractAudioDurationFromBuffer(params.buffer, contentType)
        : null;
    return {
        key,
        bucket: s3Env.bucket,
        contentType,
        size: params.buffer.length,
        originalName: params.originalName,
        category,
        url: publicUrlForKey(key),
        durationSeconds,
    };
}
/**
 * Create a presigned S3 PUT URL so the client can stream a (potentially very
 * large) file straight to S3 — bypassing the in-memory multipart buffering on
 * both the device and this server. The client must PUT with the exact
 * `Content-Type` returned here (and echo `x-amz-acl` when `acl` is non-null),
 * otherwise the S3 signature check fails.
 */
export async function presignUpload(params) {
    assertAllowedUploadMime(params.contentType);
    const category = mediaCategory(params.contentType);
    if (!category) {
        throw new HttpError(500, 'MIME validation mismatch', 'INTERNAL');
    }
    const safeName = sanitizeOriginalName(params.originalName);
    const key = `uploads/${params.userId}/${randomUUID()}-${safeName}`;
    const contentType = params.contentType.split(';')[0]?.trim() ?? params.contentType;
    const acl = s3Env.objectAcl ?? null;
    const expiresIn = 900; // 15 minutes — generous for large video uploads.
    const client = getS3Client();
    try {
        const uploadUrl = await getSignedUrl(client, new PutObjectCommand({
            Bucket: s3Env.bucket,
            Key: key,
            ContentType: contentType,
            ...(acl ? { ACL: acl } : {}),
        }), { expiresIn });
        return {
            uploadUrl,
            key,
            bucket: s3Env.bucket,
            contentType,
            category,
            url: publicUrlForKey(key),
            acl,
            expiresIn,
        };
    }
    catch (e) {
        const name = e && typeof e === 'object' && 'name' in e
            ? String(e.name)
            : '';
        const msg = e instanceof Error ? e.message : 'Failed to presign upload';
        throw new HttpError(502, msg, name === 'CredentialsProviderError' ? 'S3_AUTH' : 'S3_PRESIGN_FAILED');
    }
}
