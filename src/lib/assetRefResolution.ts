import type { ContentRef } from "../types/vault";

export function resolveAssetBlobRef(ref: ContentRef | undefined, currentRefs: ContentRef[] | undefined): ContentRef | undefined {
  if (!ref?.checksum) return ref;
  return currentRefs?.find((candidate) => candidate.checksum === ref.checksum) ?? ref;
}

