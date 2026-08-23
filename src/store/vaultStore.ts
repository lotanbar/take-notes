import { create } from "zustand";
import Fuse from "fuse.js";
import { save, open } from "@tauri-apps/plugin-dialog";
import type { VaultFile, VaultHeaderV4, LegacyVaultFile, TreeNode, NodeType, BookmarkIndex, Attachment, InlineImage, NodeContent } from "../types/vault";
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
  vaultFileExists,
  vaultFileSize,
  resolveLiveVaultPath,
  copyFileAtomic,
  copyFileAtomicVerified,
  historyStatus,
  historyInitialize,
  historyCheckpoint,
  type HistoryStatus,
  type VaultOpenResult,
} from "../lib/vaultFileIO";
import { migrateLegacyVault } from "../lib/vaultMigration";
import { compactVaultTo, compactVaultInPlace } from "../lib/vaultCompaction";
import { stopAllAttachmentWatches } from "../lib/attachmentWatch";
import { getDeviceId } from "../lib/deviceId";
import { convertTiptapDocToPlainText, type LegacyNode } from "../editor/legacyMigration";
import { preserveNewerAttachments } from "../lib/attachmentRevision";
import { packNote, restoreSelectedCodec, selectCompressionCodec, unpackNote } from "../lib/noteCompression";
import { clearJournal, hashJournalNodeId, readJournal, writeJournal } from "../lib/sessionJournal";
import {
  getLastVaultPath,
  setLastVaultPath,
  loadVaultSession,
  saveVaultSession,
  clearVaultSession,
  loadNodeSessions,
  saveNodeSession,
  clearNodeSession,
  clearUnfinishedShutdown,
  readUnfinishedShutdown,
} from "../lib/sessionStore";
import type { ClosePhase, ShutdownProgress } from "../lib/sessionStore";

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
const pendingJournalWrites = new Map<string, Promise<void>>();
let historyNeedsCheckpoint = false;
let exitFlushInFlight: Promise<void> | null = null;
let persistenceTail: Promise<unknown> = Promise.resolve();

function coordinatePersistence<T>(work: () => Promise<T>): Promise<T> {
  const run = persistenceTail.then(work, work);
  persistenceTail = run.then(() => undefined, () => undefined);
  return run;
}

type PendingAction =
  | { kind: "vault-create"; path: string }
  | { kind: "vault-open"; path: string; livePath: string; warning: string | null; raw: VaultFile | VaultHeaderV4; legacy: false }
  | { kind: "vault-open"; path: string; livePath: string; warning: string | null; raw: LegacyVaultFile; legacy: true }
  | {
      kind: "history-init";
      path: string;
      livePath: string;
      warning: string | null;
      raw: VaultFile;
      key: CryptoKey;
      history: HistoryStatus;
    }
  | { kind: "node-lock"; id: string }
  | { kind: "node-unlock"; id: string; destination?: NavPosition };

function parseOpenResult(result: VaultOpenResult): { raw: VaultFile | VaultHeaderV4 | LegacyVaultFile; legacy: boolean } {
  if (result.format === "v2") {
    const raw = JSON.parse(result.header) as VaultFile | VaultHeaderV4;
    if ("encryptedManifest" in raw) return { raw, legacy: false };
    // Older vaults predate the generation/deviceId fields — default them so
    // downstream code can treat them as always present.
    if (typeof raw.generation !== "number") raw.generation = 0;
    if (typeof raw.deviceId !== "string") raw.deviceId = getDeviceId();
    return { raw, legacy: false };
  }
  return { raw: JSON.parse(result.contents) as LegacyVaultFile, legacy: true };
}

async function decryptNodeContent(
  filePath: string,
  node: TreeNode,
  masterKey: CryptoKey,
  nodeKeys: Map<string, CryptoKey>,
): Promise<NodeContent | null> {
  if (!node.contentRef) return null;
  const raw = await readVaultBlob(filePath, node.contentRef);
  let payload = raw;
  if (node.locked) {
    const nodeKey = nodeKeys.get(node.id);
    if (!nodeKey) return null;
    try {
      payload = await decryptFromB64(nodeKey, raw);
    } catch {
      // Some older locked notes were never wrapped with the node key.
      payload = raw;
    }
  }
  const plaintext = await unpackNote(await decryptFromB64(masterKey, payload));
  const parsed = JSON.parse(plaintext);
  const attachmentRevision = Math.max(parsed?.attachmentRevision ?? 0, node.attachmentRevision ?? 0);

  if (parsed && typeof parsed.text === "string") {
    return {
      text: parsed.text,
      bookmarks: parsed.bookmarks ?? [],
      links: parsed.links ?? [],
      attachments: (parsed.attachments ?? []) as Attachment[],
      inlineImages: (parsed.inlineImages ?? []) as InlineImage[],
      attachmentRevision,
    };
  }

  const legacyDoc: LegacyNode | undefined = parsed?.type === "doc" ? parsed : parsed?.doc;
  const legacyAttachments = (parsed?.type === "doc" ? [] : parsed?.attachments ?? []) as Attachment[];
  if (!legacyDoc) return null;
  const migrated = convertTiptapDocToPlainText(legacyDoc);
  return { ...migrated, attachments: legacyAttachments, inlineImages: [], attachmentRevision };
}

