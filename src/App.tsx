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
  type ShutdownProgress,
} from "./lib/sessionStore";
import {
  getInlineImageOptimizationSnapshot,
  initializeInlineImageOptimizations,
  scanVaultForExistingImages,
  subscribeInlineImageOptimizations,
  waitForInlineImageOptimizations,
  retryInlineImageOptimizations,
} from "./editor/inlineImageOptimization";
import { getAttachmentOptimizationSnapshot, initializeAttachmentOptimizations, retryFailedAttachmentOptimizations, subscribeAttachmentOptimizations, waitForAttachmentOptimizations } from "./lib/attachmentOptimization";
import {
  continueFullMediaMigration,
  dismissFullMediaMigration,
  getCurrentOptimizationCount,
  getFullMediaMigrationSnapshot,
  retryFullMediaMigration,
  subscribeFullMediaMigration,
} from "./lib/fullMediaMigration";
import "dockview-react/dist/styles/dockview.css";
import "./App.css";

const DOCKVIEW_COMPONENTS = { note: EditorPanel };

const LAYOUT_SAVE_DEBOUNCE_MS = 500;
const CLOSE_LABELS: Record<ClosePhase, string> = {
  "saving-notes": "Saving notes…",
  "optimizing-media": "Optimizing pending media…",
  "rebuilding-vault": "Rebuilding the current vault…",
  "verifying-vault": "Verifying encrypted data…",
  "syncing-vault": "Syncing vault…",
  "updating-history": "Updating recovery history…",
  "relocking-notes": "Relocking notes…",
  closing: "Closing…",
};

interface CloseStatus {
  phase: ClosePhase;
  error?: string;
  progress?: ShutdownProgress;
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
  const opening = useVaultStore((s) => s.opening);
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
  const attachmentOptimizationSnapshot = useSyncExternalStore(subscribeAttachmentOptimizations, getAttachmentOptimizationSnapshot, getAttachmentOptimizationSnapshot);
  const mediaMigration = useSyncExternalStore(subscribeFullMediaMigration, getFullMediaMigrationSnapshot, getFullMediaMigrationSnapshot);
  const totalPendingOptimizations = optimizationSnapshot.pendingCount + attachmentOptimizationSnapshot.pendingCount;

  useEffect(() => {
    if (opening || pending || mediaMigration.phase !== "waiting-password") return;
    void continueFullMediaMigration();
  }, [opening, pending, sessionUnlockedIds, mediaMigration.phase, mediaMigration.nextLockedNoteId]);

  async function finishClose(preserveJournal = false): Promise<void> {
    if (closeProceedingRef.current) return;
    closeProceedingRef.current = true;
    setShowOptimizationCloseWarning(false);
    const closingPath = useVaultStore.getState().syncPath;
    let currentPhase: ClosePhase = "saving-notes";
    const updatePhase = (progress: ShutdownProgress) => {
      const phase = progress.phase;
      currentPhase = phase;
      setCloseStatus({ phase, progress });
      if (closingPath) recordUnfinishedShutdown(closingPath, phase);
    };
    updatePhase({ phase: "saving-notes" });
    try {
      await useVaultStore.getState().flushForExit(updatePhase, preserveJournal);
      updatePhase({ phase: "relocking-notes" });
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
      updatePhase({ phase: "closing" });
      clearUnfinishedShutdown();
      await getCurrentWindow().destroy();
    } catch (closeError) {
      closeProceedingRef.current = false;
      const message = String(closeError);
      if (message.includes("PENDING_MEDIA_PASSWORD_REQUIRED")) setCloseStatus(null);
      else setCloseStatus({ phase: currentPhase, error: message });
    }
  }

  async function closeAnyway(): Promise<void> {
    closeProceedingRef.current = true;
    const closingPath = useVaultStore.getState().syncPath;
    if (closingPath) recordUnfinishedShutdown(closingPath, closeStatus?.phase ?? "saving-notes");
    await getCurrentWindow().destroy();
  }

