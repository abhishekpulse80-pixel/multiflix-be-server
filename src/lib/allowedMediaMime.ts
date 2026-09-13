import { HttpError } from './httpError.js';

/** Allowed media types for user uploads (images, video, audio). */
export const ALLOWED_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/bmp',
  'image/svg+xml',
]);

export const ALLOWED_VIDEO_MIMES = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
  'video/3gpp',
  'video/mpeg',
]);

export const ALLOWED_AUDIO_MIMES = new Set([
  'audio/mpeg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/wav',
  'audio/webm',
  'audio/flac',
  'audio/ogg',
  'audio/x-wav',
]);

export const ALLOWED_UPLOAD_MIMES = new Set<string>([
  ...ALLOWED_IMAGE_MIMES,
  ...ALLOWED_VIDEO_MIMES,
  ...ALLOWED_AUDIO_MIMES,
]);

export function mediaCategory(
  mime: string,
): 'image' | 'video' | 'audio' | null {
  const m = mime.toLowerCase().split(';')[0]?.trim() ?? '';
  if (ALLOWED_IMAGE_MIMES.has(m)) return 'image';
  if (ALLOWED_VIDEO_MIMES.has(m)) return 'video';
  if (ALLOWED_AUDIO_MIMES.has(m)) return 'audio';
  return null;
}

export function assertAllowedUploadMime(mimetype: string): void {
  const base = mimetype.toLowerCase().split(';')[0]?.trim() ?? '';
  if (!ALLOWED_UPLOAD_MIMES.has(base)) {
    throw new HttpError(
      400,
      'Only image, video, and audio files are allowed.',
      'UNSUPPORTED_MEDIA_TYPE',
    );
  }
}
