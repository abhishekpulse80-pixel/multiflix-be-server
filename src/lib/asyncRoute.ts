import type { NextFunction, Request, RequestHandler, Response } from 'express';

type AsyncRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<void>;

export function asyncRoute(fn: AsyncRequestHandler): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next);
  };
}
