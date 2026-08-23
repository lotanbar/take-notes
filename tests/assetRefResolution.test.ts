import test from "node:test";
import assert from "node:assert/strict";
import { resolveAssetBlobRef } from "../src/lib/assetRefResolution.ts";

test("a compacted vault remaps an envelope's stale media offset by checksum", () => {
  const stale = { payloadOffset: 122_186_484, length: 3_921_732, checksum: "same-object" };
  const current = { payloadOffset: 8_192, length: 3_921_732, checksum: "same-object" };
  assert.equal(resolveAssetBlobRef(stale, [current]), current);
});

test("an unmatched media reference is left unchanged so corruption is rejected", () => {
  const stale = { payloadOffset: 500, length: 20, checksum: "missing" };
  assert.equal(resolveAssetBlobRef(stale, [{ payloadOffset: 900, length: 20, checksum: "different" }]), stale);
});
