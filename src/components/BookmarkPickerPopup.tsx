import { useEffect, useMemo, useState } from "react";
import { X, Check, FileSearch, Paperclip, TextSearch } from "lucide-react";
import { useVaultStore, type PickerEntry } from "../store/vaultStore";
import type { LinkTarget } from "../types/vault";
import { ResultList, type ResultListItem } from "./ResultList";
import { DEFAULT_SEARCH_SCOPES, toggleSearchScope, type SearchScopes } from "../lib/searchPreferences";

interface Props { onSubmit: (target: LinkTarget) => void; onCancel: () => void; }

export function BookmarkPickerPopup({ onSubmit, onCancel }: Props) {
  const listTargets = useVaultStore((s) => s.listBookmarksForPicker);
  const [entries, setEntries] = useState<PickerEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [scopes, setScopes] = useState<SearchScopes>(() => ({ ...DEFAULT_SEARCH_SCOPES }));
  useEffect(() => { let cancelled = false; void listTargets().then((r) => { if (!cancelled) setEntries(r); }); return () => { cancelled = true; }; }, [listTargets]);

  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return (entries ?? []).filter((e) => {
      const scopeEnabled = e.kind === "file" ? scopes.names : e.kind === "text" ? scopes.content : scopes.attachments;
      return scopeEnabled && (!q || e.hostFileName.toLocaleLowerCase().includes(q) || (e.label ?? "").toLocaleLowerCase().includes(q) || (e.snippet ?? "").toLocaleLowerCase().includes(q));
    });
  }, [entries, query, scopes]);
  const items: ResultListItem[] = filtered.map((e) => {
    const q = query.trim().toLocaleLowerCase();
    const ns = q ? e.hostFileName.toLocaleLowerCase().indexOf(q) : -1;
    const ss = q && e.snippet ? e.snippet.toLocaleLowerCase().indexOf(q) : -1;
    return { id: e.targetId, kind: e.kind === "text" ? "text" : e.kind, fileName: e.hostFileName, snippet: e.snippet, disabled: e.locked,
      nameMatchStart: ns, nameMatchLength: ns >= 0 ? query.trim().length : 0,
      snippetMatchStart: ss >= 0 ? ss : e.matchStart, snippetMatchLength: ss >= 0 ? query.trim().length : e.matchLength };
  });
  const canSubmit = selected !== null && filtered.some((entry) => entry.targetId === selected && !entry.locked);
  function submit(id = selected) { const e = filtered.find((x) => x.targetId === id); if (e && !e.locked) onSubmit(e.target); }

  return <div className="modal-overlay"><div className="modal picker-modal link-picker-modal">
    <h2>New Link</h2>
    <div className="search-input-wrap picker-search-wrap">
      <input autoFocus className="picker-search-input" placeholder="Search link targets..." value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
      <div className="search-scope-buttons">
        <button type="button" className={`search-scope-btn${scopes.content ? " active" : ""}`} title="Filter text bookmarks" aria-label="Filter text bookmarks" aria-pressed={scopes.content} onClick={() => setScopes((current) => toggleSearchScope(current, "content"))}><TextSearch size={14} /></button>
        <button type="button" className={`search-scope-btn${scopes.attachments ? " active" : ""}`} title="Filter attachments" aria-label="Filter attachments" aria-pressed={scopes.attachments} onClick={() => setScopes((current) => toggleSearchScope(current, "attachments"))}><Paperclip size={14} /></button>
        <button type="button" className={`search-scope-btn${scopes.names ? " active" : ""}`} title="Filter filenames" aria-label="Filter filenames" aria-pressed={scopes.names} onClick={() => setScopes((current) => toggleSearchScope(current, "names"))}><FileSearch size={14} /></button>
      </div>
    </div>
    <div className="picker-list">{!entries ? <p className="placeholder-text result-list-empty">Loading...</p> : <ResultList items={items} selectedId={selected} emptyText="No link targets found." onSelect={(item) => setSelected(item.id)} onActivate={(item) => submit(item.id)} />}</div>
    <div className="modal-actions"><button type="button" onClick={onCancel}><X size={18} />Cancel</button><button type="button" className="primary" onClick={() => submit()} disabled={!canSubmit}><Check size={18} />Submit</button></div>
  </div></div>;
}
