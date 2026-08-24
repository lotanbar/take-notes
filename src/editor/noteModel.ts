// Shared per-file Monaco model + save/bookmark-tracking state, ref-counted so
// the same note can be open in more than one tab at once (the "Duplicate"
// tab feature) without either view's edits clobbering the other's, and
// without saving stopping just because whichever tab happened to load the
// note first gets closed while a second view of it is still open.
//
// Monaco's `editor.onDidChangeModelContent` is really just `model.onDidChangeContent`
// scoped to whichever model the editor currently has attached — it fires on
// every editor widget attached to a model, regardless of which widget made
// the edit. That's what makes sharing a model safe: the content-change/save
// listener below is attached once, here, when the model is created — not by
// whichever editor widget happens to mount first — so it keeps running for
// as long as ANY view of the note is open.
import { monaco } from "./monacoSetup";
import { useVaultStore } from "../store/vaultStore";
import type { Attachment, BookmarkIndex, InlineImage, LinkTarget, NodeContent } from "../types/vault";

const SAVE_DEBOUNCE_MS = 500;
const STICKINESS = monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges;

export interface BookmarkMeta {
  bookmarkId: string;
  label: string;
}

export interface LinkMeta {
  linkId: string;
  target: LinkTarget;
  broken: boolean;
}

const EMPTY_CONTENT: NodeContent = { text: "", bookmarks: [], links: [], attachments: [], inlineImages: [], attachmentRevision: 0 };

export interface NoteModelState {
  fileId: string;
  model: monaco.editor.ITextModel;
  refCount: number;
  loaded: boolean;
  editedBeforeLoad: boolean;

  bookmarkMeta: BookmarkMeta[];
  bookmarkDecoIds: string[];
  linkMeta: LinkMeta[];
  linkDecoIds: string[];

  attachments: Attachment[];
  attachmentBookmarks: string[];
  attachmentListeners: Set<() => void>;
  inlineImages: InlineImage[];
  inlineImageDecoIds: string[];
  inlineImageListeners: Set<() => void>;
  latestContent: NodeContent;

  saveTimer: ReturnType<typeof setTimeout> | null;
  prevBookmarkWidths: Map<string, number>;
  skipShrinkCheckOnce: boolean;
  markSnapshots: Map<number, MarkSnapshot>;
  restoringMarks: boolean;

  // Only ever set by the singleton "full" Editor view (never by a duplicate/
  // mirror view) while it's mounted, so it can show the "other files link
  // here" confirmation dialog. If no full view is currently mounted, a shrink
  // that would break other files' links is left in place rather than either
  // silently dropped or blocked with no UI to ask about it — see
  // handleContentChange below.
  onEntangledShrink: ((shrunkIds: string[], entangledIds: string[]) => void) | null;

  contentListener: monaco.IDisposable;
}

const states = new Map<string, NoteModelState>();

interface OffsetRange { from: number; to: number }
interface MarkSnapshot {
  bookmarks: Array<BookmarkMeta & OffsetRange>;
  links: Array<LinkMeta & OffsetRange>;
  attachmentBookmarks: string[];
  hostedEntries: BookmarkIndex;
}

function captureMarkSnapshot(state: NoteModelState): MarkSnapshot {
  const model = state.model;
  const index = useVaultStore.getState().vault?.index ?? {};
  const hostedIds = new Set([...state.bookmarkMeta.map((item) => item.bookmarkId), ...state.attachmentBookmarks]);
  return {
    bookmarks: state.bookmarkMeta.map((meta, i) => {
      const range = model.getDecorationRange(state.bookmarkDecoIds[i]);
      return { ...meta, from: range ? model.getOffsetAt(range.getStartPosition()) : 0, to: range ? model.getOffsetAt(range.getEndPosition()) : 0 };
    }),
    links: state.linkMeta.map((meta, i) => {
      const range = model.getDecorationRange(state.linkDecoIds[i]);
      return { ...meta, from: range ? model.getOffsetAt(range.getStartPosition()) : 0, to: range ? model.getOffsetAt(range.getEndPosition()) : 0 };
    }),
    attachmentBookmarks: [...state.attachmentBookmarks],
    hostedEntries: Object.fromEntries([...hostedIds].flatMap((id) => index[id] ? [[id, { ...index[id], referrers: [...index[id].referrers], referrerCounts: { ...(index[id].referrerCounts ?? {}) } }]] : [])),
  };
}

