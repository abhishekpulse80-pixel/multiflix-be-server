import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import type { IBlog } from '../models/blog.model.js';
import { BlogModel } from '../models/blog.model.js';
import { UserModel } from '../models/user.model.js';

/** Same convention as `seedPosts.ts` — re-runs only replace these rows. */
const SEED_VIDEO_MARKER = '__seed_blog__';

/** Authors: seed user emails `multiflix.seed.NN@multiflix.test` */
const AUTHOR_SEED_NUMBERS = [1, 3, 5, 8, 12] as const;

function seedEmail(n: number): string {
  return `multiflix.seed.${String(n).padStart(2, '0')}@multiflix.test`.toLowerCase();
}

/** Public sample MP4 (W3Schools Big Buck Bunny clip, ~10 s). */
const SAMPLE_VIDEOS = [
  'https://www.w3schools.com/html/mov_bbb.mp4',
] as const;

const BLOG_BLUEPRINTS: Omit<
  IBlog,
  | 'author'
  | 'createdAt'
  | 'updatedAt'
  | 'videoUrl'
  | 'thumbnailUrl'
  | 'viewsCount'
  | 'videoKey'
  | 'mediaProcessingStatus'
  | 'hlsUrl'
  | 'hlsVariants'
  | 'mediaProcessingError'
>[] = [
  {
    title: 'Building a calm creative routine',
    description:
      'Weekly habits, deep work blocks, and why boring systems beat motivation spikes.',
    durationSeconds: 10,
    tags: ['creativity', 'productivity', 'podcast'],
    status: 'published',
    publishedAt: new Date('2026-03-01T10:00:00.000Z'),
  },
  {
    title: 'Film scores that changed how we hear stories',
    description:
      'From leitmotifs to silence — a long listen with scene breakdowns.',
    durationSeconds: 10,
    tags: ['film', 'music', 'analysis'],
    status: 'published',
    publishedAt: new Date('2026-03-08T15:30:00.000Z'),
  },
  {
    title: 'Indie dev diary: shipping v0.1',
    description:
      'Scope creep, test users, and the one feature we cut at the last minute.',
    durationSeconds: 10,
    tags: ['startup', 'engineering', 'story'],
    status: 'published',
    publishedAt: new Date('2026-03-12T09:00:00.000Z'),
  },
  {
    title: 'Nutrition myths — office hours (live Q&A)',
    description:
      'Audience questions on protein, sleep, and caffeine timing.',
    durationSeconds: 10,
    tags: ['health', 'qna'],
    status: 'published',
    publishedAt: new Date('2026-03-15T18:00:00.000Z'),
  },
  {
    title: 'Draft: upcoming season trailer',
    description: 'Placeholder episode — not published yet.',
    durationSeconds: 10,
    tags: ['trailer', 'draft'],
    status: 'draft',
    publishedAt: null,
  },
];

async function main(): Promise<void> {
  await connectDb();

  const emails = [...AUTHOR_SEED_NUMBERS].map((n) => seedEmail(n));
  const users = await UserModel.find({ email: { $in: emails } })
    .select({ _id: 1, email: 1 })
    .lean();

  if (users.length !== emails.length) {
    const found = new Set(users.map((u) => u.email));
    const missing = emails.filter((e) => !found.has(e));
    console.error(
      'Missing seed user(s). Run `pnpm seed:users` first. Not found:',
      missing.join(', '),
    );
    process.exit(1);
  }

  const byEmail = new Map(users.map((u) => [u.email, String(u._id)] as const));

  const del = await BlogModel.deleteMany({
    videoUrl: { $regex: SEED_VIDEO_MARKER },
  });
  console.log(`Removed ${String(del.deletedCount)} previous seed blog(s).`);

  type BlogInsert = Omit<IBlog, 'createdAt' | 'updatedAt'>;
  const docs: BlogInsert[] = [];

  BLOG_BLUEPRINTS.forEach((bp, idx) => {
    const authorN = AUTHOR_SEED_NUMBERS[idx % AUTHOR_SEED_NUMBERS.length];
    const email = seedEmail(authorN);
    const userId = byEmail.get(email);
    if (userId === undefined) {
      throw new Error(`Internal: missing user id for ${email}`);
    }
    const slug = `blog-${String(idx + 1).padStart(2, '0')}`;
    const baseVideo = SAMPLE_VIDEOS[idx % SAMPLE_VIDEOS.length];
    const join = baseVideo.includes('?') ? '&' : '?';
    const videoUrl = `${baseVideo}${join}${SEED_VIDEO_MARKER}=${slug}`;

    docs.push({
      ...bp,
      author: new mongoose.Types.ObjectId(userId),
      thumbnailUrl: `https://picsum.photos/seed/multiflix-blog-${slug}/1280/720`,
      videoUrl,
      videoKey: videoUrl,
      mediaProcessingStatus: 'not_required',
      hlsUrl: null,
      hlsVariants: [],
      mediaProcessingError: null,
      viewsCount: 0,
    });
  });

  const inserted = await BlogModel.insertMany(docs);
  console.log(`Inserted ${String(inserted.length)} seed blog(s).`);

  await disconnectDb();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
