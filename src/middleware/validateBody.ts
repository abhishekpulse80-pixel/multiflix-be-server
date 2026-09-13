import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { z } from 'zod';
import { HttpError } from '../lib/httpError.js';

export function validateBody<S extends z.ZodTypeAny>(
  schema: S,
): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      next(
        new HttpError(
          400,
          'Invalid request body',
          'VALIDATION_ERROR',
          parsed.error.flatten(),
        ),
      );
      return;
    }
    req.body = parsed.data as Request['body'];
    next();
  };
}
