# Media API Test Checklist

Ye checklist media pipeline ko local ya production environment mein verify karne ke liye hai.

## 1. Required services

API aur worker dono start hone chahiye:

```bash
npm run dev
npm run dev:worker
```

Production/PM2:

```bash
pm2 status
pm2 logs multiflix-be
pm2 logs multiflix-worker
```

Verify:

```bash
ffmpeg -version
redis-cli ping
```

Expected:

```text
PONG
```

Required environment variables:

```text
MONGODB_URI
JWT_SECRET
REDIS_URL
AWS_REGION
S3_BUCKET
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
S3_PUBLIC_BASE_URL
```

`S3_ENDPOINT` only needs to be set for Cloudflare R2, MinIO, or another S3-compatible provider.

## 2. Health API

```http
GET /api/v1/health
```

Expected: HTTP `200` and a healthy response.

## 3. Login and token

```http
POST /api/v1/auth/login
Content-Type: application/json
```

```json
{
  "identifier": "username-or-email",
  "password": "password"
}
```

Expected:

- HTTP `200`
- Response contains `data.token`
- Save the token as `<JWT_TOKEN>` for protected requests

Use this header in the remaining tests:

```http
Authorization: Bearer <JWT_TOKEN>
```

## 4. Presigned video upload

```http
POST /api/v1/uploads/presign
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json
```

```json
{
  "contentType": "video/mp4",
  "originalName": "test-video.mp4"
}
```

Expected response:

- HTTP `200`
- `data.uploadUrl` exists
- `data.key` exists
- `data.category` is `video`
- `data.url` is a public CDN/object URL or is `null` when CDN is not configured

Upload the binary file to `data.uploadUrl`:

```http
PUT <data.uploadUrl>
Content-Type: video/mp4
```

Expected: HTTP `200` or `204` from S3/R2.

## 5. Create a video post

Use the `key`, `bucket`, `contentType`, and `url` from the presign response. Use the actual file size.

```http
POST /api/v1/posts
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json
```

```json
{
  "mediaKind": "short_video",
  "file": {
    "key": "uploads/USER_ID/FILE_NAME.mp4",
    "bucket": "multiflix-media",
    "contentType": "video/mp4",
    "size": 5242880,
    "originalName": "test-video.mp4",
    "url": "https://cdn.example.com/uploads/USER_ID/FILE_NAME.mp4"
  },
  "caption": "Media pipeline test",
  "mediaWidth": 1080,
  "mediaHeight": 1920,
  "durationSeconds": 10,
  "originalAudioMuted": false
}
```

Expected:

- HTTP `201`
- A `post.id` is returned
- `post.mediaProcessingStatus` is `processing`

Save the returned post id as `<POST_ID>`.

## 6. Verify video HLS processing

Poll this endpoint every 3 to 5 seconds:

```http
GET /api/v1/posts/<POST_ID>/media-status
Authorization: Bearer <JWT_TOKEN>
```

Expected sequence:

```text
processing -> ready
```

When ready, verify:

- `data.status` is `ready`
- `data.hlsUrl` ends with `.m3u8`
- `data.variants` contains 360p, 480p, 720p, and 1080p where source dimensions allow them
- `data.error` is `null`

Open the returned `hlsUrl` in an HLS-compatible player. The master playlist should load successfully and its segment requests should return HTTP `200`.

If status becomes `failed`, check:

```bash
pm2 logs multiflix-worker
```

Common causes: FFmpeg missing, Redis unavailable, incorrect S3 credentials, private CDN objects, or insufficient disk space.

## 7. Image variants

Presign and upload an image using the same flow with:

```json
{
  "contentType": "image/jpeg",
  "originalName": "test-image.jpg"
}
```

Then call:

```http
POST /api/v1/uploads/image-variants
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json
```

```json
{
  "sourceKey": "uploads/USER_ID/FILE_NAME.jpg"
}
```

Expected:

- HTTP `200`
- `data.variants` contains `360w`, `720w`, and `1080w`
- Every variant has a working CDN URL
- Each returned URL responds with HTTP `200` and `Content-Type: image/jpeg`

Include the returned variants in the `file.imageVariants` object when creating an image post or story. The feed response should return the same `media.imageVariants` values.

## 8. Story HLS status

Create a story with an uploaded video, then call:

```http
GET /api/v1/stories/<STORY_ID>/media-status
Authorization: Bearer <JWT_TOKEN>
```

Expected: same `processing -> ready` lifecycle and a playable `hlsUrl`.

## 9. Blog HLS status

Create a blog with an uploaded video, then call:

```http
GET /api/v1/blogs/<BLOG_ID>/media-status
Authorization: Bearer <JWT_TOKEN>
```

Expected: same `processing -> ready` lifecycle and a playable `hlsUrl`.

## 10. Audio processing

For a music track:

```http
GET /api/v1/music/tracks/<TRACK_ID>/audio-status?networkSpeedMbps=4
Authorization: Bearer <JWT_TOKEN>
```

For an original sound:

```http
GET /api/v1/sounds/<SOUND_ID>/audio-status?networkSpeedMbps=4
Authorization: Bearer <JWT_TOKEN>
```

Expected:

- `status` is `ready` after the worker completes
- `recommendedQuality` is `low`, `medium`, or `high`
- `recommendedUrl` exists
- `variants` contains 64, 128, and 256 kbps files where processing succeeded
- Each audio URL responds successfully and can be played by the mobile audio player

Audio currently uses separate M4A variants. The frontend can request this endpoint again when network conditions change.

## 11. Network profile API

```http
GET /api/v1/uploads/quality-profile?networkSpeedMbps=0.4
Authorization: Bearer <JWT_TOKEN>
```

Expected low profile:

```json
{
  "networkProfile": "low",
  "recommendedQuality": "360p",
  "maxResolution": "360p"
}
```

Repeat with `2` and `8` Mbps. The recommended profile should increase accordingly.

## 12. Adaptive plan API

```http
POST /api/v1/uploads/adaptive
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json
```

```json
{
  "mediaUrl": "https://cdn.example.com/uploads/test.mp4",
  "mediaKind": "video",
  "networkSpeedMbps": 0.4
}
```

Expected:

- HTTP `200`
- `networkProfile` is `low`
- `recommendedQuality` is `360p`
- `transcoding.enabled` remains `false`

This endpoint is only a recommendation helper. Real video adaptive playback must use the HLS `hlsUrl` from the media status endpoint.

## 13. Pass criteria

Media backend is considered ready when:

- API and worker are both running
- S3/R2 upload succeeds
- Video post reaches `ready`
- HLS master playlist and segments return HTTP `200`
- Image variant URLs return HTTP `200`
- Audio variant URLs play successfully
- Failed jobs show `failed` and a useful error
- React Native player can play the returned HLS URL

## 14. Quick troubleshooting

| Problem | Check |
|---|---|
| `S3_NOT_CONFIGURED` | S3/R2 environment variables |
| `FFMPEG_MISSING` | `ffmpeg -version` on the worker host |
| Status stuck at `processing` | Redis, worker process, and worker logs |
| HLS URL loads but segments fail | CDN/bucket public read policy and `S3_PUBLIC_BASE_URL` |
| Presigned PUT fails | Exact `Content-Type` and optional `x-amz-acl` header |
| Image variants fail | Source key ownership, FFmpeg, S3 write permission |
| Audio remains processing | Worker logs and source audio key |
