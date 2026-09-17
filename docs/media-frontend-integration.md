# Frontend Media Integration

Base URL:

```text
https://your-api.example.com/api/v1
```

All API requests below require:

```http
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json
```

## Video or audio upload

1. Create a direct upload URL:

```ts
const presignResponse = await fetch(`${API_URL}/uploads/presign`, {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({
    contentType: file.mimeType,
    originalName: file.name,
  }),
});
const { data: upload } = await presignResponse.json();
```

2. Upload the binary file directly to `upload.uploadUrl`:

```ts
await fetch(upload.uploadUrl, {
  method: 'PUT',
  headers: {
    'Content-Type': upload.contentType,
    ...(upload.acl ? { 'x-amz-acl': upload.acl } : {}),
  },
  body: fileBlob,
});
```

Do not send the large binary file through the Node API when using this flow.

## Image upload

After the direct upload succeeds, generate real CDN image variants:

```ts
const variantsResponse = await fetch(`${API_URL}/uploads/image-variants`, {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({ sourceKey: upload.key }),
});
const { data: imageData } = await variantsResponse.json();
```

`imageData.variants` contains `360w`, `720w`, and `1080w` JPEG URLs. Include it in the post or story file object:

```ts
const file = {
  key: upload.key,
  bucket: upload.bucket,
  contentType: upload.contentType,
  size: fileSize,
  originalName: file.name,
  url: upload.url,
  imageVariants: imageData.variants,
};
```

## Create a video post

```ts
await fetch(`${API_URL}/posts`, {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({
    mediaKind: 'short_video',
    file,
    caption: 'My video',
    mediaWidth: 1080,
    mediaHeight: 1920,
    durationSeconds: 35,
    originalAudioMuted: false,
  }),
});
```

The API returns immediately with `mediaProcessingStatus: "processing"`.

Poll the status endpoint:

```ts
const response = await fetch(`${API_URL}/posts/${postId}/media-status`, {
  headers: authHeaders,
});
const { data } = await response.json();

if (data.status === 'ready' && data.hlsUrl) {
  // Pass data.hlsUrl directly to an HLS-compatible React Native player.
}
```

Use `data.hlsUrl` as the player source. Do not add a `quality` query parameter. The HLS player selects between 360p, 480p, 720p, and 1080p automatically.

The same status flow is available for:

```text
GET /stories/:storyId/media-status
GET /blogs/:blogId/media-status
```

## React Native video player

Use an HLS-compatible player such as `react-native-video`:

```tsx
<Video
  source={{ uri: mediaStatus.hlsUrl }}
  controls
  resizeMode="cover"
  paused={false}
  onError={(error) => console.warn('Video playback failed', error)}
/>
```

Only render the player when `status === 'ready'` and `hlsUrl` is not null. Show a processing placeholder for `processing` and a retry/fallback state for `failed`.

## Adaptive images

Select the largest generated image that fits the device width and network profile:

```ts
function imageUrlForWidth(
  variants: Array<{ quality: string; width: number; url: string }>,
  deviceWidth: number,
) {
  return [...variants]
    .sort((a, b) => a.width - b.width)
    .find((variant) => variant.width >= deviceWidth)?.url
    ?? variants.at(-1)?.url;
}
```

Use the selected URL in an `<Image>` component. The original upload URL is a fallback only.

## Adaptive audio

For a music track:

```text
GET /music/tracks/:trackId/audio-status?networkSpeedMbps=4
```

For an original sound:

```text
GET /sounds/:soundId/audio-status?networkSpeedMbps=4
```

The response includes `recommendedUrl` and all available `variants`:

```json
{
  "status": "ready",
  "recommendedQuality": "high",
  "recommendedUrl": "https://cdn.example.com/music/track/variants/high.m4a",
  "variants": [
    { "quality": "low", "bitrateKbps": 64, "url": "..." },
    { "quality": "medium", "bitrateKbps": 128, "url": "..." },
    { "quality": "high", "bitrateKbps": 256, "url": "..." }
  ]
}
```

Play `recommendedUrl`. If the player reports repeated buffering, request the endpoint again with the latest measured `networkSpeedMbps` and replace the source. Audio currently uses separate M4A variants, not an audio HLS master playlist.

## Required backend runtime

The following must be running/configured for production media processing:

- API process: `npm run start`
- Media worker: `npm run start:worker`
- Redis for BullMQ
- FFmpeg available on the worker host
- S3 or S3-compatible storage
- `S3_PUBLIC_BASE_URL` pointing to the public CDN/object URL

Video and audio processing are asynchronous. Never block the upload screen waiting for FFmpeg; show `processing` and poll the status endpoint.
