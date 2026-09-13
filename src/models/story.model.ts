import mongoose, { Schema, type Model } from 'mongoose';

/** A story is a single image or short-video asset that expires after 24 h. */
export type StoryMediaKind = 'image' | 'short_video';

export interface IStoryMedia {
  key: string;
  bucket: string;
  contentType: string;
  size: number;
  originalName: string;
  url: string | null;
}

/**
 * Pinch-to-zoom + pan transform applied to the story media in the editor.
 * Saved so the viewer renders the same framing the author chose.
 *
 *  - `scale`     — uniform zoom, 1 = original. Clamped to a sane range.
 *  - `translateX`/`translateY` — pan offsets in screen-independent units,
 *    expressed as a fraction of the canvas width/height (so the same
 *    payload renders consistently across phones with different sizes).
 */
export interface IStoryMediaTransform {
  scale: number;
  translateX: number;
  translateY: number;
}

/**
 * A single user-placed text overlay rendered on top of the story media.
 * `x`/`y` are normalized (0..1) relative to the media frame so the same
 * payload renders consistently across phones with different viewport sizes.
 */
export interface IStoryTextOverlay {
  text: string;
  /** Horizontal center, 0 = left edge, 1 = right edge. */
  x: number;
  /** Vertical center, 0 = top edge, 1 = bottom edge. */
  y: number;
  /** Hex color (e.g. `#FFFFFF`). */
  color: string;
  /** Font size in points. */
  fontSize: number;
}

export interface IStory {
  author: mongoose.Types.ObjectId;
  mediaKind: StoryMediaKind;
  media: IStoryMedia;
  /** Optional soundtrack track name displayed on the story card. */
  soundTitle: string | null;
  /**
   * Optional reference to a curated MusicTrack attached by the author.
   * When set, `musicTrimStartMs` defines the 15s window to play.
   */
  musicTrack: mongoose.Types.ObjectId | null;
  /**
   * Start offset (ms) of the 15s music window within the source track.
   * Always paired with `musicTrack`. Story plays from this offset for 15s.
   */
  musicTrimStartMs: number | null;
  /** Optional caption overlay text. */
  caption: string | null;
  mediaWidth: number | null;
  mediaHeight: number | null;
  durationSeconds: number | null;
  viewsCount: number;
  /** Absolute expiry time — set to `createdAt + 24 h` on create. */
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  isActive: boolean;
  /**
   * When false, the story is excluded from the public trending list.
   * Author-, connections-, and profile-views still include it.
   */
  showInTrending: boolean;
  /** User-placed text overlays rendered on top of the story media. */
  textOverlays: IStoryTextOverlay[];
  /**
   * Optional pinch/pan transform from the editor. Null when the author
   * left the media untouched (treated as identity by the viewer).
   */
  mediaTransform: IStoryMediaTransform | null;
}

const textOverlaySchema = new Schema<IStoryTextOverlay>(
  {
    text: { type: String, required: true, maxlength: 300 },
    x: { type: Number, required: true, min: 0, max: 1 },
    y: { type: Number, required: true, min: 0, max: 1 },
    color: { type: String, default: '#FFFFFF', maxlength: 16 },
    fontSize: { type: Number, default: 24, min: 10, max: 80 },
  },
  { _id: false },
);

const storyMediaSchema = new Schema<IStoryMedia>(
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

const storySchema = new Schema<IStory>(
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
    media: { type: storyMediaSchema, required: true },
    soundTitle: { type: String, default: null, maxlength: 512 },
    musicTrack: {
      type: Schema.Types.ObjectId,
      ref: 'MusicTrack',
      default: null,
      index: true,
    },
    musicTrimStartMs: { type: Number, default: null, min: 0 },
    caption: { type: String, default: null, maxlength: 2000 },
    mediaWidth: { type: Number, default: null, min: 1 },
    mediaHeight: { type: Number, default: null, min: 1 },
    durationSeconds: { type: Number, default: null, min: 0 },
    viewsCount: { type: Number, default: 0, min: 0 },
    expiresAt: { type: Date, required: true },
    isActive: { type: Boolean, default: true },
    showInTrending: { type: Boolean, default: true },
    textOverlays: { type: [textOverlaySchema], default: [] },
    mediaTransform: {
      type: new Schema<IStoryMediaTransform>(
        {
          // Sane upper bound so a malicious / buggy client can't ship a
          // transform that breaks the viewer.
          scale: { type: Number, required: true, min: 0.5, max: 5 },
          translateX: { type: Number, required: true, min: -2, max: 2 },
          translateY: { type: Number, required: true, min: -2, max: 2 },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { timestamps: true },
);

/** Fast lookup of all active stories for a given author (profile ring). */
storySchema.index({ author: 1, expiresAt: 1, isActive: 1 });

/** Feed ordering: newest active stories first. */
storySchema.index({ expiresAt: 1, createdAt: -1, _id: -1, isActive: 1 });

export const StoryModel: Model<IStory> =
  (mongoose.models.Story as Model<IStory> | undefined) ??
  mongoose.model<IStory>('Story', storySchema);
