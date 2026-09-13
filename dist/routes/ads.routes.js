import rateLimit from 'express-rate-limit';
import { Router } from 'express';
import { env, isProd } from '../config/env.js';
import { asyncRoute } from '../lib/asyncRoute.js';
import { HttpError } from '../lib/httpError.js';
import { sendData } from '../lib/sendData.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { AdModel } from '../models/ad.model.js';
import { getAdsConfig } from '../services/appSetting.service.js';
const rateLimitShared = !isProd && env.trustProxyHops === 0
    ? {
        validate: { xForwardedForHeader: false },
    }
    : {};
/**
 * Click tracking is high-volume but still user-initiated — generous cap,
 * but not unbounded. Matches the `playLimiter` tier for music plays.
 */
const clickLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    ...rateLimitShared,
});
export const adsRouter = Router();
adsRouter.use(requireAuth);
/**
 * `GET /ads/config` — admin-managed AdMob behaviour the app reads at startup:
 * the master on/off switch plus the feed-ad / interstitial frequency. All
 * tunable from the admin App Settings page (no app release needed).
 */
adsRouter.get('/config', asyncRoute(async (_req, res) => {
    const config = await getAdsConfig();
    sendData(res, config);
}));
function adIdParam(req) {
    const raw = req.params.adId;
    const adId = Array.isArray(raw) ? raw[0] : raw;
    if (typeof adId !== 'string' || adId.length === 0) {
        throw new HttpError(400, 'Invalid ad id', 'INVALID_AD_ID');
    }
    return adId;
}
/** `POST /ads/:adId/click` — increment ad click counter by 1. */
adsRouter.post('/:adId/click', clickLimiter, asyncRoute(async (req, res) => {
    const adId = adIdParam(req);
    const result = await AdModel.updateOne({ _id: adId }, { $inc: { clicks: 1 } });
    if (result.matchedCount === 0) {
        throw new HttpError(404, 'Ad not found', 'AD_NOT_FOUND');
    }
    sendData(res, { ok: true });
}));
