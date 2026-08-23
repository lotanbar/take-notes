import test from "node:test";
import assert from "node:assert/strict";
import { decodedBase64Size, hasCurrentMediaCompression, isOptimizableMediaMime, needsMediaMigration } from "../src/lib/mediaMigrationPolicy.ts";
import type { Attachment } from "../src/types/vault.ts";

function asset(overrides: Partial<Attachment> = {}): Attachment {
  return { id: "asset", name: "photo.jpg", mimeType: "image/jpeg", size: 3, data: "AQID", ...overrides };
}

test("the full-library scan recognizes supported media but not arbitrary files", () => {
  assert.equal(isOptimizableMediaMime("image/jpeg"), true);
  assert.equal(isOptimizableMediaMime("image/avif"), true);
  assert.equal(isOptimizableMediaMime("audio/wav"), true);
  assert.equal(isOptimizableMediaMime("video/mp4"), true);
  assert.equal(isOptimizableMediaMime("application/pdf"), false);
  assert.equal(isOptimizableMediaMime("image/svg+xml"), false);
});

test("only a verified current-profile result is skipped", () => {
  assert.equal(needsMediaMigration(asset()), true);
  const processed = asset({
    compressionState: "processed",
    compression: { codec: "original", profileVersion: 1, sourceHash: "aa", outputHash: "aa", sourceSize: 3, outputSize: 3 },
  });
  assert.equal(hasCurrentMediaCompression(processed), true);
  assert.equal(needsMediaMigration(processed), false);
  assert.equal(needsMediaMigration({ ...processed, compression: { ...processed.compression!, profileVersion: 0 } }), true);
});

test("base64 sizes include padding correctly", () => {
  assert.equal(decodedBase64Size("AQ=="), 1);
  assert.equal(decodedBase64Size("AQI="), 2);
  assert.equal(decodedBase64Size("AQID"), 3);
});
