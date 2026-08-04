import { useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Link2, Trash2, UploadCloud } from "lucide-react";
import { monaco, registerIndentCarryingEnter, currentThemeName, watchThemeChanges } from "../editor/monacoSetup";
import {
  acquireNoteModel,
  releaseNoteModel,
  flushSaveNow,
  setBookmarkDecorations,
  setLinkDecorations,
  setInlineImages,
  getDecorationRanges,
  type NoteModelState,
} from "../editor/noteModel";
import { clipboardImageFiles, mountInlineImageView, pasteInlineImages, pasteNativeClipboard } from "../editor/inlineImages";
import { useVaultStore } from "../store/vaultStore";
import { useZoomStore } from "../store/zoomStore";
import { isLinkBroken } from "../lib/bookmarkOps";
import { fileToAttachment, MAX_ATTACHMENT_BYTES } from "../lib/attachmentOps";
import {
  openAndWatchAttachment,
  registerAttachmentUpdateHandler,
  stopWatchForAttachment,
  unregisterAttachmentUpdateHandler,
} from "../lib/attachmentWatch";
import { detectDirection } from "../lib/textDirection";
import type { Attachment } from "../types/vault";
import { ConfirmDialog } from "./ConfirmDialog";
import { NewBookmarkPopup } from "./NewBookmarkPopup";
import { BookmarkPickerPopup } from "./BookmarkPickerPopup";
import { ReferrersPopup } from "./ReferrersPopup";
import { AttachmentRow } from "./AttachmentRow";

const BASE_FONT_SIZE = 12;
const STICKINESS = monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges;

interface EditorProps {
  fileId: string;
  fileName: string;
}

interface PendingBookmarkDeletion {
  // "shrink": text covering a bookmark was deleted (auto-undone pending confirmation).
  // "explicit": the bookmark button removed a mark directly (no text touched).
  kind: "shrink" | "explicit";
  shrunkIds: string[];
  entangledIds: string[];
}

type MarkMode = "disabled" | "create" | "remove";

function computeMarkMode(
  selFrom: number,
  selTo: number,
  ranges: { id: string; from: number; to: number }[],
): { mode: MarkMode; id?: string } {
  const containing = ranges.find((r) => r.from <= selFrom && selTo <= r.to);
  if (containing) return { mode: "remove", id: containing.id };
  const overlaps = ranges.some((r) => selFrom < r.to && selTo > r.from);
  if (overlaps) return { mode: "disabled" };
  return { mode: "create" };
}

interface ToolbarState {
  bookmarkMode: MarkMode;
  bookmarkRemoveId?: string;
  linkMode: MarkMode;
  linkRemoveId?: string;
}

