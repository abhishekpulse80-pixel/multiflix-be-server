import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { HttpError } from '../lib/httpError.js';
import { UserModel } from '../models/user.model.js';

export const requireAdmin: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  if (!req.auth) {
    next(new HttpError(401, 'Authentication required', 'UNAUTHORIZED'));
    return;
  }

  UserModel.findById(req.auth.userId)
    .select('role')
    .lean()
    .then((user) => {
      if (!user || user.role !== 'admin') {
        next(new HttpError(403, 'Admin access required', 'FORBIDDEN'));
        return;
      }
      next();
    })
    .catch(next);
};
