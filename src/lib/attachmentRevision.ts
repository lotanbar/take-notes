import type { NodeContent } from "../types/vault";

export function nextAttachmentRevision(current: number | undefined, now = Date.now()): number {
  return Math.max(now, (current ?? 0) + 1);
}

export function withChangedAttachments(
  content: NodeContent,
  attachments: NodeContent["attachments"],
  now = Date.now(),
): NodeContent {
  return {
    ...content,
    attachments,
    attachmentRevision: nextAttachmentRevision(content.attachmentRevision, now),
  };
}

export function preserveNewerAttachments(incoming: NodeContent, stored: NodeContent): NodeContent {
  const incomingRevision = incoming.attachmentRevision ?? 0;
  const storedRevision = stored.attachmentRevision ?? 0;
  if (incomingRevision >= storedRevision) return incoming;
  return {
    ...incoming,
    attachments: stored.attachments,
    attachmentRevision: storedRevision,
  };
}
