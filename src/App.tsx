import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FolderPlus, FolderOpen, FileText, X } from "lucide-react";
import { DockviewReact, type DockviewApi, type DockviewReadyEvent } from "dockview-react";
import { useVaultStore } from "./store/vaultStore";
import { useZoomStore, type ZoomScope } from "./store/zoomStore";
import { useUiStore } from "./store/uiStore";
import { Sidebar } from "./components/Sidebar";
import { PasswordPrompt } from "./components/PasswordPrompt";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { EditorPanel, type NotePanelParams } from "./components/EditorPanel";
import { findNode, flattenTree } from "./lib/treeOps";
import {
  clearNodeSessions,
  clearUnfinishedShutdown,
  loadLayout,
  recordUnfinishedShutdown,
  saveLayout,
  type ClosePhase,
} from "./lib/sessionStore";
import {
  getInlineImageOptimizationSnapshot,
  initializeInlineImageOptimizations,
  subscribeInlineImageOptimizations,
  waitForInlineImageOptimizations,
} from "./editor/inlineImageOptimization";
import "dockview-react/dist/styles/dockview.css";
import "./App.css";

const DOCKVIEW_COMPONENTS = { note: EditorPanel };

const LAYOUT_SAVE_DEBOUNCE_MS = 500;
const CLOSE_LABELS: Record<ClosePhase, string> = {
  "saving-notes": "Saving notes…",
  "syncing-vault": "Syncing vault…",
  "updating-history": "Updating recovery history…",
  "relocking-notes": "Relocking notes…",
  closing: "Closing…",
};

