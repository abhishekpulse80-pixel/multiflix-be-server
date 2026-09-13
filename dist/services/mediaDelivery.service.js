const profiles = {
    slow: {
        quality: 'slow',
        video: {
            strategy: 'hls-adaptive-bitrate',
            maxHeight: 360,
            preferredRenditions: [360, 240],
            preload: 'none',
        },
        image: {
            formats: ['avif', 'webp', 'jpeg'],
            maxWidth: 300,
            quality: 60,
            widths: [160, 300],
        },
        audio: { preferredBitrateKbps: 64, allowedBitratesKbps: [64, 96] },
        api: { pageSize: 10, maxPreloadItems: 0 },
        cache: { clientCacheSeconds: 300, mediaMustBeImmutable: true },
    },
    normal: {
        quality: 'normal',
        video: {
            strategy: 'hls-adaptive-bitrate',
            maxHeight: 720,
            preferredRenditions: [720, 480, 360],
            preload: 'metadata',
        },
        image: {
            formats: ['avif', 'webp', 'jpeg'],
            maxWidth: 600,
            quality: 75,
            widths: [300, 600],
        },
        audio: { preferredBitrateKbps: 128, allowedBitratesKbps: [96, 128] },
        api: { pageSize: 20, maxPreloadItems: 1 },
        cache: { clientCacheSeconds: 600, mediaMustBeImmutable: true },
    },
    fast: {
        quality: 'fast',
        video: {
            strategy: 'hls-adaptive-bitrate',
            maxHeight: 1080,
            preferredRenditions: [1080, 720, 480],
            preload: 'auto',
        },
        image: {
            formats: ['avif', 'webp', 'jpeg'],
            maxWidth: 1000,
            quality: 85,
            widths: [300, 600, 1000],
        },
        audio: { preferredBitrateKbps: 192, allowedBitratesKbps: [128, 192] },
        api: { pageSize: 30, maxPreloadItems: 3 },
        cache: { clientCacheSeconds: 1800, mediaMustBeImmutable: true },
    },
};
export function getDeliveryProfile(quality) {
    return profiles[quality];
}
export function classifyNetworkProfile(body) {
    if (body.quality) {
        return { quality: body.quality, source: 'client' };
    }
    if (body.downloadMbps != null &&
        (body.downloadMbps < 1.5 || (body.latencyMs != null && body.latencyMs > 600))) {
        return { quality: 'slow', source: 'observed' };
    }
    if (body.downloadMbps != null &&
        body.downloadMbps >= 8 &&
        (body.latencyMs == null || body.latencyMs < 150) &&
        (body.rebufferCount == null || body.rebufferCount === 0)) {
        return { quality: 'fast', source: 'observed' };
    }
    return { quality: 'normal', source: 'observed' };
}
