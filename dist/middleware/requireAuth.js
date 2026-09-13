import { HttpError } from '../lib/httpError.js';
import { verifyAccessToken } from '../lib/jwt.js';
function extractBearer(header) {
    if (!header?.startsWith('Bearer ')) {
        return null;
    }
    const token = header.slice('Bearer '.length).trim();
    return token.length > 0 ? token : null;
}
export const requireAuth = (req, _res, next) => {
    const token = extractBearer(req.headers.authorization);
    if (!token) {
        next(new HttpError(401, 'Missing or invalid Authorization header', 'UNAUTHORIZED'));
        return;
    }
    try {
        const payload = verifyAccessToken(token);
        const auth = { userId: payload.sub, email: payload.email };
        req.auth = auth;
        next();
    }
    catch (err) {
        next(err);
    }
};
