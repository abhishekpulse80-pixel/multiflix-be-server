import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Router } from 'express';
import { asyncRoute } from '../lib/asyncRoute.js';
import { HttpError } from '../lib/httpError.js';
import { s3Env, isS3Configured } from '../config/s3Env.js';
import { PostModel } from '../models/post.model.js';
import { deliveryProfileQuerySchema, networkProfileBodySchema, } from '../schemas/media.schemas.js';
const profiles = {
    normal: {
        quality: 'normal',
        video: { maxWidth: 1080, maxHeight: 1920, bitrateKbps: 2500 },
        image: { quality: 82, maxWidth: 1080 },
        preload: 'metadata',
    },
    fast: {
        quality: 'fast',
        video: { maxWidth: 720, maxHeight: 1280, bitrateKbps: 900 },
        image: { quality: 68, maxWidth: 720 },
        preload: 'none',
    },
};
export const mediaRouter = Router();
export const hlsRouter = Router();
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
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * Serves HLS generated for a post through the API. The asset id is the
 * basename of the original upload key, which is what mobile clients retain.
 * Relative playlist and segment URLs continue to resolve under this route.
 */
hlsRouter.get('/hls/:assetId/*', asyncRoute(async (req, res) => {
    if (!isS3Configured()) {
        throw new HttpError(503, 'Media storage is not configured', 'MEDIA_STORAGE_UNAVAILABLE');
    }
    const rawAssetId = req.params.assetId;
    const assetId = decodeURIComponent(typeof rawAssetId === 'string' ? rawAssetId : rawAssetId[0] ?? '');
    const filePath = req.params[0] ?? '';
    if (!assetId || !filePath || filePath.includes('..')) {
        throw new HttpError(400, 'Invalid HLS path', 'VALIDATION_ERROR');
    }
    const post = await PostModel.findOne({
        mediaKind: 'short_video',
        'media.key': { $regex: new RegExp(`/${escapeRegex(assetId)}$`) },
    })
        .select('_id author media.key')
        .lean();
    if (!post) {
        throw new HttpError(404, 'HLS media not found', 'MEDIA_NOT_FOUND');
    }
    const key = `transcoded/${post.author.toString()}/${post._id.toString()}/hls/${filePath}`;
    let object;
    try {
        object = await getS3Client().send(new GetObjectCommand({ Bucket: s3Env.bucket, Key: key }));
    }
    catch {
        throw new HttpError(404, 'HLS file not found', 'MEDIA_NOT_FOUND');
    }
    if (!object.Body) {
        throw new HttpError(404, 'HLS file not found', 'MEDIA_NOT_FOUND');
    }
    const contentType = filePath.endsWith('.m3u8')
        ? 'application/vnd.apple.mpegurl'
        : 'video/mp2t';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    for await (const chunk of object.Body) {
        res.write(chunk);
    }
    res.end();
}));
mediaRouter.get('/delivery-profile', asyncRoute(async (req, res) => {
    const parsed = deliveryProfileQuerySchema.safeParse(req.query);
    if (!parsed.success) {
        throw new HttpError(400, 'Invalid query parameters', 'VALIDATION_ERROR', parsed.error.flatten());
    }
    const profile = profiles[parsed.data.quality];
    const etag = `"media-${profile.quality}-v1"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
    if (req.headers['if-none-match'] === etag) {
        res.status(304).end();
        return;
    }
    res.json({ data: profile });
}));
mediaRouter.post('/network-profile', asyncRoute(async (req, res) => {
    const parsed = networkProfileBodySchema.safeParse(req.body);
    if (!parsed.success) {
        throw new HttpError(400, 'Invalid network profile', 'VALIDATION_ERROR', parsed.error.flatten());
    }
    res.json({ data: recommendNetworkProfile(parsed.data) });
}));
function recommendNetworkProfile(input) {
    const slowConnection = input.quality === 'slow' ||
        input.saveData === true ||
        input.effectiveType === 'slow-2g' ||
        input.effectiveType === '2g' ||
        input.downlinkMbps !== undefined && input.downlinkMbps < 1.5 ||
        input.rttMs !== undefined && input.rttMs > 500;
    return {
        quality: slowConnection ? 'fast' : 'normal',
        feedLimit: slowConnection ? 10 : 30,
        preload: slowConnection ? 'none' : 'metadata',
    };
}
