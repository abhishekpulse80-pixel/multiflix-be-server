import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { HttpError } from './httpError.js';
const ACCESS_TYP = 'access';
const PWD_RESET_TYP = 'pwd_reset';
export function signAccessToken(userId, email) {
    const payload = {
        sub: userId,
        email: email ?? null,
        typ: ACCESS_TYP,
    };
    return jwt.sign(payload, env.jwtSecret, {
        expiresIn: env.jwtExpiresIn,
    });
}
export function signPasswordResetToken(userId) {
    const payload = {
        sub: userId,
        typ: PWD_RESET_TYP,
    };
    return jwt.sign(payload, env.jwtSecret, {
        expiresIn: env.passwordResetJwtExpiresIn,
    });
}
export function verifyAccessToken(token) {
    try {
        const decoded = jwt.verify(token, env.jwtSecret);
        if (typeof decoded.sub !== 'string' || decoded.typ !== ACCESS_TYP) {
            throw new HttpError(401, 'Invalid token', 'INVALID_TOKEN');
        }
        return {
            sub: decoded.sub,
            // Tokens issued before the user set an email carry null/no email.
            email: typeof decoded.email === 'string' ? decoded.email : null,
            typ: ACCESS_TYP,
        };
    }
    catch (err) {
        if (err instanceof HttpError) {
            throw err;
        }
        throw new HttpError(401, 'Invalid or expired token', 'INVALID_TOKEN');
    }
}
export function verifyPasswordResetToken(token) {
    try {
        const decoded = jwt.verify(token, env.jwtSecret);
        if (typeof decoded.sub !== 'string' || decoded.typ !== PWD_RESET_TYP) {
            throw new HttpError(401, 'Invalid reset token', 'INVALID_RESET_TOKEN');
        }
        return { sub: decoded.sub, typ: PWD_RESET_TYP };
    }
    catch (err) {
        if (err instanceof HttpError) {
            throw err;
        }
        throw new HttpError(401, 'Invalid or expired reset token', 'INVALID_RESET_TOKEN');
    }
}