function syncNoteIndex(state: NoteModelState): void {
  const bookmarked = state.attachments
    .filter((item) => state.attachmentBookmarks.includes(item.id))
    .map((item) => ({ id: item.id, name: item.name }));
  useVaultStore.getState().reconcileNoteIndex(state.fileId, state.bookmarkMeta, bookmarked, state.linkMeta.map((item) => item.target));
}

function restoreMarkSnapshot(state: NoteModelState, snapshot: MarkSnapshot): void {
  state.restoringMarks = true;
  state.bookmarkMeta = snapshot.bookmarks.map(({ from: _from, to: _to, ...meta }) => meta);
  setBookmarkDecorations(state, snapshot.bookmarks.map((item) => monaco.Range.fromPositions(state.model.getPositionAt(item.from), state.model.getPositionAt(item.to))));
  state.linkMeta = snapshot.links.map(({ from: _from, to: _to, ...meta }) => meta);
  setLinkDecorations(state, snapshot.links.map((item) => monaco.Range.fromPositions(state.model.getPositionAt(item.from), state.model.getPositionAt(item.to))));
  state.attachmentBookmarks = [...snapshot.attachmentBookmarks];
  state.prevBookmarkWidths = new Map(snapshot.bookmarks.map((item) => [item.bookmarkId, item.to - item.from]));
  useVaultStore.getState().restoreIndexEntries(snapshot.hostedEntries);
  syncNoteIndex(state);
  for (const listener of state.attachmentListeners) listener();
  state.restoringMarks = false;
}

/** Seed snapshots after persisted marks have been loaded into a newly-created model. */
export function initializeMarkUndoState(state: NoteModelState): void {
  state.markSnapshots.clear();
  state.markSnapshots.set(state.model.getAlternativeVersionId(), captureMarkSnapshot(state));
}

/** Commit metadata adjusted as part of the current text undo entry. */
export function commitMarksAtCurrentUndoState(state: NoteModelState): void {
  syncNoteIndex(state);
  state.markSnapshots.set(state.model.getAlternativeVersionId(), captureMarkSnapshot(state));
  scheduleFlush(state);
}

/** Add a metadata-only operation to the same resource undo stack as typing. */
export function applyNoteMarkMutation(state: NoteModelState, mutate: () => void): void {
  const model = state.model;
  state.markSnapshots.set(model.getAlternativeVersionId(), captureMarkSnapshot(state));
  model.pushStackElement();
  mutate();
  syncNoteIndex(state);
  scheduleFlush(state);

  // Monaco only exposes text edit operations publicly. An identity edit gives
  // this metadata mutation a resource-undo entry without changing note text.
  const value = model.getValue();
  if (value.length) {
    const start = model.getPositionAt(0);
    const end = model.getPositionAt(1);
    model.pushEditOperations(null, [{ range: monaco.Range.fromPositions(start, end), text: value.slice(0, 1) }], () => null);
  } else {
    const pos = new monaco.Range(1, 1, 1, 1);
    model.pushEditOperations(null, [{ range: pos, text: "\u2060" }], () => null);
    model.pushEditOperations(null, [{ range: new monaco.Range(1, 1, 1, 2), text: "" }], () => null);
  }
  model.pushStackElement();
  state.markSnapshots.set(model.getAlternativeVersionId(), captureMarkSnapshot(state));
}

export function getNoteModelState(fileId: string): NoteModelState | undefined {
  return states.get(fileId);
}

export function subscribeNoteAttachments(state: NoteModelState, listener: () => void): () => void {
  state.attachmentListeners.add(listener);
  return () => state.attachmentListeners.delete(listener);
}

/** Keep an open editor synchronized with a background attachment rewrite. */
export function applyOptimizedAttachment(fileId: string, replacement: Attachment, attachmentRevision: number): void {
  const state = states.get(fileId);
  if (!state) return;
  state.attachments = state.attachments.map((item) => item.id === replacement.id ? replacement : item);
  state.latestContent = {
    ...state.latestContent,
    attachments: state.attachments,
    attachmentRevision: Math.max(state.latestContent.attachmentRevision ?? 0, attachmentRevision),
  };
  for (const listener of state.attachmentListeners) listener();
}

