import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FolderPlus, FolderOpen, FileText, X } from "lucide-react";
import { DockviewReact, type DockviewApi, type DockviewReadyEvent } from "dockview-react";
import { useVaultStore } from "./store/vaultStore";
import { useZoomStore } from "./store/zoomStore";
import { useUiStore } from "./store/uiStore";
import { Sidebar } from "./components/Sidebar";
import { PasswordPrompt } from "./components/PasswordPrompt";
import { EditorPanel, type NotePanelParams } from "./components/EditorPanel";
import { findNode, flattenTree } from "./lib/treeOps";
import { loadLayout, saveLayout } from "./lib/sessionStore";
import "dockview-react/dist/styles/dockview.css";
import "./App.css";

const DOCKVIEW_COMPONENTS = { note: EditorPanel };

const LAYOUT_SAVE_DEBOUNCE_MS = 500;

function EmptyWatermark() {
  return (
    <div className="empty-state">
      <FileText size={64} />
      <p>Pick a file to start editing</p>
    </div>
  );
}

function App() {
  const vault = useVaultStore((s) => s.vault);
  const error = useVaultStore((s) => s.error);
  const pending = useVaultStore((s) => s.pending);
  const passwordError = useVaultStore((s) => s.passwordError);
  const newVault = useVaultStore((s) => s.newVault);
  const openVault = useVaultStore((s) => s.openVault);
  const tryAutoOpenLastVault = useVaultStore((s) => s.tryAutoOpenLastVault);
  const flushForExit = useVaultStore((s) => s.flushForExit);
  const submitPassword = useVaultStore((s) => s.submitPassword);
  const cancelPassword = useVaultStore((s) => s.cancelPassword);
  const clearError = useVaultStore((s) => s.clearError);
  const sessionUnlockedIds = useVaultStore((s) => s.sessionUnlockedIds);
  const activeFileId = useVaultStore((s) => s.activeFileId);
  const activeBookmarkId = useVaultStore((s) => s.activeBookmarkId);
  const openFile = useVaultStore((s) => s.openFile);
  const syncPath = useVaultStore((s) => s.syncPath);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);

  const uiZoom = useZoomStore((s) => s.uiZoom);
  const zoomIn = useZoomStore((s) => s.zoomIn);
  const zoomOut = useZoomStore((s) => s.zoomOut);
  const zoomReset = useZoomStore((s) => s.zoomReset);

  const dockviewApiRef = useRef<DockviewApi | null>(null);
  const restoredForPathRef = useRef<string | null>(null);
  const layoutSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Closes any open tab (primary or duplicate) whose file no longer exists in
  // the tree — covers deletes, and moves that changed nothing id-wise so it's
  // a no-op for those. Safe to call anytime the tree changes.
  function pruneStalePanels() {
    const api = dockviewApiRef.current;
    const currentVault = useVaultStore.getState().vault;
    if (!api || !currentVault) return;
    const validIds = new Set(flattenTree(currentVault.tree).map((n) => n.id));
    for (const panel of api.panels) {
      const params = panel.params as NotePanelParams;
      if (!validIds.has(params.fileId)) panel.api.close();
    }
  }

  function scheduleSaveLayout() {
    if (!syncPath) return;
    if (layoutSaveTimerRef.current) clearTimeout(layoutSaveTimerRef.current);
    layoutSaveTimerRef.current = setTimeout(() => {
      const api = dockviewApiRef.current;
      if (api && syncPath) saveLayout(syncPath, api.toJSON());
    }, LAYOUT_SAVE_DEBOUNCE_MS);
  }

  function handleDockviewReady(event: DockviewReadyEvent) {
    dockviewApiRef.current = event.api;
    event.api.onDidLayoutChange(scheduleSaveLayout);
  }

  // Restores the previous session's tabs/layout once per vault open (not on
  // every render), then drops any panels for files deleted/moved away while
  // the vault was closed.
  useEffect(() => {
    const api = dockviewApiRef.current;
    if (!api || !syncPath || restoredForPathRef.current === syncPath) return;
    restoredForPathRef.current = syncPath;
    const saved = loadLayout(syncPath);
    if (saved) {
      try {
        api.fromJSON(saved as Parameters<typeof api.fromJSON>[0]);
      } catch (e) {
        console.error("Failed to restore previous tab layout, starting empty:", e);
        api.clear();
      }
      pruneStalePanels();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncPath]);

  useEffect(() => {
    if (!vault) return;
    pruneStalePanels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault?.tree]);

  // Opens (or focuses, if already open) a tab whenever the "requested active
  // file" signal changes — driven by Sidebar clicks, search selection,
  // referrer navigation, ctrl+click bookmark links, and back/forward, all of
  // which already funnel through vaultStore's openFile/navigateToBookmark/
  // goBack/goForward. One tab per file: re-requesting an already-open file
  // just focuses its existing tab (see the "Duplicate" tab action for
  // intentionally opening a second, synced view of the same file).
  useEffect(() => {
    const api = dockviewApiRef.current;
    // Read the current vault directly rather than subscribing to it: `vault`
    // gets a new object reference on every autosave (even just a content-only
    // save touches the tree), and this effect only actually needs to react to
    // activeFileId/activeBookmarkId/sessionUnlockedIds changing — not to
    // every keystroke-driven save re-running it and re-calling setActive().
    const currentVault = useVaultStore.getState().vault;
    if (!api || !currentVault || !activeFileId) return;
    const node = findNode(currentVault.tree, activeFileId);
    if (!node || node.type !== "file") return;
    if (node.locked && !sessionUnlockedIds.has(node.id)) return;
    const existing = api.getPanel(node.id);
    if (existing) {
      if (!existing.api.isActive) existing.api.setActive();
    } else {
      api.addPanel({
        id: node.id,
        component: "note",
        params: { fileId: node.id, fileName: node.name } satisfies NotePanelParams,
        title: node.name,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFileId, activeBookmarkId, sessionUnlockedIds]);

  const didAutoOpen = useRef(false);
  useEffect(() => {
    // Guards against React StrictMode's dev-mode double-invoke of this effect,
    // which would otherwise fire two concurrent auto-opens (and, for a legacy
    // vault, two concurrent migrations) for the same path.
    if (didAutoOpen.current) return;
    didAutoOpen.current = true;
    tryAutoOpenLastVault();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "Just close the window" is the other half of never touching Save As
  // (the other being lockVault, see vaultStore.ts): intercept the close
  // request to compact in place first, then destroy() the window ourselves.
  // Must be destroy(), not close(): close() just emits another
  // closeRequested event (recursing back into this same handler), where
  // destroy() actually tears the window down without round-tripping through
  // JS again. And the destroy() has to run in `finally` -- if it only ran
  // after a successful flushForExit(), any error there (e.g. the close
  // command itself being denied) would throw out of this handler, and since
  // preventDefault() already ran, the window's onCloseRequested wrapper has
  // no fallback of its own: the window would be stuck unclosable with no
  // visible error.
  useEffect(() => {
    const win = getCurrentWindow();
    const unlistenPromise = win.onCloseRequested(async (event) => {
      event.preventDefault();
      try {
        await flushForExit();
      } finally {
        await win.destroy();
      }
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return;
      const isZoomIn = e.key === "+" || e.key === "=" || e.code === "NumpadAdd";
      const isZoomOut = e.key === "-" || e.key === "_" || e.code === "NumpadSubtract";
      const isReset = e.key === "0" || e.code === "Numpad0";
      if (!isZoomIn && !isZoomOut && !isReset) return;
      e.preventDefault();
      const scope = (e.target as HTMLElement | null)?.closest?.(".editor-content") ? "editor" : "ui";
      if (isZoomIn) zoomIn(scope);
      else if (isZoomOut) zoomOut(scope);
      else zoomReset(scope);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [zoomIn, zoomOut, zoomReset]);

  const passwordPromptProps = (() => {
    if (!pending) return null;
    switch (pending.kind) {
      case "vault-create":
        return { mode: "create" as const, title: "Set Master Password" };
      case "vault-open":
        return { mode: "verify" as const, title: "Enter Master Password" };
      case "node-lock":
        return { mode: "create" as const, title: "Set Lock Password" };
      case "node-unlock":
        return { mode: "verify" as const, title: "Enter Node Password" };
    }
  })();

  if (!vault) {
    return (
      <div className="zoom-viewport">
        <main className="container" style={{ zoom: uiZoom }}>
          <h1>Vault Notes</h1>
          <div className="row">
            <button className="primary" onClick={newVault}>
              <FolderPlus size={20} />
              New Vault
            </button>
            <button onClick={openVault}>
              <FolderOpen size={20} />
              Open New Vault
            </button>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              <p className="error-text">{error}</p>
              <button className="error-banner-dismiss" onClick={clearError} aria-label="Dismiss">
                <X size={16} />
              </button>
            </div>
          )}
          {passwordPromptProps && (
            <PasswordPrompt
              {...passwordPromptProps}
              error={passwordError}
              onSubmit={submitPassword}
              onCancel={cancelPassword}
            />
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="zoom-viewport">
      <div className="app-shell" style={{ zoom: uiZoom }}>
        <Sidebar onOpenFile={openFile} />
        <main className={`main-area${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
          <div className="main-body">
            {error && (
            <div className="error-banner" role="alert">
              <p className="error-text">{error}</p>
              <button className="error-banner-dismiss" onClick={clearError} aria-label="Dismiss">
                <X size={16} />
              </button>
            </div>
          )}
            <DockviewReact
              className="dockview-theme-vs dv-vault-theme"
              components={DOCKVIEW_COMPONENTS}
              watermarkComponent={EmptyWatermark}
              onReady={handleDockviewReady}
              getTabContextMenuItems={({ panel, api }) => {
                const params = panel.params as NotePanelParams;
                return [
                  "close",
                  "closeOthers",
                  "closeAll",
                  "separator",
                  {
                    label: "Duplicate",
                    action: () => {
                      api.addPanel({
                        id: `${params.fileId}::mirror::${crypto.randomUUID()}`,
                        component: "note",
                        params: { fileId: params.fileId, fileName: params.fileName, mirror: true } satisfies NotePanelParams,
                        title: `${params.fileName} — Copy`,
                        position: { referencePanel: panel.id },
                      });
                    },
                  },
                ];
              }}
            />
          </div>
        </main>
        {passwordPromptProps && (
          <PasswordPrompt
            {...passwordPromptProps}
            error={passwordError}
            onSubmit={submitPassword}
            onCancel={cancelPassword}
          />
        )}
      </div>
    </div>
  );
}

export default App;