interface CloseStatus {
  phase: ClosePhase;
  error?: string;
}

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
  const submitPassword = useVaultStore((s) => s.submitPassword);
  const cancelPassword = useVaultStore((s) => s.cancelPassword);
  const clearError = useVaultStore((s) => s.clearError);
  const initializeHistory = useVaultStore((s) => s.initializeHistory);
  const cancelHistory = useVaultStore((s) => s.cancelHistory);
  const sessionUnlockedIds = useVaultStore((s) => s.sessionUnlockedIds);
  const activeFileId = useVaultStore((s) => s.activeFileId);
  const activeBookmarkId = useVaultStore((s) => s.activeBookmarkId);
  const openFile = useVaultStore((s) => s.openFile);
  const syncPath = useVaultStore((s) => s.syncPath);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);

  const sidebarZoom = useZoomStore((s) => s.sidebarZoom);
  const chromeZoom = useZoomStore((s) => s.chromeZoom);
  const zoomIn = useZoomStore((s) => s.zoomIn);
  const zoomOut = useZoomStore((s) => s.zoomOut);
  const zoomReset = useZoomStore((s) => s.zoomReset);

  const dockviewApiRef = useRef<DockviewApi | null>(null);
  const lastZoomScopeRef = useRef<ZoomScope>("chrome");
  const restoredForPathRef = useRef<string | null>(null);
  const layoutSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeProceedingRef = useRef(false);
  const [closeStatus, setCloseStatus] = useState<CloseStatus | null>(null);
  const [showOptimizationCloseWarning, setShowOptimizationCloseWarning] = useState(false);
  const [waitingForOptimizations, setWaitingForOptimizations] = useState(false);
  const optimizationSnapshot = useSyncExternalStore(
    subscribeInlineImageOptimizations,
    getInlineImageOptimizationSnapshot,
    getInlineImageOptimizationSnapshot,
  );

  async function finishClose(): Promise<void> {
    if (closeProceedingRef.current) return;
    closeProceedingRef.current = true;
    setShowOptimizationCloseWarning(false);
    const closingPath = useVaultStore.getState().syncPath;
    let currentPhase: ClosePhase = "saving-notes";
    const updatePhase = (phase: ClosePhase) => {
      currentPhase = phase;
      setCloseStatus({ phase });
      if (closingPath) recordUnfinishedShutdown(closingPath, phase);
    };
    updatePhase("saving-notes");
    try {
      await useVaultStore.getState().flushForExit(updatePhase);
      updatePhase("relocking-notes");
      if (closingPath) clearNodeSessions(closingPath);
      const api = dockviewApiRef.current;
      if (api) {
        const currentVault = useVaultStore.getState().vault;
        for (const panel of [...api.panels]) {
          const params = panel.params as NotePanelParams;
          const node = currentVault ? findNode(currentVault.tree, params.fileId) : undefined;
          if (params.mirror || node?.locked) panel.api.close();
        }
        if (closingPath) saveLayout(closingPath, api.toJSON());
      }
      updatePhase("closing");
      clearUnfinishedShutdown();
      await getCurrentWindow().destroy();
    } catch (closeError) {
      closeProceedingRef.current = false;
      setCloseStatus({ phase: currentPhase, error: String(closeError) });
    }
  }

  async function waitAndClose(): Promise<void> {
    setWaitingForOptimizations(true);
    try {
      await waitForInlineImageOptimizations();
      await finishClose();
    } catch (optimizationError) {
      useVaultStore.setState({ error: String(optimizationError) });
      setWaitingForOptimizations(false);
    }
  }

  // Keeps every open panel in sync with the tree. Deleted files lose their
  // panels, while renames update both primary and duplicate tab titles and
  // the filename passed to their editor components.
  function syncPanelsToTree() {
    const api = dockviewApiRef.current;
    const currentVault = useVaultStore.getState().vault;
    if (!api || !currentVault) return;
    const nodesById = new Map(flattenTree(currentVault.tree).map((node) => [node.id, node]));
    for (const panel of api.panels) {
      const params = panel.params as NotePanelParams;
      const node = nodesById.get(params.fileId);
      if (!node) {
        panel.api.close();
        continue;
      }

      const title = params.mirror ? `${node.name} — Copy` : node.name;
      if (panel.api.title !== title) panel.api.setTitle(title);
      if (params.fileName !== node.name) {
        panel.api.updateParameters({ ...params, fileName: node.name });
      }
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
    event.api.onDidActivePanelChange(({ panel, origin }) => {
      if (origin !== "user" || !panel) return;
      const params = panel.params as NotePanelParams;
      const state = useVaultStore.getState();
      if (!state.vault || !params.fileId || params.fileId === state.activeFileId) return;

      const node = findNode(state.vault.tree, params.fileId);
      if (node) void state.openFile(node);
    });
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
      syncPanelsToTree();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncPath]);

  useEffect(() => {
    if (!vault) return;
    syncPanelsToTree();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault?.tree]);

  // Relocking a note is transactional in the store. Once its key is gone,
  // remove every primary/duplicate view so no stale editor remains visible.
  useEffect(() => {
    const api = dockviewApiRef.current;
    const currentVault = useVaultStore.getState().vault;
    if (!api || !currentVault) return;
    for (const panel of [...api.panels]) {
      const params = panel.params as NotePanelParams;
      const node = findNode(currentVault.tree, params.fileId);
      if (node?.locked && !sessionUnlockedIds.has(node.id)) panel.api.close();
    }
  }, [sessionUnlockedIds]);

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

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    void initializeInlineImageOptimizations(vault?.salt ?? null).catch((optimizationError) => {
      console.error("Could not initialize screenshot optimization:", optimizationError);
    });
  }, [vault?.salt, sessionUnlockedIds]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      if (closeProceedingRef.current) return;
      if (getInlineImageOptimizationSnapshot().pendingCount > 0) {
        setShowOptimizationCloseWarning(true);
        return;
      }
      void finishClose();
    }).then((stop) => {
      unlisten = stop;
    });
    return () => unlisten?.();
    // Installed once; the handler reads current stores/snapshots directly.
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
      const scope = lastZoomScopeRef.current;
      if (isZoomIn) zoomIn(scope);
      else if (isZoomOut) zoomOut(scope);
      else zoomReset(scope);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [zoomIn, zoomOut, zoomReset]);

  function rememberZoomScope(target: EventTarget | null) {
    if (!(target instanceof Element)) return;
    lastZoomScopeRef.current = target.closest(".sidebar")
      ? "sidebar"
      : target.closest(".editor-content")
        ? "editor"
        : "chrome";
  }

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
      case "history-init":
        return null;
    }
  })();

  if (!vault) {
    return (
      <div className="zoom-viewport">
        <main className="container" style={{ zoom: chromeZoom }}>
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
          {pending?.kind === "history-init" && (
            <ConfirmDialog
              title="Recovery history required"
              message={`This vault requires two synchronized local Git recovery histories:\n${pending.history.repositoryPath}\n${pending.history.mirrorRepositoryPath}`}
              actions={[{ label: "Create History", onClick: () => void initializeHistory() }]}
              onCancel={cancelHistory}
            />
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="zoom-viewport">
      <div
        className="app-shell"
        onPointerDownCapture={(e) => rememberZoomScope(e.target)}
        onFocusCapture={(e) => rememberZoomScope(e.target)}
      >
        <Sidebar onOpenFile={openFile} zoomScale={sidebarZoom} />
        <main className={`main-area${sidebarCollapsed ? " sidebar-collapsed" : ""}`} style={{ zoom: chromeZoom }}>
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
        {showOptimizationCloseWarning && (
          <ConfirmDialog
            title="Screenshots are still optimizing"
            message={`${optimizationSnapshot.pendingCount} screenshot${optimizationSnapshot.pendingCount === 1 ? " is" : "s are"} still being optimized. You can wait, or quit safely and resume next time.`}
            actions={[
              { label: "Quit and resume later", onClick: () => void finishClose() },
              { label: waitingForOptimizations ? "Waiting…" : "Wait and close", onClick: () => void waitAndClose() },
            ]}
            onCancel={() => {
              if (!waitingForOptimizations) setShowOptimizationCloseWarning(false);
            }}
          />
        )}
        {closeStatus && (
          <div className="modal-overlay close-overlay" role="alertdialog" aria-modal="true" aria-label="Saving and closing">
            <div className="modal">
              <h2>Saving and closing…</h2>
              <p>{closeStatus.error ? `Close failed: ${closeStatus.error}` : CLOSE_LABELS[closeStatus.phase]}</p>
              {closeStatus.error && (
                <div className="modal-actions">
                  <button type="button" onClick={() => { clearUnfinishedShutdown(); setCloseStatus(null); }}>
                    Cancel Close
                  </button>
                  <button type="button" className="primary" onClick={() => void finishClose()}>
                    Retry
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