export interface AcquireResult {
  state: NoteModelState;
  isNew: boolean;
}

// `isNew` tells the caller whether it's responsible for loading the note's
// content into the model (the first/primary view) or whether the model is
// already populated by an earlier acquirer (a duplicate view attaching to an
// already-open note).
export function acquireNoteModel(fileId: string): AcquireResult {
  const existing = states.get(fileId);
  if (existing) {
    existing.refCount++;
    return { state: existing, isNew: false };
  }
  const model = monaco.editor.createModel("", "plaintext");
  const state: NoteModelState = {
    fileId,
    model,
    refCount: 1,
    loaded: false,
    editedBeforeLoad: false,
    bookmarkMeta: [],
    bookmarkDecoIds: [],
    linkMeta: [],
    linkDecoIds: [],
    attachments: [],
    attachmentBookmarks: [],
    attachmentListeners: new Set(),
    inlineImages: [],
    inlineImageDecoIds: [],
    inlineImageListeners: new Set(),
    latestContent: EMPTY_CONTENT,
    saveTimer: null,
    prevBookmarkWidths: new Map(),
    skipShrinkCheckOnce: false,
    markSnapshots: new Map(),
    restoringMarks: false,
    onEntangledShrink: null,
    contentListener: null as unknown as monaco.IDisposable,
  };
  state.contentListener = model.onDidChangeContent((event) => handleContentChange(state, event));
  states.set(fileId, state);
  return { state, isNew: true };
}

// Caller must have already flushed any save it's responsible for before
// releasing (the last release disposes the model outright).
export function releaseNoteModel(fileId: string): void {
  const state = states.get(fileId);
  if (!state) return;
  state.refCount--;
  if (state.refCount <= 0) {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.contentListener.dispose();
    state.model.dispose();
    states.delete(fileId);
  }
}

export function getDecorationRanges(model: monaco.editor.ITextModel, ids: string[]): (monaco.Range | null)[] {
  return ids.map((id) => model.getDecorationRange(id));
}

export function setBookmarkDecorations(state: NoteModelState, ranges: monaco.Range[]): void {
  const decos = ranges.map((range) => ({
    range,
    options: { inlineClassName: "bookmark-anchor", stickiness: STICKINESS },
  }));
  state.bookmarkDecoIds = state.model.deltaDecorations(state.bookmarkDecoIds, decos);
}

export function setLinkDecorations(state: NoteModelState, ranges: monaco.Range[]): void {
  const decos = ranges.map((range, i) => ({
    range,
    options: {
      inlineClassName: state.linkMeta[i]?.broken ? "link-anchor link-anchor-broken" : "link-anchor",
      stickiness: STICKINESS,
    },
  }));
  state.linkDecoIds = state.model.deltaDecorations(state.linkDecoIds, decos);
}

function notifyInlineImages(state: NoteModelState): void {
  for (const listener of state.inlineImageListeners) listener();
}

function persistentInlineImages(state: NoteModelState): InlineImage[] {
  return getInlineImages(state).map((image) =>
    image.pendingOptimization ? { ...image, data: "", pendingOptimization: true } : image,
  );
}

export function subscribeInlineImages(state: NoteModelState, listener: () => void): () => void {
  state.inlineImageListeners.add(listener);
  return () => state.inlineImageListeners.delete(listener);
}

export function getInlineImages(state: NoteModelState): InlineImage[] {
  return state.inlineImages.map((image, index) => {
    const range = state.model.getDecorationRange(state.inlineImageDecoIds[index]);
    return { ...image, at: range ? state.model.getOffsetAt(range.getStartPosition()) : image.at };
  });
}

export function setInlineImages(state: NoteModelState, images: InlineImage[]): void {
  state.inlineImages = images.map((image) => ({ ...image }));
  state.inlineImageDecoIds = state.model.deltaDecorations(
    state.inlineImageDecoIds,
    images.map((image) => ({
      range: monaco.Range.fromPositions(state.model.getPositionAt(image.at)),
      options: { stickiness: STICKINESS },
    })),
  );
  notifyInlineImages(state);
}

