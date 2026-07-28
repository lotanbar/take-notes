import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { TreeApi } from "react-arborist";
import {
  FolderPlus,
  FilePlus,
  Trash2,
  FolderUp,
  Vault as VaultIcon,
  Link,
  PanelLeftOpen,
  PanelLeftClose,
} from "lucide-react";
import { TreeView } from "./TreeView";
import { ConfirmDialog } from "./ConfirmDialog";
import { ReferrersPopup } from "./ReferrersPopup";
import { SearchBar } from "./SearchBar";
import { useVaultStore } from "../store/vaultStore";
import { useUiStore } from "../store/uiStore";
import { resolveInsertTarget, findNode, collectDescendantIds } from "../lib/treeOps";
import { findEntangledBookmarks } from "../lib/bookmarkOps";
import type { TreeNode } from "../types/vault";

interface SidebarProps {
  onOpenFile: (node: TreeNode) => void;
}

export function Sidebar({ onOpenFile }: SidebarProps) {
  const vault = useVaultStore((s) => s.vault);
  const filePath = useVaultStore((s) => s.syncPath);
  const selectedIds = useVaultStore((s) => s.selectedIds);
  const pending = useVaultStore((s) => s.pending);
  const setSelection = useVaultStore((s) => s.setSelection);
  const createNode = useVaultStore((s) => s.createNode);
  const renameNodeAction = useVaultStore((s) => s.renameNodeAction);
  const moveNodesAction = useVaultStore((s) => s.moveNodesAction);
  const deleteNodesAction = useVaultStore((s) => s.deleteNodesAction);
  const addNodeLock = useVaultStore((s) => s.addNodeLock);
  const removeNodeLock = useVaultStore((s) => s.removeNodeLock);
  const lockVault = useVaultStore((s) => s.lockVault);

  const treeApiRef = useRef<TreeApi<TreeNode> | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const [entangledBookmarkIds, setEntangledBookmarkIds] = useState<string[] | null>(null);
  const [showReferrers, setShowReferrers] = useState(false);
  const [confirmLockVault, setConfirmLockVault] = useState(false);

  const sidebarRef = useRef<HTMLDivElement>(null);
  const treeWrapRef = useRef<HTMLDivElement>(null);
  const [treeHeight, setTreeHeight] = useState(500);

  const MIN_SIDEBAR_WIDTH = 280;
  const SIDEBAR_MAX_RATIO = 0.7;
  const COLLAPSE_DRAG_DISTANCE = 60;
  const [sidebarWidth, setSidebarWidth] = useState(300);
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const setCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const [collapseArmed, setCollapseArmed] = useState(false);
  const draggingRef = useRef(false);
  const collapseArmedRef = useRef(false);

  function handleResizeMouseDown(e: ReactMouseEvent) {
    e.preventDefault();
    draggingRef.current = true;
    document.body.classList.add("resizing-sidebar");
    window.addEventListener("mousemove", handleResizeMouseMove);
    window.addEventListener("mouseup", handleResizeMouseUp);
  }
  function handleResizeMouseMove(e: MouseEvent) {
    if (!draggingRef.current) return;
    const max = window.innerWidth * SIDEBAR_MAX_RATIO;
    if (e.clientX < MIN_SIDEBAR_WIDTH) {
      // Freeze the visible width at the minimum instead of shrinking further;
      // past a further drag distance, arm a full collapse on release.
      setSidebarWidth(MIN_SIDEBAR_WIDTH);
      const armed = MIN_SIDEBAR_WIDTH - e.clientX >= COLLAPSE_DRAG_DISTANCE;
      collapseArmedRef.current = armed;
      setCollapseArmed(armed);
    } else {
      setSidebarWidth(Math.min(e.clientX, max));
      collapseArmedRef.current = false;
      setCollapseArmed(false);
    }
  }
  function handleResizeMouseUp() {
    draggingRef.current = false;
    document.body.classList.remove("resizing-sidebar");
    window.removeEventListener("mousemove", handleResizeMouseMove);
    window.removeEventListener("mouseup", handleResizeMouseUp);
    if (collapseArmedRef.current) setCollapsed(true);
    collapseArmedRef.current = false;
    setCollapseArmed(false);
  }
  useEffect(() => {
    return () => {
      window.removeEventListener("mousemove", handleResizeMouseMove);
      window.removeEventListener("mouseup", handleResizeMouseUp);
      document.body.classList.remove("resizing-sidebar");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = treeWrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setTreeHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (sidebarRef.current && !sidebarRef.current.contains(e.target as Node)) {
        setSelection([]);
        treeApiRef.current?.deselectAll();
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [setSelection]);

  const singleSelected = selectedIds.length === 1 ? selectedIds[0] : null;
  const multiSelectActive = selectedIds.length > 1;

  function handleCreate(type: "folder" | "file") {
    if (!vault) return;
    const { parentId, index } = resolveInsertTarget(vault.tree, selectedIds);
    treeApiRef.current?.create({ type: type === "folder" ? "internal" : "leaf", parentId, index });
  }

  function handleDeleteClick() {
    if (selectedIds.length === 0 || !vault) return;
    const descendantIds = new Set(
      selectedIds.flatMap((id) => {
        const node = findNode(vault.tree, id);
        return node ? collectDescendantIds(node) : [id];
      }),
    );
    const entangled = findEntangledBookmarks(vault.index, descendantIds);
    setConfirmDelete(selectedIds);
    setEntangledBookmarkIds(entangled.length > 0 ? entangled.map((e) => e.bookmarkId) : null);
  }

  function handleDeleteConfirmed() {
    if (confirmDelete) deleteNodesAction(confirmDelete);
    treeApiRef.current?.deselectAll();
    setConfirmDelete(null);
    setEntangledBookmarkIds(null);
    setShowReferrers(false);
  }

  function handleMoveToRoot() {
    if (!vault || selectedIds.length === 0) return;
    moveNodesAction(selectedIds, null, vault.tree.children.length);
  }

  function handleBlankClick() {
    setSelection([]);
    treeApiRef.current?.deselectAll();
  }

  function handleSearchSelectFile(fileId: string) {
    if (!vault) return;
    const node = findNode(vault.tree, fileId);
    if (node) onOpenFile(node);
  }

  function handleSearchSelectFolder(folderId: string) {
    setSelection([folderId]);
    treeApiRef.current?.openParents(folderId);
    treeApiRef.current?.select(folderId);
    treeApiRef.current?.scrollTo(folderId);
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target;
      if (
        target instanceof Element &&
        target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")
      ) {
        return;
      }
      if (pending || confirmDelete) return;

      if (e.key === "Delete") {
        if (selectedIds.length > 0) {
          e.preventDefault();
          handleDeleteClick();
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r") {
        if (singleSelected) {
          e.preventDefault();
          treeApiRef.current?.edit(singleSelected);
        }
        return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedIds, singleSelected, pending, confirmDelete]);

  if (!vault) return null;

  const selectedNames = confirmDelete
    ?.map((id) => treeApiRef.current?.get(id)?.data.name)
    .filter((n): n is string => !!n);

  return (
    <div
      className={`sidebar${collapsed ? " collapsed" : ""}`}
      style={{ width: collapsed ? 0 : sidebarWidth }}
      ref={sidebarRef}
    >
      {collapsed && (
        <button
          className="icon-btn sidebar-restore-btn"
          onClick={() => setCollapsed(false)}
          title="Show Explorer"
        >
          <PanelLeftOpen size={24} />
        </button>
      )}
      {/* Kept mounted (not conditionally removed) so the tree's expanded-folder
          state, selection, and DOM measurements survive collapsing/restoring. */}
      <div className="sidebar-inner">
        <div className="toolbar">
          <button
            className="icon-btn"
            onClick={() => handleCreate("folder")}
            disabled={multiSelectActive}
            title="New Folder"
          >
            <FolderPlus size={24} />
          </button>
          <button
            className="icon-btn"
            onClick={() => handleCreate("file")}
            disabled={multiSelectActive}
            title="New File"
          >
            <FilePlus size={24} />
          </button>
          <button
            className="icon-btn"
            onClick={handleMoveToRoot}
            disabled={selectedIds.length === 0}
            title="Move to Root"
          >
            <FolderUp size={24} />
          </button>
          <button
            className="icon-btn spacer-left"
            onClick={() => setConfirmLockVault(true)}
            title="Lock Vault and Return to Main Screen"
          >
            <VaultIcon size={24} />
          </button>
          <button
            className="icon-btn"
            onClick={() => setCollapsed(true)}
            title="Hide Explorer"
          >
            <PanelLeftClose size={24} />
          </button>
        </div>
        <SearchBar onSelectFile={handleSearchSelectFile} onSelectFolder={handleSearchSelectFolder} />
        <div className="tree-wrap" ref={treeWrapRef}>
          <TreeView
            nodes={vault.tree.children}
            mode="browse"
            height={treeHeight}
            treeRef={treeApiRef}
            onSelect={(nodes) => setSelection(nodes.map((n) => n.id))}
            onOpen={(node) => {
              if (node.type === "file") onOpenFile(node);
            }}
            onCreate={({ parentId, index, type }) =>
              createNode(type === "internal" ? "folder" : "file", parentId, index)
            }
            onRename={renameNodeAction}
            onMove={moveNodesAction}
            onBlankClick={handleBlankClick}
            onRequestAddLock={addNodeLock}
            onRequestRemoveLock={removeNodeLock}
          />
        </div>
        <div className="sidebar-footer" title={filePath ?? undefined}>
          {filePath}
        </div>
        <div
          className="sidebar-resize-handle"
          onMouseDown={handleResizeMouseDown}
        />
      </div>
      {collapseArmed && <div className="sidebar-collapse-flash" />}
      {confirmDelete && !showReferrers && (
        <ConfirmDialog
          title="Delete"
          message={
            entangledBookmarkIds
              ? `Delete ${selectedNames?.join(", ")}? Other files link to bookmarks in this selection.`
              : `Delete ${selectedNames?.join(", ")}? This cannot be undone.`
          }
          actions={[
            ...(entangledBookmarkIds
              ? [
                  {
                    label: "Show who points here",
                    icon: <Link size={15} />,
                    onClick: () => setShowReferrers(true),
                  },
                ]
              : []),
            {
              label: entangledBookmarkIds ? "Delete anyway" : "Delete",
              icon: <Trash2 size={15} />,
              onClick: handleDeleteConfirmed,
              variant: "danger" as const,
            },
          ]}
          onCancel={() => {
            setConfirmDelete(null);
            setEntangledBookmarkIds(null);
          }}
        />
      )}
      {showReferrers && entangledBookmarkIds && (
        <ReferrersPopup bookmarkIds={entangledBookmarkIds} onClose={() => setShowReferrers(false)} />
      )}
      {confirmLockVault && (
        <ConfirmDialog
          title="Lock Vault"
          message="Lock the vault and return to the main screen?"
          actions={[
            {
              label: "Lock Vault",
              icon: <VaultIcon size={15} />,
              onClick: () => {
                setConfirmLockVault(false);
                lockVault();
              },
            },
          ]}
          onCancel={() => setConfirmLockVault(false)}
        />
      )}
    </div>
  );
}
