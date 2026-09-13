import type { Response } from 'express';

/** Consistent success envelope for mobile clients: `{ data: ... }`. */
export function sendData(res: Response, payload: unknown, statusCode = 200) {
  res.status(statusCode).json({ data: payload });
}
