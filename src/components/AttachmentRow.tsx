import { useEffect, useRef, useState } from "react";
import { Bookmark, Paperclip, Save, Trash2 } from "lucide-react";
import type { Attachment } from "../types/vault";
import { formatFileSize } from "../lib/attachmentOps";

interface AttachmentRowProps {
  attachments: Attachment[];
  onOpen: (attachment: Attachment) => void;
  onRequestDelete: (attachment: Attachment) => void;
  onSaveAs: (attachment: Attachment) => void;
  bookmarkedIds: string[];
  onToggleBookmark: (attachment: Attachment) => void;
  selectedAttachmentId?: string | null;
}

export function AttachmentRow({ attachments, onOpen, onRequestDelete, onSaveAs, bookmarkedIds, onToggleBookmark, selectedAttachmentId }: AttachmentRowProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [pulsingId, setPulsingId] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedAttachmentId || !attachments.some((item) => item.id === selectedAttachmentId)) return;
    const chip = rowRef.current?.querySelector<HTMLElement>(`[data-attachment-id="${CSS.escape(selectedAttachmentId)}"]`);
    chip?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    setPulsingId(selectedAttachmentId);
    const timer = setTimeout(() => setPulsingId((id) => id === selectedAttachmentId ? null : id), 3000);
    return () => clearTimeout(timer);
  }, [selectedAttachmentId, attachments]);

  if (attachments.length === 0) return null;

  return (
    <div className="attachment-row" ref={rowRef}>
      {attachments.map((a) => (
        <div key={a.id} data-attachment-id={a.id} className={`attachment-chip${selectedAttachmentId === a.id ? " selected" : ""}${pulsingId === a.id ? " pulse" : ""}`} onClick={() => onOpen(a)} title={a.name}>
          <Paperclip size={13} className="attachment-chip-icon" />
          <div className="attachment-chip-info">
            <span className="attachment-chip-name">{a.name}</span>
            <span className="attachment-chip-size">{formatFileSize(a.size)}</span>
          </div>
          <button
            type="button"
            className={`icon-btn attachment-chip-action${bookmarkedIds.includes(a.id) ? " active" : ""}`}
            title={bookmarkedIds.includes(a.id) ? "Remove attachment bookmark" : "Bookmark attachment"}
            aria-pressed={bookmarkedIds.includes(a.id)}
            onClick={(e) => { e.stopPropagation(); onToggleBookmark(a); }}
          >
            <Bookmark size={20} fill={bookmarkedIds.includes(a.id) ? "currentColor" : "none"} />
          </button>
          <button
            type="button"
            className="icon-btn attachment-chip-action"
            title="Save As..."
            onClick={(e) => {
              e.stopPropagation();
              onSaveAs(a);
            }}
          >
            <Save size={20} />
          </button>
          <button
            type="button"
            className="icon-btn attachment-chip-action"
            title="Delete attachment"
            onClick={(e) => {
              e.stopPropagation();
              onRequestDelete(a);
            }}
          >
            <Trash2 size={20} />
          </button>
        </div>
      ))}
    </div>
  );
}
