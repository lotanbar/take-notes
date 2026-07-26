import { create } from "zustand";
import Fuse from "fuse.js";
import { save, open } from "@tauri-apps/plugin-dialog";
import type { VaultFile, LegacyVaultFile, TreeNode, NodeType, BookmarkIndex, Attachment, NodeContent } from "../types/vault";
import { deriveKey, encryptToB64, decryptFromB64, randomSaltB64, exportKeyB64, importKeyB64 } from "../crypto/crypto";
import {
  insertNode,
  removeNodes,
  renameNode as renameNodeInTree,
  moveNodes as moveNodesInTree,
  uniqueSiblingName,
  findNode,
  collectDescendantIds,
  flattenTree,
} from "../lib/treeOps";
import { extractBookmarks, getLinkTextsForTargets } from "../lib/bookmarkOps";
import { buildSnippet } from "../lib/searchOps";
import { serializeVault } from "../lib/serializeVault";
import {
  openVaultFile,
  appendVaultBlob,
  writeVaultHeader,
  readVaultBlob,
  vaultCreateFresh,
  backupVaultFile,
  type VaultOpenResult,
} from "../lib/vaultFileIO";
import { migrateLegacyVault } from "../lib/vaultMigration";
import { compactVaultTo, compactVaultInPlace } from "../lib/vaultCompaction";
import { stopAllAttachmentWatches } from "../lib/attachmentWatch";
import { convertTiptapDocToPlainText, type LegacyNode } from "../editor/legacyMigration";
import {
  getLastVaultPath,
  setLastVaultPath,
  loadVaultSession,
  saveVaultSession,
  clearVaultSession,
  loadNodeSessions,
  saveNodeSession,
  clearNodeSession,
} from "../lib/sessionStore";

const MASTER_CHECK_SENTINEL = "vault-notes-master-check-v1";
const LOCK_CHECK_SENTINEL = "vault-notes-lock-check-v1";
const BACKUP_SUFFIX = ".backup";

// Editor unmount (switching notes) and in-editor autosave can both call
// saveNodeContent for the same id in close succession; the append+contentRef
// update is async, so a fast switch-away-and-back could otherwise have
// loadNodeContent read node.contentRef before that save has landed in the
// tree, silently reloading the pre-save version (e.g. dropping an attachment
// that was just added). Track in-flight saves per id so loads and later
// saves for that id can wait for them to actually commit first.
const pendingContentSaves = new Map<string, Promise<void>>();

type PendingAction =
  | { kind: "vault-create"; path: string }
  | { kind: "vault-open"; path: string; raw: VaultFile; legacy: false }
  | { kind: "vault-open"; path: string; raw: LegacyVaultFile; legacy: true }
  | { kind: "node-lock"; id: string }
  | { kind: "node-unlock"; id: string };

function parseOpenResult(result: VaultOpenResult): { raw: VaultFile | LegacyVaultFile; legacy: boolean } {
  if (result.format === "v2") return { raw: JSON.parse(result.header) as VaultFile, legacy: false };
  return { raw: JSON.parse(result.contents) as LegacyVaultFile, legacy: true };
}

function newRootNode(): TreeNode {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    type: "folder",
    name: "root",
    createdAt: now,
    modifiedAt: now,
    children: [],
    locked: false,
  };
}

function buildNode(type: NodeType, name: string): TreeNode {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    type,
    name,
    createdAt: now,
    modifiedAt: now,
    children: [],
    locked: false,
  };
}

export interface NavPosition {
  fileId: string;
  bookmarkId: string | null;
}

export interface PickerEntry {
  bookmarkId: string;
  label: string | null;
  hostFileId: string;
  hostFileName: string;
  locked: boolean;
}

export interface ReferrerEntry {
  fileId: string;
  fileName: string;
  locked: boolean;
  snippets: string[];
}

export interface SearchResult {
  fileId: string;
  fileName: string;
  type: NodeType;
  snippet: string | null;
}

interface VaultState {
  filePath: string | null;
  vault: VaultFile | null;
  masterKey: CryptoKey | null;
  dirty: boolean;
  error: string | null;

  pending: PendingAction | null;
  passwordError: string | null;

  sessionUnlockedIds: Set<string>;
  nodeKeys: Map<string, CryptoKey>;

  selectedIds: string[];

  activeFileId: string | null;
  activeBookmarkId: string | null;
  navBack: NavPosition[];
  navForward: NavPosition[];

