import { useEffect, useState } from "react";
import { Search, FileSearch, Paperclip, TextSearch } from "lucide-react";
import { useVaultStore, type SearchResult } from "../store/vaultStore";
import { loadSearchScopes, saveSearchScopes, toggleSearchScope, type SearchScopes } from "../lib/searchPreferences";
import { ResultList, type ResultListItem } from "./ResultList";

interface SearchBarProps {
  onSelectFile: (fileId: string, attachmentId?: string, textOffset?: number, textLength?: number) => void;
  onSelectFolder: (fileId: string) => void;
}

export function SearchBar({ onSelectFile, onSelectFolder }: SearchBarProps) {
  const searchVault = useVaultStore((s) => s.searchVault);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [scopes, setScopes] = useState<SearchScopes>(loadSearchScopes);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setLoading(false);
      setFailure(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setFailure(null);
    const timer = setTimeout(() => {
      searchVault(q, scopes).then((r) => {
        if (!cancelled) setResults(r);
      }).catch((error: unknown) => {
        if (!cancelled) setFailure(error instanceof Error ? error.message : "Search failed.");
      }).finally(() => {
        if (!cancelled) setLoading(false);
      });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, scopes, searchVault]);

  function handleClick(result: SearchResult) {
    if (result.type === "folder") onSelectFolder(result.fileId);
    else onSelectFile(result.fileId, result.type === "attachment" ? result.attachmentId : undefined, result.type === "content" ? result.offset : undefined, result.type === "content" ? result.matchLength : undefined);
    setQuery("");
  }

  function toggle(scope: keyof SearchScopes) {
    setScopes((current) => {
      const next = toggleSearchScope(current, scope);
      saveSearchScopes(next);
      return next;
    });
  }

  const active = query.trim().length > 0;
  const q = query.trim().toLocaleLowerCase();
  const items: ResultListItem[] = results.map((r, index) => {
    const nameStart = r.fileName.toLocaleLowerCase().indexOf(q);
    return {
      id: `${r.type}-${r.fileId}-${r.type === "attachment" ? r.attachmentId : index}`,
      kind: r.type === "content" ? "text" : r.type,
      fileName: r.fileName,
      snippet: r.type === "content" ? r.snippet : r.type === "attachment" ? r.attachmentName : null,
      nameMatchStart: r.type === "file" || r.type === "folder" ? r.matchStart : nameStart,
      nameMatchLength: r.type === "file" || r.type === "folder" ? r.matchLength : nameStart >= 0 ? query.trim().length : 0,
      snippetMatchStart: r.type === "content" || r.type === "attachment" ? r.matchStart : undefined,
      snippetMatchLength: r.type === "content" || r.type === "attachment" ? r.matchLength : undefined,
    };
  });

  return (
    <div className="search-bar">
      <div className="search-input-wrap">
        <Search size={15} />
        <input
          type="text"
          className="search-input"
          placeholder="Search files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            setQuery("");
            setResults([]);
            setFailure(null);
            setLoading(false);
            e.currentTarget.blur();
          }}
        />
        <div className="search-scope-buttons">
          <button type="button" className={`search-scope-btn${scopes.content ? " active" : ""}`} title="Search note contents" aria-label="Search note contents" aria-pressed={scopes.content} onClick={() => toggle("content")}><TextSearch size={14} /></button>
          <button type="button" className={`search-scope-btn${scopes.attachments ? " active" : ""}`} title="Search attachment names" aria-label="Search attachment names" aria-pressed={scopes.attachments} onClick={() => toggle("attachments")}><Paperclip size={14} /></button>
          <button type="button" className={`search-scope-btn${scopes.names ? " active" : ""}`} title="Search file and folder names" aria-label="Search file and folder names" aria-pressed={scopes.names} onClick={() => toggle("names")}><FileSearch size={14} /></button>
        </div>
      </div>
      {active && (
        <div className="search-results">
          {loading ? (
            <p className="placeholder-text search-empty" role="status">Searching…</p>
          ) : failure ? (
            <p className="search-empty search-error" role="alert">{failure}</p>
          ) : <ResultList items={items} zoomBase="sidebar" onSelect={(item) => { const index = items.indexOf(item); if (index >= 0) handleClick(results[index]); }} />}
        </div>
      )}
    </div>
  );
}
