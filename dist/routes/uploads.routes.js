import rateLimit from 'express-rate-limit';
import { Router } from 'express';
import { env, isProd } from '../config/env.js';
import { asyncRoute } from '../lib/asyncRoute.js';
import { HttpError } from '../lib/httpError.js';
import { multerErrorToHttp } from '../lib/multerErrorToHttp.js';
import { sendData } from '../lib/sendData.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { UPLOAD_BULK_MAX_FILES, uploadBulkMedia, uploadSingleMedia, } from '../middleware/uploadMulter.js';
import { presignUpload, uploadOneBuffer } from '../services/upload.service.js';
import { recommendedTranscodeQuality, transcodeVideoToVariants } from '../services/transcoding.service.js';
const rateLimitShared = !isProd && env.trustProxyHops === 0
    ? {
        validate: { xForwardedForHeader: false },
    }
    : {};
const strictLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    ...rateLimitShared,
});
export const uploadsRouter = Router();
const ADAPTIVE_CACHE_TTL_MS = 60_000;
const adaptiveCache = new Map();
function normalizeSpeedBucket(speedMbps) {
    const normalized = clampNetworkSpeed(speedMbps);
    return Number(normalized.toFixed(1));
}
function getAdaptiveCacheKey(params) {
    const normalizedSpeed = normalizeSpeedBucket(params.networkSpeedMbps);
    return `${params.mediaKind}:${params.mediaUrl}:${normalizedSpeed}`;
}
function clampNetworkSpeed(value) {
    if (!Number.isFinite(value))
        return 6;
    return Math.min(100, Math.max(0.2, value));
}
function networkProfileFromSpeed(speedMbps) {
    if (speedMbps <= 1.5)
        return 'slow';
    if (speedMbps <= 5)
        return 'balanced';
    if (speedMbps <= 15)
        return 'good';
    return 'fast';
}
function recommendedQualityForKind(kind, speedMbps) {
    if (kind === 'audio') {
        if (speedMbps <= 1.5)
            return 'low';
        if (speedMbps <= 5)
            return 'medium';
        return 'high';
    }
    if (kind === 'image') {
        if (speedMbps <= 1.5)
            return '360w';
        if (speedMbps <= 5)
            return '720w';
        return '1080w';
    }
    if (speedMbps <= 1.5)
        return '360p';
    if (speedMbps <= 5)
        return '480p';
    if (speedMbps <= 15)
        return '720p';
    return '1080p';
}
function appendVariantParam(url, variant) {
    const hasQuery = url.includes('?');
    const separator = hasQuery ? '&' : '?';
    return `${url}${separator}quality=${encodeURIComponent(variant)}`;
}
function buildAdaptiveMediaPlan(params) {
    const safeUrl = params.mediaUrl.trim();
    const speed = clampNetworkSpeed(typeof params.networkSpeedMbps === 'number' ? params.networkSpeedMbps : 6);
    const profile = networkProfileFromSpeed(speed);
    const recommendedQuality = recommendedQualityForKind(params.mediaKind, speed);
    const variants = params.mediaKind === 'audio'
        ? [
            { quality: 'low', label: 'Low', url: appendVariantParam(safeUrl, 'low'), bitrateKbps: 64, preferred: false },
            { quality: 'medium', label: 'Medium', url: appendVariantParam(safeUrl, 'medium'), bitrateKbps: 128, preferred: false },
            { quality: 'high', label: 'High', url: appendVariantParam(safeUrl, 'high'), bitrateKbps: 256, preferred: false },
        ]
        : params.mediaKind === 'image'
            ? [
                { quality: '360w', label: '360w', url: appendVariantParam(safeUrl, '360w'), width: 360, height: 640, bitrateKbps: 150, preferred: false },
                { quality: '720w', label: '720w', url: appendVariantParam(safeUrl, '720w'), width: 720, height: 1280, bitrateKbps: 300, preferred: false },
                { quality: '1080w', label: '1080w', url: appendVariantParam(safeUrl, '1080w'), width: 1080, height: 1920, bitrateKbps: 500, preferred: false },
            ]
            : [
                { quality: '360p', label: '360p', url: appendVariantParam(safeUrl, '360p'), width: 640, height: 360, bitrateKbps: 500, preferred: false },
                { quality: '480p', label: '480p', url: appendVariantParam(safeUrl, '480p'), width: 854, height: 480, bitrateKbps: 900, preferred: false },
                { quality: '720p', label: '720p', url: appendVariantParam(safeUrl, '720p'), width: 1280, height: 720, bitrateKbps: 1800, preferred: false },
                { quality: '1080p', label: '1080p', url: appendVariantParam(safeUrl, '1080p'), width: 1920, height: 1080, bitrateKbps: 3500, preferred: false },
            ];
    const preferredIndex = Math.max(0, variants.findIndex((item) => item.quality === recommendedQuality));
    const resolvedVariants = variants.map((item, index) => ({
        ...item,
        preferred: index === preferredIndex,
    }));
    const recommendedUrl = resolvedVariants[preferredIndex]?.url ?? safeUrl;
    return {
        mediaKind: params.mediaKind,
        networkSpeedMbps: Number(speed.toFixed(1)),
        networkProfile: profile,
        recommendedQuality,
        recommendedUrl,
        transcoding: {
            enabled: true,
            strategy: 'network-aware',
            note: 'Frontend should use recommendedUrl and fall back to the original media URL when a higher-quality variant is not available yet.',
        },
        variants: resolvedVariants,
    };
}
function runMulter(middleware) {
    return (req, res, next) => {
        middleware(req, res, (err) => {
            if (err) {
                next(multerErrorToHttp(err));
                return;
            }
            next();
        });
    };
}
/**
 * Presign a direct-to-S3 PUT so the client can stream large files (e.g. blog
 * videos) straight to S3 without buffering the whole body in memory on the
 * device or this server. Body: `{ contentType, originalName }`.
 * `POST /api/v1/uploads/presign`
 */
