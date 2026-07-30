import { create } from "zustand";

export type ZoomScope = "sidebar" | "chrome" | "editor";
type ZoomValueKey = "sidebarZoom" | "chromeZoom" | "editorZoom";

const ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const LEGACY_UI_ZOOM_KEY = "vault-notes-ui-zoom";
const SIDEBAR_ZOOM_KEY = "vault-notes-sidebar-zoom";
const CHROME_ZOOM_KEY = "vault-notes-chrome-zoom";
const EDITOR_ZOOM_KEY = "vault-notes-editor-zoom";

function storageKey(scope: ZoomScope) {
  if (scope === "sidebar") return SIDEBAR_ZOOM_KEY;
  if (scope === "chrome") return CHROME_ZOOM_KEY;
  return EDITOR_ZOOM_KEY;
}

function stateKey(scope: ZoomScope): ZoomValueKey {
  if (scope === "sidebar") return "sidebarZoom";
  if (scope === "chrome") return "chromeZoom";
  return "editorZoom";
}

function loadZoom(scope: ZoomScope): number {
  const raw = localStorage.getItem(storageKey(scope))
    ?? (scope !== "editor" ? localStorage.getItem(LEGACY_UI_ZOOM_KEY) : null);
  const parsed = raw ? Number(raw) : NaN;
  return ZOOM_LEVELS.includes(parsed) ? parsed : 1;
}

function closestLevelIndex(value: number): number {
  return ZOOM_LEVELS.reduce(
    (closest, level, i) => (Math.abs(level - value) < Math.abs(ZOOM_LEVELS[closest] - value) ? i : closest),
    0,
  );
}

interface ZoomState {
  sidebarZoom: number;
  chromeZoom: number;
  editorZoom: number;
  zoomIn: (scope: ZoomScope) => void;
  zoomOut: (scope: ZoomScope) => void;
  zoomReset: (scope: ZoomScope) => void;
}

export const useZoomStore = create<ZoomState>((set, get) => {
  function step(scope: ZoomScope, dir: 1 | -1) {
    const key = stateKey(scope);
    const current = get()[key];
    const idx = closestLevelIndex(current);
    const nextIdx = Math.min(Math.max(idx + dir, 0), ZOOM_LEVELS.length - 1);
    const next = ZOOM_LEVELS[nextIdx];
    localStorage.setItem(storageKey(scope), String(next));
    set({ [key]: next } as Partial<ZoomState>);
  }

  return {
    sidebarZoom: loadZoom("sidebar"),
    chromeZoom: loadZoom("chrome"),
    editorZoom: loadZoom("editor"),
    zoomIn: (scope) => step(scope, 1),
    zoomOut: (scope) => step(scope, -1),
    zoomReset: (scope) => {
      const key = stateKey(scope);
      localStorage.setItem(storageKey(scope), "1");
      set({ [key]: 1 } as Partial<ZoomState>);
    },
  };
});
