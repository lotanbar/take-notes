import { invoke } from "@tauri-apps/api/core";
import { findNode, flattenTree } from "../lib/treeOps";
import { useVaultStore } from "../store/vaultStore";
import type { InlineImage, NodeContent } from "../types/vault";
import {
  addInlineImage,
  flushSaveNow,
  getInlineImages,
  getNoteModelState,
  hydratePendingInlineImage,
  replaceInlineImage,
  type NoteModelState,
} from "./noteModel";

const MINIMUM_SAVINGS_RATIO = 0;
const ENCODING_GRACE_MS = 1000;
const OPTIMIZABLE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/apng",
]);
const ANIMATED_MIME_TYPES = new Set(["image/gif", "image/apng"]);
function encodedSize(value: string): number { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)).length; }
async function hashB64(value: string): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(atob(value), (character) => character.charCodeAt(0))))].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function isAnimatedImage(image: InlineImage): boolean {
  if (ANIMATED_MIME_TYPES.has(image.mimeType.toLowerCase())) return true;
  if (image.mimeType.toLowerCase() === "image/webp") {
    try { const header = atob(image.data.slice(0, 4096)); return header.includes("ANIM") || header.includes("ANMF"); } catch { return false; }
  }
  if (image.mimeType.toLowerCase() !== "image/png") return false;
  try { return atob(image.data.slice(0, 4096)).includes("acTL"); } catch { return false; }
}

export type InlineImageOptimizationStatus = "securing" | "queued" | "encoding" | "waiting" | "failed";

interface NativeOptimizedImage {
  mimeType: string;
  size: number;
  data: string;
  width: number;
  height: number;
}

interface PendingImageEntry {
  noteId: string;
  imageId: string;
}

interface OptimizationJob {
  vaultKey: string;
  noteId: string;
  imageId: string;
  source: InlineImage;
  recoveryStored: boolean;
  token: number;
  attempts: number;
}

export interface OptimizationSnapshot {
  pendingCount: number;
  activeCount: number;
  failedCount: number;
  version: number;
}

const jobs = new Map<string, OptimizationJob>();
const statuses = new Map<string, InlineImageOptimizationStatus>();
const listeners = new Set<() => void>();
const cancelledIds = new Set<string>();
const scannedNoteIds = new Set<string>();
let queue: string[] = [];
let processing: Promise<void> | null = null;
let currentVaultKey: string | null = null;
let vaultToken = 0;
let snapshot: OptimizationSnapshot = { pendingCount: 0, activeCount: 0, failedCount: 0, version: 0 };

function publish(): void {
  snapshot = {
    pendingCount: statuses.size,
    activeCount: [...statuses.values()].filter((status) => status === "securing" || status === "queued" || status === "encoding").length,
    failedCount: [...statuses.values()].filter((status) => status === "failed").length,
    version: snapshot.version + 1,
  };
  for (const listener of listeners) listener();
}

function setStatus(imageId: string, status: InlineImageOptimizationStatus): void {
  statuses.set(imageId, status);
  publish();
}

