import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Router } from 'express';
import { s3Env, isS3Configured } from '../config/s3Env.js';
import { asyncRoute } from '../lib/asyncRoute.js';
import { HttpError } from '../lib/httpError.js';
import { PostModel } from '../models/post.model.js';
const s3 = new S3Client({
    region: s3Env.region,
    credentials: {
        accessKeyId: s3Env.accessKeyId,
        secretAccessKey: s3Env.secretAccessKey,
    },
    ...(s3Env.endpoint ? { endpoint: s3Env.endpoint, forcePathStyle: true } : {}),
});
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
export const hlsRouter = Router();
/**
 * Serves transcoded HLS files. The asset id is the basename of the original
 * upload key, which is what mobile clients use when constructing this URL.
 */
hlsRouter.get('/:assetId/*', asyncRoute(async (req, res) => {
    if (!isS3Configured()) {
        throw new HttpError(503, 'Media storage is not configured', 'S3_NOT_CONFIGURED');
    }
    const assetId = Array.isArray(req.params.assetId)
        ? req.params.assetId[0]
        : req.params.assetId;
    const filePath = req.params[0];
    if (!assetId || !filePath || filePath.split('/').some(part => part === '..' || part === '.')) {
        throw new HttpError(400, 'Invalid HLS path', 'INVALID_MEDIA_PATH');
    }
    const assetPattern = new RegExp(`(?:^|/)${escapeRegExp(assetId)}(?:\\.[^/]*)?$`);
    const post = await PostModel.findOne({ 'media.key': assetPattern })
        .select('_id mediaKind media.key')
        .lean();
    if (!post || post.mediaKind !== 'short_video') {
        throw new HttpError(404, 'HLS media not found', 'MEDIA_NOT_FOUND');
    }
    const key = `transcoded/${post._id.toString()}/${filePath}`;
    const object = await s3.send(new GetObjectCommand({ Bucket: s3Env.bucket, Key: key }));
    if (!object.Body) {
        throw new HttpError(404, 'HLS file not found', 'MEDIA_NOT_FOUND');
    }
    res.setHeader('Content-Type', filePath.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (object.ContentLength != null)
        res.setHeader('Content-Length', String(object.ContentLength));
    object.Body.pipe(res);
}));
