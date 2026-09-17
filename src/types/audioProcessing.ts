export type AudioProcessingStatus = 'not_required' | 'processing' | 'ready' | 'failed';

export type AudioQuality = 'low' | 'medium' | 'high';

export type AudioVariant = {
  quality: AudioQuality;
  bitrateKbps: number;
  url: string;
};
