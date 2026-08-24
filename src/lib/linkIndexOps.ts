import type { BookmarkIndex, LinkTarget } from "../types/vault";

function targetId(target: LinkTarget): string {
  return target.kind === "file" ? target.fileId : target.kind === "text" ? target.bookmarkId : target.attachmentId;
}

/** Pure index update used after edits and undo/redo. */
export function reconcileNoteIndex(
  index: BookmarkIndex,
  fileId: string,
  bookmarks: Array<{ bookmarkId: string }>,
  attachmentBookmarks: Array<{ id: string; name: string }>,
  linkTargets: LinkTarget[],
): BookmarkIndex {
  const textIds = new Set(bookmarks.map((item) => item.bookmarkId));
  const attachmentById = new Map(attachmentBookmarks.map((item) => [item.id, item.name]));
  const linkCounts = new Map<string, number>();
  for (const target of linkTargets) linkCounts.set(targetId(target), (linkCounts.get(targetId(target)) ?? 0) + 1);
  const next: BookmarkIndex = {};
  for (const [id, current] of Object.entries(index)) {
    const kind = current.kind ?? "text";
    if (current.hostFileId === fileId && kind === "text" && !textIds.has(id)) continue;
    if (current.hostFileId === fileId && kind === "attachment" && !attachmentById.has(id)) continue;
    const counts = { ...(current.referrerCounts ?? Object.fromEntries(current.referrers.map((referrer) => [referrer, 1]))) };
    const count = linkCounts.get(id) ?? 0;
    if (count) counts[fileId] = count;
    else delete counts[fileId];
    next[id] = { ...current, kind, referrerCounts: counts, referrers: Object.keys(counts).filter((referrer) => counts[referrer] > 0) };
  }
  for (const bookmark of bookmarks) next[bookmark.bookmarkId] ??= { kind: "text", hostFileId: fileId, referrers: [], referrerCounts: {} };
  for (const attachment of attachmentBookmarks) next[attachment.id] ??= { kind: "attachment", hostFileId: fileId, attachmentId: attachment.id, attachmentName: attachment.name, referrers: [], referrerCounts: {} };
  return next;
}
