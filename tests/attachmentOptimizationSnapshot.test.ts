import assert from "node:assert/strict";
import test from "node:test";

import { createAttachmentOptimizationSnapshotStore } from "../src/lib/attachmentOptimizationSnapshot.ts";

test("external-store attachment snapshots remain referentially stable between updates", () => {
  let pendingCount = 0;
  const store = createAttachmentOptimizationSnapshotStore(() => ({ pendingCount, failedCount: 0 }));
  assert.strictEqual(store.getSnapshot(), store.getSnapshot());
  const before = store.getSnapshot();
  pendingCount = 1;
  store.publish();
  assert.notStrictEqual(store.getSnapshot(), before);
  assert.strictEqual(store.getSnapshot(), store.getSnapshot());
  assert.equal(store.getSnapshot().pendingCount, 1);
});
