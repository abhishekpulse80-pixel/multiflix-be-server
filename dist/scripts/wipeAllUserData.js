import 'dotenv/config';
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
const COLLECTIONS = [
    ['posts', PostModel],
    ['postLikes', PostLikeModel],
    ['postSaves', PostSaveModel],
    ['postViews', PostViewModel],
    ['comments', CommentModel],
    ['follows', FollowModel],
    ['userBlocks', UserBlockModel],
    ['conversations', ConversationModel],
    ['messages', MessageModel],
    ['notifications', NotificationModel],
    ['stories', StoryModel],
    ['storyViews', StoryViewModel],
    ['storyReactions', StoryReactionModel],
    ['transactions', TransactionModel],
    ['withdrawalRequests', WithdrawalRequestModel],
    ['feedback', FeedbackModel],
    ['reports', ReportModel],
    ['blogs', BlogModel],
    ['blogFavorites', BlogFavoriteModel],
    ['originalSounds', OriginalSoundModel],
    ['musicTrackFavourites', MusicTrackFavouriteModel],
    ['musicTracks', MusicTrackModel],
    ['musicAlbums', MusicAlbumModel],
    ['artists', ArtistModel],
    ['users', UserModel],
];
function isConfirmed() {
    if (process.argv.includes('--yes'))
        return true;
    if ((process.env.WIPE_CONFIRM ?? '').toUpperCase() === 'YES')
        return true;
    return false;
}
async function main() {
    if (!isConfirmed()) {
        console.error('Refusing to wipe: pass --yes (or set WIPE_CONFIRM=YES) to confirm.');
        process.exit(1);
    }
    console.log(`Connecting to ${env.mongodbUri.replace(/\/\/.*@/, '//***@')}`);
    await connectDb();
    try {
        for (const [name, Model] of COLLECTIONS) {
            const res = await Model.deleteMany({});
            console.log(`  ${name.padEnd(22)} deleted ${String(res.deletedCount)} doc(s)`);
        }
        console.log('Wipe complete. Run `npm run seed:admin` to re-create admin.');
    }
    finally {
        await disconnectDb();
    }
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
