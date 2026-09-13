import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import type { IPost } from '../models/post.model.js';
import { PostModel } from '../models/post.model.js';
import { UserModel } from '../models/user.model.js';

/** 1-based indices matching `seedUsers.ts` emails (subset only — not all 16 users post). */
const AUTHOR_SEED_NUMBERS = [1, 2, 5, 8, 12, 15] as const;

const POSTS_PER_AUTHOR = 3;

/** Keys contain this segment so re-runs can replace seeded posts only. */
const SEED_KEY_MARKER = '/__seed__/';

function seedEmail(n: number): string {
  return `multiflix.seed.${String(n).padStart(
    2,
    '0',
  )}@multiflix.test`.toLowerCase();
}

const IMAGE_POST_TEMPLATES = [
  {
    caption:
      "Still from last night's watch — colors popped more than I expected.",
    hashtags: '#multiflix #still #mood',
  },
  {
    caption: 'Coffee, couch, credits rolling. Perfect Sunday.',
    hashtags: '#cozy #weekend',
  },
  {
    caption: 'Throwback frame — same spot, different playlist.',
    hashtags: '#tbt #photography',
  },
] as const;

/**
 * Public sample MP4 URLs for seeded video posts.
 * These are well-known test videos hosted by reliable sources.
 */
const VIDEO_TEMPLATES = [
  {
    url: 'https://www.w3schools.com/html/mov_bbb.mp4',
    thumbnailUrl: 'https://picsum.photos/seed/vid-bbb/720/1280',
    caption: 'Quick clip from today — the vibe was unmatched.',
    hashtags: '#reels #vibes #trending',
    durationSeconds: 10,
  },
  {
    url: 'https://www.w3schools.com/html/movie.mp4',
    thumbnailUrl: 'https://picsum.photos/seed/vid-movie/720/1280',
    caption: 'Escape mode: activated.',
    hashtags: '#adventure #explore',
    durationSeconds: 12,
  },
  {
    url: 'https://media.w3.org/2010/05/sintel/trailer_hd.mp4',
    thumbnailUrl: 'https://picsum.photos/seed/vid-sintel/720/1280',
    caption: 'Weekend energy — catch me if you can.',
    hashtags: '#fun #weekend #multiflix',
    durationSeconds: 52,
  },
] as const;

/** Authors that get video posts (subset of AUTHOR_SEED_NUMBERS). */
const VIDEO_AUTHOR_SEED_NUMBERS = [2, 8, 15] as const;

function pickImageTemplate(
  postIndex: number,
): (typeof IMAGE_POST_TEMPLATES)[number] {
  switch (postIndex % 3) {
    case 0:
      return IMAGE_POST_TEMPLATES[0];
    case 1:
      return IMAGE_POST_TEMPLATES[1];
    default:
      return IMAGE_POST_TEMPLATES[2];
  }
}

async function main(): Promise<void> {
  await connectDb();

  const emails = [...AUTHOR_SEED_NUMBERS].map(n => seedEmail(n));
  const users = await UserModel.find({ email: { $in: emails } })
    .select({ _id: 1, email: 1 })
    .lean();

  if (users.length !== emails.length) {
    const found = new Set(users.map(u => u.email));
    const missing = emails.filter(e => !found.has(e));
    console.error(
      'Missing seed user(s). Run `pnpm seed:users` first. Not found:',
      missing.join(', '),
    );
    process.exit(1);
  }

  const byEmail = new Map(users.map(u => [u.email, String(u._id)] as const));

  const del = await PostModel.deleteMany({
    'media.key': { $regex: '__seed__' },
  });
  console.log(`Removed ${String(del.deletedCount)} previous seed post(s).`);

  type PostInsert = Omit<IPost, 'createdAt' | 'updatedAt'>;
  const docs: PostInsert[] = [];

  for (const n of AUTHOR_SEED_NUMBERS) {
    const email = seedEmail(n);
    const userId = byEmail.get(email);
    if (userId === undefined) {
      throw new Error(`Internal: missing user id for ${email}`);
    }

    for (let p = 0; p < POSTS_PER_AUTHOR; p += 1) {
      const t = pickImageTemplate(p);
      const slug = `post-${String(n).padStart(2, '0')}-${String(p + 1)}`;
      const key = `uploads/${userId}${SEED_KEY_MARKER}${slug}.jpg`;

      docs.push({
        author: new mongoose.Types.ObjectId(userId),
        mediaKind: 'image' as const,
        media: {
          key,
          bucket: 'placeholder',
          contentType: 'image/jpeg',
          size: 180_000 + n * 1000 + p * 50,
          originalName: `${slug}.jpg`,
          url: `https://picsum.photos/seed/multiflix-${slug}/720/960`,
        },
        caption: t.caption,
        hashtags: t.hashtags,
        musicTitle: null,
        musicTrack: null,
        musicTrimStartMs: 0,
        originalAudioMuted: false,
        originalSoundId: null,
        attachedOriginalSound: null,
        mediaWidth: 720,
        mediaHeight: 960,
        durationSeconds: null,
        likesCount: 0,
        savesCount: 0,
        commentsCount: 0,
      });
    }
  }

  const insertedImages = await PostModel.insertMany(docs);
  console.log(
    `Inserted ${String(insertedImages.length)} image seed post(s) from ${String(
      AUTHOR_SEED_NUMBERS.length,
    )} author(s).`,
  );

  // --- Video seed posts ---
  const videoDocs: PostInsert[] = [];

  for (let vi = 0; vi < VIDEO_AUTHOR_SEED_NUMBERS.length; vi += 1) {
    const n = VIDEO_AUTHOR_SEED_NUMBERS[vi];
    const email = seedEmail(n);
    const userId = byEmail.get(email);
    if (userId === undefined) {
      throw new Error(`Internal: missing user id for ${email}`);
    }

    const vt = VIDEO_TEMPLATES[vi % VIDEO_TEMPLATES.length];
    const slug = `video-${String(n).padStart(2, '0')}-1`;
    const key = `uploads/${userId}${SEED_KEY_MARKER}${slug}.mp4`;

    videoDocs.push({
      author: new mongoose.Types.ObjectId(userId),
      mediaKind: 'short_video' as const,
      media: {
        key,
        bucket: 'placeholder',
        contentType: 'video/mp4',
        size: 2_500_000 + vi * 100_000,
        originalName: `${slug}.mp4`,
        url: vt.url,
      },
      thumbnailUrl: vt.thumbnailUrl,
      caption: vt.caption,
      hashtags: vt.hashtags,
      musicTrack: null,
      musicTrimStartMs: 0,
      musicTitle: null,
      originalAudioMuted: false,
      originalSoundId: null,
      attachedOriginalSound: null,
      mediaWidth: 720,
      mediaHeight: 1280,
      durationSeconds: vt.durationSeconds,
      likesCount: 0,
      savesCount: 0,
      commentsCount: 0,
    });
  }

  const insertedVideos = await PostModel.insertMany(videoDocs);
  console.log(
    `Inserted ${String(insertedVideos.length)} video seed post(s) from ${String(
      VIDEO_AUTHOR_SEED_NUMBERS.length,
    )} author(s).`,
  );

  await disconnectDb();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
