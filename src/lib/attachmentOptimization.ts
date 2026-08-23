import { invoke } from "@tauri-apps/api/core";
import { useVaultStore } from "../store/vaultStore";
import type { Attachment, CompressionMetadata } from "../types/vault";
import { applyOptimizedAttachment } from "../editor/noteModel";
import { withChangedAttachments } from "./attachmentRevision";
import { createAttachmentOptimizationSnapshotStore, type AttachmentOptimizationSnapshot } from "./attachmentOptimizationSnapshot";
import { decodedBase64Size, MEDIA_COMPRESSION_PROFILE_VERSION } from "./mediaMigrationPolicy";

interface NativeResult { data: string; mimeType: string; codec: string; sourceHash: string; outputHash: string; sourceSize: number; outputSize: number; accepted: boolean }
interface StillResult { data: string; mimeType: string; size: number }
const listeners = new Set<() => void>();
const queued = new Map<string, { noteId: string; attachment: Attachment }>();
const failed = new Map<string, { noteId: string; attachment: Attachment }>();
let running = false;
let activeId: string | null = null;

let failedCount = 0;
const snapshotStore = createAttachmentOptimizationSnapshotStore(() => ({
  pendingCount: queued.size + failed.size + (activeId ? 1 : 0),
  failedCount,
}));
function publish() {
  snapshotStore.publish();
  for (const listener of listeners) listener();
}
export function subscribeAttachmentOptimizations(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); }
export function getAttachmentOptimizationSnapshot(): AttachmentOptimizationSnapshot { return snapshotStore.getSnapshot(); }
export function waitForAttachmentOptimizations(): Promise<void> { return new Promise((resolve, reject) => { const check = () => { if (!running && queued.size === 0) { stop(); failedCount ? reject(new Error(`${failedCount} media optimization job(s) failed.`)) : resolve(); } }; const stop = subscribeAttachmentOptimizations(check); check(); }); }

async function hashB64(value: string): Promise<string> { const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0)); return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((v) => v.toString(16).padStart(2, "0")).join(""); }
function isAnimated(attachment: Attachment): boolean { const mime = attachment.mimeType.toLowerCase(); if (mime === "image/gif" || mime === "image/apng") return true; try { const header = atob(attachment.data.slice(0, 4096)); return mime === "image/png" ? header.includes("acTL") : mime === "image/webp" && (header.includes("ANIM") || header.includes("ANMF")); } catch { return false; } }

export function enqueueAttachmentOptimization(noteId: string, attachment: Attachment): void {
  if (attachment.mimeType.toLowerCase() === "image/avif") return;
  if (!attachment.compressionState || attachment.compressionState === "processed") return;
  if (queued.has(attachment.id) || failed.has(attachment.id) || activeId === attachment.id) return;
  queued.set(attachment.id, { noteId, attachment }); publish(); if (!running) void processQueue();
}
export function retryFailedAttachmentOptimizations(): void { failedCount = 0; for (const [id, job] of failed) queued.set(id, job); failed.clear(); publish(); if (!running) void processQueue(); }

async function optimize(attachment: Attachment): Promise<{ replacement: Attachment; metadata: CompressionMetadata }> {
  const mime = attachment.mimeType.toLowerCase();
  if (mime.startsWith("image/") && !isAnimated(attachment)) {
    const result = await invoke<StillResult>("optimize_inline_image", { data: attachment.data, imageId: attachment.id });
    const sourceSize = decodedBase64Size(attachment.data);
    const accepted = result.size + result.mimeType.length + "avif-q35".length < sourceSize + attachment.mimeType.length + "original".length;
    const data = accepted ? result.data : attachment.data;
    const outputSize = accepted ? result.size : sourceSize;
    const metadata: CompressionMetadata = { codec: accepted ? "avif-q35" : "original", profileVersion: MEDIA_COMPRESSION_PROFILE_VERSION, sourceHash: await hashB64(attachment.data), outputHash: await hashB64(data), sourceSize, outputSize };
    return { replacement: { ...attachment, data, blobRef: undefined, size: outputSize, mimeType: accepted ? result.mimeType : attachment.mimeType, compressionState: "processed", originalMimeType: attachment.mimeType }, metadata };
  }
  const mediaMime = mime === "image/png" && isAnimated(attachment) ? "image/apng" : attachment.mimeType;
  const result = await invoke<NativeResult>("optimize_media", { data: attachment.data, mimeType: mediaMime });
  const codec = result.codec === "opus-24k-mono" || result.codec === "av1-webm-720p15" ? result.codec : "original";
  const metadata: CompressionMetadata = { codec, profileVersion: MEDIA_COMPRESSION_PROFILE_VERSION, sourceHash: result.sourceHash, outputHash: result.outputHash, sourceSize: result.sourceSize, outputSize: result.outputSize };
  return { replacement: { ...attachment, data: result.data, blobRef: undefined, size: result.outputSize, mimeType: result.mimeType, compressionState: "processed", originalMimeType: attachment.mimeType }, metadata };
}

async function processQueue(): Promise<void> {
  running = true; publish();
  while (queued.size) {
    const [id, job] = queued.entries().next().value as [string, { noteId: string; attachment: Attachment }]; queued.delete(id); activeId = id; publish();
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const store = useVaultStore.getState(); const content = await store.loadNodeContent(job.noteId);
      if (!content) throw new Error("The media's note is locked or unavailable.");
      const current = content.attachments.find((item) => item.id === id);
      if (current?.compressionState && current.compressionState !== "processed") {
        await store.saveNodeContent(job.noteId, { ...content, attachments: content.attachments.map((item) => item.id === id ? { ...item, compressionState: "processing" } : item) });
        const { replacement, metadata } = await optimize({ ...current, data: current.data || job.attachment.data });
        const latest = await store.loadNodeContent(job.noteId);
        if (latest) {
          const optimized = { ...replacement, compression: metadata };
          const finalContent = withChangedAttachments(
            latest,
            latest.attachments.map((item) => item.id === id ? optimized : item),
          );
          await store.saveNodeContent(job.noteId, finalContent);
          applyOptimizedAttachment(job.noteId, optimized, finalContent.attachmentRevision ?? 0);
        }
        failed.delete(id);
      }
    } catch (error) {
      console.error("Attachment optimization failed:", error); failed.set(id, job); failedCount += 1;
      const store = useVaultStore.getState();
      const latest = await store.loadNodeContent(job.noteId).catch(() => null);
      if (latest) await store.saveNodeContent(job.noteId, { ...latest, attachments: latest.attachments.map((item) => item.id === id ? { ...item, compressionState: "failed" } : item) }).catch(() => {});
    } finally {
      activeId = null; publish();
    }
  }
  running = false; publish();
}

export async function initializeAttachmentOptimizations(): Promise<void> {
  const store = useVaultStore.getState(); if (!store.vault) return;
  const { flattenTree } = await import("./treeOps");
  for (const node of flattenTree(store.vault.tree)) {
    if (node.type !== "file" || (node.locked && !store.sessionUnlockedIds.has(node.id))) continue;
    const content = await store.loadNodeContent(node.id).catch(() => null);
    for (const attachment of content?.attachments ?? []) if (attachment.compressionState && attachment.compressionState !== "processed") enqueueAttachmentOptimization(node.id, attachment);
  }
}
