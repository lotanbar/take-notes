import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
// editor.api.js only exports the base namespace (Range, Position, KeyCode, ...).
// Folding, multi-cursor, move-lines, etc. are separate editor *contributions*
// that only register their commands/keybindings if imported for side effects —
// this is a different axis from the per-language grammars/workers we're still
// avoiding (those live under vs/basic-languages and vs/language, untouched here).
import "monaco-editor/esm/vs/editor/editor.all.js";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker.js?worker";

// Vite-native worker wiring — no bundler plugin needed. Since every note is
// plaintext (no language services), this base worker only ever backs generic
// editor features (e.g. word-based suggestions), never TS/CSS/etc. workers.
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};

interface ThemeColors {
  bg1: string;
  bg2: string;
  border: string;
  text0: string;
  text2: string;
}

// Mirrors the --bg-1/--bg-2/--border/--text-0/--text-2 custom properties in App.css.
// Monaco themes need literal colors (no CSS custom properties), so light/dark are
// defined up front and swapped based on prefers-color-scheme, same trigger the CSS uses.
const LIGHT_COLORS: ThemeColors = {
  bg1: "#f4f4f5",
  bg2: "#e5e5e8",
  border: "#d2d2d7",
  text0: "#000000",
  text2: "#6b6b74",
};

const DARK_COLORS: ThemeColors = {
  bg1: "#141416",
  bg2: "#2c2c32",
  border: "#4a4a52",
  text0: "#ffffff",
  text2: "#9a9aa3",
};

const LIGHT_THEME = "vault-notes-light";
const DARK_THEME = "vault-notes-dark";

function defineTheme(name: string, base: "vs" | "vs-dark", colors: ThemeColors) {
  monaco.editor.defineTheme(name, {
    base,
    inherit: true,
    rules: [],
    colors: {
      "editor.background": colors.bg1,
      "editor.foreground": colors.text0,
      "editor.lineHighlightBackground": colors.bg2,
      "editorLineNumber.foreground": colors.text2,
      "editorLineNumber.activeForeground": colors.text0,
      "editorIndentGuide.background1": colors.border,
      "editorIndentGuide.activeBackground1": colors.text2,
      "editorCursor.foreground": colors.text0,
    },
  });
}

defineTheme(LIGHT_THEME, "vs", LIGHT_COLORS);
defineTheme(DARK_THEME, "vs-dark", DARK_COLORS);

export function currentThemeName(): string {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? DARK_THEME : LIGHT_THEME;
}

export function watchThemeChanges(onChange: (theme: string) => void): () => void {
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => onChange(currentThemeName());
  mql.addEventListener("change", handler);
  return () => mql.removeEventListener("change", handler);
}

// Enter inherits the current line's leading whitespace (matches the previous
// Tiptap behavior): a non-empty line carries its indentation forward, a
// whitespace-only line is cleared instead of growing, selections just insert
// a plain newline.
export function registerIndentCarryingEnter(editor: monaco.editor.IStandaloneCodeEditor) {
  // addCommand() registers against Monaco's shared keybinding service, so the
  // most recently created pane would handle Enter even when another pane had
  // focus. addAction() automatically adds this editor's id as a precondition.
  editor.addAction({
    id: `vault-notes.indent-enter.${editor.getId()}`,
    label: "Insert Line Break",
    keybindings: [monaco.KeyCode.Enter],
    keybindingContext: "editorTextFocus",
    run: (activeEditor) => {
      const model = activeEditor.getModel();
      const selection = activeEditor.getSelection();
      if (!model || !selection) return;

      if (!selection.isEmpty()) {
        activeEditor.executeEdits("indent-enter", [{ range: selection, text: "\n" }]);
        return;
      }

      const lineNumber = selection.positionLineNumber;
      const lineContent = model.getLineContent(lineNumber);

      if (/^\s*$/.test(lineContent)) {
        if (lineContent.length === 0) {
          activeEditor.executeEdits("indent-enter", [{ range: selection, text: "\n" }]);
          activeEditor.setPosition({ lineNumber: lineNumber + 1, column: 1 });
          return;
        }
        const range = new monaco.Range(lineNumber, 1, lineNumber, lineContent.length + 1);
        activeEditor.executeEdits("indent-enter", [{ range, text: "" }]);
        activeEditor.setPosition({ lineNumber, column: 1 });
        return;
      }

      const leading = (lineContent.match(/^ */) || [""])[0];
      activeEditor.executeEdits("indent-enter", [{ range: selection, text: `\n${leading}` }]);
      activeEditor.setPosition({ lineNumber: lineNumber + 1, column: leading.length + 1 });
    },
  });
}

export { monaco };
