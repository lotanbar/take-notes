import type { LegacyTreeNode, LegacyVaultFile, TreeNode, VaultFile } from "../types/vault";
import { getDeviceId } from "./deviceId";
import { serializeVault } from "./serializeVault";
import { appendVaultBlob, backupVaultFile, finalizeVaultWrite, vaultCreateFresh, writeVaultHeader } from "./vaultFileIO";

const MIGRATION_TEMP_SUFFIX = ".migrating.tmp";
const PRE_MIGRATION_BACKUP_SUFFIX = ".pre-v2-backup";

// Two concurrent migrations for the same path (e.g. StrictMode's dev-mode
// double-invoke of an unguarded mount effect, or auto-open racing a manual
// open) would both target the same tempPath: each does vaultCreateFresh
// (truncate) then appends node-by-node, so the second truncate silently
// invalidates offsets the first migration already handed out and baked into
// its in-progress tree — corrupting contentRefs for whichever nodes were
// mid-append at that moment, permanently, since those notes are never
// resaved afterward. Dedupe by path so only one migration ever touches a
// given tempPath at a time; a second caller just awaits the first's result.
const inFlightMigrations = new Map<string, Promise<VaultFile>>();

export function migrateLegacyVault(path: string, legacy: LegacyVaultFile): Promise<VaultFile> {
  const existing = inFlightMigrations.get(path);
  if (existing) return existing;
  const promise = migrateLegacyVaultInner(path, legacy).finally(() => {
    inFlightMigrations.delete(path);
  });
  inFlightMigrations.set(path, promise);
  return promise;
}

// Moves every node's already-encrypted `content` string out of the tree and
// into the file's blob region, replacing it with a small offset/length ref.
// No decryption happens here — content stays opaque ciphertext the whole
// time, so this works uniformly for locked and unlocked nodes alike, without
// needing any node passwords. Writes to a temp file and only swaps it in via
// atomic rename once fully written; the original is preserved as a backup.
async function migrateLegacyVaultInner(path: string, legacy: LegacyVaultFile): Promise<VaultFile> {
  const tempPath = `${path}${MIGRATION_TEMP_SUFFIX}`;
  await vaultCreateFresh(tempPath);

  async function migrateNode(node: LegacyTreeNode): Promise<TreeNode> {
    const contentRef = node.content ? await appendVaultBlob(tempPath, node.content) : undefined;
    const children: TreeNode[] = [];
    for (const child of node.children) children.push(await migrateNode(child));
    const { content: _content, ...rest } = node;
    return { ...rest, contentRef, children };
  }

  const tree = await migrateNode(legacy.tree);
  const migrated: VaultFile = {
    version: 2,
    salt: legacy.salt,
    masterCheck: legacy.masterCheck,
    tree,
    index: legacy.index,
    generation: 0,
    deviceId: getDeviceId(),
  };

  const headerJson = await serializeVault(migrated);
  await writeVaultHeader(tempPath, headerJson);

  await backupVaultFile(path, PRE_MIGRATION_BACKUP_SUFFIX);
  await finalizeVaultWrite(tempPath, path);
  return migrated;
}