function clearStatus(imageId: string): void {
  if (statuses.delete(imageId)) publish();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function subscribeInlineImageOptimizations(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getInlineImageOptimizationSnapshot(): OptimizationSnapshot {
  return snapshot;
}

export function getInlineImageOptimizationStatus(imageId: string): InlineImageOptimizationStatus | undefined {
  return statuses.get(imageId);
}

function resetForVault(vaultKey: string | null): void {
  if (currentVaultKey === vaultKey) return;
  currentVaultKey = vaultKey;
  vaultToken += 1;
  jobs.clear();
  statuses.clear();
  cancelledIds.clear();
  scannedNoteIds.clear();
  queue = [];
  publish();
}

function enqueue(job: OptimizationJob): void {
  if (cancelledIds.has(job.imageId) || job.token !== vaultToken || job.vaultKey !== currentVaultKey || jobs.has(job.imageId)) return;
  jobs.set(job.imageId, job);
  queue.push(job.imageId);
  setStatus(job.imageId, "queued");
  if (!processing) {
    processing = processQueue().finally(() => {
      processing = null;
      publish();
    });
  }
}

function replacementContent(content: NodeContent, job: OptimizationJob, replacement: InlineImage): NodeContent | null {
  const index = content.inlineImages.findIndex((image) => image.id === job.imageId);
  if (index < 0 && !job.recoveryStored) return null;
  const inlineImages = [...content.inlineImages];
  if (index < 0) inlineImages.push(replacement);
  else inlineImages[index] = { ...inlineImages[index], ...replacement, at: inlineImages[index].at, width: inlineImages[index].width, height: inlineImages[index].height };
  return { ...content, inlineImages };
}

async function commitReplacement(job: OptimizationJob, replacement: InlineImage): Promise<boolean> {
  if (cancelledIds.has(job.imageId) || job.token !== vaultToken) return false;
  let openState = getNoteModelState(job.noteId);
  for (let attempt = 0; openState && !openState.loaded && attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    openState = getNoteModelState(job.noteId);
  }
  if (openState?.loaded) {
    const replaced = replaceInlineImage(openState, job.imageId, replacement);
    if (!replaced && job.recoveryStored) {
      addInlineImage(openState, { ...replacement, pendingOptimization: false });
    } else if (!replaced) {
      return false;
    }
    await flushSaveNow(job.noteId);
    return true;
  }

  const store = useVaultStore.getState();
  const content = await store.loadNodeContent(job.noteId);
  if (!content) return false;
  const latestOpenState = getNoteModelState(job.noteId);
  if (latestOpenState?.loaded) return commitReplacement(job, replacement);
  const next = replacementContent(content, job, replacement);
  if (!next) return false;
  await store.saveNodeContent(job.noteId, next);
  return true;
}

async function finishJob(job: OptimizationJob, optimized: NativeOptimizedImage): Promise<void> {
  const targetCodec = isAnimatedImage(job.source) ? "av1-webm-720p15" : "avif-q35";
  const worthwhile = optimized.size + optimized.mimeType.length + targetCodec.length < Math.floor(job.source.size * (1 - MINIMUM_SAVINGS_RATIO)) + job.source.mimeType.length + "original".length;
  const data = worthwhile ? optimized.data : job.source.data;
  const codec = worthwhile ? targetCodec : "original";
  const compression = {
    codec: codec as "av1-webm-720p15" | "avif-q35" | "original",
    profileVersion: 1,
    sourceHash: await hashB64(job.source.data),
    outputHash: await hashB64(data),
    sourceSize: job.source.size || encodedSize(job.source.data),
    outputSize: worthwhile ? optimized.size : (job.source.size || encodedSize(job.source.data)),
  };
  const replacement: InlineImage = worthwhile
    ? { ...job.source, mimeType: optimized.mimeType, size: optimized.size, data, pendingOptimization: false, compressionState: "processed", originalMimeType: job.source.mimeType, compression }
    : { ...job.source, pendingOptimization: false, compressionState: "processed", originalMimeType: job.source.mimeType, compression };
  const committed = await commitReplacement(job, replacement);
  if (committed && job.recoveryStored) {
    await invoke("pending_image_delete", { vaultKey: job.vaultKey, imageId: job.imageId });
  }
}

async function processQueue(): Promise<void> {
  while (queue.length > 0) {
    const imageId = queue.shift()!;
    const job = jobs.get(imageId);
    if (!job || cancelledIds.has(imageId) || job.token !== vaultToken) continue;
    await delay(ENCODING_GRACE_MS);
    if (!jobs.has(imageId) || cancelledIds.has(imageId) || job.token !== vaultToken) continue;
    setStatus(imageId, "encoding");
    try {
      const optimized = isAnimatedImage(job.source)
        ? await invoke<{ data: string; mimeType: string; outputSize: number }>("optimize_media", { data: job.source.data, mimeType: isAnimatedImage(job.source) && job.source.mimeType === "image/png" ? "image/apng" : job.source.mimeType }).then((result) => ({ ...result, size: result.outputSize, width: job.source.width, height: job.source.height }))
        : await invoke<NativeOptimizedImage>("optimize_inline_image", { data: job.source.data, imageId });
      if (cancelledIds.has(imageId) || job.token !== vaultToken) continue;
      await finishJob(job, optimized);
      jobs.delete(imageId);
      clearStatus(imageId);
    } catch (error) {
      if (cancelledIds.has(imageId) || job.token !== vaultToken) {
        jobs.delete(imageId);
        clearStatus(imageId);
        continue;
      }
      console.error(`Screenshot optimization failed for ${imageId}:`, error);
      job.attempts += 1;
      if (job.attempts < 2 && !cancelledIds.has(imageId)) {
        queue.push(imageId);
        setStatus(imageId, "queued");
      } else {
        setStatus(imageId, "failed");
      }
    }
  }
}

export async function stageInlineImageOptimization(state: NoteModelState, image: InlineImage): Promise<void> {
  if (image.mimeType === "image/avif" || !OPTIMIZABLE_MIME_TYPES.has(image.mimeType.toLowerCase())) {
    addInlineImage(state, image);
    return;
  }
  const vaultKey = useVaultStore.getState().vault?.salt;
  if (!vaultKey) throw new Error("Open a vault before pasting a screenshot.");
  resetForVault(vaultKey);
  const pendingImage = { ...image, pendingOptimization: true, compressionState: "pending" as const };
  setStatus(image.id, "securing");
  addInlineImage(state, pendingImage);
  try {
    const encryptedPayload = await useVaultStore.getState().protectPendingImage(state.fileId, JSON.stringify(image));
    await invoke("pending_image_write", {
      vaultKey,
      noteId: state.fileId,
      imageId: image.id,
      encryptedPayload,
    });
    if (cancelledIds.has(image.id)) {
      await invoke("pending_image_delete", { vaultKey, imageId: image.id });
      clearStatus(image.id);
      return;
    }
    enqueue({
      vaultKey,
      noteId: state.fileId,
      imageId: image.id,
      source: image,
      recoveryStored: true,
      token: vaultToken,
      attempts: 0,
    });
  } catch (error) {
    if (cancelledIds.has(image.id)) {
      clearStatus(image.id);
      return;
    }
    // If the encrypted recovery spool cannot be written, preserve the source
    // in the vault instead of risking a screenshot that disappears on exit.
    replaceInlineImage(state, image.id, image);
    await flushSaveNow(state.fileId);
    clearStatus(image.id);
    throw new Error(`Screenshot recovery could not be prepared; the original was saved unchanged. ${String(error)}`);
  }
}

async function resumePendingEntry(vaultKey: string, entry: PendingImageEntry, token: number): Promise<void> {
  if (jobs.has(entry.imageId) || token !== vaultToken) return;
  const store = useVaultStore.getState();
  const node = store.vault ? findNode(store.vault.tree, entry.noteId) : undefined;
  if (!node) {
    await invoke("pending_image_delete", { vaultKey, imageId: entry.imageId });
    clearStatus(entry.imageId);
    return;
  }
  if (node.locked && !store.sessionUnlockedIds.has(node.id)) {
    setStatus(entry.imageId, "waiting");
    return;
  }
  try {
    const encryptedPayload = await invoke<string>("pending_image_read", { vaultKey, imageId: entry.imageId });
    const plaintext = await store.unprotectPendingImage(entry.noteId, encryptedPayload);
    const source = JSON.parse(plaintext) as InlineImage;
    if (source.id !== entry.imageId) throw new Error("pending screenshot id mismatch");
    const state = getNoteModelState(entry.noteId);
    if (state?.loaded) hydratePendingInlineImage(state, { ...source, pendingOptimization: true });
    enqueue({ vaultKey, noteId: entry.noteId, imageId: entry.imageId, source, recoveryStored: true, token, attempts: 0 });
  } catch (error) {
    console.error(`Pending screenshot recovery failed for ${entry.imageId}:`, error);
    setStatus(entry.imageId, "failed");
  }
}

export async function initializeInlineImageOptimizations(vaultKey: string | null): Promise<void> {
  resetForVault(vaultKey);
  if (!vaultKey) return;
  const token = vaultToken;
  const entries = await invoke<PendingImageEntry[]>("pending_image_list", { vaultKey });
  await Promise.all(entries.map((entry) => resumePendingEntry(vaultKey, entry, token)));
}

export function queueExistingInlineImages(state: NoteModelState): void {
  const vaultKey = useVaultStore.getState().vault?.salt;
  if (!vaultKey) return;
  resetForVault(vaultKey);
  for (const source of getInlineImages(state)) {
    if (
      !source.pendingOptimization
      || source.mimeType === "image/avif"
      || !OPTIMIZABLE_MIME_TYPES.has(source.mimeType.toLowerCase())
      || !source.data
      || jobs.has(source.id)
    ) continue;
    enqueue({
      vaultKey,
      noteId: state.fileId,
      imageId: source.id,
      source,
      recoveryStored: false,
      token: vaultToken,
      attempts: 0,
    });
  }
}

export function activateInlineImageOptimizations(state: NoteModelState): void {
  for (const job of jobs.values()) {
    if (job.noteId === state.fileId && job.recoveryStored) {
      hydratePendingInlineImage(state, { ...job.source, pendingOptimization: true });
    }
  }
  queueExistingInlineImages(state);
}

export async function scanVaultForExistingImages(): Promise<void> {
  const store = useVaultStore.getState();
  const { vault } = store;
  const vaultKey = vault?.salt;
  if (!vault || !vaultKey) return;
  resetForVault(vaultKey);
  const token = vaultToken;
  for (const node of flattenTree(vault.tree)) {
    if (token !== vaultToken || node.type !== "file" || scannedNoteIds.has(node.id)) continue;
    if (node.locked && !useVaultStore.getState().sessionUnlockedIds.has(node.id)) continue;
    const state = getNoteModelState(node.id);
    if (state && !state.loaded) continue;
    scannedNoteIds.add(node.id);
    if (state?.loaded) {
      queueExistingInlineImages(state);
      continue;
    }
    try {
      const content = await useVaultStore.getState().loadNodeContent(node.id);
      if (!content || token !== vaultToken) continue;
      for (const source of content.inlineImages) {
        if (
          !source.pendingOptimization
          || source.mimeType === "image/avif"
          || !OPTIMIZABLE_MIME_TYPES.has(source.mimeType.toLowerCase())
          || !source.data
          || jobs.has(source.id)
        ) continue;
        enqueue({ vaultKey, noteId: node.id, imageId: source.id, source, recoveryStored: false, token, attempts: 0 });
      }
    } catch (error) {
      console.error(`Could not scan ${node.id} for screenshots:`, error);
    }
  }
}

export async function cancelInlineImageOptimization(noteId: string, imageId: string): Promise<void> {
  const wasEncoding = statuses.get(imageId) === "encoding";
  cancelledIds.add(imageId);
  const job = jobs.get(imageId);
  jobs.delete(imageId);
  queue = queue.filter((queuedId) => queuedId !== imageId);
  setStatus(imageId, "securing");
  if (wasEncoding) {
    try {
      await invoke("cancel_inline_image_optimization", { imageId });
    } catch (error) {
      console.error(`Could not stop AVIF conversion ${imageId}:`, error);
    }
  }
  const vaultKey = job?.vaultKey ?? currentVaultKey;
  if (vaultKey) {
    try {
      await invoke("pending_image_delete", { vaultKey, imageId });
      clearStatus(imageId);
    } catch (error) {
      console.error(`Could not remove pending screenshot ${imageId}:`, error);
      setStatus(imageId, "failed");
    }
  } else {
    clearStatus(imageId);
  }
  void noteId;
}

export async function waitForInlineImageOptimizations(): Promise<void> {
  if (processing) await processing;
  if (snapshot.pendingCount > 0) {
    throw new Error("Some screenshots could not finish and will resume the next time the vault is opened.");
  }
}

export async function retryInlineImageOptimizations(): Promise<void> {
  await initializeInlineImageOptimizations(currentVaultKey);
}
