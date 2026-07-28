import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FolderPlus, FolderOpen, FileText, X } from "lucide-react";
import { useVaultStore } from "./store/vaultStore";
import { useZoomStore } from "./store/zoomStore";
import { useUiStore } from "./store/uiStore";
import { Sidebar } from "./components/Sidebar";
import { PasswordPrompt } from "./components/PasswordPrompt";
import { Editor } from "./components/Editor";
import { findNode } from "./lib/treeOps";
import type { TreeNode } from "./types/vault";
import "./App.css";

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
  const openFile = useVaultStore((s) => s.openFile);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);

  const uiZoom = useZoomStore((s) => s.uiZoom);
  const zoomIn = useZoomStore((s) => s.zoomIn);
  const zoomOut = useZoomStore((s) => s.zoomOut);
  const zoomReset = useZoomStore((s) => s.zoomReset);

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

  const activeNode: TreeNode | null =
    vault && activeFileId ? findNode(vault.tree, activeFileId) : null;
  const activeFileOpenable =
    activeNode && activeNode.type === "file" && (!activeNode.locked || sessionUnlockedIds.has(activeNode.id));

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
            {activeFileOpenable && activeNode ? (
              <Editor key={activeNode.id} fileId={activeNode.id} fileName={activeNode.name} />
            ) : (
              <div className="empty-state">
                <FileText size={64} />
                <p>Pick a file to start editing</p>
              </div>
            )}
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
