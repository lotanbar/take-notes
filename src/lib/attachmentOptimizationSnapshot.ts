export interface AttachmentOptimizationSnapshot {
  pendingCount: number;
  failedCount: number;
  version: number;
}

export function createAttachmentOptimizationSnapshotStore(
  readCounts: () => Omit<AttachmentOptimizationSnapshot, "version">,
) {
  let snapshot: AttachmentOptimizationSnapshot = { pendingCount: 0, failedCount: 0, version: 0 };
  return {
    getSnapshot: () => snapshot,
    publish: () => {
      snapshot = { ...readCounts(), version: snapshot.version + 1 };
      return snapshot;
    },
  };
}
