import multer from 'multer';
import { ALLOWED_UPLOAD_MIMES } from '../lib/allowedMediaMime.js';
import { HttpError } from '../lib/httpError.js';
const storage = multer.memoryStorage();
function normalizeMime(m) {
    return m.toLowerCase().split(';')[0]?.trim() ?? '';
}
export const UPLOAD_BULK_MAX_FILES = Math.min(40, Math.max(1, Number(process.env.UPLOAD_MAX_FILES_BULK) || 20));
export const uploadSingleMedia = multer({
    storage,
    limits: {
        fileSize: Number(process.env.UPLOAD_MAX_BYTES_SINGLE) || 200 * 1024 * 1024,
    },
    fileFilter: (_req, file, cb) => {
        const mime = normalizeMime(file.mimetype);
        if (!ALLOWED_UPLOAD_MIMES.has(mime)) {
            cb(new HttpError(400, 'Only image, video, and audio files are allowed.', 'UNSUPPORTED_MEDIA_TYPE'));
            return;
        }
        cb(null, true);
    },
});
export const uploadBulkMedia = multer({
    storage,
    limits: {
        fileSize: Number(process.env.UPLOAD_MAX_BYTES_EACH_BULK) || 200 * 1024 * 1024,
        files: UPLOAD_BULK_MAX_FILES,
    },
    fileFilter: (_req, file, cb) => {
        const mime = normalizeMime(file.mimetype);
        if (!ALLOWED_UPLOAD_MIMES.has(mime)) {
            cb(new HttpError(400, 'Only image, video, and audio files are allowed.', 'UNSUPPORTED_MEDIA_TYPE'));
            return;
        }
        cb(null, true);
    },
});
