import type { IDockviewPanelProps } from "dockview-react";
import { Editor } from "./Editor";
import { EditorMirror } from "./EditorMirror";

export interface NotePanelParams {
  fileId: string;
  fileName: string;
  // True for a duplicate/mirror view created via a tab's "Duplicate" action —
  // see EditorMirror and editor/noteModel.ts.
  mirror?: boolean;
}

export function EditorPanel(props: IDockviewPanelProps<NotePanelParams>) {
  const { fileId, fileName, mirror } = props.params;
  return mirror ? <EditorMirror fileId={fileId} fileName={fileName} /> : <Editor fileId={fileId} fileName={fileName} />;
}
