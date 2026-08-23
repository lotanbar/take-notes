import { invoke } from "@tauri-apps/api/core";
import type { NodeContent } from "../types/vault";

export interface JournalRecord { nodeHash: string; ciphertext: string; revision: number }
export function writeJournal(sourcePath: string, nodeId: string, ciphertext: string, revision: number): Promise<void> { return invoke("journal_write", { sourcePath, nodeId, ciphertext, revision }); }
export function readJournal(sourcePath: string): Promise<JournalRecord[]> { return invoke("journal_read", { sourcePath }); }
export function clearJournal(sourcePath: string): Promise<void> { return invoke("journal_clear", { sourcePath }); }

// Journal snapshots are deliberately self-contained whenever an asset's bytes
// were loaded in the editor. A crash or interrupted compaction can invalidate
// the old vault offsets, so replay must prefer those embedded bytes and create
// fresh encrypted objects instead of trusting a stale blobRef.
export function prepareJournalContentForReplay(content: NodeContent): NodeContent {
  const preferEmbeddedData = <T extends NodeContent["attachments"][number] | NodeContent["inlineImages"][number]>(asset: T): T =>
    asset.data ? { ...asset, blobRef: undefined } : asset;
  return {
    ...content,
    attachments: content.attachments.map(preferEmbeddedData),
    inlineImages: content.inlineImages.map(preferEmbeddedData),
  };
}
export async function hashJournalNodeId(nodeId: string): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nodeId)))].map((v) => v.toString(16).padStart(2, "0")).join(""); }
