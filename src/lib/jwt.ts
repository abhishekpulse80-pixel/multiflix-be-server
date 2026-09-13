import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env.js';
import { HttpError } from './httpError.js';

const ACCESS_TYP = 'access' as const;
const PWD_RESET_TYP = 'pwd_reset' as const;

export type AccessTokenPayload = {
  sub: string;
  /** Null for users who haven't provided an email yet (still in onboarding). */
  email: string | null;
  typ: typeof ACCESS_TYP;
};

export type PasswordResetTokenPayload = {
  sub: string;
  typ: typeof PWD_RESET_TYP;
};

export function signAccessToken(
  userId: string,
  email: string | null,
): string {
  const payload: AccessTokenPayload = {
    sub: userId,
    email: email ?? null,
    typ: ACCESS_TYP,
  };
  return jwt.sign(payload, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  } as SignOptions);
}

export function signPasswordResetToken(userId: string): string {
  const payload: PasswordResetTokenPayload = {
    sub: userId,
    typ: PWD_RESET_TYP,
  };
  return jwt.sign(payload, env.jwtSecret, {
    expiresIn: env.passwordResetJwtExpiresIn,
  } as SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, env.jwtSecret) as jwt.JwtPayload &
      Partial<AccessTokenPayload>;
    if (typeof decoded.sub !== 'string' || decoded.typ !== ACCESS_TYP) {
      throw new HttpError(401, 'Invalid token', 'INVALID_TOKEN');
    }
    return {
      sub: decoded.sub,
      // Tokens issued before the user set an email carry null/no email.
      email: typeof decoded.email === 'string' ? decoded.email : null,
      typ: ACCESS_TYP,
    };
  } catch (err) {
    if (err instanceof HttpError) {
      throw err;
    }
    throw new HttpError(401, 'Invalid or expired token', 'INVALID_TOKEN');
  }
}

export function verifyPasswordResetToken(token: string): PasswordResetTokenPayload {
  try {
    const decoded = jwt.verify(token, env.jwtSecret) as jwt.JwtPayload &
      Partial<PasswordResetTokenPayload>;
    if (typeof decoded.sub !== 'string' || decoded.typ !== PWD_RESET_TYP) {
      throw new HttpError(401, 'Invalid reset token', 'INVALID_RESET_TOKEN');
    }
    return { sub: decoded.sub, typ: PWD_RESET_TYP };
  } catch (err) {
    if (err instanceof HttpError) {
      throw err;
    }
    throw new HttpError(401, 'Invalid or expired reset token', 'INVALID_RESET_TOKEN');
  }
}