  newVault: () => Promise<void>;
  openVault: () => Promise<void>;
  tryAutoOpenLastVault: () => Promise<void>;
  submitPassword: (password: string) => Promise<void>;
  cancelPassword: () => void;
  saveVault: () => Promise<void>;
  saveVaultAs: () => Promise<void>;
  lockVault: () => void;
  flushForExit: () => Promise<void>;

  setSelection: (ids: string[]) => void;
  createNode: (type: NodeType, parentId: string | null, index: number) => TreeNode | null;
  renameNodeAction: (id: string, name: string) => void;
  moveNodesAction: (ids: string[], parentId: string | null, index: number) => void;
  deleteNodesAction: (ids: string[]) => void;

  addNodeLock: (id: string) => void;
  toggleNodeLock: (id: string) => void;
  removeNodeLock: (id: string) => Promise<void>;

  loadNodeContent: (id: string) => Promise<NodeContent | null>;
  saveNodeContent: (id: string, content: NodeContent) => Promise<void>;
  // Lower-level pieces exposed for Editor.tsx, which needs to reserve a save
  // slot for a note synchronously (before an async attachment read starts)
  // so a fast switch-away-and-back can't race it. See saveNodeContent/
  // runExclusive in the implementation for the ordering guarantee this gives.
  saveNodeContentRaw: (id: string, content: NodeContent) => Promise<void>;
  runExclusive: <T>(id: string, work: () => Promise<T>) => Promise<T>;

  openFile: (node: TreeNode) => void;
  navigateToBookmark: (targetBookmarkId: string) => void;
  goBack: () => void;
  goForward: () => void;

  addBookmarkToIndex: (bookmarkId: string, hostFileId: string) => void;
  removeBookmarkFromIndex: (bookmarkId: string) => void;
  addReferrerToIndex: (targetBookmarkId: string, referrerFileId: string) => void;
  removeReferrerFromIndex: (targetBookmarkId: string, referrerFileId: string) => void;
  listBookmarksForPicker: () => Promise<PickerEntry[]>;
  getReferrerEntries: (bookmarkIds: string[]) => Promise<ReferrerEntry[]>;

  searchVault: (query: string) => Promise<SearchResult[]>;
}

// Shared by the password-prompt open path and the cached-session fast path:
// migrates a legacy (pre-v2) vault in place if needed, restores locked-node
// sessions, and lands the store in the same "vault open" state either way.
async function finalizeVaultOpen(
  set: (partial: Partial<VaultState>) => void,
  path: string,
  masterKey: CryptoKey,
  raw: VaultFile | LegacyVaultFile,
  legacy: boolean,
): Promise<void> {
  const vault = legacy ? await migrateLegacyVault(path, raw as LegacyVaultFile) : (raw as VaultFile);

  // Best-effort safety net: one full copy per open, not per edit, so a corrupt
  // append-in-progress can't lose more than the current session's edits.
  void backupVaultFile(path, BACKUP_SUFFIX);

  const nodeSessions = loadNodeSessions(path);
  const nodeKeys = new Map<string, CryptoKey>();
  const sessionUnlockedIds = new Set<string>();
  for (const [nodeId, s] of Object.entries(nodeSessions)) {
    try {
      nodeKeys.set(nodeId, await importKeyB64(s.keyB64));
      sessionUnlockedIds.add(nodeId);
    } catch {
      // corrupt entry, skip
    }
  }

  set({
    filePath: path,
    vault,
    masterKey,
    dirty: false,
    error: null,
    pending: null,
    passwordError: null,
    sessionUnlockedIds,
    nodeKeys,
    selectedIds: [],
    activeFileId: null,
    activeBookmarkId: null,
    navBack: [],
    navForward: [],
  });
}