async function unlockVaultHeader(raw: VaultFile | VaultHeaderV4, key: CryptoKey): Promise<VaultFile> {
  if (!("encryptedManifest" in raw)) return raw;
  const vault = JSON.parse(await decryptFromB64(key, raw.encryptedManifest)) as VaultFile;
  if (vault.salt !== raw.salt || vault.version !== 4) throw new Error("The encrypted vault manifest is invalid.");
  return vault;
}

// `syncPath` is the cloud-facing path the user actually picked (what's shown
// in the UI, remembered as "last vault path", and used as the identity key
// for locally-cached sessions). It is never edited in place — see
// prepareLiveVault below for why. Returns the local-only "live" path this
// device should actually read/write, seeding or reconciling it against
// whatever's currently at syncPath first.
async function prepareLiveVault(syncPath: string): Promise<{ livePath: string; warning: string | null }> {
  const livePath = await resolveLiveVaultPath(syncPath);
  const liveExists = await vaultFileExists(livePath);
  const syncExists = await vaultFileExists(syncPath);

  if (!liveExists) {
    if (!syncExists) return { livePath, warning: null };
    try {
      await openVaultFile(syncPath); // structural sanity check before adopting
    } catch (e) {
      throw new Error(
        `Could not read "${syncPath}": ${String(e)}. It looks corrupted, and there's no local copy on this ` +
          "device yet to fall back to.",
      );
    }
    await copyFileAtomic(syncPath, livePath);
    return { livePath, warning: null };
  }

  if (!syncExists) return { livePath, warning: null };

  let syncResult: VaultOpenResult;
  try {
    syncResult = await openVaultFile(syncPath);
  } catch (e) {
    return {
      livePath,
      warning:
        `The cloud copy at "${syncPath}" looks corrupted (${String(e)}) — continuing from this device's local ` +
        "copy instead. It will be overwritten with a known-good copy the next time this vault saves.",
    };
  }
  // Only v2 files carry a generation counter; if either side is still the
  // legacy flat-JSON format, skip the comparison and just keep the local
  // live copy (legacy vaults are migrated to v2 — with a fresh counter — the
  // moment they're actually opened).
  if (syncResult.format !== "v2") return { livePath, warning: null };
  const syncGeneration = (JSON.parse(syncResult.header) as Partial<VaultFile>).generation ?? 0;

  const liveResult = await openVaultFile(livePath);
  if (liveResult.format !== "v2") return { livePath, warning: null };
  const liveGeneration = (JSON.parse(liveResult.header) as Partial<VaultFile>).generation ?? 0;

  if (syncGeneration > liveGeneration) {
    await copyFileAtomic(syncPath, livePath);
  }
  return { livePath, warning: null };
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
  // The local-only working copy this device actually reads/writes — never
  // inside a cloud-synced folder. See prepareLiveVault.
  filePath: string | null;
  // The cloud-facing path the user opened/chose — what's shown in the UI and
  // what the local live copy periodically gets published to.
  syncPath: string | null;
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
  initializeHistory: () => Promise<void>;
  cancelHistory: () => void;
  clearError: () => void;
  saveVault: () => Promise<void>;
  saveVaultAs: () => Promise<void>;
  lockVault: () => Promise<void>;
  flushForExit: (onProgress?: (progress: ShutdownProgress) => void, preserveJournal?: boolean) => Promise<{ beforeBytes: number; afterBytes: number; savedBytes: number }>;

  setSelection: (ids: string[]) => void;
  createNode: (type: NodeType, parentId: string | null, index: number) => TreeNode | null;
  renameNodeAction: (id: string, name: string) => void;
  moveNodesAction: (ids: string[], parentId: string | null, index: number) => void;
  deleteNodesAction: (ids: string[]) => void;

  addNodeLock: (id: string) => void;
  toggleNodeLock: (id: string, destination?: NavPosition) => Promise<void>;
  removeNodeLock: (id: string) => Promise<void>;

  loadNodeContent: (id: string) => Promise<NodeContent | null>;
  saveNodeContent: (id: string, content: NodeContent) => Promise<void>;
  // Lower-level pieces exposed for Editor.tsx, which needs to reserve a save
  // slot for a note synchronously (before an async attachment read starts)
  // so a fast switch-away-and-back can't race it. See saveNodeContent/
  // runExclusive in the implementation for the ordering guarantee this gives.
  saveNodeContentRaw: (id: string, content: NodeContent) => Promise<void>;
  journalNodeContent: (id: string, content: NodeContent) => Promise<void>;
  runExclusive: <T>(id: string, work: () => Promise<T>) => Promise<T>;
  protectPendingImage: (id: string, plaintext: string) => Promise<string>;
  unprotectPendingImage: (id: string, ciphertext: string) => Promise<string>;

  openFile: (node: TreeNode) => Promise<void>;
  navigateToBookmark: (targetBookmarkId: string) => Promise<void>;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;

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
  syncPath: string,
  livePath: string,
  masterKey: CryptoKey,
  raw: VaultFile | LegacyVaultFile,
  legacy: boolean,
): Promise<void> {
  historyNeedsCheckpoint = false;
  let vault = legacy ? await migrateLegacyVault(livePath, raw as LegacyVaultFile, masterKey) : (raw as VaultFile);
  if (vault.version < 4) {
    await backupVaultFile(livePath, ".pre-v4-backup");
    vault = { ...vault, version: 4 };
    await writeVaultHeader(livePath, await serializeVault(vault, masterKey));
  }

  // Best-effort safety net: one full copy per open, not per edit, so a corrupt
  // append-in-progress can't lose more than the current session's edits.
  void backupVaultFile(livePath, BACKUP_SUFFIX);

  // Keyed by syncPath (the vault's stable identity across devices), not
  // livePath (which is derived from it and device-specific), so sessions
  // survive this device's live copy being reseeded from the cloud.
  const nodeSessions = loadNodeSessions(syncPath);
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
    filePath: livePath,
    syncPath,
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
  restoreSelectedCodec(vault.salt);
  const journal = await readJournal(syncPath);
  if (journal.length) {
    const nodes = flattenTree(vault.tree);
    const hashes = new Map<string, string>();
    for (const node of nodes) hashes.set(await hashJournalNodeId(node.id), node.id);
    for (const record of journal) {
      const nodeId = hashes.get(record.nodeHash);
      if (!nodeId) continue;
      try {
        const content = JSON.parse(await decryptFromB64(masterKey, record.ciphertext)) as NodeContent;
        await useVaultStore.getState().saveNodeContent(nodeId, content);
      } catch (error) {
        set({ error: `A crash-recovery journal entry could not be replayed and was preserved: ${String(error)}` });
      }
    }
  }
  void (async () => {
    const payloads: string[] = [];
    for (const node of flattenTree(vault.tree)) {
      if (node.type !== "file" || (node.locked && !sessionUnlockedIds.has(node.id))) continue;
      const content = await useVaultStore.getState().loadNodeContent(node.id).catch(() => null);
      if (content) payloads.push(JSON.stringify({ ...content, attachments: [], inlineImages: [] }));
    }
    await selectCompressionCodec(vault.salt, payloads);
  })().catch((error) => console.error("Note compression benchmark failed:", error));
  const interrupted = readUnfinishedShutdown();
  if (interrupted?.vaultPath === syncPath) {
    try {
      await checkpointOpenVault(
        () => useVaultStore.getState(),
        set,
        "Resumed interrupted shutdown",
        true,
      );
      clearUnfinishedShutdown();
      set({ error: `The previous close was interrupted during ${interrupted.phase.replace(/-/g, " ")}; rebuild, verified sync, and recovery history were resumed successfully.` });
    } catch (e) {
      set({ error: `The previous close was interrupted during ${interrupted.phase.replace(/-/g, " ")}, and resuming it failed: ${String(e)}` });
    }
  }
}

