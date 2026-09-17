# Media API

Base URL:

```text
http://localhost:4000/api/v1
```

Protected APIs में header भेजें:

```http
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json
```

## 1. Login

```http
POST /auth/login
```

Request body:

```json
{
  "identifier": "username-or-email",
  "password": "your-password"
}
```

Response में मिलने वाला token बाकी protected APIs में भेजें:

```json
{
  "data": {
    "token": "<JWT_TOKEN>"
  }
}
```

## 2. Upload URL बनाना

```http
POST /uploads/presign
```

Request body:

```json
{
  "contentType": "video/mp4",
  "originalName": "my-video.mp4"
}
```

Parameters:

| नाम | Type | Required | Description |
|---|---|---|---|
| `contentType` | string | Yes | `video/mp4`, `image/jpeg`, `audio/mpeg` आदि |
| `originalName` | string | Yes | Original file name |

Response:

```json
{
  "data": {
    "uploadUrl": "https://s3-presigned-url",
    "key": "uploads/user-id/file.mp4",
    "bucket": "bucket-name",
    "contentType": "video/mp4",
    "category": "video",
    "url": "https://cdn.example.com/uploads/user-id/file.mp4",
    "acl": null,
    "expiresIn": 900
  }
}
```

## 3. File को S3 पर upload करना

यह request backend को नहीं, बल्कि पिछले response के `uploadUrl` पर भेजें।

```http
PUT <uploadUrl>
Content-Type: video/mp4
```

Request body: पूरा binary file.

- `Content-Type` वही रखें जो presign response में मिला है।
- अगर `acl` null नहीं है, तो `x-amz-acl` header भी भेजें।
- Upload सफल होने के बाद ही post create करें।

## 4. Video post बनाना

```http
POST /posts
```

Request body:

```json
{
  "mediaKind": "short_video",
  "file": {
    "key": "uploads/user-id/file.mp4",
    "bucket": "bucket-name",
    "contentType": "video/mp4",
    "size": 5242880,
    "originalName": "my-video.mp4",
    "url": "https://cdn.example.com/uploads/user-id/file.mp4"
  },
  "caption": "My video",
  "hashtags": "#video",
  "mediaWidth": 1080,
  "mediaHeight": 1920,
  "durationSeconds": 35,
  "originalAudioMuted": false
}
```

Parameters:

| नाम | Type | Required | Description |
|---|---|---|---|
| `mediaKind` | `short_video` | Yes | Video post के लिए |
| `file` | object | Yes | Presign response और uploaded file की जानकारी |
| `file.key` | string | Yes | Presign response का `key` |
| `file.bucket` | string | Yes | Presign response का `bucket` |
| `file.contentType` | string | Yes | Uploaded file का MIME type |
| `file.size` | number | Yes | File size bytes में |
| `file.originalName` | string | Yes | Original file name |
| `file.url` | string/null | Yes | CDN/public URL |
| `caption` | string/null | No | Maximum 4000 characters |
| `hashtags` | string/null | No | Maximum 2000 characters |
| `mediaWidth` | number/null | No | Video width |
| `mediaHeight` | number/null | No | Video height |
| `durationSeconds` | number/null | No | Video duration |
| `originalAudioMuted` | boolean | No | Default `false` |

Response में post तुरंत बनता है:

```json
{
  "data": {
    "post": {
      "id": "post-id",
      "mediaKind": "short_video",
      "mediaProcessingStatus": "processing",
      "hlsUrl": null,
      "hlsVariants": [],
      "mediaProcessingError": null
    }
  }
}
```

## 5. HLS processing status

```http
GET /posts/{postId}/media-status
```

Path parameter:

| नाम | Type | Required | Description |
|---|---|---|---|
| `postId` | string | Yes | `POST /posts` response का post ID |

Example:

```http
GET /api/v1/posts/post-id/media-status
Authorization: Bearer <JWT_TOKEN>
```

Processing के दौरान:

```json
{
  "data": {
    "postId": "post-id",
    "mediaKind": "short_video",
    "status": "processing",
    "hlsUrl": null,
    "variants": [],
    "error": null
  }
}
```

Processing complete होने पर:

```json
{
  "data": {
    "postId": "post-id",
    "mediaKind": "short_video",
    "status": "ready",
    "hlsUrl": "https://cdn.example.com/.../master.m3u8",
    "variants": [
      {
        "quality": "360p",
        "width": 640,
        "height": 360,
        "bitrateKbps": 500,
        "playlistUrl": "https://cdn.example.com/.../360p/index.m3u8"
      },
      {
        "quality": "720p",
        "width": 1280,
        "height": 720,
        "bitrateKbps": 1800,
        "playlistUrl": "https://cdn.example.com/.../720p/index.m3u8"
      }
    ],
    "error": null
  }
}
```

Possible statuses:

| Status | Meaning |
|---|---|
| `processing` | FFmpeg HLS conversion चल रही है |
| `ready` | `hlsUrl` playback के लिए तैयार है |
| `failed` | Processing fail हुई; `error` देखें |
| `not_required` | Image या non-video media |

## 6. HLS playback

`status` जब `ready` हो, तब केवल `hlsUrl` player को दें:

```ts
const response = await fetch(`${API_URL}/posts/${postId}/media-status`, {
  headers: { Authorization: `Bearer ${token}` },
});

const { data } = await response.json();

if (data.status === 'ready' && data.hlsUrl) {
  // React Native HLS-compatible video player में data.hlsUrl चलाएं
  playVideo(data.hlsUrl);
}
```

`hlsUrl` को manually quality query parameters के साथ modify न करें। HLS player खुद adaptive quality switch करेगा।

## 7. Network quality profile

Optional endpoint:

```http
GET /uploads/quality-profile?networkSpeedMbps=4
```

Query parameters:

| नाम | Type | Required | Description |
|---|---|---|---|
| `networkSpeedMbps` | number | No | Current network speed; default `6` |

Response:

```json
{
  "data": {
    "networkSpeedMbps": 4,
    "networkProfile": "high",
    "recommendedQuality": "1080p",
    "maxResolution": "1080p"
  }
}
```

Network mapping:

| Network speed | Profile | Recommended video quality |
|---|---|---|
| `< 0.5 Mbps` | `low` | `360p` |
| `0.5 - <1.5 Mbps` | `balanced` | `480p` |
| `1.5 - <4 Mbps` | `good` | `720p` |
| `>= 4 Mbps` | `high` | `1080p` |

`quality-profile` recommendation देता है; यह FFmpeg transcoding start नहीं करता। HLS video के लिए `hlsUrl` directly player को दें।

## 8. Adaptive media recommendation

Direct image, audio या non-HLS video URL के लिए:

```http
POST /uploads/adaptive
```

Request:

```json
{
  "mediaUrl": "https://cdn.example.com/uploads/user-id/file.mp4",
  "mediaKind": "video",
  "networkSpeedMbps": 4
}
```

यह endpoint CDN quality query के साथ `recommendedUrl` और variants लौटाता है। यह खुद FFmpeg transcoding नहीं करता और तभी useful है जब आपका CDN `quality` query support करता हो। HLS `hlsUrl` के लिए इसे call न करें।

## 9. Blog video media status

```http
GET /blogs/{blogId}/media-status
```

Video blog create करने के लिए पहले वही `/uploads/presign` और direct `PUT` flow use करें, फिर:

```http
POST /blogs
```

Request में `title`, `description`, `file`, optional `posterFile` और `durationSeconds` भेजें। Blog का `file.key` backend worker के लिए save होता है।

Status response:

```json
{
  "data": {
    "mediaId": "blog-id",
    "mediaKind": "video",
    "status": "ready",
    "hlsUrl": "https://cdn.example.com/uploads/.../master.m3u8",
    "variants": [
      {
        "quality": "720p",
        "width": 1280,
        "height": 720,
        "bitrateKbps": 1800,
        "playlistUrl": "https://cdn.example.com/.../720p/index.m3u8"
      }
    ],
    "error": null
  }
}
```

`processing` पर poll करें, `ready` पर `hlsUrl` directly player को दें, और `failed` पर `error` दिखाएं। पुराने blogs जिनमें S3 `videoKey` नहीं है, वे original `videoUrl` fallback use करेंगे।

## 10. Story video media status

```http
GET /stories/{storyId}/media-status
```

Video story create होने पर `POST /stories` automatic HLS queue job add करता है। Status response:

```json
{
  "data": {
    "mediaId": "story-id",
    "mediaKind": "short_video",
    "status": "processing",
    "hlsUrl": null,
    "variants": [],
    "error": null
  }
}
```

