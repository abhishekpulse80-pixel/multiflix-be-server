/** Optional until upload routes are used — validated in `upload.service`. */
export const s3Env = {
  region: process.env.AWS_REGION?.trim() ?? '',
  bucket: process.env.S3_BUCKET?.trim() ?? '',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID?.trim() ?? '',
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY?.trim() ?? '',
  /** MinIO / LocalStack / custom S3-compatible API */
  endpoint: process.env.S3_ENDPOINT?.trim() || undefined,
  /** Public CDN or bucket website URL (no trailing slash). If empty, `url` in responses is null. */
  publicBaseUrl: process.env.S3_PUBLIC_BASE_URL?.replace(/\/+$/, '') ?? '',
  /**
   * If `public-read`, uploads set object ACL (only works when the bucket allows ACLs).
   * Prefer a bucket policy for `s3:GetObject` on `uploads/*` instead (works with ACLs disabled).
   */
  objectAcl:
    process.env.S3_OBJECT_ACL?.trim().toLowerCase() === 'public-read'
      ? ('public-read' as const)
      : undefined,
} as const;

export function isS3Configured(): boolean {
  return Boolean(
    s3Env.region &&
      s3Env.bucket &&
      s3Env.accessKeyId &&
      s3Env.secretAccessKey,
  );
}
