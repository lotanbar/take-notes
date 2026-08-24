import { FileText, Lock, Paperclip, TextSearch } from "lucide-react";
import { useZoomStore } from "../store/zoomStore";

export interface ResultListItem {
  id: string;
  kind: "file" | "folder" | "text" | "attachment";
  fileName: string;
  snippet?: string | null;
  nameMatchStart?: number;
  nameMatchLength?: number;
  snippetMatchStart?: number;
  snippetMatchLength?: number;
  disabled?: boolean;
}

interface ResultListProps {
  items: ResultListItem[];
  selectedId?: string | null;
  emptyText?: string;
  onSelect: (item: ResultListItem) => void;
  onActivate?: (item: ResultListItem) => void;
  zoomBase?: "chrome" | "sidebar";
}

function Highlight({ text, start = -1, length = 0 }: { text: string; start?: number; length?: number }) {
  if (start < 0 || length <= 0) return <>{text}</>;
  return <>{text.slice(0, start)}<mark>{text.slice(start, start + length)}</mark>{text.slice(start + length)}</>;
}

export function ResultList({ items, selectedId, emptyText = "No matches.", onSelect, onActivate, zoomBase = "chrome" }: ResultListProps) {
  const editorZoom = useZoomStore((state) => state.editorZoom);
  const baseZoom = useZoomStore((state) => zoomBase === "sidebar" ? state.sidebarZoom : state.chromeZoom);
  if (items.length === 0) return <p className="placeholder-text result-list-empty">{emptyText}</p>;
  return (
    <div className="result-list" role="listbox" style={{ fontSize: `${12 * editorZoom / baseZoom}px` }}>
      {items.map((item) => (
        <div
          key={item.id}
          role="option"
          aria-selected={selectedId === item.id}
          aria-disabled={item.disabled}
          className={`result-list-item${selectedId === item.id ? " selected" : ""}${item.disabled ? " disabled" : ""}`}
          onClick={() => !item.disabled && onSelect(item)}
          onDoubleClick={() => !item.disabled && (onActivate ?? onSelect)(item)}
        >
          <span className="result-list-icon">{item.disabled ? <Lock size={15} /> : item.kind === "attachment" ? <Paperclip size={15} /> : item.kind === "text" ? <TextSearch size={15} /> : <FileText size={15} />}</span>
          <div className="result-list-text">
            <div className="result-list-name"><Highlight text={item.fileName} start={item.nameMatchStart} length={item.nameMatchLength} /></div>
            {item.snippet && <div className="result-list-snippet"><Highlight text={item.snippet} start={item.snippetMatchStart} length={item.snippetMatchLength} /></div>}
          </div>
        </div>
      ))}
    </div>
  );
}
