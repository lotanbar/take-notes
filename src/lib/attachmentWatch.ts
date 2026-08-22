import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openPath } from "@tauri-apps/plugin-opener";
import { useVaultStore } from "../store/vaultStore";
import type { Attachment } from "../types/vault";
import { MAX_ATTACHMENT_BYTES } from "./attachmentOps";
import { withChangedAttachments } from "./attachmentRevision";

type AttachmentUpdateHandler = (attachmentId: string, dataB64: string, size: number) => void;

interface AttachmentChangedPayload {
  watchId: string;
  dataB64: string;
  size: number;
}

const editorHandlers = new Map<string, AttachmentUpdateHandler>();
const watchOwners = new Map<string, { fileId: string; attachmentId: string }>();
let listenerReady: Promise<void> | null = null;

function watchIdFor(fileId: string, attachmentId: string) {
  return `${fileId}::${attachmentId}`;
}

function ensureListener(): Promise<void> {
  if (!listenerReady) {
    listenerReady = listen<AttachmentChangedPayload>("attachment-file-changed", ({ payload }) => {
      const owner = watchOwners.get(payload.watchId);
      if (!owner) return;

      if (payload.size > MAX_ATTACHMENT_BYTES) {
        console.warn(`Attachment update for "${owner.attachmentId}" exceeds the size limit; ignoring.`);
        return;
      }

      const handler = editorHandlers.get(owner.fileId);
      if (handler) {
        handler(owner.attachmentId, payload.dataB64, payload.size);
        return;
      }
      void applyFallbackSave(owner.fileId, owner.attachmentId, payload.dataB64, payload.size);
    }).then(() => undefined);
  }
  return listenerReady;
}

async function applyFallbackSave(fileId: string, attachmentId: string, dataB64: string, size: number) {
  const store = useVaultStore.getState();
  await store.runExclusive(fileId, async () => {
    const content = await store.loadNodeContent(fileId);
    if (!content) return;
    const next = content.attachments.map((a) => (a.id === attachmentId ? { ...a, data: dataB64, size } : a));
    await store.saveNodeContentRaw(fileId, withChangedAttachments(content, next));
  });
}

export function registerAttachmentUpdateHandler(fileId: string, handler: AttachmentUpdateHandler) {
  editorHandlers.set(fileId, handler);
}

export function unregisterAttachmentUpdateHandler(fileId: string) {
  editorHandlers.delete(fileId);
}

export async function openAndWatchAttachment(fileId: string, attachment: Attachment) {
  await ensureListener();
  const path = await invoke<string>("write_temp_attachment", {
    name: attachment.name,
    dataB64: attachment.data,
  });
  const watchId = watchIdFor(fileId, attachment.id);
  watchOwners.set(watchId, { fileId, attachmentId: attachment.id });
  await invoke("start_attachment_watch", { watchId, path });
  await openPath(path);
}

export async function stopWatchForAttachment(fileId: string, attachmentId: string) {
  const watchId = watchIdFor(fileId, attachmentId);
  watchOwners.delete(watchId);
  await invoke("stop_attachment_watch", { watchId }).catch(() => {});
}

export async function stopAllAttachmentWatches() {
  watchOwners.clear();
  editorHandlers.clear();
  await invoke("stop_all_attachment_watches").catch(() => {});
}
