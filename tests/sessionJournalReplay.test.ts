import assert from "node:assert/strict";
import test from "node:test";
import { prepareJournalContentForReplay } from "../src/lib/sessionJournal.ts";
import type { NodeContent } from "../src/types/vault.ts";

test("journal replay rebuilds assets with embedded bytes instead of trusting stale offsets", () => {
  const content: NodeContent = {
    text: "SkyWind recovery",
    bookmarks: [],
    links: [],
    attachments: [{
      id: "embedded",
      name: "map.jpg",
      mimeType: "image/jpeg",
      size: 3,
      data: "abc",
      blobRef: { offset: 999999, length: 100, checksum: "stale" },
    }],
    inlineImages: [{
      id: "reference-only",
      mimeType: "image/avif",
      size: 10,
      data: "",
      at: 0,
      width: 100,
      height: 100,
      blobRef: { offset: 42, length: 10, checksum: "valid" },
    }],
  };

  const recovered = prepareJournalContentForReplay(content);
  assert.equal(recovered.attachments[0].data, "abc");
  assert.equal(recovered.attachments[0].blobRef, undefined);
  assert.deepEqual(recovered.inlineImages[0].blobRef, content.inlineImages[0].blobRef);
});