  async function waitAndClose(): Promise<void> {
    setWaitingForOptimizations(true);
    setCloseStatus({ phase: "optimizing-media" });
    try {
      await Promise.all([waitForInlineImageOptimizations(), waitForAttachmentOptimizations()]);
      await finishClose();
    } catch (optimizationError) {
      useVaultStore.setState({ error: String(optimizationError) });
      setWaitingForOptimizations(false);
      setCloseStatus({ phase: "optimizing-media", error: String(optimizationError) });
    }
  }

  async function retryAndClose(): Promise<void> {
    retryFailedAttachmentOptimizations();
    await retryInlineImageOptimizations();
    setCloseStatus(null);
    await waitAndClose();
  }

  // Keeps every open panel in sync with the tree. Deleted files lose their
  // panels, while renames update both primary and duplicate tab titles and
  // the filename passed to their editor components.
  function syncPanelsToTree() {
    const api = dockviewApiRef.current;
    const state = useVaultStore.getState();
    const currentVault = state.vault;
    if (!api || !currentVault || state.opening) return;
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

  function closeUnavailablePanels() {
    const api = dockviewApiRef.current;
    const state = useVaultStore.getState();
    if (!api || !state.vault || state.opening) return;
    for (const panel of [...api.panels]) {
      const params = panel.params as NotePanelParams;
      const node = findNode(state.vault.tree, params.fileId);
      if (!node || params.mirror || (node.locked && !state.sessionUnlockedIds.has(node.id))) panel.api.close();
    }
  }

  function restoreLayoutIfReady() {
    const api = dockviewApiRef.current;
    const state = useVaultStore.getState();
    const path = state.syncPath;
    if (!api || !path || state.opening || restoredForPathRef.current === path) return;
    restoredForPathRef.current = path;
    const saved = loadLayout(path);
    if (saved) {
      try {
        api.fromJSON(saved as Parameters<typeof api.fromJSON>[0]);
      } catch (e) {
        console.error("Failed to restore previous tab layout, starting empty:", e);
        api.clear();
      }
    }
    syncPanelsToTree();
    closeUnavailablePanels();
    saveLayout(path, api.toJSON());
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
    // Auto-open can resolve before Dockview mounts. Restore here as well as
    // in the syncPath effect so either ordering produces the same tabs.
    restoreLayoutIfReady();
  }

  // Restores the previous session's tabs/layout once per vault open (not on
  // every render), then drops any panels for files deleted/moved away while
  // the vault was closed.
  useEffect(() => {
    restoreLayoutIfReady();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncPath, opening]);

  useEffect(() => {
    if (!vault || opening) return;
    syncPanelsToTree();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault?.tree, opening]);

  // Relocking a note is transactional in the store. Once its key is gone,
  // remove every primary/duplicate view so no stale editor remains visible.
  useEffect(() => {
    closeUnavailablePanels();
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
    if (!api || !currentVault || opening || !activeFileId) return;
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
  }, [activeFileId, activeBookmarkId, sessionUnlockedIds, opening]);

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
    if (!("__TAURI_INTERNALS__" in window) || opening) return;
    void initializeInlineImageOptimizations(vault?.salt ?? null).catch((optimizationError) => {
      console.error("Could not initialize screenshot optimization:", optimizationError);
    });
    void scanVaultForExistingImages().catch((optimizationError) => {
      console.error("Could not resume existing screenshot optimization:", optimizationError);
    });
    void initializeAttachmentOptimizations().catch((optimizationError) => console.error("Could not initialize attachment optimization:", optimizationError));
  }, [vault?.salt, sessionUnlockedIds, opening]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      if (closeProceedingRef.current) return;
      const state = useVaultStore.getState();
      const lockedPending = state.vault && flattenTree(state.vault.tree).find((node) => node.locked && (node.pendingMediaCount ?? 0) > 0 && !state.sessionUnlockedIds.has(node.id));
      if (lockedPending) {
        void state.toggleNodeLock(lockedPending.id);
        return;
      }
      if (getInlineImageOptimizationSnapshot().pendingCount + getAttachmentOptimizationSnapshot().pendingCount > 0) {
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
              onCancel={() => {
                if (mediaMigration.phase === "waiting-password") dismissFullMediaMigration();
                cancelPassword();
              }}
            />
          )}
          {pending?.kind === "history-init" && (
            <ConfirmDialog
              title="Recovery history required"
              message={`This vault requires one local incremental Git recovery history:\n${pending.history.repositoryPath}`}
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
        onPointerDownCapture={(e) => {
          rememberZoomScope(e.target);
          useVaultStore.getState().clearActiveAttachment();
        }}
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
            onCancel={() => {
              if (mediaMigration.phase === "waiting-password") dismissFullMediaMigration();
              cancelPassword();
            }}
          />
        )}
        {mediaMigration.phase !== "idle" && mediaMigration.phase !== "waiting-password" && (
          <div className="modal-overlay" role="alertdialog" aria-modal="true" aria-label="Optimizing existing media">
            <div className="modal">
              <h2>Optimize Existing Media</h2>
              <p>
                {mediaMigration.phase === "scanning" && `Scanning notes ${mediaMigration.scannedNotes}/${mediaMigration.totalNotes}…`}
                {mediaMigration.phase === "optimizing" && `Optimizing ${getCurrentOptimizationCount()} remaining media item(s)…`}
                {mediaMigration.phase === "verifying" && `Verifying ${mediaMigration.verifiedMedia}/${mediaMigration.eligibleMedia} media item(s)…`}
                {mediaMigration.phase === "completed" && `Verified ${mediaMigration.verifiedMedia} media item(s).`}
                {mediaMigration.phase === "failed" && `Migration failed: ${mediaMigration.error}`}
              </p>
              {(mediaMigration.phase === "completed" || mediaMigration.phase === "verifying") && (
                <p>{`${(mediaMigration.beforeBytes / 1024 / 1024).toFixed(1)} MB → ${(mediaMigration.afterBytes / 1024 / 1024).toFixed(1)} MB; saved ${(mediaMigration.savedBytes / 1024 / 1024).toFixed(1)} MB`}</p>
              )}
              <p>{`${mediaMigration.totalAttachments} attachment(s), ${mediaMigration.totalInlineImages} inline image(s), ${mediaMigration.unsupportedAttachments} non-media attachment(s).`}</p>
              {(mediaMigration.phase === "completed" || mediaMigration.phase === "failed") && (
                <div className="modal-actions">
                  {mediaMigration.phase === "failed" && <button type="button" className="primary" onClick={() => void retryFullMediaMigration()}>Retry</button>}
                  <button type="button" onClick={dismissFullMediaMigration}>Dismiss</button>
                </div>
              )}
            </div>
          </div>
        )}
        {showOptimizationCloseWarning && (
          <ConfirmDialog
            title="Screenshots are still optimizing"
            message={`${totalPendingOptimizations} media item${totalPendingOptimizations === 1 ? " is" : "s are"} still being optimized. You can wait, or quit safely and resume next time.`}
            actions={[
              { label: "Quit and resume later", onClick: () => void finishClose(true) },
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
              {closeStatus.progress?.beforeBytes !== undefined && closeStatus.progress.afterBytes !== undefined && (
                <p>{`${(closeStatus.progress.beforeBytes / 1024 / 1024).toFixed(1)} MB → ${(closeStatus.progress.afterBytes / 1024 / 1024).toFixed(1)} MB; saved ${((closeStatus.progress.savedBytes ?? 0) / 1024 / 1024).toFixed(1)} MB`}</p>
              )}
              {closeStatus.error && (
                <div className="modal-actions">
                  <button type="button" onClick={() => { clearUnfinishedShutdown(); setCloseStatus(null); }}>
                    Cancel Close
                  </button>
                  <button type="button" className="primary" onClick={() => closeStatus.phase === "optimizing-media" ? void retryAndClose() : void finishClose()}>
                    Retry
                  </button>
                  <button type="button" onClick={() => void closeAnyway()}>
                    Close anyway
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
