/** Sponsored row in `GET /posts/feed` — admin/CMS can replace seeded payloads later. */
export type SponsoredAdDto = {
  id: string;
  imageUrl: string;
  avatarUrl: string | null;
  brandName: string;
  handle: string;
  caption: string;
  hashtags: string | null;
  targetUrl: string;
  ctaLabel: string;
};
