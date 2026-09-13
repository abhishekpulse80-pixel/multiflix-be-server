import { StoryModel } from '../models/story.model.js';

export function startStoryStatusCron() {
  console.log('[Cron] Started story status cron job (runs every 5 minutes)');
  
  // Run every 5 mins (300,000 ms)
  setInterval(() => {
    expireOldStories().catch((err) => {
      console.error('[Cron] Error running expireOldStories:', err);
    });
  }, 5 * 60 * 1000);
}

async function expireOldStories() {
  const now = new Date();
  
  // Find stories that are active but their expiry time has passed
  const result = await StoryModel.updateMany(
    {
      isActive: true,
      expiresAt: { $lte: now }
    },
    {
      $set: { isActive: false }
    }
  );

  if (result.modifiedCount > 0) {
    console.log(`[Cron] Marked ${result.modifiedCount} stories as inactive (expired).`);
  }
}
