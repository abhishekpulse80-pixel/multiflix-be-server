import type { TranscodeQuality } from '../services/transcoding.service.js';

export type MediaProcessingStatus = 'not_required' | 'processing' | 'ready' | 'failed';

export type MediaProcessingVariant = {
  quality: TranscodeQuality;
  width: number;
  height: number;
  bitrateKbps: number;
  playlistUrl: string;
};