Image story में status `not_required` रहता है और image का original `media.url` use करें।

## 11. Shared processing behavior

Video post, blog और story तीनों का backend flow समान है:

```text
Create media
  -> status: processing
  -> Redis/BullMQ queue
  -> FFmpeg worker
  -> 360p / 480p / 720p / 1080p HLS variants
  -> status: ready + hlsUrl
```

API process और worker process दोनों same MongoDB, Redis, S3 configuration और `S3_PUBLIC_BASE_URL` use करें। Frontend को `hlsUrl` manually construct नहीं करना है।

## 12. Image upload

Image के लिए भी `/uploads/presign` और direct `PUT` flow use करें। Post बनाते समय:

```json
{
  "mediaKind": "image",
  "file": {
    "key": "uploads/user-id/image.jpg",
    "bucket": "bucket-name",
    "contentType": "image/jpeg",
    "size": 200000,
    "originalName": "image.jpg",
    "url": "https://cdn.example.com/uploads/user-id/image.jpg"
  },
  "caption": "My image"
}
```

Image post के लिए HLS processing नहीं होगी और `mediaProcessingStatus` `not_required` रहेगा।

## 13. Audio upload

Audio को `/uploads/presign` से upload किया जा सकता है। `contentType` उदाहरण:

```text
audio/mpeg
audio/mp4
audio/wav
```

Audio को video post में `mediaKind: "short_video"` के साथ attach न करें। Audio का उपयोग music या sound APIs के अनुसार करें।

Audio processing के बाद backend `low` (64 kbps), `medium` (128 kbps) और `high` (256 kbps) M4A variants बनाता है। Recommended variant लेने के लिए:

Original sound:

```http
GET /sounds/{soundId}/audio-status?networkSpeedMbps=1.2
```

Music track:

```http
GET /music/tracks/{trackId}/audio-status?networkSpeedMbps=1.2
```

Response:

```json
{
  "data": {
    "soundId": "sound-id",
    "status": "ready",
    "recommendedQuality": "medium",
    "recommendedUrl": "https://cdn.example.com/sounds/.../medium.m4a",
    "variants": [
      {
        "quality": "low",
        "bitrateKbps": 64,
        "url": "https://cdn.example.com/sounds/.../low.m4a"
      },
      {
        "quality": "medium",
        "bitrateKbps": 128,
        "url": "https://cdn.example.com/sounds/.../medium.m4a"
      },
      {
        "quality": "high",
        "bitrateKbps": 256,
        "url": "https://cdn.example.com/sounds/.../high.m4a"
      }
    ],
    "error": null
  }
}
```

Audio network mapping वही है: `<0.5 Mbps` low, `0.5 - <1.5 Mbps` medium, और `>=1.5 Mbps` high। `processing` पर original audio fallback रख सकते हैं; `ready` पर `recommendedUrl` play करें; `failed` पर original URL fallback करें।

---

# API + Frontend Integration Checklist

इस checklist को ऊपर से नीचे तक follow करें। जिस item का test successful हो, उसके आगे `[x]` कर दें।

## A. Backend setup

- [ ] Backend `.env` में `MONGODB_URI` और `JWT_SECRET` configured हैं।
- [ ] S3 के लिए `AWS_REGION`, `S3_BUCKET`, `AWS_ACCESS_KEY_ID` और `AWS_SECRET_ACCESS_KEY` configured हैं।
- [ ] `S3_PUBLIC_BASE_URL` public CloudFront या S3 URL पर set है। इसमें trailing slash नहीं होना चाहिए।
- [ ] S3 bucket में `uploads/*` objects पढ़ने के लिए CloudFront/bucket policy configured है।
- [ ] Backend host पर `ffmpeg -version` काम करता है।
- [ ] Redis चल रहा है और `REDIS_URL` सही है।
- [ ] API process और worker process दोनों चल रहे हैं:

```bash
pnpm build
pm2 restart multiflix-be
pm2 restart multiflix-worker
```

Legacy `short_video` posts के लिए एक बार backfill चलाएं:

```bash
# पहले preview देखें
pnpm backfill:video-transcoding

# सही लगे तो jobs queue करें
pnpm backfill:video-transcoding -- --apply
```

