import test from "node:test";
import assert from "node:assert/strict";
import { resolveInsertTarget } from "../src/lib/treeOps.ts";
import type { TreeNode } from "../src/types/vault.ts";

function node(id: string, type: "folder" | "file", children: TreeNode[] = []): TreeNode {
  return {
    id,
    type,
    name: id,
    createdAt: 0,
    modifiedAt: 0,
    children,
    locked: false,
  };
}

const nestedFile = node("nested-file", "file");
const folder = node("folder", "folder", [nestedFile]);
const rootFile = node("root-file", "file");
const root = node("root", "folder", [folder, rootFile]);

test("creating from a folder inserts inside that folder", () => {
  assert.deepEqual(resolveInsertTarget(root, [folder.id]), {
    parentId: folder.id,
    index: folder.children.length,
  });
});

test("creating from a nested file inserts beside that file", () => {
  assert.deepEqual(resolveInsertTarget(root, [nestedFile.id]), {
    parentId: folder.id,
    index: 1,
  });
});

test("creating from a root file inserts beside it at the root", () => {
  assert.deepEqual(resolveInsertTarget(root, [rootFile.id]), {
    parentId: null,
    index: 2,
  });
});
