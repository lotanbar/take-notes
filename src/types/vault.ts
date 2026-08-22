export type NodeType = "file" | "folder";

// Points at a note's encrypted content blob inside the vault file's append-only
// blob region, instead of carrying the content inline. See src-tauri/src/vault.rs.
export interface ContentRef {
  payloadOffset: number;
  length: number;
  checksum?: string;
}

export interface TreeNode {
  id: string;
  type: NodeType;
  name: string;
  createdAt: number;
  modifiedAt: number;
  children: TreeNode[];
  locked: boolean;
  lockSalt?: string;
  lockCheck?: string;
  contentRef?: ContentRef;
  // v3 immutable attachment/image records. Kept in the unencrypted header so
  // compaction can preserve locked notes without requiring their passwords.
  blobRefs?: ContentRef[];
  // Mirrors the attachment snapshot stored in this node's encrypted content.
  // Text-only saves must never move this backwards, otherwise a stale editor
  // can replace a newer attachment with older bytes.
  attachmentRevision?: number;
}

export interface BookmarkIndexEntry {
  hostFileId: string;
  referrers: string[];
}

export type BookmarkIndex = Record<string, BookmarkIndexEntry>;

export interface VaultFile {
  version: number;
  salt: string;
  masterCheck: string;
  tree: TreeNode;
  index: BookmarkIndex;
  // Monotonic counter bumped on every local header write, plus the device
  // that bumped it. Used to tell which of two candidate copies of this vault
  // (the local live copy vs. whatever a cloud sync client handed back) is
  // actually newer, without trusting file mtimes. Doesn't resolve true
  // concurrent edits from two devices — that falls back to last-publish-wins.
  generation: number;
  deviceId: string;
}

// Pre-migration shape: content lived inline as a base64 ciphertext string
// directly on the tree node instead of as a separate blob reference.
export interface LegacyTreeNode extends Omit<TreeNode, "children" | "contentRef"> {
  children: LegacyTreeNode[];
  content?: string;
}

export interface LegacyVaultFile extends Omit<VaultFile, "tree"> {
  tree: LegacyTreeNode;
}

export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  data: string; // populated at runtime; empty when persisted via blobRef
  blobRef?: ContentRef;
}

export interface InlineImage {
  id: string;
  mimeType: string;
  size: number;
  data: string; // populated at runtime; empty when persisted via blobRef
  blobRef?: ContentRef;
  at: number; // text offset whose line the image is displayed after
  width: number;
  height: number;
  // A durable, data-less placeholder while the full original waits in the
  // encrypted local optimization spool. Runtime views replace `data` from
  // that spool; the large source image never enters the append-only vault.
  pendingOptimization?: boolean;
}

export interface BookmarkRange {
  bookmarkId: string;
  label: string;
  from: number;
  to: number;
}

export interface LinkRange {
  linkId: string;
  targetBookmarkId: string;
  from: number;
  to: number;
}

export interface NodeContent {
  text: string;
  bookmarks: BookmarkRange[];
  links: LinkRange[];
  attachments: Attachment[];
  inlineImages: InlineImage[];
  attachmentRevision?: number;
}
