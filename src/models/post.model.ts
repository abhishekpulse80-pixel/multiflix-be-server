import mongoose, { Schema, type Model } from 'mongoose';

/** One feed item: single image or short video (matches upload `category` image | video). */
export type PostMediaKind = 'image' | 'short_video';

/** Same shape as `uploadOneBuffer` → `UploadedFileMeta` (single asset per post). */
export interface IPostMedia {
  key: string;
  bucket: string;
  contentType: string;
  size: number;
  originalName: string;
  url: string | null;
}

export interface IPost {
  author: mongoose.Types.ObjectId;
  mediaKind: PostMediaKind;
  media: IPostMedia;
  /** Auto-generated poster image URL for video posts. */
  thumbnailUrl?: string | null;
  caption: string | null;
  hashtags: string | null;
  /** Display-only music label (legacy + auto-derived from track when set). */
  musicTitle: string | null;
  /**
   * Optional curated music track attached to the post. When set,
   * `musicTrimStartMs` defines the playback offset within the track.
   */
  musicTrack: mongoose.Types.ObjectId | null;
  /** Start offset (ms) of the audio window within the source track. */
  musicTrimStartMs: number | null;
  /**
   * True if the uploader chose to mute the original video audio. Players
   * use this to mute the source clip regardless of any attached music
   * track. Defaults to false so legacy posts behave as before.
   */
  originalAudioMuted: boolean;
  /**
   * Back-link to the extracted `OriginalSound`, set by the worker once the
   * audio is published. Null while the job is pending or if extraction
   * failed / was skipped (e.g. uploader muted original audio).
   */
  originalSoundId: mongoose.Types.ObjectId | null;
  /**
   * Optional `OriginalSound` attached at upload time when the user picks
   * a creator's sound from the picker. Mutually exclusive with
   * `musicTrack`. Selecting this source bumps `OriginalSound.usesCount`.
   */
  attachedOriginalSound: mongoose.Types.ObjectId | null;
  mediaWidth: number | null;
  mediaHeight: number | null;
  durationSeconds: number | null;
  likesCount: number;
  savesCount: number;
  commentsCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const mediaSchema = new Schema<IPostMedia>(
  {
    key: { type: String, required: true },
    bucket: { type: String, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true, min: 0 },
    originalName: { type: String, required: true },
    url: { type: String, default: null },
  },
  { _id: false },
);

const postSchema = new Schema<IPost>(
  {
    author: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    mediaKind: {
      type: String,
      required: true,
      enum: ['image', 'short_video'],
    },
    media: { type: mediaSchema, required: true },
    thumbnailUrl: { type: String, default: null },
    caption: { type: String, default: null, maxlength: 4000 },
    hashtags: { type: String, default: null, maxlength: 2000 },
    musicTitle: { type: String, default: null, maxlength: 512 },
    musicTrack: {
      type: Schema.Types.ObjectId,
      ref: 'MusicTrack',
      default: null,
      index: true,
    },
    musicTrimStartMs: { type: Number, default: null, min: 0 },
    originalAudioMuted: { type: Boolean, default: false },
    originalSoundId: {
      type: Schema.Types.ObjectId,
      ref: 'OriginalSound',
      default: null,
      index: true,
    },
    attachedOriginalSound: {
      type: Schema.Types.ObjectId,
      ref: 'OriginalSound',
      default: null,
      index: true,
    },
    mediaWidth: { type: Number, default: null, min: 1 },
    mediaHeight: { type: Number, default: null, min: 1 },
    durationSeconds: { type: Number, default: null, min: 0 },
    likesCount: { type: Number, default: 0, min: 0 },
    savesCount: { type: Number, default: 0, min: 0 },
    commentsCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

postSchema.index({ createdAt: -1, _id: -1 });
postSchema.index({ author: 1, createdAt: -1 });

postSchema.pre('validate', function (next) {
  if (this.mediaKind === 'image' && this.durationSeconds != null) {
    this.invalidate(
      'durationSeconds',
      'durationSeconds must be unset for image posts',
    );
  }
  if (this.musicTrack != null && this.attachedOriginalSound != null) {
    this.invalidate(
      'attachedOriginalSound',
      'A post can attach a curated track or an OriginalSound, not both',
    );
  }
  next();
});

export const PostModel: Model<IPost> =
  (mongoose.models.Post as Model<IPost> | undefined) ??
  mongoose.model<IPost>('Post', postSchema);
