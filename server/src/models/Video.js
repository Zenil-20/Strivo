import mongoose from 'mongoose';
import { SUPPORTED_MIME_TYPES } from '../utils/videoFormats.js';

// MongoDB stores only METADATA. The video bytes live on disk in storage/videos/.
const videoSchema = new mongoose.Schema(
  {
    // Public, random, unguessable ID used in the share URL. `unique` also creates an index,
    // so looking a video up by shareId is fast.
    shareId: { type: String, required: true, unique: true },
    title: { type: String, required: true, trim: true, maxlength: 100 },
    // Only for display. Never used to build a filesystem path.
    originalName: { type: String, required: true, maxlength: 255 },
    // Server-generated UUID filename, e.g. "550e8400-...-446655440000.mp4".
    storedName: { type: String, required: true, unique: true },
    mimeType: { type: String, required: true, enum: SUPPORTED_MIME_TYPES },
    size: { type: Number, required: true, min: 1 },
    // processing = being converted to a TV-friendly MP4; failed = conversion failed
    // (the original file is kept and can still be downloaded).
    status: { type: String, enum: ['processing', 'ready', 'failed'], default: 'ready', index: true },
    progress: { type: Number, min: 0, max: 100, default: 100 },
    // Text subtitle tracks extracted from the video as WebVTT files ("<uuid>.vtt" in storage).
    subtitles: {
      type: [
        {
          _id: false,
          file: { type: String, required: true },
          language: { type: String, maxlength: 8 }, // ISO 639-1 for <track srclang>, "und" if unknown
          label: { type: String, maxlength: 60 },
        },
      ],
      default: [],
    },
    // SHA-256 of the uploader's delete token. Excluded from queries by default.
    deleteTokenHash: { type: String, required: true, select: false },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

// The only shape that ever leaves the server: no storage path, no stored filename, no hash.
videoSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this.shareId,
    title: this.title,
    originalName: this.originalName,
    size: this.size,
    mimeType: this.mimeType,
    status: this.status,
    progress: this.progress,
    // Index + language + label only: the stored .vtt filename stays internal.
    subtitles: (this.subtitles ?? []).map((s, index) => ({ index, language: s.language, label: s.label })),
    createdAt: this.createdAt,
  };
};

export const Video = mongoose.model('Video', videoSchema);
