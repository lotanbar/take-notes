import { invoke } from "@tauri-apps/api/core";
import type { monaco } from "./monacoSetup";

export function editorClipboardText(editor: monaco.editor.IStandaloneCodeEditor): string | null {
  const model = editor.getModel();
  const selections = editor.getSelections();
  if (!model || !selections?.length) return null;

  return selections
    .map((selection) => {
      if (!selection.isEmpty()) return model.getValueInRange(selection);
      return model.getLineContent(selection.positionLineNumber) + model.getEOL();
    })
    .join("");
}

export async function copyEditorSelectionToNativeClipboard(
  editor: monaco.editor.IStandaloneCodeEditor,
): Promise<boolean> {
  if (!("__TAURI_INTERNALS__" in window)) return false;
  const text = editorClipboardText(editor);
  if (text === null) return false;
  await invoke<void>("write_native_clipboard", { text });
  return true;
}