async function openAfterHistoryCheck(
  set: (partial: Partial<VaultState>) => void,
  path: string,
  livePath: string,
  key: CryptoKey,
  raw: VaultFile | LegacyVaultFile,
  legacy: boolean,
  warning: string | null,
): Promise<void> {
  // Migration is completed before the first history snapshot, so even an old
  // vault's initial commit contains the same complete v2 file the editor uses.
  const prepared = legacy ? await migrateLegacyVault(livePath, raw as LegacyVaultFile, key) : (raw as VaultFile);
  const history = await historyStatus(path);
  if (history.status !== "ready") {
    set({
      filePath: null,
      syncPath: null,
      vault: null,
      masterKey: null,
      pending: { kind: "history-init", path, livePath, warning, raw: prepared, key, history },
      passwordError: null,
    });
    return;
  }
  await finalizeVaultOpen(set, path, livePath, key, prepared, false);
  if (warning) set({ error: warning });
}

async function checkpointOpenVault(
  get: () => VaultState,
  set: (partial: Partial<VaultState>) => void,
  reason: string,
  compactAndPublish: boolean,
  publishWithoutCompaction = false,
  onPhase?: (phase: ClosePhase) => void,
): Promise<void> {
  cancelScheduledAutosave();
  const { flushAllDirtyNotes } = await import("../editor/noteModel");
  await flushAllDirtyNotes();
  await Promise.all([...pendingContentSaves.values()]);
  await Promise.all([...pendingJournalWrites.values()]);

  await coordinatePersistence(async () => {
    let { filePath, syncPath, vault, masterKey, dirty } = get();
    if (!filePath || !syncPath || !vault || !masterKey) return;
    if (dirty) {
      const snapshot = vault;
      vault = { ...snapshot, generation: (snapshot.generation ?? 0) + 1, deviceId: getDeviceId() };
      await writeVaultHeader(filePath, await serializeVault(vault, masterKey));
      if (get().vault === snapshot) set({ vault, dirty: false });
      else {
        const latest = get().vault;
        if (!latest) return;
        vault = { ...latest, generation: vault.generation + 1, deviceId: getDeviceId() };
        await writeVaultHeader(filePath, await serializeVault(vault, masterKey));
        if (get().vault === latest) set({ vault, dirty: false });
      }
    }
    const shouldCheckpoint = historyNeedsCheckpoint || compactAndPublish;
    if (compactAndPublish) {
      vault = await compactVaultInPlace(vault, filePath, masterKey);
      if (!get().dirty) set({ vault });
      onPhase?.("verifying-vault");
      await verifyVaultReopen(filePath, vault, masterKey, get().nodeKeys);
      onPhase?.("syncing-vault");
      await copyFileAtomicVerified(filePath, syncPath);
    } else if (publishWithoutCompaction && historyNeedsCheckpoint) {
      onPhase?.("syncing-vault");
      await copyFileAtomic(filePath, syncPath);
    }
    if (shouldCheckpoint) {
      onPhase?.("updating-history");
      await historyCheckpoint(syncPath, filePath, reason);
      historyNeedsCheckpoint = false;
    }
  });
}