export function addInlineImage(state: NoteModelState, image: InlineImage): void {
  setInlineImages(state, [...getInlineImages(state), image]);
  state.latestContent = { ...state.latestContent, inlineImages: persistentInlineImages(state) };
  scheduleFlush(state);
}

export function replaceInlineImage(
  state: NoteModelState,
  id: string,
  replacement: Pick<InlineImage, "mimeType" | "size" | "data">,
): boolean {
  const image = state.inlineImages.find((candidate) => candidate.id === id);
  if (!image) return false;
  image.mimeType = replacement.mimeType;
  image.size = replacement.size;
  image.data = replacement.data;
  delete image.blobRef;
  delete image.pendingOptimization;
  state.latestContent = { ...state.latestContent, inlineImages: persistentInlineImages(state) };
  notifyInlineImages(state);
  scheduleFlush(state);
  return true;
}

export function hydratePendingInlineImage(state: NoteModelState, source: InlineImage): void {
  const existing = state.inlineImages.find((candidate) => candidate.id === source.id);
  if (existing) {
    existing.mimeType = source.mimeType;
    existing.size = source.size;
    existing.data = source.data;
    existing.pendingOptimization = true;
    notifyInlineImages(state);
    return;
  }
  setInlineImages(state, [...getInlineImages(state), { ...source, pendingOptimization: true }]);
  state.latestContent = { ...state.latestContent, inlineImages: persistentInlineImages(state) };
  scheduleFlush(state);
}

export function updateInlineImageSize(
  state: NoteModelState,
  id: string,
  width: number,
  height: number,
  notify = false,
): void {
  const image = state.inlineImages.find((candidate) => candidate.id === id);
  if (!image) return;
  image.width = Math.max(80, Math.round(width));
  image.height = Math.max(60, Math.round(height));
  state.latestContent = { ...state.latestContent, inlineImages: persistentInlineImages(state) };
  scheduleFlush(state);
  if (notify) notifyInlineImages(state);
}

export function removeInlineImage(state: NoteModelState, id: string): void {
  const images = getInlineImages(state).filter((image) => image.id !== id);
  setInlineImages(state, images);
  state.latestContent = {
    ...state.latestContent,
    inlineImages: images.map((image) =>
      image.pendingOptimization ? { ...image, data: "", pendingOptimization: true } : image,
    ),
  };
  scheduleFlush(state);
}

function scheduleFlush(state: NoteModelState) {
  void useVaultStore.getState().journalNodeContent(state.fileId, contentForSave(state)).catch((error) => {
    useVaultStore.setState({ error: `Session recovery write failed: ${String(error)}` });
  });
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => flushSave(state), SAVE_DEBOUNCE_MS);
}

function contentForSave(state: NoteModelState): NodeContent {
  const model = state.model;
  const bookmarks = state.bookmarkMeta.map((meta, i) => {
    const range = model.getDecorationRange(state.bookmarkDecoIds[i]);
    return {
      ...meta,
      from: range ? model.getOffsetAt(range.getStartPosition()) : 0,
      to: range ? model.getOffsetAt(range.getEndPosition()) : 0,
    };
  });
  const links = state.linkMeta.map((meta, i) => {
    const range = model.getDecorationRange(state.linkDecoIds[i]);
    return {
      linkId: meta.linkId,
      target: meta.target,
      from: range ? model.getOffsetAt(range.getStartPosition()) : 0,
      to: range ? model.getOffsetAt(range.getEndPosition()) : 0,
    };
  });
  const content = {
    text: model.getValue(),
    bookmarks,
    links,
    attachments: state.attachments,
    attachmentBookmarks: state.attachmentBookmarks,
    inlineImages: persistentInlineImages(state),
  };
  state.latestContent = content;
  return content;
}

function flushSave(state: NoteModelState): Promise<void> {
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = null;
  if (!state.loaded) return Promise.resolve();
  const { runExclusive, saveNodeContentRaw } = useVaultStore.getState();
  return runExclusive(state.fileId, () => saveNodeContentRaw(state.fileId, contentForSave(state)));
}

