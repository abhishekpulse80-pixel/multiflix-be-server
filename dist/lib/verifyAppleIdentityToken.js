import * as jose from 'jose';
import { env } from '../config/env.js';
import { HttpError } from './httpError.js';
const APPLE_ISSUER = 'https://appleid.apple.com';
const jwks = jose.createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));
export async function verifyAppleIdentityToken(identityToken) {
    const audiences = env.appleSignInAudiences;
    if (audiences.length === 0) {
        throw new HttpError(503, 'Apple Sign-In is not configured on this server', 'APPLE_NOT_CONFIGURED');
    }
    try {
        const { payload } = await jose.jwtVerify(identityToken, jwks, {
            issuer: APPLE_ISSUER,
            audience: audiences,
        });
        const sub = typeof payload.sub === 'string' ? payload.sub.trim() : '';
        if (!sub) {
            throw new HttpError(401, 'Invalid Apple token', 'INVALID_APPLE_TOKEN');
        }
        return {
            sub,
            email: typeof payload.email === 'string' ? payload.email.trim() : undefined,
            email_verified: payload.email_verified,
        };
    }
    catch (err) {
        if (err instanceof HttpError) {
            throw err;
        }
        throw new HttpError(401, 'Invalid Apple token', 'INVALID_APPLE_TOKEN');
    }
}