async function verifyVaultReopen(
  path: string,
  expected: VaultFile,
  masterKey: CryptoKey,
  nodeKeys: Map<string, CryptoKey>,
): Promise<void> {
  const opened = parseOpenResult(await openVaultFile(path));
  if (opened.legacy) throw new Error("The rebuilt vault reopened as a legacy format.");
  const reopened = await unlockVaultHeader(opened.raw as VaultFile | VaultHeaderV4, masterKey);
  if (reopened.version !== 4 || reopened.salt !== expected.salt || reopened.generation !== expected.generation) {
    throw new Error("The rebuilt vault manifest did not match the saved revision.");
  }
  for (const node of flattenTree(reopened.tree)) {
    if (node.contentRef && (!node.locked || nodeKeys.has(node.id))) {
      const content = await decryptNodeContent(path, node, masterKey, nodeKeys);
      if (!content) throw new Error(`Could not reopen note ${node.id}.`);
    } else if (node.contentRef) {
      await readVaultBlob(path, node.contentRef);
    }
    for (const reference of node.blobRefs ?? []) {
      const encrypted = await readVaultBlob(path, reference);
      await decryptFromB64(masterKey, encrypted);
    }
  }
}

function clearOpenVault(set: (partial: Partial<VaultState>) => void, error: string | null = null) {
  set({
    vault: null,
    filePath: null,
    syncPath: null,
    masterKey: null,
    dirty: false,
    error,
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
}

async function checkpointAfterNavigation(
  get: () => VaultState,
  set: (partial: Partial<VaultState>) => void,
  previousFileId: string | null,
  targetFileId: string,
): Promise<boolean> {
  if (!previousFileId || previousFileId === targetFileId) return true;
  try {
    await checkpointOpenVault(get, set, `Switched from ${findNode(get().vault!.tree, previousFileId)?.name ?? "note"}`, false);
    return true;
  } catch (e) {
    const syncPath = get().syncPath;
    await stopAllAttachmentWatches().catch(() => {});
    if (syncPath) clearVaultSession(syncPath);
    clearOpenVault(set, `Recovery history failed; the vault was locked: ${String(e)}`);
    return false;
  }
}

export const useVaultStore = create<VaultState>((set, get) => ({
  filePath: null,
  syncPath: null,
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
    if (get().vault) {
      try {
        await checkpointOpenVault(get, set, "Before opening another vault", true);
      } catch (e) {
        set({ error: `The current vault could not be saved before opening another one: ${String(e)}` });
        return;
      }
    }
    const path = await open({
      multiple: false,
      filters: [{ name: "Vault", extensions: ["vlt"] }],
    });
    if (!path || Array.isArray(path)) return;
    try {
      const { livePath, warning } = await prepareLiveVault(path);
      const { raw, legacy } = parseOpenResult(await openVaultFile(livePath));
      set({
        pending: { kind: "vault-open", path, livePath, warning, raw, legacy } as PendingAction,
        passwordError: null,
      });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  tryAutoOpenLastVault: async () => {
    if (get().vault) return;
    const path = getLastVaultPath();
    if (!path) return;
    try {
      const { livePath, warning } = await prepareLiveVault(path);
      const { raw, legacy } = parseOpenResult(await openVaultFile(livePath));

      const session = loadVaultSession(path);
      if (session) {
        try {
          const key = await importKeyB64(session.keyB64);
          const unlocked = legacy ? raw as LegacyVaultFile : await unlockVaultHeader(raw as VaultFile | VaultHeaderV4, key);
          const decrypted = await decryptFromB64(key, unlocked.masterCheck);
          if (decrypted === MASTER_CHECK_SENTINEL) {
            await openAfterHistoryCheck(set, path, livePath, key, unlocked, legacy, warning);
            return;
          }
        } catch {
          // cached key no longer works (file replaced, corrupt entry, etc.) — fall through
        }
      }

      set({
        pending: { kind: "vault-open", path, livePath, warning, raw, legacy } as PendingAction,
        passwordError: null,
      });
    } catch {
      // last vault file missing or unreadable — silently fall back to the landing screen
    }
  },

  submitPassword: async (password) => {
    const { pending, vault } = get();
    if (!pending) return;

    if (pending.kind === "vault-create") {
      try {
        const syncPath = pending.path;
        const livePath = await resolveLiveVaultPath(syncPath);
        const salt = randomSaltB64();
        const key = await deriveKey(password, salt);
        const masterCheck = await encryptToB64(key, MASTER_CHECK_SENTINEL);
        const newVaultFile: VaultFile = {
          version: 4,
          salt,
          masterCheck,
          tree: newRootNode(),
          index: {},
          generation: 1,
          deviceId: getDeviceId(),
        };
        await vaultCreateFresh(livePath);
        const headerJson = await serializeVault(newVaultFile, key);
        await writeVaultHeader(livePath, headerJson);
        await copyFileAtomic(livePath, syncPath); // initial publish
        setLastVaultPath(syncPath);
        saveVaultSession(syncPath, await exportKeyB64(key));
        await openAfterHistoryCheck(set, syncPath, livePath, key, newVaultFile, false, null);
      } catch (e) {
        set({ error: String(e), pending: null });
      }
      return;
    }

    if (pending.kind === "vault-open") {
      let key: CryptoKey;
      let unlocked: VaultFile | LegacyVaultFile;
      try {
        key = await deriveKey(password, pending.raw.salt);
        unlocked = pending.legacy
          ? pending.raw as LegacyVaultFile
          : await unlockVaultHeader(pending.raw as VaultFile | VaultHeaderV4, key);
        const decrypted = await decryptFromB64(key, unlocked.masterCheck);
        if (decrypted !== MASTER_CHECK_SENTINEL) throw new Error("mismatch");
      } catch {
        set({ passwordError: "Incorrect password." });
        return;
      }
      setLastVaultPath(pending.path);
      saveVaultSession(pending.path, await exportKeyB64(key));
      try {
        await openAfterHistoryCheck(set, pending.path, pending.livePath, key, unlocked, pending.legacy, pending.warning);
      } catch (e) {
        set({ error: String(e), pending: null });
      }
      return;
    }

    if (pending.kind === "node-lock") {
      const { flushSaveNow } = await import("../editor/noteModel");
      await flushSaveNow(pending.id);
      await (pendingContentSaves.get(pending.id) ?? Promise.resolve());
      if (!vault) return;
      const currentVault = get().vault;
      if (!currentVault) return;
      const node = findNode(currentVault.tree, pending.id);
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
      const { syncPath } = get();
      if (syncPath) saveNodeSession(syncPath, pending.id, await exportKeyB64(key));
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
        const { syncPath } = get();
        if (syncPath) saveNodeSession(syncPath, pending.id, await exportKeyB64(key));
        set({
          nodeKeys,
          sessionUnlockedIds,
          pending: null,
          passwordError: null,
          activeFileId: pending.destination?.fileId ?? get().activeFileId,
          activeBookmarkId: pending.destination ? pending.destination.bookmarkId : get().activeBookmarkId,
        });
      } catch {
        set({ passwordError: "Incorrect password." });
      }
      return;
    }
  },

  cancelPassword: () => set({ pending: null, passwordError: null }),

  initializeHistory: async () => {
    const pending = get().pending;
    if (!pending || pending.kind !== "history-init") return;
    try {
      await historyInitialize(pending.path, pending.livePath);
      setLastVaultPath(pending.path);
      saveVaultSession(pending.path, await exportKeyB64(pending.key));
      await finalizeVaultOpen(set, pending.path, pending.livePath, pending.key, pending.raw, false);
      if (pending.warning) set({ error: pending.warning });
    } catch (e) {
      clearVaultSession(pending.path);
      set({ pending: null, vault: null, masterKey: null, error: `Could not create required recovery history: ${String(e)}` });
    }
  },

  cancelHistory: () => {
    const pending = get().pending;
    if (pending?.kind === "history-init") clearVaultSession(pending.path);
    set({ pending: null, vault: null, masterKey: null, passwordError: null });
  },

  clearError: () => set({ error: null }),

  saveVault: async () => {
    try {
      await coordinatePersistence(async () => {
        const { filePath, vault, masterKey } = get();
        if (!filePath || !vault || !masterKey) return;
        const nextVault: VaultFile = { ...vault, generation: (vault.generation ?? 0) + 1, deviceId: getDeviceId() };
        await writeVaultHeader(filePath, await serializeVault(nextVault, masterKey));
        if (get().vault === vault) set({ vault: nextVault, dirty: false, error: null });
        else set({ error: null });
      });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  saveVaultAs: async () => {
    let { vault, filePath, masterKey } = get();
    if (!vault || !filePath || !masterKey) return;
    const path = await save({
      filters: [{ name: "Vault", extensions: ["vlt"] }],
      defaultPath: "untitled.vlt",
    });
    if (!path) return;
    try {
      await checkpointOpenVault(get, set, "Before Save As", false);
      ({ vault, filePath, masterKey } = get());
      if (!vault || !filePath || !masterKey) return;
      const newLivePath = await resolveLiveVaultPath(path);
      // compactVaultTo already produces a complete, correct file at newLivePath
      // in one shot (no in-place mutation involved), so publishing it onward
      // to the new cloud-facing path is just one more atomic copy.
      const compacted = await compactVaultTo(vault, filePath, newLivePath, masterKey);
      await copyFileAtomic(newLivePath, path);
      await openAfterHistoryCheck(set, path, newLivePath, masterKey, compacted, false, null);
    } catch (e) {
      set({ error: String(e) });
    }
  },

  lockVault: async () => {
    const { filePath, syncPath, vault } = get();
    if (!filePath || !vault) return;
    let failure: string | null = null;
    try {
      await checkpointOpenVault(get, set, "Vault locked", true);
    } catch (e) {
      failure = `Recovery history failed; the vault was locked: ${String(e)}`;
    }
    await stopAllAttachmentWatches().catch(() => {});
    if (syncPath) clearVaultSession(syncPath);
    clearOpenVault(set, failure);
  },

  // Called from the window's close-requested handler (see App.tsx) before it
  // lets the close actually go through, so quitting via the window controls
  // compacts and publishes just like locking does -- covers the "just close
  // the window" half of never touching Save As. Awaited by the caller, so the
  // cloud copy is guaranteed up to date before the window actually closes.
  flushForExit: async (onProgress, preserveJournal = false) => {
    if (!get().vault || !get().filePath) return { beforeBytes: 0, afterBytes: 0, savedBytes: 0 };
    const lockedPending = flattenTree(get().vault!.tree).find((node) => node.locked && (node.pendingMediaCount ?? 0) > 0 && !get().sessionUnlockedIds.has(node.id));
    if (lockedPending) {
      set({ pending: { kind: "node-unlock", id: lockedPending.id }, passwordError: null });
      throw new Error(`PENDING_MEDIA_PASSWORD_REQUIRED: Enter the password for "${lockedPending.name}" to finish pending media.`);
    }
    const beforeBytes = await vaultFileSize(get().filePath!);
    cancelScheduledAutosave();
    if (!exitFlushInFlight) {
      // Close is the publication gate: flush the journaled editor state,
      // rebuild a clean vault, verify it, publish it, then checkpoint history.
      exitFlushInFlight = (async () => {
        onProgress?.({ phase: "saving-notes", current: 0, total: 1, beforeBytes });
        onProgress?.({ phase: "rebuilding-vault", current: 0, total: 1, beforeBytes });
        await checkpointOpenVault(get, set, "Application closed", true, false, (phase) => onProgress?.({ phase, beforeBytes }));
        const sourcePath = get().syncPath;
        if (sourcePath) {
          const afterBytes = await vaultFileSize(get().filePath!);
          onProgress?.({ phase: "verifying-vault", current: 1, total: 1, beforeBytes, afterBytes, savedBytes: Math.max(0, beforeBytes - afterBytes) });
          await openVaultFile(sourcePath);
          if (!preserveJournal) await clearJournal(sourcePath);
        }
      })().finally(() => {
        exitFlushInFlight = null;
      });
    }
    await exitFlushInFlight;
    const afterBytes = get().filePath ? await vaultFileSize(get().filePath!) : beforeBytes;
    return { beforeBytes, afterBytes, savedBytes: Math.max(0, beforeBytes - afterBytes) };
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
    const { syncPath } = get();
    for (const id of deletedIds) {
      nextSessionUnlocked.delete(id);
      nextNodeKeys.delete(id);
      if (syncPath) clearNodeSession(syncPath, id);
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

  toggleNodeLock: async (id, destination) => {
    const { vault, sessionUnlockedIds } = get();
    if (!vault) return;
    const node = findNode(vault.tree, id);
    if (!node || !node.locked) return;

    if (sessionUnlockedIds.has(id)) {
      const { flushSaveNow } = await import("../editor/noteModel");
      await flushSaveNow(id);
      await (pendingContentSaves.get(id) ?? Promise.resolve());
      const nextSessionUnlocked = new Set(sessionUnlockedIds);
      nextSessionUnlocked.delete(id);
      const nextNodeKeys = new Map(get().nodeKeys);
      nextNodeKeys.delete(id);
      const { syncPath } = get();
      if (syncPath) clearNodeSession(syncPath, id);
      set({
        sessionUnlockedIds: nextSessionUnlocked,
        nodeKeys: nextNodeKeys,
        activeFileId: get().activeFileId === id ? null : get().activeFileId,
        activeBookmarkId: get().activeFileId === id ? null : get().activeBookmarkId,
      });
      return;
    }

    // Unlocking a file from its padlock button has no explicit navigation
    // destination. Treat the file itself as the destination so a successful
    // password submission opens it immediately, just like clicking its name.
    const unlockDestination = destination ?? (node.type === "file" ? { fileId: id, bookmarkId: null } : undefined);
    set({ pending: { kind: "node-unlock", id, destination: unlockDestination }, passwordError: null });
  },

  removeNodeLock: async (id) => {
    const { flushSaveNow } = await import("../editor/noteModel");
    await flushSaveNow(id);
    await (pendingContentSaves.get(id) ?? Promise.resolve());
    const { vault, sessionUnlockedIds, nodeKeys, filePath, syncPath } = get();
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
    if (syncPath) clearNodeSession(syncPath, id);
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
    const plaintext = await unpackNote(await decryptFromB64(masterKey, payload));
    const parsed = JSON.parse(plaintext);

    // Current format: flat plain-text envelope.
    if (parsed && typeof parsed.text === "string") {
      const loadAsset = async <T extends Attachment | InlineImage>(asset: T): Promise<T> => {
        if (!asset.blobRef || asset.data) return asset;
        const resolvedRef = asset.blobRef.checksum
          ? node.blobRefs?.find((candidate) => candidate.checksum === asset.blobRef?.checksum) ?? asset.blobRef
          : asset.blobRef;
        const stored = await readVaultBlob(filePath, resolvedRef);
        return { ...asset, data: await decryptFromB64(masterKey, stored) };
      };
      return {
        text: parsed.text,
        bookmarks: parsed.bookmarks ?? [],
        links: parsed.links ?? [],
        attachments: await Promise.all(((parsed.attachments ?? []) as Attachment[]).map(loadAsset)),
        inlineImages: await Promise.all(((parsed.inlineImages ?? []) as InlineImage[]).map(loadAsset)),
        attachmentRevision: Math.max(parsed.attachmentRevision ?? 0, node.attachmentRevision ?? 0),
      };
    }

    // Legacy formats: a Tiptap/ProseMirror doc, either bare (`type: "doc"`, pre-envelope)
    // or wrapped in a `{ doc, attachments }` envelope. Converted once, lazily, the next
    // time the note is opened; saving afterwards rewrites it in the current format.
    const legacyDoc: LegacyNode | undefined = parsed?.type === "doc" ? parsed : parsed?.doc;
    const legacyAttachments = (parsed?.type === "doc" ? [] : parsed?.attachments ?? []) as Attachment[];
    if (!legacyDoc) return null;
    const migrated = convertTiptapDocToPlainText(legacyDoc);
    return { ...migrated, attachments: legacyAttachments, inlineImages: [], attachmentRevision: node.attachmentRevision ?? 0 };
  },

  saveNodeContentRaw: async (id, content) => {
    return coordinatePersistence(async () => {
    const { vault, masterKey, nodeKeys, filePath, syncPath } = get();
    if (!vault || !masterKey || !filePath || !syncPath) return;
    const node = findNode(vault.tree, id);
    if (!node) return;
    const nodeKey = node.locked ? nodeKeys.get(id) : undefined;
    if (node.locked && !nodeKey) return;
    await get().journalNodeContent(id, content);
    const persistAsset = async <T extends Attachment | InlineImage>(asset: T): Promise<T> => {
      if (asset.blobRef) return { ...asset, data: "" };
      if (!asset.data) return asset;
      // The note-level envelope (and therefore these opaque references) is
      // additionally protected by the note password when locked. Keeping
      // immutable assets master-encrypted avoids rewriting every large asset
      // merely because a note lock is added or removed.
      const stored = await encryptToB64(masterKey, asset.data);
      const blobRef = await appendVaultBlob(filePath, stored);
      if (await readVaultBlob(filePath, blobRef) !== stored) throw new Error(`verification failed for ${asset.id}`);
      return { ...asset, data: "", blobRef };
    };
    let contentToSave = content;
    const storedAttachmentRevision = node.attachmentRevision ?? 0;
    if ((content.attachmentRevision ?? 0) < storedAttachmentRevision) {
      const currentContent = await decryptNodeContent(filePath, node, masterKey, nodeKeys);
      if (!currentContent) return;
      contentToSave = preserveNewerAttachments(content, currentContent);
    }
    const storedContent: NodeContent = {
      ...contentToSave,
      attachments: [],
      inlineImages: [],
    };
    for (const attachment of contentToSave.attachments) storedContent.attachments.push(await persistAsset(attachment));
    for (const image of contentToSave.inlineImages) storedContent.inlineImages.push(await persistAsset(image));
    const packedContent = await packNote(JSON.stringify(storedContent));
    let payload = await encryptToB64(masterKey, packedContent.plaintext);
    if (node.locked) {
      payload = await encryptToB64(nodeKey!, payload);
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
    const blobRefs = [...storedContent.attachments, ...storedContent.inlineImages]
      .map((asset) => asset.blobRef)
      .filter((ref): ref is NonNullable<typeof ref> => !!ref);
    const nextTree = applyToNode(latestVault.tree, id, (n) => ({
      ...n,
      contentRef,
      blobRefs,
      attachmentRevision: contentToSave.attachmentRevision ?? 0,
      compression: packedContent.metadata,
      pendingMediaCount: [...contentToSave.attachments, ...contentToSave.inlineImages].filter((asset) => asset.compressionState === "pending" || asset.compressionState === "processing" || asset.compressionState === "failed" || ("pendingOptimization" in asset && asset.pendingOptimization)).length,
      modifiedAt: Date.now(),
    }));
    set({ vault: { ...latestVault, version: 4, tree: nextTree }, dirty: true });
    });
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

  journalNodeContent: (id, content) => {
    const { masterKey, syncPath } = get();
    if (!masterKey || !syncPath) return Promise.resolve();
    const revision = Date.now();
    const prior = pendingJournalWrites.get(id) ?? Promise.resolve();
    const run = prior.then(async () => {
      await writeJournal(syncPath, id, await encryptToB64(masterKey, JSON.stringify(content)), revision);
    });
    const tracked = run.finally(() => {
      if (pendingJournalWrites.get(id) === tracked) pendingJournalWrites.delete(id);
    });
    pendingJournalWrites.set(id, tracked);
    return tracked;
  },

  protectPendingImage: async (id, plaintext) => {
    const { vault, masterKey, nodeKeys } = get();
    if (!vault || !masterKey) throw new Error("The vault is locked.");
    const node = findNode(vault.tree, id);
    if (!node) throw new Error("The screenshot's note no longer exists.");
    let payload = await encryptToB64(masterKey, plaintext);
    if (node.locked) {
      const nodeKey = nodeKeys.get(id);
      if (!nodeKey) throw new Error("Unlock the note before optimizing its screenshots.");
      payload = await encryptToB64(nodeKey, payload);
    }
    return payload;
  },

  unprotectPendingImage: async (id, ciphertext) => {
    const { vault, masterKey, nodeKeys } = get();
    if (!vault || !masterKey) throw new Error("The vault is locked.");
    const node = findNode(vault.tree, id);
    if (!node) throw new Error("The screenshot's note no longer exists.");
    let payload = ciphertext;
    if (node.locked) {
      const nodeKey = nodeKeys.get(id);
      if (!nodeKey) throw new Error("Unlock the note before resuming its screenshots.");
      payload = await decryptFromB64(nodeKey, payload);
    }
    return decryptFromB64(masterKey, payload);
  },

  openFile: async (node) => {
    const { sessionUnlockedIds } = get();
    if (node.locked && !sessionUnlockedIds.has(node.id)) {
      await get().toggleNodeLock(node.id, { fileId: node.id, bookmarkId: null });
      return;
    }
    const previous = get().activeFileId;
    set({ activeFileId: node.id, activeBookmarkId: null });
    await checkpointAfterNavigation(get, set, previous, node.id);
  },

  navigateToBookmark: async (targetBookmarkId) => {
    const { vault, activeFileId, activeBookmarkId, sessionUnlockedIds, navBack } = get();
    if (!vault) return;
    const entry = vault.index[targetBookmarkId];
    if (!entry) return;
    const hostNode = findNode(vault.tree, entry.hostFileId);
    if (!hostNode) return;
    if (hostNode.locked && !sessionUnlockedIds.has(hostNode.id)) {
      await get().toggleNodeLock(hostNode.id, { fileId: hostNode.id, bookmarkId: targetBookmarkId });
      return;
    }
    const nextBack = activeFileId ? [...navBack, { fileId: activeFileId, bookmarkId: activeBookmarkId }] : navBack;
    set({
      activeFileId: entry.hostFileId,
      activeBookmarkId: targetBookmarkId,
      navBack: nextBack,
      navForward: [],
    });
    await checkpointAfterNavigation(get, set, activeFileId, entry.hostFileId);
  },

  goBack: async () => {
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
    await checkpointAfterNavigation(get, set, activeFileId, prev.fileId);
  },

  goForward: async () => {
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
    await checkpointAfterNavigation(get, set, activeFileId, next.fileId);
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
    const { vault, sessionUnlockedIds, masterKey, nodeKeys, filePath } = get();
    const q = query.trim();
    if (!vault || !masterKey || !filePath || !q) return [];
    const searchFilePath = filePath;
    const searchMasterKey = masterKey;

    const allNodes = flattenTree(vault.tree);
    const nameFuse = new Fuse(allNodes, { keys: ["name"], threshold: 0.4 });
    const nameMatchIds = new Set(nameFuse.search(q).map((r) => r.item.id));

    const snippetByFileId = new Map<string, string>();
    const searchable = allNodes.filter((node) =>
      node.type === "file" && (!node.locked || sessionUnlockedIds.has(node.id)),
    );
    let nextIndex = 0;
    async function scanWorker() {
      while (nextIndex < searchable.length) {
        const node = searchable[nextIndex++];
        await (pendingContentSaves.get(node.id) ?? Promise.resolve());
        const result = await decryptNodeContent(searchFilePath, node, searchMasterKey, nodeKeys).catch(() => null);
        if (!result) continue;
        const snippet = buildSnippet(result.text, q);
        if (snippet) snippetByFileId.set(node.id, snippet);
      }
    }
    await Promise.all(Array.from({ length: Math.min(8, searchable.length) }, () => scanWorker()));

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
  historyNeedsCheckpoint = true;
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    useVaultStore.getState().saveVault();
  }, AUTOSAVE_DEBOUNCE_MS);
});

function cancelScheduledAutosave() {
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
}

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
