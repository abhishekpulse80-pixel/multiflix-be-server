import 'dotenv/config';
import type { Model } from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import { env } from '../config/env.js';

import { ArtistModel } from '../models/artist.model.js';
import { BlogModel } from '../models/blog.model.js';
import { BlogFavoriteModel } from '../models/blogFavorite.model.js';
import { CommentModel } from '../models/comment.model.js';
import { ConversationModel } from '../models/conversation.model.js';
import { FeedbackModel } from '../models/feedback.model.js';
import { FollowModel } from '../models/follow.model.js';
import { MessageModel } from '../models/message.model.js';
import { MusicAlbumModel } from '../models/musicAlbum.model.js';
import { MusicTrackModel } from '../models/musicTrack.model.js';
import { MusicTrackFavouriteModel } from '../models/musicTrackFavourite.model.js';
import { NotificationModel } from '../models/notification.model.js';
import { OriginalSoundModel } from '../models/originalSound.model.js';
import { PostModel } from '../models/post.model.js';
import { PostLikeModel } from '../models/postLike.model.js';
import { PostSaveModel } from '../models/postSave.model.js';
import { PostViewModel } from '../models/postView.model.js';
import { ReportModel } from '../models/report.model.js';
import { StoryModel } from '../models/story.model.js';
import { StoryReactionModel } from '../models/storyReaction.model.js';
import { StoryViewModel } from '../models/storyView.model.js';
import { TransactionModel } from '../models/transaction.model.js';
import { UserModel } from '../models/user.model.js';
import { UserBlockModel } from '../models/userBlock.model.js';
import { WithdrawalRequestModel } from '../models/withdrawalRequest.model.js';

/**
 * One-shot destructive wipe ahead of the Open Music migration / Apple
 * re-submission. Deletes:
 *   - all users (admin must be re-seeded with `npm run seed:admin`)
 *   - every collection that references users
 *   - all music data (artist / album / track) so we can re-seed with the
 *     open-music catalogue
 *
 * Preserves admin-managed config: AppSetting, EarningRate, Ad.
 *
 * Safety: requires `--yes` (or WIPE_CONFIRM=YES env) to actually run.
 */

const COLLECTIONS: Array<[string, Model<unknown>]> = [
  ['posts', PostModel as unknown as Model<unknown>],
  ['postLikes', PostLikeModel as unknown as Model<unknown>],
  ['postSaves', PostSaveModel as unknown as Model<unknown>],
  ['postViews', PostViewModel as unknown as Model<unknown>],
  ['comments', CommentModel as unknown as Model<unknown>],
  ['follows', FollowModel as unknown as Model<unknown>],
  ['userBlocks', UserBlockModel as unknown as Model<unknown>],
  ['conversations', ConversationModel as unknown as Model<unknown>],
  ['messages', MessageModel as unknown as Model<unknown>],
  ['notifications', NotificationModel as unknown as Model<unknown>],
  ['stories', StoryModel as unknown as Model<unknown>],
  ['storyViews', StoryViewModel as unknown as Model<unknown>],
  ['storyReactions', StoryReactionModel as unknown as Model<unknown>],
  ['transactions', TransactionModel as unknown as Model<unknown>],
  ['withdrawalRequests', WithdrawalRequestModel as unknown as Model<unknown>],
  ['feedback', FeedbackModel as unknown as Model<unknown>],
  ['reports', ReportModel as unknown as Model<unknown>],
  ['blogs', BlogModel as unknown as Model<unknown>],
  ['blogFavorites', BlogFavoriteModel as unknown as Model<unknown>],
  ['originalSounds', OriginalSoundModel as unknown as Model<unknown>],
  ['musicTrackFavourites', MusicTrackFavouriteModel as unknown as Model<unknown>],
  ['musicTracks', MusicTrackModel as unknown as Model<unknown>],
  ['musicAlbums', MusicAlbumModel as unknown as Model<unknown>],
  ['artists', ArtistModel as unknown as Model<unknown>],
  ['users', UserModel as unknown as Model<unknown>],
];

function isConfirmed(): boolean {
  if (process.argv.includes('--yes')) return true;
  if ((process.env.WIPE_CONFIRM ?? '').toUpperCase() === 'YES') return true;
  return false;
}

async function main(): Promise<void> {
  if (!isConfirmed()) {
    console.error(
      'Refusing to wipe: pass --yes (or set WIPE_CONFIRM=YES) to confirm.',
    );
    process.exit(1);
  }

  console.log(`Connecting to ${env.mongodbUri.replace(/\/\/.*@/, '//***@')}`);
  await connectDb();

  try {
    for (const [name, Model] of COLLECTIONS) {
      const res = await Model.deleteMany({});
      console.log(
        `  ${name.padEnd(22)} deleted ${String(res.deletedCount)} doc(s)`,
      );
    }
    console.log('Wipe complete. Run `npm run seed:admin` to re-create admin.');
  } finally {
    await disconnectDb();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
