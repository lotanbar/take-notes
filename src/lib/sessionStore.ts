// Persists "stay unlocked" sessions across app restarts in localStorage, scoped by
// vault file path. Only the derived AES key material is stored (never the password).
// Sessions persist until explicitly cleared by a lock action.

const LAST_VAULT_KEY = "vault-notes:lastVaultPath";

function vaultSessionKey(vaultPath: string): string {
  return `vault-notes:session:${vaultPath}`;
}

function nodeSessionsKey(vaultPath: string): string {
  return `vault-notes:nodeSessions:${vaultPath}`;
}

function layoutKey(vaultPath: string): string {
  return `vault-notes:layout:${vaultPath}`;
}

interface StoredSession {
  keyB64: string;
}

export function getLastVaultPath(): string | null {
  return localStorage.getItem(LAST_VAULT_KEY);
}

export function setLastVaultPath(path: string): void {
  localStorage.setItem(LAST_VAULT_KEY, path);
}

export function loadVaultSession(vaultPath: string): StoredSession | null {
  const raw = localStorage.getItem(vaultSessionKey(vaultPath));
  if (!raw) return null;
  try {
    const parsed: StoredSession = JSON.parse(raw);
    if (typeof parsed.keyB64 !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveVaultSession(vaultPath: string, keyB64: string): void {
  localStorage.setItem(vaultSessionKey(vaultPath), JSON.stringify({ keyB64 }));
}

export function clearVaultSession(vaultPath: string): void {
  localStorage.removeItem(vaultSessionKey(vaultPath));
  localStorage.removeItem(nodeSessionsKey(vaultPath));
}

export function loadNodeSessions(vaultPath: string): Record<string, StoredSession> {
  const raw = localStorage.getItem(nodeSessionsKey(vaultPath));
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function saveNodeSession(vaultPath: string, nodeId: string, keyB64: string): void {
  const sessions = loadNodeSessions(vaultPath);
  sessions[nodeId] = { keyB64 };
  localStorage.setItem(nodeSessionsKey(vaultPath), JSON.stringify(sessions));
}

export function clearNodeSession(vaultPath: string, nodeId: string): void {
  const sessions = loadNodeSessions(vaultPath);
  delete sessions[nodeId];
  localStorage.setItem(nodeSessionsKey(vaultPath), JSON.stringify(sessions));
}

// Remembers the open tabs / split layout across app relaunches (and across
// lock/unlock), keyed by vault path same as the other session state above.
// The stored value is dockview's own serialized layout shape — opaque here.
export function loadLayout(vaultPath: string): unknown | null {
  const raw = localStorage.getItem(layoutKey(vaultPath));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveLayout(vaultPath: string, layout: unknown): void {
  localStorage.setItem(layoutKey(vaultPath), JSON.stringify(layout));
}
