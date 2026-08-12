import type { TreeNode, VaultFile } from "../types/vault";
import { serializeVault } from "./serializeVault";
import {
  appendVaultBlob,
  backupVaultFile,
  finalizeVaultWrite,
  readVaultBlob,
  vaultCreateFresh,
  writeVaultHeader,
} from "./vaultFileIO";

// Rewrites the vault at a fresh path containing only live blobs (dropping
// the dead space left behind by edits/removed attachments since the last
// compaction). Used for "Save As" — since it has to produce a complete,
// valid file at a new path anyway, that's the natural point to compact.
export async function compactVaultTo(vault: VaultFile, oldPath: string, newPath: string): Promise<VaultFile> {
  await vaultCreateFresh(newPath);

  async function rewriteNode(node: TreeNode): Promise<TreeNode> {
    const contentRef = node.contentRef
      ? await appendVaultBlob(newPath, await readVaultBlob(oldPath, node.contentRef))
      : undefined;
    const blobRefs: typeof node.blobRefs = [];
    for (const ref of node.blobRefs ?? []) {
      blobRefs.push(await appendVaultBlob(newPath, await readVaultBlob(oldPath, ref)));
    }
    const children: TreeNode[] = [];
    for (const child of node.children) children.push(await rewriteNode(child));
    return { ...node, contentRef, blobRefs: blobRefs.length ? blobRefs : undefined, children };
  }

  const tree = await rewriteNode(vault.tree);
  const compacted: VaultFile = { ...vault, tree };
  const headerJson = await serializeVault(compacted);
  await writeVaultHeader(newPath, headerJson);
  return compacted;
}

const COMPACTION_TEMP_SUFFIX = ".compacting.tmp";
const PRE_COMPACT_BACKUP_SUFFIX = ".pre-compact-backup";

// Two overlapping calls for the same path (e.g. lock firing right as the
// window's close-requested handler also fires) would both target the same
// tempPath: each does vaultCreateFresh (truncate) then appends node-by-node,
// so the second truncate would invalidate offsets the first already handed
// out. Dedupe by path, same as migrateLegacyVault, so a second caller just
// awaits the first's result instead of racing it.
const inFlightCompactions = new Map<string, Promise<VaultFile>>();

// Rewrites the vault onto itself in place: compacts to a sibling temp file,
// backs up the pre-compaction original (safety net against an interrupted
// rewrite), then atomically swaps the temp file in via rename. Called
// automatically on lock/close so users who never touch "Save As" still get
// their dead space (superseded edits, deleted notes/attachments) reclaimed.
export function compactVaultInPlace(vault: VaultFile, path: string): Promise<VaultFile> {
  const existing = inFlightCompactions.get(path);
  if (existing) return existing;
  const promise = compactVaultInPlaceInner(vault, path).finally(() => {
    inFlightCompactions.delete(path);
  });
  inFlightCompactions.set(path, promise);
  return promise;
}

async function compactVaultInPlaceInner(vault: VaultFile, path: string): Promise<VaultFile> {
  const tempPath = `${path}${COMPACTION_TEMP_SUFFIX}`;
  const compacted = await compactVaultTo(vault, path, tempPath);
  await backupVaultFile(path, PRE_COMPACT_BACKUP_SUFFIX);
  await finalizeVaultWrite(tempPath, path);
  return compacted;
}