`--apply` के बाद worker चलना जरूरी है। यह script केवल उन पुराने video posts को queue करती है जिनका status `not_required` या missing है।

- [ ] Health endpoint successful है:

```http
GET /api/v1/health
```

## B. Login और upload test

- [ ] `POST /auth/login` से token मिल रहा है।
- [ ] हर protected request में ये header भेजा जा रहा है:

```http
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json
```

- [ ] `POST /uploads/presign` से `uploadUrl`, `key`, `bucket` और `url` मिल रहे हैं।
- [ ] App file को backend पर नहीं, response के `uploadUrl` पर direct `PUT` कर रही है।
- [ ] Direct `PUT` में वही `Content-Type` भेजा जा रहा है जो presign request में था।
- [ ] `PUT` के बाद `POST /posts` में वही `key`, `bucket`, `contentType`, `size`, `originalName` और `url` भेजे जा रहे हैं।

## C. Video post और automatic HLS

- [ ] Video post `mediaKind: "short_video"` के साथ create हो रहा है।
- [ ] `POST /posts` response में `mediaProcessingStatus: "processing"` मिल रहा है।
- [ ] Post create होने के बाद worker logs में media processing job दिख रही है।
- [ ] `GET /posts/{postId}/media-status` पहले `processing` return करता है।
- [ ] Processing complete होने पर status `ready` होता है।
- [ ] `ready` response में `hlsUrl` एक complete public URL है, जैसे:

```text
https://your-cloudfront-domain/uploads/.../master.m3u8
```

- [ ] `hlsUrl` को app manually modify नहीं करती।
- [ ] App `/api/v1/hls/{assetId}/master.m3u8` URL manually create नहीं करती। Current backend में यह route नहीं है।
- [ ] App `data.hlsUrl` को directly AndroidX Media3/ExoPlayer या React Native HLS player को देती है।
- [ ] Video blog के लिए `GET /blogs/{blogId}/media-status` से यही status contract use हो रहा है।
- [ ] Video story के लिए `GET /stories/{storyId}/media-status` से यही status contract use हो रहा है।
- [ ] Image story का status `not_required` handle हो रहा है।
- [ ] Original sound के लिए `GET /sounds/{soundId}/audio-status` use हो रहा है।
- [ ] Music track के लिए `GET /music/tracks/{trackId}/audio-status` use हो रहा है।
- [ ] Audio `processing` पर fallback URL और `ready` पर `recommendedUrl` use हो रहा है।

## D. Frontend implementation

Frontend में video post create करने का order यही होना चाहिए:

```ts
const loginResponse = await api.post('/auth/login', {
  identifier,
  password,
});

const token = loginResponse.data.data.token;

const presignResponse = await api.post(
  '/uploads/presign',
  { contentType: 'video/mp4', originalName: fileName },
  { headers: { Authorization: `Bearer ${token}` } },
);

const upload = presignResponse.data.data;

await fetch(upload.uploadUrl, {
  method: 'PUT',
  headers: { 'Content-Type': upload.contentType },
  body: videoFile,
});

const postResponse = await api.post(
  '/posts',
  {
    mediaKind: 'short_video',
    file: {
      key: upload.key,
      bucket: upload.bucket,
      contentType: upload.contentType,
      size: videoFileSize,
      originalName: fileName,
      url: upload.url,
    },
    caption,
    hashtags,
    mediaWidth,
    mediaHeight,
    durationSeconds,
    originalAudioMuted: false,
  },
  { headers: { Authorization: `Bearer ${token}` } },
);

const postId = postResponse.data.data.post.id;
```

Video playback के लिए:

```ts
const response = await api.get(`/posts/${postId}/media-status`, {
  headers: { Authorization: `Bearer ${token}` },
});

const media = response.data.data;

if (media.status === 'ready' && media.hlsUrl) {
  // AndroidX Media3 / ExoPlayer को यही complete URL दें।
  player.setMediaItem(media.hlsUrl);
}
```

## D1. Copy-paste frontend helpers

यह helper Axios जैसे `api` client के साथ use कर सकते हैं। `api` का `baseURL` यह होना चाहिए:

```ts
const API_URL = 'http://localhost:4000/api/v1';
const api = axios.create({ baseURL: API_URL });
```

Network profile:

```ts
export async function getNetworkProfile(token: string, networkSpeedMbps: number) {
  const response = await api.get('/uploads/quality-profile', {
    params: { networkSpeedMbps },
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.data.data;
}
```

