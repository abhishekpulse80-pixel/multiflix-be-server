import multer from 'multer';
import { HttpError } from './httpError.js';

export function multerErrorToHttp(err: unknown): HttpError {
  if (err instanceof HttpError) {
    return err;
  }
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return new HttpError(413, 'File exceeds maximum allowed size', 'FILE_TOO_LARGE');
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_PART_COUNT') {
      return new HttpError(
        400,
        'Too many files in this request',
        'TOO_MANY_FILES',
      );
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return new HttpError(
        400,
        err.message || 'Unexpected file field',
        'UNEXPECTED_FILE',
      );
    }
    return new HttpError(400, err.message || 'Upload error', 'MULTER_ERROR');
  }
  if (err instanceof Error) {
    return new HttpError(400, err.message, 'UPLOAD_ERROR');
  }
  return new HttpError(500, 'Upload failed', 'UPLOAD_ERROR');
}
