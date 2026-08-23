import type { Attachment, InlineImage } from "../types/vault";

export const MEDIA_COMPRESSION_PROFILE_VERSION = 1;

const STILL_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/apng",
  "image/avif",
]);

export type MediaAsset = Attachment | InlineImage;

export function isOptimizableMediaMime(mimeType: string): boolean {
  const mime = mimeType.toLowerCase();
  return STILL_IMAGE_MIME_TYPES.has(mime) || mime.startsWith("audio/") || mime.startsWith("video/");
}

export function hasCurrentMediaCompression(asset: MediaAsset): boolean {
  return asset.compressionState === "processed"
    && asset.compression?.profileVersion === MEDIA_COMPRESSION_PROFILE_VERSION
    && !!asset.compression.sourceHash
    && !!asset.compression.outputHash;
}

export function needsMediaMigration(asset: MediaAsset): boolean {
  return isOptimizableMediaMime(asset.mimeType) && !hasCurrentMediaCompression(asset);
}

export function decodedBase64Size(value: string): number {
  if (!value) return 0;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor(value.length * 3 / 4) - padding;
}
