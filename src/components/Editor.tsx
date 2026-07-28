import { useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import {
  Bookmark as BookmarkIcon,
  Link2,
  ArrowLeft,
  ArrowRight,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { monaco, registerIndentCarryingEnter, currentThemeName, watchThemeChanges } from "../editor/monacoSetup";
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
import type { Attachment, NodeContent } from "../types/vault";
import { ConfirmDialog } from "./ConfirmDialog";
import { NewBookmarkPopup } from "./NewBookmarkPopup";
import { BookmarkPickerPopup } from "./BookmarkPickerPopup";
import { ReferrersPopup } from "./ReferrersPopup";
import { AttachmentRow } from "./AttachmentRow";

const SAVE_DEBOUNCE_MS = 500;
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

interface BookmarkMeta {
  bookmarkId: string;
  label: string;
}

interface LinkMeta {
  linkId: string;
  targetBookmarkId: string;
  broken: boolean;
}

interface ToolbarState {
  bookmarkMode: MarkMode;
  bookmarkRemoveId?: string;
  linkMode: MarkMode;
  linkRemoveId?: string;
}

const EMPTY_CONTENT: NodeContent = { text: "", bookmarks: [], links: [], attachments: [] };

export function Editor({ fileId, fileName }: EditorProps) {
  const loadNodeContent = useVaultStore((s) => s.loadNodeContent);
  const runExclusive = useVaultStore((s) => s.runExclusive);
  const saveNodeContentRaw = useVaultStore((s) => s.saveNodeContentRaw);
  const addBookmarkToIndex = useVaultStore((s) => s.addBookmarkToIndex);
  const removeBookmarkFromIndex = useVaultStore((s) => s.removeBookmarkFromIndex);
  const addReferrerToIndex = useVaultStore((s) => s.addReferrerToIndex);
  const removeReferrerFromIndex = useVaultStore((s) => s.removeReferrerFromIndex);
  const activeBookmarkId = useVaultStore((s) => s.activeBookmarkId);
  const navBack = useVaultStore((s) => s.navBack);
  const navForward = useVaultStore((s) => s.navForward);
  const goBack = useVaultStore((s) => s.goBack);
  const goForward = useVaultStore((s) => s.goForward);
  const uiZoom = useZoomStore((s) => s.uiZoom);
  const editorZoom = useZoomStore((s) => s.editorZoom);

  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const bookmarkDecosRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const linkDecosRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const rtlLineDecosRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const bookmarkMetaRef = useRef<BookmarkMeta[]>([]);
  const linkMetaRef = useRef<LinkMeta[]>([]);
  const latestContentRef = useRef<NodeContent>(EMPTY_CONTENT);
  const latestAttachments = useRef<Attachment[]>([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragCounter = useRef(0);
  const rejectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedRef = useRef(false);
  const mountedRef = useRef(true);
  const editedBeforeLoadRef = useRef(false);
  const prevBookmarkWidthsRef = useRef<Map<string, number>>(new Map());
  const skipBookmarkCheckRef = useRef(false);

  const [editorReady, setEditorReady] = useState(false);
  const [toolbarState, setToolbarState] = useState<ToolbarState | null>(null);
  const [showNewBookmarkPopup, setShowNewBookmarkPopup] = useState(false);
  const [showLinkPicker, setShowLinkPicker] = useState(false);
  const [pendingBookmarkDeletion, setPendingBookmarkDeletion] = useState<PendingBookmarkDeletion | null>(null);
  const [showReferrers, setShowReferrers] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [pendingDeleteAttachment, setPendingDeleteAttachment] = useState<Attachment | null>(null);
  const [rejectedNames, setRejectedNames] = useState<string[]>([]);

  function flushSave() {
    if (!loadedRef.current) return;
    // Read the refs lazily, inside the work callback, rather than building the
    // content object here: if this ends up queued behind another pending save
    // for this note (see runExclusive in vaultStore.ts), building it eagerly
    // would capture a stale snapshot instead of whatever those refs hold by
    // the time this actually gets to run.
    runExclusive(fileId, () =>
      saveNodeContentRaw(fileId, { ...latestContentRef.current, attachments: latestAttachments.current }),
    );
  }

  function refreshToolbarState() {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const selection = editor.getSelection();
    const hasSelection = !!selection && !selection.isEmpty();
    const selFrom = selection ? model.getOffsetAt(selection.getStartPosition()) : 0;
    const selTo = selection ? model.getOffsetAt(selection.getEndPosition()) : 0;

    const bookmarkRanges = (bookmarkDecosRef.current?.getRanges() ?? []).map((r, i) => ({
      id: bookmarkMetaRef.current[i]?.bookmarkId,
      from: model.getOffsetAt(r.getStartPosition()),
      to: model.getOffsetAt(r.getEndPosition()),
    }));
    const linkRanges = (linkDecosRef.current?.getRanges() ?? []).map((r, i) => ({
      id: linkMetaRef.current[i]?.linkId,
      from: model.getOffsetAt(r.getStartPosition()),
      to: model.getOffsetAt(r.getEndPosition()),
    }));

    const bookmark = hasSelection ? computeMarkMode(selFrom, selTo, bookmarkRanges) : { mode: "disabled" as const };
    const link = hasSelection ? computeMarkMode(selFrom, selTo, linkRanges) : { mode: "disabled" as const };

    setToolbarState({
      bookmarkMode: bookmark.mode,
      bookmarkRemoveId: bookmark.id,
      linkMode: link.mode,
      linkRemoveId: link.id,
    });
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

  function rebuildBookmarkDecorations(editor: monaco.editor.IStandaloneCodeEditor, ranges: monaco.Range[]) {
    const decos = ranges.map((range) => ({ range, options: { inlineClassName: "bookmark-anchor", stickiness: STICKINESS } }));
    if (bookmarkDecosRef.current) bookmarkDecosRef.current.set(decos);
    else bookmarkDecosRef.current = editor.createDecorationsCollection(decos);
  }

  function rebuildLinkDecorations(editor: monaco.editor.IStandaloneCodeEditor, ranges: monaco.Range[]) {
    const decos = ranges.map((range, i) => ({
      range,
      options: {
        inlineClassName: linkMetaRef.current[i]?.broken ? "link-anchor link-anchor-broken" : "link-anchor",
        stickiness: STICKINESS,
      },
    }));
    if (linkDecosRef.current) linkDecosRef.current.set(decos);
    else linkDecosRef.current = editor.createDecorationsCollection(decos);
  }

  function removeBookmarkMark(bookmarkId: string) {
    const editor = editorRef.current;
    if (!editor) return;
    const idx = bookmarkMetaRef.current.findIndex((m) => m.bookmarkId === bookmarkId);
    if (idx === -1) return;
    const ranges = (bookmarkDecosRef.current?.getRanges() ?? []).filter((_, i) => i !== idx);
    bookmarkMetaRef.current = bookmarkMetaRef.current.filter((_, i) => i !== idx);
    prevBookmarkWidthsRef.current.delete(bookmarkId);
    rebuildBookmarkDecorations(editor, ranges);
    removeBookmarkFromIndex(bookmarkId);
    refreshToolbarState();
  }

  function removeLinkMark(linkId: string) {
    const editor = editorRef.current;
    if (!editor) return;
    const idx = linkMetaRef.current.findIndex((m) => m.linkId === linkId);
    if (idx === -1) return;
    const meta = linkMetaRef.current[idx];
    const ranges = (linkDecosRef.current?.getRanges() ?? []).filter((_, i) => i !== idx);
    linkMetaRef.current = linkMetaRef.current.filter((_, i) => i !== idx);
    rebuildLinkDecorations(editor, ranges);
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

    registerAttachmentUpdateHandler(fileId, (attachmentId, dataB64, size) => {
      const next = latestAttachments.current.map((a) =>
        a.id === attachmentId ? { ...a, data: dataB64, size } : a,
      );
      latestAttachments.current = next;
      if (mountedRef.current) setAttachments(next);
      latestContentRef.current = { ...latestContentRef.current, attachments: next };
      flushSave();
    });

    const editor = monaco.editor.create(containerRef.current, {
      value: "",
      language: "plaintext",
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
    setEditorReady(true);

    const stopThemeWatch = watchThemeChanges((theme) => editor.updateOptions({ theme }));

    const disposables = [
      editor.onDidChangeModelContent(() => {
        if (!loadedRef.current) {
          // The user typed/pasted before the async loadNodeContent below resolved.
          // Flag it so that callback preserves what's in the model instead of
          // stomping it with the (now-stale) loaded content.
          editedBeforeLoadRef.current = true;
          return;
        }
        const model = editor.getModel();
        if (!model) return;

        const bookmarkRanges = bookmarkDecosRef.current?.getRanges() ?? [];
        const nextBookmarks = bookmarkMetaRef.current.map((meta, i) => {
          const r = bookmarkRanges[i];
          return {
            bookmarkId: meta.bookmarkId,
            label: meta.label,
            from: r ? model.getOffsetAt(r.getStartPosition()) : 0,
            to: r ? model.getOffsetAt(r.getEndPosition()) : 0,
          };
        });

        const linkRanges = linkDecosRef.current?.getRanges() ?? [];
        const nextLinks = linkMetaRef.current.map((meta, i) => {
          const r = linkRanges[i];
          return {
            linkId: meta.linkId,
            targetBookmarkId: meta.targetBookmarkId,
            from: r ? model.getOffsetAt(r.getStartPosition()) : 0,
            to: r ? model.getOffsetAt(r.getEndPosition()) : 0,
          };
        });

        if (!skipBookmarkCheckRef.current) {
          const shrunkIds: string[] = [];
          for (const b of nextBookmarks) {
            const prevWidth = prevBookmarkWidthsRef.current.get(b.bookmarkId) ?? 0;
            if (b.to - b.from < prevWidth) shrunkIds.push(b.bookmarkId);
          }
          if (shrunkIds.length > 0) {
            const currentIndex = useVaultStore.getState().vault?.index ?? {};
            const entangledIds = shrunkIds.filter((id) => (currentIndex[id]?.referrers.length ?? 0) > 0);
            if (entangledIds.length > 0) {
              editor.trigger("source", "undo", null);
              setPendingBookmarkDeletion({ kind: "shrink", shrunkIds, entangledIds });
              return;
            }
            for (const id of shrunkIds) {
              const b = nextBookmarks.find((x) => x.bookmarkId === id);
              if (b && b.to - b.from === 0) useVaultStore.getState().removeBookmarkFromIndex(id);
            }
          }
        }
        skipBookmarkCheckRef.current = false;
        prevBookmarkWidthsRef.current = new Map(nextBookmarks.map((b) => [b.bookmarkId, b.to - b.from]));

        latestContentRef.current = {
          text: model.getValue(),
          bookmarks: nextBookmarks,
          links: nextLinks,
          attachments: latestAttachments.current,
        };
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(flushSave, SAVE_DEBOUNCE_MS);

        refreshRtlLineDecorations(editor, model);
        refreshToolbarState();
      }),
      editor.onDidChangeCursorSelection(() => refreshToolbarState()),
      editor.onMouseDown((e: monaco.editor.IEditorMouseEvent) => {
        if (!(e.event.ctrlKey || e.event.metaKey)) return;
        if (!e.target.position) return;
        const model = editor.getModel();
        if (!model) return;
        const offset = model.getOffsetAt(e.target.position);
        const ranges = linkDecosRef.current?.getRanges() ?? [];
        for (let i = 0; i < ranges.length; i++) {
          const from = model.getOffsetAt(ranges[i].getStartPosition());
          const to = model.getOffsetAt(ranges[i].getEndPosition());
          if (offset >= from && offset <= to) {
            useVaultStore.getState().navigateToBookmark(linkMetaRef.current[i].targetBookmarkId);
            return;
          }
        }
      }),
    ];

    loadNodeContent(fileId).then((result) => {
      if (cancelled) return;
      const model = editor.getModel();
      if (!model) return;

      if (editedBeforeLoadRef.current) {
        // Don't overwrite what the user already typed/pasted while this load
        // was in flight. Its bookmarks/links refer to offsets in the old text,
        // which no longer apply, so treat the current buffer as a fresh,
        // mark-less note; attachments are unaffected by text edits, so keep those.
        const attachments = result?.attachments ?? [];
        latestAttachments.current = attachments;
        setAttachments(attachments);
        bookmarkMetaRef.current = [];
        rebuildBookmarkDecorations(editor, []);
        linkMetaRef.current = [];
        rebuildLinkDecorations(editor, []);
        prevBookmarkWidthsRef.current = new Map();
        latestContentRef.current = { text: model.getValue(), bookmarks: [], links: [], attachments };
        loadedRef.current = true;
        refreshRtlLineDecorations(editor, model);
        refreshToolbarState();
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
        return;
      }

      const content = result ?? EMPTY_CONTENT;
      model.setValue(content.text);

      const index = useVaultStore.getState().vault?.index ?? {};
      bookmarkMetaRef.current = content.bookmarks.map((b) => ({ bookmarkId: b.bookmarkId, label: b.label }));
      rebuildBookmarkDecorations(
        editor,
        content.bookmarks.map((b) => monaco.Range.fromPositions(model.getPositionAt(b.from), model.getPositionAt(b.to))),
      );
      linkMetaRef.current = content.links.map((l) => ({
        linkId: l.linkId,
        targetBookmarkId: l.targetBookmarkId,
        broken: isLinkBroken(l, index),
      }));
      rebuildLinkDecorations(
        editor,
        content.links.map((l) => monaco.Range.fromPositions(model.getPositionAt(l.from), model.getPositionAt(l.to))),
      );

      latestAttachments.current = content.attachments;
      setAttachments(content.attachments);
      prevBookmarkWidthsRef.current = new Map(content.bookmarks.map((b) => [b.bookmarkId, b.to - b.from]));
      latestContentRef.current = content;
      loadedRef.current = true;
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
      // loadedRef.current deliberately stays false: it gates every save (debounced
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

    return () => {
      cancelled = true;
      mountedRef.current = false;
      unregisterAttachmentUpdateHandler(fileId);
      stopThemeWatch();
      for (const d of disposables) d.dispose();
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      if (rejectTimer.current) {
        clearTimeout(rejectTimer.current);
        rejectTimer.current = null;
      }
      if (loadedRef.current) flushSave();
      const model = editor.getModel();
      editor.dispose();
      model?.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!editorReady || !loadedRef.current || !activeBookmarkId) return;
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const idx = bookmarkMetaRef.current.findIndex((m) => m.bookmarkId === activeBookmarkId);
    if (idx === -1) return;
    const range = (bookmarkDecosRef.current?.getRanges() ?? [])[idx];
    if (!range) return;
    editor.revealLineInCenter(range.getStartPosition().lineNumber, monaco.editor.ScrollType.Smooth);
  }, [activeBookmarkId, editorReady]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !editorReady) return;
    editor.updateOptions({ fontSize: BASE_FONT_SIZE * (editorZoom / uiZoom) });
    editor.layout();
  }, [editorZoom, uiZoom, editorReady]);

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
    const model = editor?.getModel();
    const range = getSelectionRange();
    if (!editor || !model || !range) return;
    const bookmarkId = crypto.randomUUID();
    bookmarkMetaRef.current = [...bookmarkMetaRef.current, { bookmarkId, label }];
    const ranges = [...(bookmarkDecosRef.current?.getRanges() ?? []), range];
    rebuildBookmarkDecorations(editor, ranges);
    prevBookmarkWidthsRef.current.set(bookmarkId, model.getOffsetAt(range.getEndPosition()) - model.getOffsetAt(range.getStartPosition()));
    addBookmarkToIndex(bookmarkId, fileId);
    setShowNewBookmarkPopup(false);
    editor.focus();
  }

  function handleCreateLink(targetBookmarkId: string) {
    const editor = editorRef.current;
    const range = getSelectionRange();
    if (!editor || !range) return;
    const linkId = crypto.randomUUID();
    linkMetaRef.current = [...linkMetaRef.current, { linkId, targetBookmarkId, broken: false }];
    const ranges = [...(linkDecosRef.current?.getRanges() ?? []), range];
    rebuildLinkDecorations(editor, ranges);
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

    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    skipBookmarkCheckRef.current = true;
    editor.trigger("source", "redo", null);
    const ranges = bookmarkDecosRef.current?.getRanges() ?? [];
    for (const id of pendingBookmarkDeletion.entangledIds) {
      const idx = bookmarkMetaRef.current.findIndex((m) => m.bookmarkId === id);
      const r = idx >= 0 ? ranges[idx] : undefined;
      const width = r ? model.getOffsetAt(r.getEndPosition()) - model.getOffsetAt(r.getStartPosition()) : 0;
      if (width === 0) removeBookmarkFromIndex(id);
    }
    setPendingBookmarkDeletion(null);
  }

  function handleBookmarkButtonClick() {
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

    // Reserve this note's save slot synchronously, before the FileReader-based
    // read below, so a fast switch-away-and-back can't have a freshly mounted
    // Editor for this note load in between the read finishing and this saving
    // — its loadNodeContent call would see this reservation and wait for it.
    await runExclusive(fileId, async () => {
      const newAttachments = await Promise.all(accepted.map(fileToAttachment));
      const next = [...latestAttachments.current, ...newAttachments];
      latestAttachments.current = next;
      if (mountedRef.current) setAttachments(next);
      await saveNodeContentRaw(fileId, { ...latestContentRef.current, attachments: next });
    });
  }

  function handleConfirmDeleteAttachment() {
    if (!pendingDeleteAttachment) return;
    const next = latestAttachments.current.filter((a) => a.id !== pendingDeleteAttachment.id);
    latestAttachments.current = next;
    setAttachments(next);
    flushSave();
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

  const titleDir = detectDirection(fileName);

  return (
    <div
      className="editor"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="editor-toolbar">
        <button
          className="icon-btn"
          onClick={handleBookmarkButtonClick}
          disabled={(toolbarState?.bookmarkMode ?? "disabled") === "disabled"}
          title={toolbarState?.bookmarkMode === "remove" ? "Remove Bookmark" : "New Bookmark"}
        >
          <BookmarkIcon size={24} />
        </button>
        <button
          className="icon-btn"
          onClick={handleLinkButtonClick}
          disabled={(toolbarState?.linkMode ?? "disabled") === "disabled"}
          title={toolbarState?.linkMode === "remove" ? "Remove Link" : "New Link"}
        >
          <Link2 size={24} />
        </button>

        <span className="toolbar-divider spacer-left" />

        <button className="icon-btn" onClick={goBack} disabled={navBack.length === 0} title="Back">
          <ArrowLeft size={24} />
        </button>
        <button className="icon-btn" onClick={goForward} disabled={navForward.length === 0} title="Forward">
          <ArrowRight size={24} />
        </button>
      </div>

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

      <div className="editor-filename" dir={titleDir}>{fileName}</div>
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
