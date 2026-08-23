import type { MouseEvent, Ref } from "react";
import { Tree, TreeApi } from "react-arborist";
import type { TreeNode } from "../types/vault";
import { NodeRow } from "./NodeRow";

interface TreeViewProps {
  nodes: TreeNode[];
  mode: "browse" | "select-only";
  onOpen?: (node: TreeNode) => void;
  onSelect?: (nodes: TreeNode[]) => void;
  onCreate?: (args: {
    parentId: string | null;
    index: number;
    type: "internal" | "leaf";
  }) => TreeNode | null;
  onRename?: (id: string, name: string) => void;
  onMove?: (ids: string[], parentId: string | null, index: number) => void;
  onBlankClick?: () => void;
  onNodeContextMenu?: (node: TreeNode, event: MouseEvent<HTMLDivElement>) => void;
  onRequestAddLock?: (id: string) => void;
  onRequestRemoveLock?: (id: string) => void;
  treeRef?: Ref<TreeApi<TreeNode> | undefined>;
  height?: number;
}

export function TreeView({
  nodes,
  mode,
  onOpen,
  onSelect,
  onCreate,
  onRename,
  onMove,
  onBlankClick,
  onNodeContextMenu,
  onRequestAddLock,
  onRequestRemoveLock,
  treeRef,
  height,
}: TreeViewProps) {
  const browse = mode === "browse";
  return (
    <Tree<TreeNode>
      ref={treeRef}
      data={nodes}
      idAccessor="id"
      childrenAccessor={(d) => (d.type === "folder" ? d.children : null)}
      disableEdit={!browse}
      disableDrag={!browse}
      disableMultiSelection={!browse}
      height={height}
      onClick={(e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (!target.closest('[role="treeitem"]')) {
          onBlankClick?.();
        }
      }}
      onCreate={
        browse && onCreate
          ? (args) => onCreate({ parentId: args.parentId, index: args.index, type: args.type })
          : undefined
      }
      onRename={browse && onRename ? ({ id, name }) => onRename(id, name) : undefined}
      onMove={browse && onMove ? ({ dragIds, parentId, index }) => onMove(dragIds, parentId, index) : undefined}
      onSelect={(selected) => onSelect?.(selected.map((n) => n.data))}
      onActivate={(node) => onOpen?.(node.data)}
      width="100%"
      rowHeight={28}
    >
      {(rowProps) => (
        <NodeRow
          {...rowProps}
          interactive={browse}
          onContextMenu={onNodeContextMenu}
          onRequestAddLock={onRequestAddLock}
          onRequestRemoveLock={onRequestRemoveLock}
        />
      )}
    </Tree>
  );
}
