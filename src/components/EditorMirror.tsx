import { useEffect, useRef, useState } from "react";
import { monaco, currentThemeName, watchThemeChanges, registerIndentCarryingEnter } from "../editor/monacoSetup";
import { acquireNoteModel, releaseNoteModel, flushSaveNow } from "../editor/noteModel";
import { useVaultStore } from "../store/vaultStore";
import { useZoomStore } from "../store/zoomStore";
import { detectDirection } from "../lib/textDirection";
import { clipboardImageFiles, mountInlineImageView, pasteInlineImages, pasteNativeClipboard } from "../editor/inlineImages";

const BASE_FONT_SIZE = 12;
const STICKINESS = monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges;

interface EditorMirrorProps {
  fileId: string;
  fileName: string;
}

// A second, independent view of a note that's already open in a full Editor
// tab (created via that tab's "Duplicate" action), attached to the same
// shared Monaco model so edits made in either view appear instantly in both.
// Deliberately has no bookmark/link/attachment UI — those stay the full
// Editor's responsibility (see noteModel.ts) — this is a plain text view for
// editing two spots in the same note side by side.
export function EditorMirror({ fileId }: EditorMirrorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const rtlLineDecosRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const chromeZoom = useZoomStore((s) => s.chromeZoom);
  const editorZoom = useZoomStore((s) => s.editorZoom);
  const [editorReady, setEditorReady] = useState(false);


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

  useEffect(() => {
    if (!containerRef.current) return;

    // The primary Editor for this file must already be mounted (Duplicate is
    // only offered from an existing tab), so this is always attaching to an
    // already-loaded, already-populated model — no content load needed here.
    const { state: noteState } = acquireNoteModel(fileId);

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
    const editorId = editor.getId();
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
    refreshRtlLineDecorations(editor, noteState.model);

    const stopThemeWatch = watchThemeChanges((theme) => editor.updateOptions({ theme }));
    const contentSub = editor.onDidChangeModelContent(() => {
      const model = editor.getModel();
      if (model) refreshRtlLineDecorations(editor, model);
    });
    const pasteSub = editor.onDidPaste((event) => {
      const files = clipboardImageFiles(event.clipboardEvent);
      if (files.length > 0) {
        void pasteInlineImages(editor, noteState, files).catch((error) => {
          useVaultStore.setState({ error: String(error) });
        });
      }
    });

    return () => {
      stopThemeWatch();
      contentSub.dispose();
      pasteSub.dispose();
      editorDomNode?.removeEventListener("paste", handlePaste, true);
      editorDomNode?.removeEventListener("keydown", handleNativePasteKey, true);
      inlineImageView.dispose();
      if (noteState.loaded) flushSaveNow(fileId);
      editor.dispose();
      releaseNoteModel(fileId);
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !editorReady) return;
    editor.updateOptions({ fontSize: BASE_FONT_SIZE * (editorZoom / chromeZoom) });
    editor.layout();
  }, [editorZoom, chromeZoom, editorReady]);

  return (
    <div className="editor editor-mirror">
      <div ref={containerRef} className="editor-content monaco-host" />
    </div>
  );
}
