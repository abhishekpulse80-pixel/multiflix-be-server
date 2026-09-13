import { HttpError } from '../lib/httpError.js';
export function validateBody(schema) {
    return (req, _res, next) => {
        const parsed = schema.safeParse(req.body);
        if (!parsed.success) {
            next(new HttpError(400, 'Invalid request body', 'VALIDATION_ERROR', parsed.error.flatten()));
            return;
        }
        req.body = parsed.data;
        next();
    };
}
