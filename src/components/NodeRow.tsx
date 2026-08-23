import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import type { NodeApi, NodeRendererProps } from "react-arborist";
import { ChevronRight, ChevronDown, Folder, Lock, Unlock, ShieldPlus, ShieldX } from "lucide-react";
import type { TreeNode } from "../types/vault";
import { useVaultStore } from "../store/vaultStore";

function EditInput({ node }: { node: NodeApi<TreeNode> }) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      className="tree-name-input"
      defaultValue={node.data.name}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => node.reset()}
      onKeyDown={(e) => {
        if (e.key === "Escape") node.reset();
        if (e.key === "Enter") node.submit(inputRef.current?.value ?? "");
      }}
    />
  );
}

interface NodeRowProps extends NodeRendererProps<TreeNode> {
  interactive?: boolean;
  onContextMenu?: (node: TreeNode, event: ReactMouseEvent<HTMLDivElement>) => void;
  onRequestAddLock?: (id: string) => void;
  onRequestRemoveLock?: (id: string) => void;
}

export function NodeRow({
  node,
  style,
  dragHandle,
  interactive = true,
  onContextMenu,
  onRequestAddLock,
  onRequestRemoveLock,
}: NodeRowProps) {
  const data = node.data;
  const sessionUnlocked = useVaultStore((s) => s.sessionUnlockedIds.has(data.id));
  const toggleNodeLock = useVaultStore((s) => s.toggleNodeLock);

  const multiSelectActive = node.tree.selectedIds.size > 1;
  const disabled = multiSelectActive || !interactive;

  return (
    <div
      ref={dragHandle}
      style={style}
      className={`tree-row${node.isSelected ? " selected" : ""}`}
      onContextMenu={(event) => {
        if (!interactive) return;
        event.preventDefault();
        event.stopPropagation();
        onContextMenu?.(data, event);
      }}
    >
      {data.type === "folder" ? (
        <span
          className="tree-toggle"
          onClick={(e) => {
            e.stopPropagation();
            node.toggle();
          }}
        >
          {node.isOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </span>
      ) : (
        <span className="tree-toggle" />
      )}
      {data.type === "folder" && (
        <span className="tree-icon">
          <Folder size={18} />
        </span>
      )}
      {node.isEditing ? <EditInput node={node} /> : <span className="tree-name">{data.name}</span>}
      {data.locked ? (
        <span className="tree-lock-group">
          <span
            className={`tree-lock${disabled ? " disabled" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              if (disabled) return;
              toggleNodeLock(data.id);
            }}
            title={sessionUnlocked ? "Lock" : "Unlock"}
          >
            {sessionUnlocked ? <Unlock size={18} /> : <Lock size={18} />}
          </span>
          <span
            className={`tree-lock tree-lock-remove${disabled || !sessionUnlocked ? " disabled" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              if (disabled || !sessionUnlocked) return;
              onRequestRemoveLock?.(data.id);
            }}
            title="Remove Lock"
          >
            <ShieldX size={18} />
          </span>
        </span>
      ) : (
        <span
          className={`tree-lock tree-lock-add${disabled ? " disabled" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            if (disabled) return;
            onRequestAddLock?.(data.id);
          }}
          title="Add Lock"
        >
          <ShieldPlus size={18} />
        </span>
      )}
    </div>
  );
}