export function Editor({ fileId, fileName }: EditorProps) {
  const loadNodeContent = useVaultStore((s) => s.loadNodeContent);
  const addBookmarkToIndex = useVaultStore((s) => s.addBookmarkToIndex);
  const removeBookmarkFromIndex = useVaultStore((s) => s.removeBookmarkFromIndex);
  const addReferrerToIndex = useVaultStore((s) => s.addReferrerToIndex);
  const removeReferrerFromIndex = useVaultStore((s) => s.removeReferrerFromIndex);
  const activeBookmarkId = useVaultStore((s) => s.activeBookmarkId);
  const chromeZoom = useZoomStore((s) => s.chromeZoom);
  const editorZoom = useZoomStore((s) => s.editorZoom);

  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const noteStateRef = useRef<NoteModelState | null>(null);
  const rtlLineDecosRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const dragCounter = useRef(0);
  const rejectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  // Bookmark/link mode is now only read by the Ctrl+B/Ctrl+L keyboard shortcuts
  // (see the mount effect), not rendered — a ref avoids a re-render on every
  // cursor move.
  const toolbarStateRef = useRef<ToolbarState | null>(null);

  const [editorReady, setEditorReady] = useState(false);
  const [showNewBookmarkPopup, setShowNewBookmarkPopup] = useState(false);
  const [showLinkPicker, setShowLinkPicker] = useState(false);
  const [pendingBookmarkDeletion, setPendingBookmarkDeletion] = useState<PendingBookmarkDeletion | null>(null);
  const [showReferrers, setShowReferrers] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [pendingDeleteAttachment, setPendingDeleteAttachment] = useState<Attachment | null>(null);
  const [rejectedNames, setRejectedNames] = useState<string[]>([]);

  function refreshToolbarState() {
    const editor = editorRef.current;
    const noteState = noteStateRef.current;
    const model = editor?.getModel();
    if (!editor || !model || !noteState) return;
    const selection = editor.getSelection();
    const hasSelection = !!selection && !selection.isEmpty();
    const selFrom = selection ? model.getOffsetAt(selection.getStartPosition()) : 0;
    const selTo = selection ? model.getOffsetAt(selection.getEndPosition()) : 0;

    const bookmarkRanges = getDecorationRanges(model, noteState.bookmarkDecoIds).map((r, i) => ({
      id: noteState.bookmarkMeta[i]?.bookmarkId,
      from: r ? model.getOffsetAt(r.getStartPosition()) : 0,
      to: r ? model.getOffsetAt(r.getEndPosition()) : 0,
    }));
    const linkRanges = getDecorationRanges(model, noteState.linkDecoIds).map((r, i) => ({
      id: noteState.linkMeta[i]?.linkId,
      from: r ? model.getOffsetAt(r.getStartPosition()) : 0,
      to: r ? model.getOffsetAt(r.getEndPosition()) : 0,
    }));

    const bookmark = hasSelection ? computeMarkMode(selFrom, selTo, bookmarkRanges) : { mode: "disabled" as const };
    const link = hasSelection ? computeMarkMode(selFrom, selTo, linkRanges) : { mode: "disabled" as const };

    toolbarStateRef.current = {
      bookmarkMode: bookmark.mode,
      bookmarkRemoveId: bookmark.id,
      linkMode: link.mode,
      linkRemoveId: link.id,
    };
  }

  // Judges direction per line (not per note) so a fully-English line inside
  // an otherwise-Hebrew note stays LTR, and vice versa.
  function refreshRtlLineDecorations(editor: monaco.editor.IStandaloneCodeEditor, model: monaco.editor.ITextModel) {
    const decos: { range: monaco.Range; options: monaco.editor.IModelDecorationOptions }[] = [];
    for (let line = 1; line <= model.getLineCount(); line++) {
      const content = model.getLineContent(line);
      if (content.trim() && detectDirection(content) === "rtl") {
        decos.push({
          range: new monaco.Range(line, 1, line, model.getLineMaxColumn(line)),
          options: { inlineClassName: "rtl-line", stickiness: STICKINESS },
        });
      }
    }
    if (rtlLineDecosRef.current) rtlLineDecosRef.current.set(decos);
    else rtlLineDecosRef.current = editor.createDecorationsCollection(decos);
  }

  function removeBookmarkMark(bookmarkId: string) {
    const noteState = noteStateRef.current;
    if (!noteState) return;
    const idx = noteState.bookmarkMeta.findIndex((m) => m.bookmarkId === bookmarkId);
    if (idx === -1) return;
    const ranges = getDecorationRanges(noteState.model, noteState.bookmarkDecoIds).filter((_, i) => i !== idx);
    noteState.bookmarkMeta = noteState.bookmarkMeta.filter((_, i) => i !== idx);
    noteState.prevBookmarkWidths.delete(bookmarkId);
    setBookmarkDecorations(noteState, ranges.filter((r): r is monaco.Range => !!r));
    removeBookmarkFromIndex(bookmarkId);
    refreshToolbarState();
  }

  function removeLinkMark(linkId: string) {
    const noteState = noteStateRef.current;
    if (!noteState) return;
    const idx = noteState.linkMeta.findIndex((m) => m.linkId === linkId);
    if (idx === -1) return;
    const meta = noteState.linkMeta[idx];
    const ranges = getDecorationRanges(noteState.model, noteState.linkDecoIds).filter((_, i) => i !== idx);
    noteState.linkMeta = noteState.linkMeta.filter((_, i) => i !== idx);
    setLinkDecorations(noteState, ranges.filter((r): r is monaco.Range => !!r));
    removeReferrerFromIndex(meta.targetBookmarkId, fileId);
    refreshToolbarState();
  }

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    // React Strict Mode's dev-only mount->cleanup->mount cycle runs this
    // effect's cleanup once immediately after the first mount, which would
    // otherwise permanently leave mountedRef false for the second, real mount
    // (only the initial useRef(true) sets it true, and nothing else did).
    mountedRef.current = true;

    const { state: noteState, isNew } = acquireNoteModel(fileId);
    noteStateRef.current = noteState;
    noteState.onEntangledShrink = (shrunkIds, entangledIds) =>
      setPendingBookmarkDeletion({ kind: "shrink", shrunkIds, entangledIds });

    registerAttachmentUpdateHandler(fileId, (attachmentId, dataB64, size) => {
      const next = noteState.attachments.map((a) => (a.id === attachmentId ? { ...a, data: dataB64, size } : a));
      noteState.attachments = next;
      if (mountedRef.current) setAttachments(next);
      noteState.latestContent = { ...noteState.latestContent, attachments: next };
      flushSaveNow(fileId);
    });

    const editor = monaco.editor.create(containerRef.current, {
      model: noteState.model,
      theme: currentThemeName(),
      automaticLayout: true,
      minimap: { enabled: false },
      renderLineHighlight: "all",
      cursorBlinking: "solid",
      foldingStrategy: "indentation",
      showFoldingControls: "always",
      wordWrap: "on",
      scrollBeyondLastLine: false,
      padding: { top: 8, bottom: 32 },
      fontFamily: "Consolas, 'Cascadia Mono', 'Courier New', monospace",
      fontSize: BASE_FONT_SIZE,
      tabSize: 4,
      insertSpaces: true,
      // Plaintext notes have no language provider backing any of this, but several
      // of these features scan the raw text on every keystroke/cursor move regardless
      // (word/selection occurrence highlighting, link detection, bracket matching,
      // unicode-ambiguity scanning) — turn off everything that isn't multi-cursor,
      // move-lines, folding, or basic editing.
      quickSuggestions: false,
      wordBasedSuggestions: "off",
      suggestOnTriggerCharacters: false,
      parameterHints: { enabled: false },
      hover: { enabled: false },
      links: false,
      occurrencesHighlight: "off",
      selectionHighlight: false,
      matchBrackets: "never",
      bracketPairColorization: { enabled: false },
      guides: { bracketPairs: false, indentation: true },
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
      codeLens: false,
      lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.Off },
      inlayHints: { enabled: "off" },
      stickyScroll: { enabled: false },
      renderValidationDecorations: "off",
    });
    editorRef.current = editor;
    registerIndentCarryingEnter(editor);
    const inlineImageView = mountInlineImageView(editor, noteState);
    const editorDomNode = editor.getDomNode();
    const handlePaste = (event: ClipboardEvent) => {
      const files = clipboardImageFiles(event);
      if (files.length === 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void pasteInlineImages(editor, noteState, files).catch((error) => {
        useVaultStore.setState({ error: String(error) });
      });
    };
    editorDomNode?.addEventListener("paste", handlePaste, true);
    const handleNativePasteKey = (event: KeyboardEvent) => {
      if (!("__TAURI_INTERNALS__" in window)) return;
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "v" || !noteState.loaded) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void pasteNativeClipboard(editor, noteState).catch((error) => {
        useVaultStore.setState({ error: `Clipboard paste failed: ${String(error)}` });
      });
    };
    editorDomNode?.addEventListener("keydown", handleNativePasteKey, true);
    // addAction scopes each keybinding to this editor id. addCommand uses
    // Monaco's shared keybinding service and can invoke a different pane.
    const editorId = editor.getId();
    editor.addAction({
      id: `vault-notes.bookmark.${editorId}`,
      label: "Toggle Bookmark",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB],
      keybindingContext: "editorTextFocus",
      run: () => handleBookmarkButtonClick(),
    });
    editor.addAction({
      id: `vault-notes.link.${editorId}`,
      label: "Toggle Link",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL],
      keybindingContext: "editorTextFocus",
      run: () => handleLinkButtonClick(),
    });
    editor.addAction({
      id: `vault-notes.back.${editorId}`,
      label: "Go Back",
      keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.LeftArrow],
      keybindingContext: "editorTextFocus",
      run: () => useVaultStore.getState().goBack(),
    });
    editor.addAction({
      id: `vault-notes.forward.${editorId}`,
      label: "Go Forward",
      keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.RightArrow],
      keybindingContext: "editorTextFocus",
      run: () => useVaultStore.getState().goForward(),
    });
    setEditorReady(true);

    const stopThemeWatch = watchThemeChanges((theme) => editor.updateOptions({ theme }));

    const disposables = [
      // model.onDidChangeContent (equivalently, this) fires for edits made
      // through ANY editor widget attached to this note's model, not just
      // this one — so this only needs to refresh this widget's own toolbar/
      // RTL-line visuals; the shared save/bookmark-shrink bookkeeping lives
      // in noteModel.ts, registered once per note regardless of how many
      // views of it are open.
      editor.onDidChangeModelContent(() => {
        if (!noteState.loaded) return;
        const model = editor.getModel();
        if (!model) return;
        refreshRtlLineDecorations(editor, model);
        refreshToolbarState();
      }),
      editor.onDidChangeCursorSelection(() => refreshToolbarState()),
      editor.onDidPaste((event) => {
        const files = clipboardImageFiles(event.clipboardEvent);
        if (files.length > 0) {
          void pasteInlineImages(editor, noteState, files).catch((error) => {
            useVaultStore.setState({ error: String(error) });
          });
        }
      }),
      editor.onMouseDown((e: monaco.editor.IEditorMouseEvent) => {
        if (!(e.event.ctrlKey || e.event.metaKey)) return;
        if (!e.target.position) return;
        const model = editor.getModel();
        if (!model) return;
        const offset = model.getOffsetAt(e.target.position);
        const ranges = getDecorationRanges(model, noteState.linkDecoIds);
        for (let i = 0; i < ranges.length; i++) {
          const range = ranges[i];
          if (!range) continue;
          const from = model.getOffsetAt(range.getStartPosition());
          const to = model.getOffsetAt(range.getEndPosition());
          if (offset >= from && offset <= to) {
            useVaultStore.getState().navigateToBookmark(noteState.linkMeta[i].targetBookmarkId);
            return;
          }
        }
      }),
    ];

    if (isNew) {
      loadNodeContent(fileId).then((result) => {
        if (cancelled) return;
        const model = editor.getModel();
        if (!model) return;

        if (noteState.editedBeforeLoad) {
          // Don't overwrite what the user already typed/pasted while this load
          // was in flight. Its bookmarks/links refer to offsets in the old text,
          // which no longer apply, so treat the current buffer as a fresh,
          // mark-less note; attachments are unaffected by text edits, so keep those.
          const attachments = result?.attachments ?? [];
          const inlineImages = result?.inlineImages ?? [];
          noteState.attachments = attachments;
          setAttachments(attachments);
          setInlineImages(noteState, inlineImages);
          noteState.bookmarkMeta = [];
          setBookmarkDecorations(noteState, []);
          noteState.linkMeta = [];
          setLinkDecorations(noteState, []);
          noteState.prevBookmarkWidths = new Map();
          noteState.latestContent = { text: model.getValue(), bookmarks: [], links: [], attachments, inlineImages };
          noteState.loaded = true;
          refreshRtlLineDecorations(editor, model);
          refreshToolbarState();
          return;
        }

        const content = result ?? { text: "", bookmarks: [], links: [], attachments: [], inlineImages: [] };
        model.setValue(content.text);

        const index = useVaultStore.getState().vault?.index ?? {};
        noteState.bookmarkMeta = content.bookmarks.map((b) => ({ bookmarkId: b.bookmarkId, label: b.label }));
        setBookmarkDecorations(
          noteState,
          content.bookmarks.map((b) => monaco.Range.fromPositions(model.getPositionAt(b.from), model.getPositionAt(b.to))),
        );
        noteState.linkMeta = content.links.map((l) => ({
          linkId: l.linkId,
          targetBookmarkId: l.targetBookmarkId,
          broken: isLinkBroken(l, index),
        }));
        setLinkDecorations(
          noteState,
          content.links.map((l) => monaco.Range.fromPositions(model.getPositionAt(l.from), model.getPositionAt(l.to))),
        );

        noteState.attachments = content.attachments;
        setAttachments(content.attachments);
        setInlineImages(noteState, content.inlineImages);
        noteState.prevBookmarkWidths = new Map(content.bookmarks.map((b) => [b.bookmarkId, b.to - b.from]));
        noteState.latestContent = content;
        noteState.loaded = true;
        refreshRtlLineDecorations(editor, model);

        const targetBookmarkId = useVaultStore.getState().activeBookmarkId;
        const target = targetBookmarkId ? content.bookmarks.find((b) => b.bookmarkId === targetBookmarkId) : undefined;
        if (target) {
          const pos = model.getPositionAt(target.from);
          editor.revealLineInCenter(pos.lineNumber, monaco.editor.ScrollType.Immediate);
        }
        refreshToolbarState();
      }).catch((e) => {
        if (cancelled) return;
        console.error(`Failed to load note content for ${fileId}:`, e);
        // noteState.loaded deliberately stays false: it gates every save (debounced
        // autosave, and the flush-on-navigate-away in this effect's cleanup), and a
        // decrypt failure is frequently transient/recoverable (e.g. a sync tool
        // corrupting bytes on disk while the original content is still recoverable
        // from a prior version/backup elsewhere). Auto-resetting to a blank note and
        // marking it loaded — the previous behavior here — actively destroyed the
        // real content by persisting the blank state over it on the very next
        // autosave. Better to leave this note un-editable and unsaved than to
        // silently commit a guess that erases something we can't get back.
        editor.updateOptions({ readOnly: true });
        useVaultStore.setState({
          error: `"${fileName}" could not be read (its stored data is corrupted). Editing is disabled for this note so nothing gets overwritten — the previous content may still be recoverable from a backup. Do not delete this note.`,
        });
      });
    } else {
      // A duplicate view attaching to an already-open, already-loaded note:
      // reuse the existing shared state as-is (no content load needed).
      setAttachments(noteState.attachments);
      if (noteState.loaded) {
        refreshRtlLineDecorations(editor, noteState.model);
        refreshToolbarState();
      }
    }

    return () => {
      cancelled = true;
      mountedRef.current = false;
      unregisterAttachmentUpdateHandler(fileId);
      editorDomNode?.removeEventListener("paste", handlePaste, true);
      editorDomNode?.removeEventListener("keydown", handleNativePasteKey, true);
      inlineImageView.dispose();
      stopThemeWatch();
      for (const d of disposables) d.dispose();
      if (rejectTimer.current) {
        clearTimeout(rejectTimer.current);
        rejectTimer.current = null;
      }
      if (noteState.loaded) flushSaveNow(fileId);
      noteState.onEntangledShrink = null;
      editor.dispose();
      releaseNoteModel(fileId);
      editorRef.current = null;
      noteStateRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!editorReady || !noteStateRef.current?.loaded || !activeBookmarkId) return;
    const editor = editorRef.current;
    const noteState = noteStateRef.current;
    const model = editor?.getModel();
    if (!editor || !model || !noteState) return;
    const idx = noteState.bookmarkMeta.findIndex((m) => m.bookmarkId === activeBookmarkId);
    if (idx === -1) return;
    const range = getDecorationRanges(model, noteState.bookmarkDecoIds)[idx];
    if (!range) return;
    editor.revealLineInCenter(range.getStartPosition().lineNumber, monaco.editor.ScrollType.Smooth);
  }, [activeBookmarkId, editorReady]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !editorReady) return;
    editor.updateOptions({ fontSize: BASE_FONT_SIZE * (editorZoom / chromeZoom) });
    editor.layout();
  }, [editorZoom, chromeZoom, editorReady]);

  useEffect(() => {
    function down(e: KeyboardEvent) {
      if (e.key === "Control" || e.key === "Meta") document.body.classList.add("ctrl-pressed");
    }
    function up(e: KeyboardEvent) {
      if (e.key === "Control" || e.key === "Meta") document.body.classList.remove("ctrl-pressed");
    }
    function clear() {
      document.body.classList.remove("ctrl-pressed");
    }
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
      document.body.classList.remove("ctrl-pressed");
    };
  }, []);

  function getSelectionRange(): monaco.Range | null {
    const editor = editorRef.current;
    const selection = editor?.getSelection();
    if (!editor || !selection || selection.isEmpty()) return null;
    return selection;
  }

  function getSelectedText(): string {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const range = getSelectionRange();
    if (!editor || !model || !range) return "";
    return model.getValueInRange(range);
  }

  function handleCreateBookmark(label: string) {
    const editor = editorRef.current;
    const noteState = noteStateRef.current;
    const model = editor?.getModel();
    const range = getSelectionRange();
    if (!editor || !model || !range || !noteState) return;
    const bookmarkId = crypto.randomUUID();
    noteState.bookmarkMeta = [...noteState.bookmarkMeta, { bookmarkId, label }];
    const ranges = [...getDecorationRanges(model, noteState.bookmarkDecoIds).filter((r): r is monaco.Range => !!r), range];
    setBookmarkDecorations(noteState, ranges);
    noteState.prevBookmarkWidths.set(bookmarkId, model.getOffsetAt(range.getEndPosition()) - model.getOffsetAt(range.getStartPosition()));
    addBookmarkToIndex(bookmarkId, fileId);
    setShowNewBookmarkPopup(false);
    editor.focus();
  }

  function handleCreateLink(targetBookmarkId: string) {
    const editor = editorRef.current;
    const noteState = noteStateRef.current;
    const range = getSelectionRange();
    if (!editor || !range || !noteState) return;
    const linkId = crypto.randomUUID();
    noteState.linkMeta = [...noteState.linkMeta, { linkId, targetBookmarkId, broken: false }];
    const ranges = [...getDecorationRanges(noteState.model, noteState.linkDecoIds).filter((r): r is monaco.Range => !!r), range];
    setLinkDecorations(noteState, ranges);
    addReferrerToIndex(targetBookmarkId, fileId);
    setShowLinkPicker(false);
    editor.focus();
  }

  function handleDeleteBookmarkAnyway() {
    if (!pendingBookmarkDeletion) return;

    if (pendingBookmarkDeletion.kind === "explicit") {
      for (const id of pendingBookmarkDeletion.entangledIds) removeBookmarkMark(id);
      setPendingBookmarkDeletion(null);
      return;
    }

    const noteState = noteStateRef.current;
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || !noteState) return;
    noteState.skipShrinkCheckOnce = true;
    noteState.model.redo();
    const ranges = getDecorationRanges(model, noteState.bookmarkDecoIds);
    for (const id of pendingBookmarkDeletion.entangledIds) {
      const idx = noteState.bookmarkMeta.findIndex((m) => m.bookmarkId === id);
      const r = idx >= 0 ? ranges[idx] : undefined;
      const width = r ? model.getOffsetAt(r.getEndPosition()) - model.getOffsetAt(r.getStartPosition()) : 0;
      if (width === 0) removeBookmarkFromIndex(id);
    }
    setPendingBookmarkDeletion(null);
  }

  function handleBookmarkButtonClick() {
    const toolbarState = toolbarStateRef.current;
    const mode = toolbarState?.bookmarkMode ?? "disabled";
    if (mode === "create") {
      setShowNewBookmarkPopup(true);
      return;
    }
    if (mode === "remove" && toolbarState?.bookmarkRemoveId) {
      const id = toolbarState.bookmarkRemoveId;
      const referrers = useVaultStore.getState().vault?.index[id]?.referrers ?? [];
      if (referrers.length > 0) {
        setPendingBookmarkDeletion({ kind: "explicit", shrunkIds: [id], entangledIds: [id] });
      } else {
        removeBookmarkMark(id);
      }
    }
  }

  function handleLinkButtonClick() {
    const toolbarState = toolbarStateRef.current;
    const mode = toolbarState?.linkMode ?? "disabled";
    if (mode === "create") {
      setShowLinkPicker(true);
      return;
    }
    if (mode === "remove" && toolbarState?.linkRemoveId) {
      removeLinkMark(toolbarState.linkRemoveId);
    }
  }

  async function handleAddAttachments(fileList: FileList | File[]) {
    const files = Array.from(fileList);
    const accepted = files.filter((f) => f.size <= MAX_ATTACHMENT_BYTES);
    const rejected = files.filter((f) => f.size > MAX_ATTACHMENT_BYTES).map((f) => f.name);

    if (rejected.length > 0) {
      setRejectedNames(rejected);
      if (rejectTimer.current) clearTimeout(rejectTimer.current);
      rejectTimer.current = setTimeout(() => setRejectedNames([]), 4000);
    }
    if (accepted.length === 0) return;

    const noteState = noteStateRef.current;
    if (!noteState) return;
    // Reserve this note's save slot synchronously, before the FileReader-based
    // read below, so a fast switch-away-and-back can't have a freshly mounted
    // Editor for this note load in between the read finishing and this saving
    // — its loadNodeContent call would see this reservation and wait for it.
    await useVaultStore.getState().runExclusive(fileId, async () => {
      const newAttachments = await Promise.all(accepted.map(fileToAttachment));
      const next = [...noteState.attachments, ...newAttachments];
      noteState.attachments = next;
      if (mountedRef.current) setAttachments(next);
      await useVaultStore.getState().saveNodeContentRaw(fileId, { ...noteState.latestContent, attachments: next });
    });
  }

  function handleConfirmDeleteAttachment() {
    const noteState = noteStateRef.current;
    if (!pendingDeleteAttachment || !noteState) return;
    const next = noteState.attachments.filter((a) => a.id !== pendingDeleteAttachment.id);
    noteState.attachments = next;
    setAttachments(next);
    flushSaveNow(fileId);
    void stopWatchForAttachment(fileId, pendingDeleteAttachment.id);
    setPendingDeleteAttachment(null);
  }

  async function handleOpenAttachment(attachment: Attachment) {
    try {
      await openAndWatchAttachment(fileId, attachment);
    } catch (e) {
      console.error("Failed to open attachment:", e);
    }
  }

  async function handleSaveAttachmentAs(attachment: Attachment) {
    try {
      const destPath = await save({ defaultPath: attachment.name });
      if (!destPath) return;
      await invoke("save_attachment_to_path", { destPath, dataB64: attachment.data });
    } catch (e) {
      console.error("Failed to save attachment:", e);
    }
  }

  function handleDragEnter(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (!e.dataTransfer.types.includes("Files")) return;
    dragCounter.current += 1;
    setIsDragOver(true);
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
  }

  function handleDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setIsDragOver(false);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    dragCounter.current = 0;
    setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) handleAddAttachments(e.dataTransfer.files);
  }

  return (
    <div
      className="editor"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {rejectedNames.length > 0 && (
        <p className="attachment-reject-msg">
          {rejectedNames.length === 1
            ? `"${rejectedNames[0]}" exceeds the 10MB attachment limit.`
            : `${rejectedNames.length} files exceed the 10MB attachment limit.`}
        </p>
      )}
      <AttachmentRow
        attachments={attachments}
        onOpen={handleOpenAttachment}
        onRequestDelete={setPendingDeleteAttachment}
        onSaveAs={handleSaveAttachmentAs}
      />

      <div
        ref={containerRef}
        className="editor-content monaco-host"
      />

      {isDragOver && (
        <div className="drop-overlay">
          <UploadCloud size={40} />
          <span className="drop-overlay-text">Drop files here</span>
        </div>
      )}

      {showNewBookmarkPopup && (
        <NewBookmarkPopup
          defaultLabel={getSelectedText()}
          onSubmit={handleCreateBookmark}
          onCancel={() => setShowNewBookmarkPopup(false)}
        />
      )}
      {showLinkPicker && (
        <BookmarkPickerPopup onSubmit={handleCreateLink} onCancel={() => setShowLinkPicker(false)} />
      )}
      {pendingBookmarkDeletion && !showReferrers && (
        <ConfirmDialog
          title="Bookmark is linked"
          message={
            pendingBookmarkDeletion.entangledIds.length > 1
              ? "Other files link to these bookmarks. Deleting them will break those links."
              : "Other files link to this bookmark. Deleting it will break those links."
          }
          actions={[
            { label: "Show who points here", icon: <Link2 size={15} />, onClick: () => setShowReferrers(true) },
            {
              label: "Delete anyway",
              icon: <Trash2 size={15} />,
              onClick: handleDeleteBookmarkAnyway,
              variant: "danger",
            },
          ]}
          onCancel={() => setPendingBookmarkDeletion(null)}
        />
      )}
      {showReferrers && pendingBookmarkDeletion && (
        <ReferrersPopup bookmarkIds={pendingBookmarkDeletion.entangledIds} onClose={() => setShowReferrers(false)} />
      )}
      {pendingDeleteAttachment && (
        <ConfirmDialog
          title="Delete attachment?"
          message={`Remove "${pendingDeleteAttachment.name}" from this note? This can't be undone.`}
          actions={[
            {
              label: "Delete",
              icon: <Trash2 size={15} />,
              onClick: handleConfirmDeleteAttachment,
              variant: "danger",
            },
          ]}
          onCancel={() => setPendingDeleteAttachment(null)}
        />
      )}
    </div>
  );
}