uploadsRouter.post('/presign', strictLimiter, requireAuth, asyncRoute(async (req, res) => {
    const body = (req.body ?? {});
    const contentType = typeof body.contentType === 'string' ? body.contentType.trim() : '';
    const originalName = typeof body.originalName === 'string' ? body.originalName.trim() : '';
    if (!contentType) {
        throw new HttpError(400, 'contentType is required', 'NO_CONTENT_TYPE');
    }
    if (!originalName) {
        throw new HttpError(400, 'originalName is required', 'NO_ORIGINAL_NAME');
    }
    const data = await presignUpload({
        userId: req.auth.userId,
        contentType,
        originalName,
    });
    sendData(res, data);
}));
uploadsRouter.get('/quality-profile', strictLimiter, requireAuth, asyncRoute(async (req, res) => {
    const rawSpeed = req.query.networkSpeedMbps;
    const parsed = typeof rawSpeed === 'string' && rawSpeed.trim()
        ? Number(rawSpeed)
        : Number(req.query.speed ?? req.query.bw ?? 6);
    const speed = clampNetworkSpeed(parsed);
    const profile = networkProfileFromSpeed(speed);
    const recommendedQuality = recommendedQualityForKind('video', speed);
    sendData(res, {
        networkSpeedMbps: Number(speed.toFixed(1)),
        networkProfile: profile,
        recommendedQuality,
        maxResolution: profile === 'slow' ? '360p' : profile === 'balanced' ? '480p' : profile === 'good' ? '720p' : '1080p',
        prefetchStrategy: 'cache-first',
        bufferingHint: profile === 'slow'
            ? 'Use lower bitrate and keep first frame preload short.'
            : profile === 'balanced'
                ? 'Use balanced quality and keep prefetch enabled.'
                : 'Use high-quality media and let the app prefetch next items.',
    });
}));
uploadsRouter.post('/adaptive', strictLimiter, requireAuth, asyncRoute(async (req, res) => {
    const body = (req.body ?? {});
    const mediaUrl = typeof body.mediaUrl === 'string' ? body.mediaUrl.trim() : '';
    const mediaKindRaw = typeof body.mediaKind === 'string' ? body.mediaKind.toLowerCase() : 'video';
    const mediaKind = mediaKindRaw === 'image' || mediaKindRaw === 'audio' ? mediaKindRaw : 'video';
    if (!mediaUrl) {
        throw new HttpError(400, 'mediaUrl is required', 'NO_MEDIA_URL');
    }
    const networkSpeedMbps = typeof body.networkSpeedMbps === 'number'
        ? body.networkSpeedMbps
        : typeof body.networkSpeedMbps === 'string'
            ? Number(body.networkSpeedMbps)
            : 6;
    const normalizedSpeed = normalizeSpeedBucket(networkSpeedMbps);
    const cacheKey = getAdaptiveCacheKey({
        mediaUrl,
        mediaKind,
        networkSpeedMbps: normalizedSpeed,
    });
    const now = Date.now();
    const cached = adaptiveCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
        sendData(res, cached.plan);
        return;
    }
    if (cached) {
        adaptiveCache.delete(cacheKey);
    }
    const plan = buildAdaptiveMediaPlan({
        mediaUrl,
        mediaKind,
        networkSpeedMbps: normalizedSpeed,
        width: typeof body.width === 'number' ? body.width : undefined,
        height: typeof body.height === 'number' ? body.height : undefined,
    });
    adaptiveCache.set(cacheKey, {
        expiresAt: now + ADAPTIVE_CACHE_TTL_MS,
        plan,
    });
    sendData(res, plan);
}));
uploadsRouter.post('/transcode', strictLimiter, requireAuth, asyncRoute(async (req, res) => {
    const body = (req.body ?? {});
    const sourceKey = typeof body.sourceKey === 'string' ? body.sourceKey.trim() : '';
    if (!sourceKey) {
        throw new HttpError(400, 'sourceKey is required', 'NO_SOURCE_KEY');
    }
    const networkSpeedMbps = typeof body.networkSpeedMbps === 'number'
        ? body.networkSpeedMbps
        : typeof body.networkSpeedMbps === 'string'
            ? Number(body.networkSpeedMbps)
            : 6;
    const manifest = await transcodeVideoToVariants({
        userId: req.auth.userId,
        sourceKey,
        networkSpeedMbps,
    });
    sendData(res, {
        ...manifest,
        recommendedQuality: manifest.recommendedQuality,
        recommendedUrl: manifest.recommendedUrl,
        fallbackUrl: manifest.sourceUrl ?? null,
        networkProfile: recommendedTranscodeQuality(networkSpeedMbps) === '360p'
            ? 'slow'
            : recommendedTranscodeQuality(networkSpeedMbps) === '480p'
                ? 'balanced'
                : recommendedTranscodeQuality(networkSpeedMbps) === '720p'
                    ? 'good'
                    : 'fast',
    });
}));
uploadsRouter.post('/single', strictLimiter, requireAuth, runMulter(uploadSingleMedia.single('file')), asyncRoute(async (req, res) => {
    const f = req.file;
    if (!f?.buffer) {
        throw new HttpError(400, 'Missing file field "file"', 'NO_FILE');
    }
    const meta = await uploadOneBuffer({
        userId: req.auth.userId,
        buffer: f.buffer,
        contentType: f.mimetype,
        originalName: f.originalname,
    });
    sendData(res, { file: meta });
}));
uploadsRouter.post('/bulk', strictLimiter, requireAuth, runMulter(uploadBulkMedia.array('files', UPLOAD_BULK_MAX_FILES)), asyncRoute(async (req, res) => {
    const files = req.files;
    if (!Array.isArray(files) || files.length === 0) {
        throw new HttpError(400, `Add at least one file using field name "files" (max ${String(UPLOAD_BULK_MAX_FILES)})`, 'NO_FILES');
    }
    const uploaded = [];
    const failed = [];
    for (const f of files) {
        try {
            const meta = await uploadOneBuffer({
                userId: req.auth.userId,
                buffer: f.buffer,
                contentType: f.mimetype,
                originalName: f.originalname,
            });
            uploaded.push(meta);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : 'Upload failed';
            const code = e instanceof HttpError ? e.code : undefined;
            failed.push({
                originalName: f.originalname,
                reason: msg,
                ...(code ? { code } : {}),
            });
        }
    }
    sendData(res, { uploaded, failed });
}));