export const useVaultStore = create<VaultState>((set, get) => ({
  filePath: null,
  vault: null,
  masterKey: null,
  dirty: false,
  error: null,

  pending: null,
  passwordError: null,

  sessionUnlockedIds: new Set(),
  nodeKeys: new Map(),

  selectedIds: [],

  activeFileId: null,
  activeBookmarkId: null,
  navBack: [],
  navForward: [],

  newVault: async () => {
    const path = await save({
      filters: [{ name: "Vault", extensions: ["vlt"] }],
      defaultPath: "untitled.vlt",
    });
    if (!path) return;
    set({ pending: { kind: "vault-create", path }, passwordError: null });
  },

  openVault: async () => {
    const { filePath: currentPath, vault: currentVault, dirty } = get();
    if (currentPath && currentVault && dirty) {
      serializeVault(currentVault)
        .then((headerJson) => writeVaultHeader(currentPath, headerJson))
        .catch(() => {});
    }
    const path = await open({
      multiple: false,
      filters: [{ name: "Vault", extensions: ["vlt"] }],
    });
    if (!path || Array.isArray(path)) return;
    try {
      const { raw, legacy } = parseOpenResult(await openVaultFile(path));
      set({ pending: { kind: "vault-open", path, raw, legacy } as PendingAction, passwordError: null });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  tryAutoOpenLastVault: async () => {
    if (get().vault) return;
    const path = getLastVaultPath();
    if (!path) return;
    try {
      const { raw, legacy } = parseOpenResult(await openVaultFile(path));

      const session = loadVaultSession(path);
      if (session) {
        try {
          const key = await importKeyB64(session.keyB64);
          const decrypted = await decryptFromB64(key, raw.masterCheck);
          if (decrypted === MASTER_CHECK_SENTINEL) {
            await finalizeVaultOpen(set, path, key, raw, legacy);
            return;
          }
        } catch {
          // cached key no longer works (file replaced, corrupt entry, etc.) — fall through
        }
      }

      set({ pending: { kind: "vault-open", path, raw, legacy } as PendingAction, passwordError: null });
    } catch {
      // last vault file missing or unreadable — silently fall back to the landing screen
    }
  },

  submitPassword: async (password) => {
    const { pending, vault } = get();
    if (!pending) return;

    if (pending.kind === "vault-create") {
      try {
        const salt = randomSaltB64();
        const key = await deriveKey(password, salt);
        const masterCheck = await encryptToB64(key, MASTER_CHECK_SENTINEL);
        const newVaultFile: VaultFile = {
          version: 2,
          salt,
          masterCheck,
          tree: newRootNode(),
          index: {},
        };
        await vaultCreateFresh(pending.path);
        const headerJson = await serializeVault(newVaultFile);
        await writeVaultHeader(pending.path, headerJson);
        setLastVaultPath(pending.path);
        saveVaultSession(pending.path, await exportKeyB64(key));
        set({
          filePath: pending.path,
          vault: newVaultFile,
          masterKey: key,
          dirty: false,
          error: null,
          pending: null,
          passwordError: null,
          sessionUnlockedIds: new Set(),
          nodeKeys: new Map(),
          selectedIds: [],
          activeFileId: null,
          activeBookmarkId: null,
          navBack: [],
          navForward: [],
        });
      } catch (e) {
        set({ error: String(e), pending: null });
      }
      return;
    }

    if (pending.kind === "vault-open") {
      let key: CryptoKey;
      try {
        key = await deriveKey(password, pending.raw.salt);
        const decrypted = await decryptFromB64(key, pending.raw.masterCheck);
        if (decrypted !== MASTER_CHECK_SENTINEL) throw new Error("mismatch");
      } catch {
        set({ passwordError: "Incorrect password." });
        return;
      }
      setLastVaultPath(pending.path);
      saveVaultSession(pending.path, await exportKeyB64(key));
      try {
        await finalizeVaultOpen(set, pending.path, key, pending.raw, pending.legacy);
      } catch (e) {
        set({ error: String(e), pending: null });
      }
      return;
    }

    if (pending.kind === "node-lock") {
      if (!vault) return;
      const node = findNode(vault.tree, pending.id);
      if (!node) return;
      const lockSalt = randomSaltB64();
      const key = await deriveKey(password, lockSalt);
      const lockCheck = await encryptToB64(key, LOCK_CHECK_SENTINEL);
      const { filePath: currentPath } = get();
      let contentRef = node.contentRef;
      if (contentRef && currentPath) {
        const raw = await readVaultBlob(currentPath, contentRef);
        const wrapped = await encryptToB64(key, raw);
        contentRef = await appendVaultBlob(currentPath, wrapped);
      }
      // Re-read current state: the readVaultBlob/encrypt/appendVaultBlob awaits
      // above may have taken a while (large blobs share one global file-write
      // queue), during which another async action could have committed its own
      // tree update. Merging onto the pre-await `vault` snapshot here would
      // silently revert that.
      const latestVault = get().vault;
      if (!latestVault) return;
      const updatedTree = applyToNode(latestVault.tree, pending.id, (n) => ({
        ...n,
        locked: true,
        lockSalt,
        lockCheck,
        contentRef,
      }));
      const nodeKeys = new Map(get().nodeKeys);
      nodeKeys.set(pending.id, key);
      const sessionUnlockedIds = new Set(get().sessionUnlockedIds);
      sessionUnlockedIds.add(pending.id);
      const { filePath } = get();
      if (filePath) saveNodeSession(filePath, pending.id, await exportKeyB64(key));
      set({
        vault: { ...latestVault, tree: updatedTree },
        dirty: true,
        nodeKeys,
        sessionUnlockedIds,
        pending: null,
        passwordError: null,
      });
      return;
    }

    if (pending.kind === "node-unlock") {
      if (!vault) return;
      const node = findNode(vault.tree, pending.id);
      if (!node || !node.lockSalt || !node.lockCheck) return;
      try {
        const key = await deriveKey(password, node.lockSalt);
        const decrypted = await decryptFromB64(key, node.lockCheck);
        if (decrypted !== LOCK_CHECK_SENTINEL) throw new Error("mismatch");
        const nodeKeys = new Map(get().nodeKeys);
        nodeKeys.set(pending.id, key);
        const sessionUnlockedIds = new Set(get().sessionUnlockedIds);
        sessionUnlockedIds.add(pending.id);
        const { filePath } = get();
        if (filePath) saveNodeSession(filePath, pending.id, await exportKeyB64(key));
        set({ nodeKeys, sessionUnlockedIds, pending: null, passwordError: null });
      } catch {
        set({ passwordError: "Incorrect password." });
      }
      return;
    }
  },

  cancelPassword: () => set({ pending: null, passwordError: null }),

  saveVault: async () => {
    const { filePath, vault } = get();
    if (!filePath || !vault) return;
    try {
      const headerJson = await serializeVault(vault);
      await writeVaultHeader(filePath, headerJson);
      set({ dirty: false, error: null });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  saveVaultAs: async () => {
    const { vault, filePath } = get();
    if (!vault || !filePath) return;
    const path = await save({
      filters: [{ name: "Vault", extensions: ["vlt"] }],
      defaultPath: "untitled.vlt",
    });
    if (!path) return;
    try {
      const compacted = await compactVaultTo(vault, filePath, path);
      set({ vault: compacted, filePath: path, dirty: false, error: null });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  lockVault: () => {
    const { filePath, vault } = get();
    if (!filePath || !vault) return;
    // Always compact (not just flush the header) so dead space from earlier
    // edits/deleted notes gets reclaimed on every lock, not only via the
    // rarely-used "Save As". Fire-and-forget: locking clears the master key
    // from memory immediately, same as before, rather than waiting on the
    // rewrite of however much live content there is.
    compactVaultInPlace(vault, filePath).catch(() => {});
    stopAllAttachmentWatches().catch(() => {});
    clearVaultSession(filePath);
    set({
      vault: null,
      masterKey: null,
      dirty: false,
      sessionUnlockedIds: new Set(),
      nodeKeys: new Map(),
      selectedIds: [],
      activeFileId: null,
      activeBookmarkId: null,
      navBack: [],
      navForward: [],
      pending: null,
      passwordError: null,
    });
  },

  // Called from the window's close-requested handler (see App.tsx) before it
  // lets the close actually go through, so quitting via the window controls
  // compacts just like locking does -- covers the "just close the window"
  // half of never touching Save As.
  flushForExit: async () => {
    const { filePath, vault } = get();
    if (!filePath || !vault) return;
    await compactVaultInPlace(vault, filePath).catch(() => {});
  },

  setSelection: (ids) => set({ selectedIds: ids }),

  createNode: (type, parentId, index) => {
    const { vault } = get();
    if (!vault) return null;
    const parent = parentId ? findNode(vault.tree, parentId) : vault.tree;
    if (!parent) return null;
    const baseName = type === "folder" ? "New Folder" : "New File";
    const name = uniqueSiblingName(baseName, parent.children);
    const node = buildNode(type, name);
    const nextTree = insertNode(vault.tree, parentId, index, node);
    set({ vault: { ...vault, tree: nextTree }, dirty: true });
    return node;
  },

  renameNodeAction: (id, name) => {
    const { vault } = get();
    if (!vault || !name.trim()) return;
    const nextTree = renameNodeInTree(vault.tree, id, name.trim());
    set({ vault: { ...vault, tree: nextTree }, dirty: true });
  },

  moveNodesAction: (ids, parentId, index) => {
    const { vault } = get();
    if (!vault) return;
    const nextTree = moveNodesInTree(vault.tree, ids, parentId, index);
    set({ vault: { ...vault, tree: nextTree }, dirty: true });
  },

  deleteNodesAction: (ids) => {
    const { vault, sessionUnlockedIds, nodeKeys, activeFileId } = get();
    if (!vault) return;
    const deletedIds = new Set(
      ids.flatMap((id) => {
        const node = findNode(vault.tree, id);
        return node ? collectDescendantIds(node) : [id];
      }),
    );

    // Case 1: strip bookmarks hosted by any deleted node.
    // Case 2: strip deleted node ids from other bookmarks' referrer lists.
    const nextIndex: BookmarkIndex = {};
    for (const [bookmarkId, entry] of Object.entries(vault.index)) {
      if (deletedIds.has(entry.hostFileId)) continue;
      nextIndex[bookmarkId] = {
        ...entry,
        referrers: entry.referrers.filter((rid) => !deletedIds.has(rid)),
      };
    }

    const nextTree = removeNodes(vault.tree, ids);
    const nextSessionUnlocked = new Set(sessionUnlockedIds);
    const nextNodeKeys = new Map(nodeKeys);
    const { filePath } = get();
    for (const id of deletedIds) {
      nextSessionUnlocked.delete(id);
      nextNodeKeys.delete(id);
      if (filePath) clearNodeSession(filePath, id);
    }
    set({
      vault: { ...vault, tree: nextTree, index: nextIndex },
      dirty: true,
      sessionUnlockedIds: nextSessionUnlocked,
      nodeKeys: nextNodeKeys,
      selectedIds: [],
      activeFileId: activeFileId && deletedIds.has(activeFileId) ? null : activeFileId,
      activeBookmarkId: activeFileId && deletedIds.has(activeFileId) ? null : get().activeBookmarkId,
    });
  },

  addNodeLock: (id) => {
    const { vault } = get();
    if (!vault) return;
    const node = findNode(vault.tree, id);
    if (!node || node.locked) return;
    set({ pending: { kind: "node-lock", id }, passwordError: null });
  },

  toggleNodeLock: (id) => {
    const { vault, sessionUnlockedIds } = get();
    if (!vault) return;
    const node = findNode(vault.tree, id);
    if (!node || !node.locked) return;

    if (sessionUnlockedIds.has(id)) {
      const nextSessionUnlocked = new Set(sessionUnlockedIds);
      nextSessionUnlocked.delete(id);
      const nextNodeKeys = new Map(get().nodeKeys);
      nextNodeKeys.delete(id);
      const { filePath } = get();
      if (filePath) clearNodeSession(filePath, id);
      set({ sessionUnlockedIds: nextSessionUnlocked, nodeKeys: nextNodeKeys });
      return;
    }

    set({ pending: { kind: "node-unlock", id }, passwordError: null });
  },

  removeNodeLock: async (id) => {
    const { vault, sessionUnlockedIds, nodeKeys, filePath } = get();
    if (!vault || !filePath) return;
    const node = findNode(vault.tree, id);
    if (!node || !node.locked) return;
    const nodeKey = nodeKeys.get(id);
    if (!nodeKey) return;
    let contentRef = node.contentRef;
    if (contentRef) {
      const wrapped = await readVaultBlob(filePath, contentRef);
      const unwrapped = await decryptFromB64(nodeKey, wrapped);
      contentRef = await appendVaultBlob(filePath, unwrapped);
    }
    // Re-read current state: the awaits above may have taken a while, during
    // which another async action could have committed its own tree update.
    // Merging onto the pre-await `vault` snapshot here would silently revert it.
    const latestVault = get().vault;
    if (!latestVault) return;
    const updatedTree = applyToNode(latestVault.tree, id, (n) => ({
      ...n,
      locked: false,
      lockSalt: undefined,
      lockCheck: undefined,
      contentRef,
    }));
    const nextSessionUnlocked = new Set(sessionUnlockedIds);
    nextSessionUnlocked.delete(id);
    const nextNodeKeys = new Map(nodeKeys);
    nextNodeKeys.delete(id);
    clearNodeSession(filePath, id);
    set({
      vault: { ...latestVault, tree: updatedTree },
      dirty: true,
      sessionUnlockedIds: nextSessionUnlocked,
      nodeKeys: nextNodeKeys,
    });
  },

  loadNodeContent: async (id) => {
    await (pendingContentSaves.get(id) ?? Promise.resolve());
    const { vault, masterKey, nodeKeys, filePath } = get();
    if (!vault || !masterKey || !filePath) return null;
    const node = findNode(vault.tree, id);
    if (!node || !node.contentRef) return null;
    const raw = await readVaultBlob(filePath, node.contentRef);
    let payload = raw;
    if (node.locked) {
      const nodeKey = nodeKeys.get(id);
      if (!nodeKey) return null;
      try {
        payload = await decryptFromB64(nodeKey, raw);
      } catch {
        // Some already-locked notes predate the fix that re-wraps content with
        // the lock key on lock: their blob was never actually re-encrypted, so
        // it's still just master-key-wrapped. Fall back to that interpretation
        // rather than treating the note as unreadable; the next save rewraps
        // it correctly via the normal locked-save path.
        payload = raw;
      }
    }
    const plaintext = await decryptFromB64(masterKey, payload);
    const parsed = JSON.parse(plaintext);

    // Current format: flat plain-text envelope.
    if (parsed && typeof parsed.text === "string") {
      return {
        text: parsed.text,
        bookmarks: parsed.bookmarks ?? [],
        links: parsed.links ?? [],
        attachments: (parsed.attachments ?? []) as Attachment[],
      };
    }

    // Legacy formats: a Tiptap/ProseMirror doc, either bare (`type: "doc"`, pre-envelope)
    // or wrapped in a `{ doc, attachments }` envelope. Converted once, lazily, the next
    // time the note is opened; saving afterwards rewrites it in the current format.
    const legacyDoc: LegacyNode | undefined = parsed?.type === "doc" ? parsed : parsed?.doc;
    const legacyAttachments = (parsed?.type === "doc" ? [] : parsed?.attachments ?? []) as Attachment[];
    if (!legacyDoc) return null;
    const migrated = convertTiptapDocToPlainText(legacyDoc);
    return { ...migrated, attachments: legacyAttachments };
  },

  saveNodeContentRaw: async (id, content) => {
    const { vault, masterKey, nodeKeys, filePath } = get();
    if (!vault || !masterKey || !filePath) return;
    const node = findNode(vault.tree, id);
    if (!node) return;
    let payload = await encryptToB64(masterKey, JSON.stringify(content));
    if (node.locked) {
      const nodeKey = nodeKeys.get(id);
      if (!nodeKey) return;
      payload = await encryptToB64(nodeKey, payload);
    }
    // The vault file lives under external sync tools (e.g. Google Drive) that
    // can touch/re-upload it mid-write. Read back what actually landed on disk
    // and confirm it decrypts before trusting the pointer — catches a
    // sync-induced bit-flip/truncation right here instead of silently wiring
    // this note's contentRef to bytes that will fail decryption forever after.
    let contentRef = await appendVaultBlob(filePath, payload);
    const readBack = await readVaultBlob(filePath, contentRef);
    if (readBack !== payload) {
      // One retry: the collision is almost always a one-off timing hit, not a
      // persistent fault, so a second attempt costs little and usually clears it.
      contentRef = await appendVaultBlob(filePath, payload);
      const readBack2 = await readVaultBlob(filePath, contentRef);
      if (readBack2 !== payload) {
        const message =
          `Couldn't save "${node.name}": the vault file was corrupted on disk while writing (readback mismatch ` +
          "after retry), most likely a sync tool (Google Drive) touching the file mid-write. Nothing was lost in " +
          "the note you're editing — the save was aborted rather than committing a broken pointer. Try again in a " +
          "moment once syncing settles.";
        set({ error: message });
        throw new Error(message);
      }
    }
    // Re-read current state instead of the pre-await snapshot: other async
    // actions (another note's save, a lock/unlock) may have committed their
    // own tree updates while this appendVaultBlob call was queued behind
    // others, and merging onto the stale snapshot here would silently
    // revert them.
    const latestVault = get().vault;
    if (!latestVault) return;
    const nextTree = applyToNode(latestVault.tree, id, (n) => ({ ...n, contentRef, modifiedAt: Date.now() }));
    set({ vault: { ...latestVault, tree: nextTree }, dirty: true });
  },

  // Chains `work` onto any operation already in flight for this id, so two
  // saves for the same note (e.g. an attach-triggered flush followed moments
  // later by the unmount-on-navigate flush) commit in the order they were
  // issued instead of racing each other's appendVaultBlob/tree-update pair.
  // Callers that need to read mutable refs (like Editor.tsx's latest-content
  // refs) for the content to save MUST read them from inside `work`, not
  // before calling runExclusive — reading them eagerly at the call site would
  // capture a stale snapshot if this call ends up queued behind another
  // pending operation for the same id.
  runExclusive: (id, work) => {
    const prior = pendingContentSaves.get(id) ?? Promise.resolve();
    const run = prior.then(work);
    pendingContentSaves.set(
      id,
      run.then(() => undefined, () => undefined),
    );
    return run;
  },

  saveNodeContent: (id, content) => get().runExclusive(id, () => get().saveNodeContentRaw(id, content)),

  openFile: (node) => {
    const { sessionUnlockedIds } = get();
    if (node.locked && !sessionUnlockedIds.has(node.id)) {
      get().toggleNodeLock(node.id);
      return;
    }
    set({ activeFileId: node.id, activeBookmarkId: null });
  },

  navigateToBookmark: (targetBookmarkId) => {
    const { vault, activeFileId, activeBookmarkId, sessionUnlockedIds, navBack } = get();
    if (!vault) return;
    const entry = vault.index[targetBookmarkId];
    if (!entry) return;
    const hostNode = findNode(vault.tree, entry.hostFileId);
    if (!hostNode) return;
    if (hostNode.locked && !sessionUnlockedIds.has(hostNode.id)) {
      get().toggleNodeLock(hostNode.id);
      return;
    }
    const nextBack = activeFileId ? [...navBack, { fileId: activeFileId, bookmarkId: activeBookmarkId }] : navBack;
    set({
      activeFileId: entry.hostFileId,
      activeBookmarkId: targetBookmarkId,
      navBack: nextBack,
      navForward: [],
    });
  },

  goBack: () => {
    const { navBack, navForward, activeFileId, activeBookmarkId } = get();
    if (navBack.length === 0) return;
    const prev = navBack[navBack.length - 1];
    const nextForward = activeFileId
      ? [...navForward, { fileId: activeFileId, bookmarkId: activeBookmarkId }]
      : navForward;
    set({
      activeFileId: prev.fileId,
      activeBookmarkId: prev.bookmarkId,
      navBack: navBack.slice(0, -1),
      navForward: nextForward,
    });
  },

  goForward: () => {
    const { navBack, navForward, activeFileId, activeBookmarkId } = get();
    if (navForward.length === 0) return;
    const next = navForward[navForward.length - 1];
    const nextBack = activeFileId ? [...navBack, { fileId: activeFileId, bookmarkId: activeBookmarkId }] : navBack;
    set({
      activeFileId: next.fileId,
      activeBookmarkId: next.bookmarkId,
      navBack: nextBack,
      navForward: navForward.slice(0, -1),
    });
  },

  addBookmarkToIndex: (bookmarkId, hostFileId) => {
    const { vault } = get();
    if (!vault) return;
    const nextIndex = { ...vault.index, [bookmarkId]: { hostFileId, referrers: [] } };
    set({ vault: { ...vault, index: nextIndex }, dirty: true });
  },

  removeBookmarkFromIndex: (bookmarkId) => {
    const { vault } = get();
    if (!vault) return;
    const nextIndex = { ...vault.index };
    delete nextIndex[bookmarkId];
    set({ vault: { ...vault, index: nextIndex }, dirty: true });
  },

  addReferrerToIndex: (targetBookmarkId, referrerFileId) => {
    const { vault } = get();
    if (!vault) return;
    const entry = vault.index[targetBookmarkId];
    if (!entry || entry.referrers.includes(referrerFileId)) return;
    const nextIndex = {
      ...vault.index,
      [targetBookmarkId]: { ...entry, referrers: [...entry.referrers, referrerFileId] },
    };
    set({ vault: { ...vault, index: nextIndex }, dirty: true });
  },

  removeReferrerFromIndex: (targetBookmarkId, referrerFileId) => {
    const { vault } = get();
    if (!vault) return;
    const entry = vault.index[targetBookmarkId];
    if (!entry) return;
    const nextIndex = {
      ...vault.index,
      [targetBookmarkId]: { ...entry, referrers: entry.referrers.filter((id) => id !== referrerFileId) },
    };
    set({ vault: { ...vault, index: nextIndex }, dirty: true });
  },

  listBookmarksForPicker: async () => {
    const { vault, sessionUnlockedIds, loadNodeContent } = get();
    if (!vault) return [];
    const contentCache = new Map<string, NodeContent | null>();
    const entries: PickerEntry[] = [];
    for (const [bookmarkId, entry] of Object.entries(vault.index)) {
      const hostNode = findNode(vault.tree, entry.hostFileId);
      if (!hostNode) continue;
      const locked = hostNode.locked && !sessionUnlockedIds.has(hostNode.id);
      if (locked) {
        entries.push({ bookmarkId, label: null, hostFileId: hostNode.id, hostFileName: hostNode.name, locked: true });
        continue;
      }
      if (!contentCache.has(hostNode.id)) {
        const result = await loadNodeContent(hostNode.id);
        contentCache.set(hostNode.id, result);
      }
      const content = contentCache.get(hostNode.id);
      const label = content ? extractBookmarks(content).find((b) => b.bookmarkId === bookmarkId)?.label ?? null : null;
      entries.push({ bookmarkId, label, hostFileId: hostNode.id, hostFileName: hostNode.name, locked: false });
    }
    return entries;
  },

  getReferrerEntries: async (bookmarkIds) => {
    const { vault, sessionUnlockedIds, loadNodeContent } = get();
    if (!vault) return [];
    const targetSet = new Set(bookmarkIds);
    const referrerIds = new Set(bookmarkIds.flatMap((id) => vault.index[id]?.referrers ?? []));
    const entries: ReferrerEntry[] = [];
    for (const referrerId of referrerIds) {
      const node = findNode(vault.tree, referrerId);
      if (!node) continue;
      const locked = node.locked && !sessionUnlockedIds.has(node.id);
      if (locked) {
        entries.push({ fileId: node.id, fileName: node.name, locked: true, snippets: [] });
        continue;
      }
      const content = await loadNodeContent(referrerId);
      const snippets = content ? getLinkTextsForTargets(content, targetSet) : [];
      entries.push({ fileId: node.id, fileName: node.name, locked: false, snippets });
    }
    return entries;
  },

  searchVault: async (query) => {
    const { vault, sessionUnlockedIds, loadNodeContent } = get();
    const q = query.trim();
    if (!vault || !q) return [];

    const allNodes = flattenTree(vault.tree);
    const nameFuse = new Fuse(allNodes, { keys: ["name"], threshold: 0.4 });
    const nameMatchIds = new Set(nameFuse.search(q).map((r) => r.item.id));

    const snippetByFileId = new Map<string, string>();
    for (const node of allNodes) {
      if (node.type !== "file") continue;
      const locked = node.locked && !sessionUnlockedIds.has(node.id);
      if (locked) continue;
      const result = await loadNodeContent(node.id);
      if (!result) continue;
      const snippet = buildSnippet(result.text, q);
      if (snippet) snippetByFileId.set(node.id, snippet);
    }

    const resultIds = new Set([...nameMatchIds, ...snippetByFileId.keys()]);
    const results: SearchResult[] = [];
    for (const id of resultIds) {
      const node = allNodes.find((n) => n.id === id);
      if (!node) continue;
      results.push({ fileId: id, fileName: node.name, type: node.type, snippet: snippetByFileId.get(id) ?? null });
    }
    return results;
  },
}));

const AUTOSAVE_DEBOUNCE_MS = 800;
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
useVaultStore.subscribe((state) => {
  if (!state.dirty || !state.vault || !state.filePath) return;
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    useVaultStore.getState().saveVault();
  }, AUTOSAVE_DEBOUNCE_MS);
});

// Structural sharing: only clone the path from the root down to the edited node.
// Sibling subtrees that don't contain `id` keep their original object references,
// so consumers that key off reference equality (e.g. the sidebar tree) don't see
// unrelated notes/folders as "changed" every time one note's content is saved.
function applyToNode(root: TreeNode, id: string, fn: (n: TreeNode) => TreeNode): TreeNode {
  if (root.id === id) return fn(root);
  if (root.children.length === 0) return root;
  let changed = false;
  const nextChildren = root.children.map((c) => {
    const next = applyToNode(c, id, fn);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...root, children: nextChildren } : root;
}
