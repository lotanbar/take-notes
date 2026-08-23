export const SEARCH_SCOPES_STORAGE_KEY = "take-notes.search-scopes.v1";

export interface SearchScopes {
  content: boolean;
  attachments: boolean;
  names: boolean;
}

export const DEFAULT_SEARCH_SCOPES: SearchScopes = {
  content: true,
  attachments: true,
  names: true,
};

export function parseSearchScopes(value: string | null): SearchScopes {
  if (!value) return { ...DEFAULT_SEARCH_SCOPES };
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" && parsed !== null &&
      typeof (parsed as SearchScopes).content === "boolean" &&
      typeof (parsed as SearchScopes).attachments === "boolean" &&
      typeof (parsed as SearchScopes).names === "boolean" &&
      ((parsed as SearchScopes).content || (parsed as SearchScopes).attachments || (parsed as SearchScopes).names)
    ) return { ...(parsed as SearchScopes) };
  } catch {
    // Invalid preferences use the safe default.
  }
  return { ...DEFAULT_SEARCH_SCOPES };
}

export function toggleSearchScope(scopes: SearchScopes, scope: keyof SearchScopes): SearchScopes {
  if (scopes[scope] && Object.values(scopes).filter(Boolean).length === 1) return scopes;
  return { ...scopes, [scope]: !scopes[scope] };
}

export function loadSearchScopes(): SearchScopes {
  if (typeof localStorage === "undefined") return { ...DEFAULT_SEARCH_SCOPES };
  return parseSearchScopes(localStorage.getItem(SEARCH_SCOPES_STORAGE_KEY));
}

export function saveSearchScopes(scopes: SearchScopes): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(SEARCH_SCOPES_STORAGE_KEY, JSON.stringify(scopes));
}
