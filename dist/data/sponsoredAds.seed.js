/**
 * Static sponsored slots until an admin/CMS source exists.
 * Replace `targetUrl` values with real campaign links when available.
 */
export const SEEDED_SPONSORED_ADS = [
    {
        id: 'ad_seed_streampremium',
        imageUrl: 'https://images.unsplash.com/photo-1522869635100-9f4c5e86aa37?w=1080&q=80',
        avatarUrl: null,
        brandName: 'StreamPremium',
        handle: 'streampremium',
        caption: 'Binge the hits. One low price.',
        hashtags: '#streaming #deal',
        targetUrl: 'https://www.netflix.com',
        ctaLabel: 'Start watching',
    },
    {
        id: 'ad_seed_soundwave',
        imageUrl: 'https://images.unsplash.com/photo-1470225620780-dba8b36bb745?w=1080&q=80',
        avatarUrl: null,
        brandName: 'SoundWave Pro',
        handle: 'soundwavepro',
        caption: 'Studio sound. Anywhere.',
        hashtags: '#music #audio',
        targetUrl: 'https://open.spotify.com',
        ctaLabel: 'Try free',
    },
];
