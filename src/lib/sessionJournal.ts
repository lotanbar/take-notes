import { invoke } from "@tauri-apps/api/core";

export interface JournalRecord { nodeHash: string; ciphertext: string; revision: number }
export function writeJournal(sourcePath: string, nodeId: string, ciphertext: string, revision: number): Promise<void> { return invoke("journal_write", { sourcePath, nodeId, ciphertext, revision }); }
export function readJournal(sourcePath: string): Promise<JournalRecord[]> { return invoke("journal_read", { sourcePath }); }
export function clearJournal(sourcePath: string): Promise<void> { return invoke("journal_clear", { sourcePath }); }
export async function hashJournalNodeId(nodeId: string): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nodeId)))].map((v) => v.toString(16).padStart(2, "0")).join(""); }
