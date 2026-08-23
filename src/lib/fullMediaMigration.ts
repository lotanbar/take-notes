import { findNode, flattenTree } from "./treeOps";
import { useVaultStore } from "../store/vaultStore";
import type { Attachment, InlineImage, NodeContent } from "../types/vault";
import {
  enqueueAttachmentOptimization,
  getAttachmentOptimizationSnapshot,
  retryFailedAttachmentOptimizations,
  waitForAttachmentOptimizations,
} from "./attachmentOptimization";
import {
  enqueueExistingInlineImage,
  getInlineImageOptimizationSnapshot,
  retryInlineImageOptimizations,
  waitForInlineImageOptimizations,
} from "../editor/inlineImageOptimization";
import {
  decodedBase64Size,
  hasCurrentMediaCompression,
  isOptimizableMediaMime,
  MEDIA_COMPRESSION_PROFILE_VERSION,
  needsMediaMigration,
  type MediaAsset,
} from "./mediaMigrationPolicy";

export type FullMediaMigrationPhase = "idle" | "scanning" | "waiting-password" | "optimizing" | "verifying" | "completed" | "failed";

export interface FullMediaMigrationSnapshot {
  phase: FullMediaMigrationPhase;
  totalNotes: number;
  scannedNotes: number;
  totalAttachments: number;
  totalInlineImages: number;
  eligibleMedia: number;
  queuedMedia: number;
  verifiedMedia: number;
  convertedMedia: number;
  preservedMedia: number;
  unsupportedAttachments: number;
  lockedRemaining: number;
  nextLockedNoteId: string | null;
  beforeBytes: number;
  afterBytes: number;
  savedBytes: number;
  error: string | null;
  version: number;
}

const EMPTY: FullMediaMigrationSnapshot = {
  phase: "idle",
  totalNotes: 0,
  scannedNotes: 0,
  totalAttachments: 0,
  totalInlineImages: 0,
  eligibleMedia: 0,
  queuedMedia: 0,
  verifiedMedia: 0,
  convertedMedia: 0,
  preservedMedia: 0,
  unsupportedAttachments: 0,
  lockedRemaining: 0,
  nextLockedNoteId: null,
  beforeBytes: 0,
  afterBytes: 0,
  savedBytes: 0,
  error: null,
  version: 0,
};

const listeners = new Set<() => void>();
const scannedNoteIds = new Set<string>();
let snapshot = EMPTY;
let migrationVaultSalt: string | null = null;
let continuing: Promise<void> | null = null;

function publish(update: Partial<FullMediaMigrationSnapshot>): void {
  snapshot = { ...snapshot, ...update, version: snapshot.version + 1 };
  for (const listener of listeners) listener();
}