Video, blog या story HLS status polling:

```ts
export async function waitForVideoReady(
  path: string,
  token: string,
  onStatus?: (status: string) => void,
) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await api.get(path, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const media = response.data.data;
    onStatus?.(media.status);

    if (media.status === 'ready' && media.hlsUrl) return media.hlsUrl;
    if (media.status === 'failed') {
      throw new Error(media.error || 'Media processing failed');
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  throw new Error('Media processing timed out');
}

// Post:
const postHlsUrl = await waitForVideoReady(
  `/posts/${postId}/media-status`,
  token,
);

// Blog:
const blogHlsUrl = await waitForVideoReady(
  `/blogs/${blogId}/media-status`,
  token,
);

// Story:
const storyHlsUrl = await waitForVideoReady(
  `/stories/${storyId}/media-status`,
  token,
);
```

Audio status और speed-based URL:

```ts
export async function getAudioUrl(
  kind: 'sound' | 'music',
  id: string,
  token: string,
  networkSpeedMbps: number,
  originalUrl: string,
) {
  const path = kind === 'sound'
    ? `/sounds/${id}/audio-status`
    : `/music/tracks/${id}/audio-status`;
  const response = await api.get(path, {
    params: { networkSpeedMbps },
    headers: { Authorization: `Bearer ${token}` },
  });
  const audio = response.data.data;

  if (audio.status === 'ready' && audio.recommendedUrl) {
    return audio.recommendedUrl;
  }
  if (audio.status === 'failed' || audio.status === 'not_required') {
    return originalUrl;
  }
  return originalUrl;
}

const audioUrl = await getAudioUrl(
  'music',
  track.id,
  token,
  currentNetworkSpeedMbps,
  track.audioUrl,
);
```

Frontend rules:

- Video के लिए `hlsUrl` directly player को दें।
- Audio के लिए `recommendedUrl` directly audio player को दें।
- `processing` में original URL fallback रखें।
- `failed` में error दिखाकर original URL fallback रखें।
- `/api/v1/hls/...` या quality query URL manually construct न करें।
- Screen बंद होने पर polling cancel/stop करें।

Frontend polling rules:

- [ ] `processing` पर 3 से 5 seconds के interval में status check हो।
- [ ] Maximum polling time set हो, जैसे 5 minutes।
- [ ] `ready` पर polling बंद हो और `hlsUrl` play हो।
- [ ] `failed` पर `error` दिखे और infinite polling न हो।
- [ ] `not_required` पर HLS player use न हो।

## E. Android HLS 404 troubleshooting

अगर logs में यह request दिखे:

```text
GET /api/v1/hls/<assetId>/master.m3u8 404
```

तो ये checks करें:

- [ ] Android app में `"/hls/"` search करें। यह URL manually construct नहीं होना चाहिए।
- [ ] Android app में `"master.m3u8"` search करें। Hardcoded URL हटाएं।
- [ ] Posts API या media-status response में `hlsUrl` print करें।
- [ ] `hlsUrl` `https://.../master.m3u8` होना चाहिए, `/api/v1/hls/...` नहीं।
- [ ] अगर database में पुराने `/api/v1/hls/...` URLs हैं, तो posts को reprocess करें।
- [ ] CloudFront URL को browser/curl से test करें:

```bash
curl -I "https://your-cloudfront-domain/uploads/.../master.m3u8"
```

- [ ] Master playlist मिलने के बाद उसके variant playlist और `.ts` segment URLs भी accessible हैं।
- [ ] API और worker same `.env`, same S3 bucket और same Redis use कर रहे हैं।

## F. Final acceptance test

पूरी integration तभी complete मानी जाएगी जब:

- [ ] New video upload होकर S3 में दिखाई दे।
- [ ] New post `processing` status में create हो।
- [ ] Worker बिना error के HLS files upload करे।
- [ ] Status `ready` और valid `hlsUrl` return करे।
- [ ] Android Media3 `hlsUrl` से video play करे।
- [ ] HLS quality network के अनुसार automatically switch हो।
- [ ] App logs में `/api/v1/hls/...` का 404 नहीं आए।
- [ ] Image post `not_required` status के साथ दिखे।
- [ ] Failed processing में user को error दिखे और app hang न हो।
