import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { HttpError } from '../lib/httpError.js';
import { verifyAccessToken } from '../lib/jwt.js';
import type { AuthContext } from '../types/auth.js';

function extractBearer(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

export const requireAuth: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  const token = extractBearer(req.headers.authorization);
  if (!token) {
    next(new HttpError(401, 'Missing or invalid Authorization header', 'UNAUTHORIZED'));
    return;
  }
  try {
    const payload = verifyAccessToken(token);
    const auth: AuthContext = { userId: payload.sub, email: payload.email };
    req.auth = auth;
    next();
  } catch (err) {
    next(err);
  }
};
