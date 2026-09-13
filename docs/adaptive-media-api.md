# Adaptive Media API

This document explains how the frontend should consume the adaptive media API so the app can load the best media quality based on the user's network speed.

Base URL:

```text
http://localhost:4000/api/v1
```

All endpoints require authentication:

```http
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json
```

---

## 1) GET /uploads/quality-profile

Returns a recommended quality based on the current internet speed.

### Request

```http
GET /api/v1/uploads/quality-profile?networkSpeedMbps=4
Authorization: Bearer <JWT_TOKEN>
```

### Query params

| Name | Type | Required | Description |
|---|---:|---:|---|
| networkSpeedMbps | number | Yes | Current internet speed in Mbps |

### Example response

```json
{
  "data": {
    "networkSpeedMbps": 4,
    "networkProfile": "balanced",
    "recommendedQuality": "480p",
    "maxResolution": "480p",
    "prefetchStrategy": "cache-first",
    "bufferingHint": "Use balanced quality and keep prefetch enabled."
  }
}
```

### Frontend usage

```ts
const url = `http://localhost:4000/api/v1/uploads/quality-profile?networkSpeedMbps=${networkSpeed}`;

const res = await fetch(url, {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});

const json = await res.json();
console.log(json.data.recommendedQuality);
```

---

## 2) POST /uploads/adaptive

Returns the recommended media URL for a given original media URL and network speed.

### Request body

```json
{
  "mediaUrl": "https://cdn.example.com/video.mp4",
  "mediaKind": "video",
  "networkSpeedMbps": 4
}
```

### Body fields

| Name | Type | Required | Description |
|---|---:|---:|---|
| mediaUrl | string | Yes | Original media URL |
| mediaKind | string | Yes | `video`, `image`, or `audio` |
| networkSpeedMbps | number | Yes | Current internet speed in Mbps |

### Example request

```http
POST /api/v1/uploads/adaptive
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json
```

```json
{
  "mediaUrl": "https://cdn.example.com/video.mp4",
  "mediaKind": "video",
  "networkSpeedMbps": 4
}
```

### Example response

```json
{
  "data": {
    "mediaKind": "video",
    "networkSpeedMbps": 4,
    "networkProfile": "balanced",
    "recommendedQuality": "480p",
    "recommendedUrl": "https://cdn.example.com/video.mp4?quality=480p",
    "transcoding": {
      "enabled": true,
      "strategy": "network-aware",
      "note": "Frontend should use recommendedUrl and fall back to the original media URL when a higher-quality variant is not available yet."
    },
    "variants": [
      {
        "quality": "360p",
        "label": "360p",
        "url": "https://cdn.example.com/video.mp4?quality=360p",
        "bitrateKbps": 500,
        "preferred": false
      },
      {
        "quality": "480p",
        "label": "480p",
        "url": "https://cdn.example.com/video.mp4?quality=480p",
        "bitrateKbps": 900,
        "preferred": true
      },
      {
        "quality": "720p",
        "label": "720p",
        "url": "https://cdn.example.com/video.mp4?quality=720p",
        "bitrateKbps": 1800,
        "preferred": false
      }
    ]
  }
}
```

### Frontend usage

```ts
const res = await fetch('http://localhost:4000/api/v1/uploads/adaptive', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    mediaUrl: videoUrl,
    mediaKind: 'video',
    networkSpeedMbps: networkSpeed,
  }),
});

const json = await res.json();
const finalUrl = json.data.recommendedUrl ?? videoUrl;
```

---

## 3) POST /uploads/transcode

Generates real transcoded variants for a source video and returns the recommended URL.

### Request body

```json
{
  "sourceKey": "uploads/123/user-video.mp4",
  "networkSpeedMbps": 4
}
```

### Body fields

| Name | Type | Required | Description |
|---|---:|---:|---|
| sourceKey | string | Yes | Source video key stored in S3 or storage backend |
| networkSpeedMbps | number | Yes | Current internet speed in Mbps |

### Example request

```http
POST /api/v1/uploads/transcode
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json
```

```json
{
  "sourceKey": "uploads/123/user-video.mp4",
  "networkSpeedMbps": 4
}
```

### Example response

```json
{
  "data": {
    "sourceKey": "uploads/123/user-video.mp4",
    "sourceUrl": "https://cdn.example.com/uploads/123/user-video.mp4",
    "recommendedQuality": "480p",
    "recommendedUrl": "https://cdn.example.com/uploads/123/transcoded/480p/video.mp4",
    "fallbackUrl": "https://cdn.example.com/uploads/123/user-video.mp4",
    "networkProfile": "balanced",
    "variants": [
      {
        "quality": "360p",
        "label": "360p",
        "url": "https://cdn.example.com/uploads/123/transcoded/360p/video.mp4",
        "width": 640,
        "height": 360,
        "bitrateKbps": 500,
        "preferred": false
      },
      {
        "quality": "480p",
        "label": "480p",
        "url": "https://cdn.example.com/uploads/123/transcoded/480p/video.mp4",
        "width": 854,
        "height": 480,
        "bitrateKbps": 900,
        "preferred": true
      }
    ]
  }
}
```

### Frontend usage

```ts
const res = await fetch('http://localhost:4000/api/v1/uploads/transcode', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    sourceKey: 'uploads/123/user-video.mp4',
    networkSpeedMbps: networkSpeed,
  }),
});

const json = await res.json();
const finalUrl = json.data.recommendedUrl ?? json.data.fallbackUrl;
```

---

## 4) Recommended frontend flow

1. Detect current network speed.
2. Call `/uploads/adaptive` with original media URL.
3. Take `recommendedUrl`.
4. Use the final URL to render video, image, or audio.
5. If the call fails, fall back to the original URL.

### Helper example

```ts
async function getBestMediaUrl({
  mediaUrl,
  mediaKind,
  token,
  networkSpeedMbps,
}: {
  mediaUrl: string;
  mediaKind: 'video' | 'image' | 'audio';
  token: string;
  networkSpeedMbps: number;
}) {
  const res = await fetch('http://localhost:4000/api/v1/uploads/adaptive', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      mediaUrl,
      mediaKind,
      networkSpeedMbps,
    }),
  });

  if (!res.ok) {
    return mediaUrl;
  }

  const json = await res.json();
  return json.data.recommendedUrl ?? mediaUrl;
}
```

---

## 5) Quality mapping

| Network speed | Recommended quality |
|---|---|
| <= 1.5 Mbps | 360p / low |
| 1.5 to 5 Mbps | 480p / medium |
| 5 to 15 Mbps | 720p / high |
| > 15 Mbps | 1080p / max |

---

## 6) Common frontend usage rules

- Slow network: use lower quality and preload less
- Medium network: use balanced quality
- Fast network: use high quality and allow more prefetch
- Always keep fallback URL ready
- Use this helper across feed, stories, profile media, blogs, and music previews

---

## 7) Error examples

### Missing mediaUrl

```json
{
  "error": "mediaUrl is required",
  "code": "NO_MEDIA_URL"
}
```

### Missing auth

```json
{
  "error": "Unauthorized"
}
```

### File / source not found

```json
{
  "error": "Source object not found in S3: uploads/123/user-video.mp4",
  "code": "SOURCE_NOT_FOUND"
}
```

---

## 8) Summary

Use the following flow in the app:

1. Detect network speed
2. Call `POST /uploads/adaptive`
3. Use `recommendedUrl`
4. Fallback to original URL if the adaptive call fails
5. For real generated variants, call `POST /uploads/transcode`

This keeps media smooth and adaptive for slow, medium, and fast internet conditions.