// Exposed for callers that need an immediate (non-debounced) save, e.g. on
// unmount or right after adding/removing an attachment.
export function flushSaveNow(fileId: string): Promise<void> {
  const state = states.get(fileId);
  return state ? flushSave(state) : Promise.resolve();
}

/** Flushes every loaded editor, including attachment changes, and resolves only after disk writes finish. */
export async function flushAllDirtyNotes(): Promise<void> {
  const work: Promise<void>[] = [];
  for (const state of states.values()) {
    if (state.saveTimer) work.push(flushSave(state));
  }
  await Promise.all(work);
}

function handleContentChange(state: NoteModelState, event: monaco.editor.IModelContentChangedEvent) {
  if (!state.loaded) {
    // The user typed/pasted before the async initial load resolved. Flag it
    // so the loader preserves what's in the model instead of stomping it
    // with the (now-stale) loaded content.
    state.editedBeforeLoad = true;
    return;
  }
  const model = state.model;

  if ((event.isUndoing || event.isRedoing) && !state.restoringMarks) {
    const snapshot = state.markSnapshots.get(model.getAlternativeVersionId());
    if (snapshot) restoreMarkSnapshot(state, snapshot);
  }

  let nextBookmarks = state.bookmarkMeta.map((meta, i) => {
    const range = model.getDecorationRange(state.bookmarkDecoIds[i]);
    return {
      bookmarkId: meta.bookmarkId,
      label: meta.label,
      from: range ? model.getOffsetAt(range.getStartPosition()) : 0,
      to: range ? model.getOffsetAt(range.getEndPosition()) : 0,
    };
  });

  const vanishedIds = new Set<string>();
  if (!state.skipShrinkCheckOnce) {
    const shrunkIds: string[] = [];
    for (const b of nextBookmarks) {
      const prevWidth = state.prevBookmarkWidths.get(b.bookmarkId) ?? 0;
      if (b.to - b.from < prevWidth) shrunkIds.push(b.bookmarkId);
    }
    if (shrunkIds.length > 0) {
      const currentIndex = useVaultStore.getState().vault?.index ?? {};
      const entangledIds = shrunkIds.filter((id) => (currentIndex[id]?.referrers.length ?? 0) > 0);
      if (entangledIds.length > 0) {
        if (state.onEntangledShrink) {
          state.model.undo();
          state.onEntangledShrink(shrunkIds, entangledIds);
          return;
        }
        // No full view mounted to confirm with — let the edit stand rather
        // than undo keystrokes with no visible explanation. The affected
        // bookmark's referrers just become "broken" links, which the app
        // already displays and tolerates.
      } else {
        for (const id of shrunkIds) {
          const b = nextBookmarks.find((x) => x.bookmarkId === id);
          if (b && b.to - b.from === 0) vanishedIds.add(id);
        }
      }
    }
  }
  state.skipShrinkCheckOnce = false;
  if (vanishedIds.size > 0) {
    const ranges = getDecorationRanges(model, state.bookmarkDecoIds)
      .filter((_, index) => !vanishedIds.has(state.bookmarkMeta[index]?.bookmarkId))
      .filter((range): range is monaco.Range => !!range);
    state.bookmarkMeta = state.bookmarkMeta.filter((meta) => !vanishedIds.has(meta.bookmarkId));
    setBookmarkDecorations(state, ranges);
    nextBookmarks = nextBookmarks.filter((bookmark) => !vanishedIds.has(bookmark.bookmarkId));
    syncNoteIndex(state);
  }
  state.prevBookmarkWidths = new Map(nextBookmarks.map((b) => [b.bookmarkId, b.to - b.from]));

  state.latestContent = {
    text: model.getValue(),
    bookmarks: nextBookmarks,
    // Link offsets and image positions are derived from Monaco decorations
    // only at save time; ordinary typing must not rescan or rebuild them.
    links: state.latestContent.links,
    attachments: state.attachments,
    attachmentBookmarks: state.attachmentBookmarks,
    inlineImages: state.latestContent.inlineImages,
  };
  state.markSnapshots.set(model.getAlternativeVersionId(), captureMarkSnapshot(state));
  scheduleFlush(state);
}
