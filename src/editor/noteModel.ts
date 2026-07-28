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
import type { Attachment, NodeContent } from "../types/vault";

const SAVE_DEBOUNCE_MS = 500;
const STICKINESS = monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges;

export interface BookmarkMeta {
  bookmarkId: string;
  label: string;
}

export interface LinkMeta {
  linkId: string;
  targetBookmarkId: string;
  broken: boolean;
}

const EMPTY_CONTENT: NodeContent = { text: "", bookmarks: [], links: [], attachments: [] };

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
  latestContent: NodeContent;

  saveTimer: ReturnType<typeof setTimeout> | null;
  prevBookmarkWidths: Map<string, number>;
  skipShrinkCheckOnce: boolean;

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

export function getNoteModelState(fileId: string): NoteModelState | undefined {
  return states.get(fileId);
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
    latestContent: EMPTY_CONTENT,
    saveTimer: null,
    prevBookmarkWidths: new Map(),
    skipShrinkCheckOnce: false,
    onEntangledShrink: null,
    contentListener: null as unknown as monaco.IDisposable,
  };
  state.contentListener = model.onDidChangeContent(() => handleContentChange(state));
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

function scheduleFlush(state: NoteModelState) {
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => flushSave(state), SAVE_DEBOUNCE_MS);
}

function flushSave(state: NoteModelState) {
  state.saveTimer = null;
  if (!state.loaded) return;
  const { runExclusive, saveNodeContentRaw } = useVaultStore.getState();
  runExclusive(state.fileId, () =>
    saveNodeContentRaw(state.fileId, { ...state.latestContent, attachments: state.attachments }),
  );
}

// Exposed for callers that need an immediate (non-debounced) save, e.g. on
// unmount or right after adding/removing an attachment.
export function flushSaveNow(fileId: string): void {
  const state = states.get(fileId);
  if (state) flushSave(state);
}

function handleContentChange(state: NoteModelState) {
  if (!state.loaded) {
    // The user typed/pasted before the async initial load resolved. Flag it
    // so the loader preserves what's in the model instead of stomping it
    // with the (now-stale) loaded content.
    state.editedBeforeLoad = true;
    return;
  }
  const model = state.model;

  const nextBookmarks = state.bookmarkMeta.map((meta, i) => {
    const range = model.getDecorationRange(state.bookmarkDecoIds[i]);
    return {
      bookmarkId: meta.bookmarkId,
      label: meta.label,
      from: range ? model.getOffsetAt(range.getStartPosition()) : 0,
      to: range ? model.getOffsetAt(range.getEndPosition()) : 0,
    };
  });

  const nextLinks = state.linkMeta.map((meta, i) => {
    const range = model.getDecorationRange(state.linkDecoIds[i]);
    return {
      linkId: meta.linkId,
      targetBookmarkId: meta.targetBookmarkId,
      from: range ? model.getOffsetAt(range.getStartPosition()) : 0,
      to: range ? model.getOffsetAt(range.getEndPosition()) : 0,
    };
  });

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
          if (b && b.to - b.from === 0) useVaultStore.getState().removeBookmarkFromIndex(id);
        }
      }
    }
  }
  state.skipShrinkCheckOnce = false;
  state.prevBookmarkWidths = new Map(nextBookmarks.map((b) => [b.bookmarkId, b.to - b.from]));

  state.latestContent = {
    text: model.getValue(),
    bookmarks: nextBookmarks,
    links: nextLinks,
    attachments: state.attachments,
  };
  scheduleFlush(state);
}