export function subscribeFullMediaMigration(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getFullMediaMigrationSnapshot(): FullMediaMigrationSnapshot {
  return snapshot;
}

async function hashB64(value: string): Promise<string> {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function markExistingAvifProcessed<T extends MediaAsset>(asset: T): Promise<T> {
  const sourceSize = decodedBase64Size(asset.data);
  const sourceHash = await hashB64(asset.data);
  return {
    ...asset,
    size: sourceSize,
    pendingOptimization: false,
    compressionState: "processed",
    originalMimeType: asset.originalMimeType ?? asset.mimeType,
    compression: {
      codec: "original",
      profileVersion: MEDIA_COMPRESSION_PROFILE_VERSION,
      sourceHash,
      outputHash: sourceHash,
      sourceSize,
      outputSize: sourceSize,
    },
  };
}

async function markPending(content: NodeContent): Promise<{ content: NodeContent; attachments: Attachment[]; inlineImages: InlineImage[]; changedMedia: number }> {
  const attachments: Attachment[] = [];
  const inlineImages: InlineImage[] = [];
  const nextAttachments = await Promise.all(content.attachments.map(async (asset) => {
    if (!needsMediaMigration(asset)) return asset;
    if (asset.mimeType.toLowerCase() === "image/avif") return markExistingAvifProcessed(asset);
    const pending = { ...asset, compressionState: "pending" as const };
    attachments.push(pending);
    return pending;
  }));
  const nextInlineImages = await Promise.all(content.inlineImages.map(async (asset) => {
    if (!needsMediaMigration(asset)) return asset;
    if (asset.mimeType.toLowerCase() === "image/avif") return markExistingAvifProcessed(asset);
    const pending = { ...asset, pendingOptimization: true, compressionState: "pending" as const };
    inlineImages.push(pending);
    return pending;
  }));
  const changedMedia = [...content.attachments, ...content.inlineImages].filter(needsMediaMigration).length;
  return { content: { ...content, attachments: nextAttachments, inlineImages: nextInlineImages }, attachments, inlineImages, changedMedia };
}

async function verifyAsset(asset: MediaAsset): Promise<{ before: number; after: number; converted: boolean }> {
  if (!hasCurrentMediaCompression(asset) || !asset.compression) throw new Error(`Media ${asset.id} has no verified compression result.`);
  if (!asset.data) throw new Error(`Media ${asset.id} could not be read back from the vault.`);
  const actualSize = decodedBase64Size(asset.data);
  const actualHash = await hashB64(asset.data);
  if (actualSize !== asset.size || actualSize !== asset.compression.outputSize) throw new Error(`Media ${asset.id} has a size mismatch.`);
  if (actualHash !== asset.compression.outputHash) throw new Error(`Media ${asset.id} has a checksum mismatch.`);
  if (asset.compression.profileVersion !== MEDIA_COMPRESSION_PROFILE_VERSION) throw new Error(`Media ${asset.id} uses an unsupported compression profile.`);
  const codec = asset.compression.codec;
  if (codec === "avif-q35" && asset.mimeType !== "image/avif") throw new Error(`Media ${asset.id} has invalid AVIF metadata.`);
  if (codec === "opus-24k-mono" && asset.mimeType !== "audio/opus") throw new Error(`Media ${asset.id} has invalid Opus metadata.`);
  if (codec === "av1-webm-720p15" && asset.mimeType !== "video/webm") throw new Error(`Media ${asset.id} has invalid AV1 metadata.`);
  if (codec === "original" && asset.compression.sourceHash !== asset.compression.outputHash) throw new Error(`Media ${asset.id} did not preserve its original bytes.`);
  return { before: asset.compression.sourceSize, after: actualSize, converted: codec !== "original" };
}

async function verifyEntireLibrary(): Promise<void> {
  publish({ phase: "verifying", verifiedMedia: 0 });
  const store = useVaultStore.getState();
  if (!store.vault) throw new Error("The vault was closed during media verification.");
  let verifiedMedia = 0;
  let convertedMedia = 0;
  let preservedMedia = 0;
  let beforeBytes = 0;
  let afterBytes = 0;
  for (const node of flattenTree(store.vault.tree)) {
    if (node.type !== "file" || !node.contentRef) continue;
    const content = await useVaultStore.getState().loadNodeContent(node.id);
    if (!content) throw new Error(`Locked note \"${node.name}\" was not available for final verification.`);
    for (const asset of [...content.attachments, ...content.inlineImages]) {
      if (!isOptimizableMediaMime(asset.originalMimeType ?? asset.mimeType)) continue;
      const result = await verifyAsset(asset);
      verifiedMedia += 1;
      convertedMedia += result.converted ? 1 : 0;
      preservedMedia += result.converted ? 0 : 1;
      beforeBytes += result.before;
      afterBytes += result.after;
      publish({ verifiedMedia, convertedMedia, preservedMedia, beforeBytes, afterBytes, savedBytes: Math.max(0, beforeBytes - afterBytes) });
    }
  }
  publish({
    phase: "completed",
    verifiedMedia,
    convertedMedia,
    preservedMedia,
    beforeBytes,
    afterBytes,
    savedBytes: Math.max(0, beforeBytes - afterBytes),
    error: null,
  });
}

async function scanUnlockedNotes(): Promise<void> {
  const store = useVaultStore.getState();
  const vault = store.vault;
  if (!vault || vault.salt !== migrationVaultSalt) throw new Error("The vault changed during the media scan.");
  const notes = flattenTree(vault.tree).filter((node) => node.type === "file");
  publish({ phase: "scanning", totalNotes: notes.length, nextLockedNoteId: null, lockedRemaining: 0 });
  for (const node of notes) {
    if (scannedNoteIds.has(node.id)) continue;
    const currentStore = useVaultStore.getState();
    const currentNode = currentStore.vault ? findNode(currentStore.vault.tree, node.id) : undefined;
    if (!currentNode) continue;
    if (currentNode.locked && !currentStore.sessionUnlockedIds.has(node.id)) continue;
    const content = await currentStore.loadNodeContent(node.id);
    if (!content) continue;
    const prepared = await markPending(content);
    const queued = prepared.attachments.length + prepared.inlineImages.length;
    if (prepared.changedMedia > 0) await useVaultStore.getState().saveNodeContent(node.id, prepared.content);
    scannedNoteIds.add(node.id);
    publish({
      scannedNotes: scannedNoteIds.size,
      totalAttachments: snapshot.totalAttachments + content.attachments.length,
      totalInlineImages: snapshot.totalInlineImages + content.inlineImages.length,
      eligibleMedia: snapshot.eligibleMedia + [...content.attachments, ...content.inlineImages].filter((asset) => isOptimizableMediaMime(asset.originalMimeType ?? asset.mimeType)).length,
      queuedMedia: snapshot.queuedMedia + queued,
      unsupportedAttachments: snapshot.unsupportedAttachments + content.attachments.filter((asset) => !isOptimizableMediaMime(asset.mimeType)).length,
    });
    for (const attachment of prepared.attachments) enqueueAttachmentOptimization(node.id, attachment);
    for (const image of prepared.inlineImages) enqueueExistingInlineImage(node.id, image);
  }
  const latest = useVaultStore.getState();
  const locked = latest.vault
    ? flattenTree(latest.vault.tree).filter((node) => node.type === "file" && !scannedNoteIds.has(node.id) && node.locked && !latest.sessionUnlockedIds.has(node.id))
    : [];
  if (locked.length > 0) {
    publish({ phase: "waiting-password", lockedRemaining: locked.length, nextLockedNoteId: locked[0].id });
    if (!latest.pending) await latest.toggleNodeLock(locked[0].id);
    return;
  }
  publish({ phase: "optimizing", lockedRemaining: 0, nextLockedNoteId: null });
  await Promise.all([waitForInlineImageOptimizations(), waitForAttachmentOptimizations()]);
  await verifyEntireLibrary();
}

function runContinuation(): Promise<void> {
  if (continuing) return continuing;
  continuing = scanUnlockedNotes()
    .catch((error) => publish({ phase: "failed", error: String(error) }))
    .finally(() => { continuing = null; });
  return continuing;
}

export function startFullMediaMigration(): Promise<void> {
  const vault = useVaultStore.getState().vault;
  if (!vault) return Promise.reject(new Error("Open a vault first."));
  migrationVaultSalt = vault.salt;
  scannedNoteIds.clear();
  snapshot = { ...EMPTY, phase: "scanning", version: snapshot.version + 1 };
  for (const listener of listeners) listener();
  return runContinuation();
}

export function continueFullMediaMigration(): Promise<void> {
  if (snapshot.phase !== "waiting-password" || useVaultStore.getState().pending) return Promise.resolve();
  return runContinuation();
}

export async function retryFullMediaMigration(): Promise<void> {
  if (snapshot.phase !== "failed") return;
  retryFailedAttachmentOptimizations();
  await retryInlineImageOptimizations();
  publish({ phase: "optimizing", error: null });
  try {
    await Promise.all([waitForInlineImageOptimizations(), waitForAttachmentOptimizations()]);
    await verifyEntireLibrary();
  } catch (error) {
    publish({ phase: "failed", error: String(error) });
  }
}

export function dismissFullMediaMigration(): void {
  if (["completed", "failed", "waiting-password"].includes(snapshot.phase)) {
    publish({ phase: "idle", error: null, nextLockedNoteId: null });
  }
}

export function getCurrentOptimizationCount(): number {
  return getAttachmentOptimizationSnapshot().pendingCount + getInlineImageOptimizationSnapshot().pendingCount;
}
