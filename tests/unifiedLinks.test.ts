import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLinkTarget, isLinkBroken } from "../src/lib/bookmarkOps.ts";
import { reconcileNoteIndex } from "../src/lib/linkIndexOps.ts";
import { buildSnippetMatch } from "../src/lib/searchOps.ts";
import type { BookmarkIndex, LinkRange, LinkTarget } from "../src/types/vault.ts";

test("legacy bookmark-only links normalize and remain navigable", () => {
  const legacy = { linkId: "l", targetBookmarkId: "b", from: 0, to: 1 } as unknown as LinkRange;
  assert.deepEqual(normalizeLinkTarget(legacy), { kind: "text", bookmarkId: "b" });
  assert.equal(isLinkBroken(legacy, { b: { hostFileId: "host", referrers: [] } }), false);
});

test("same-target referrers remain until the final link is removed", () => {
  const base: BookmarkIndex = { b: { kind: "text", hostFileId: "host", referrers: [] } };
  const target: LinkTarget = { kind: "text", bookmarkId: "b" };
  const twice = reconcileNoteIndex(base, "referrer", [], [], [target, target]);
  assert.equal(twice.b.referrerCounts?.referrer, 2);
  assert.deepEqual(twice.b.referrers, ["referrer"]);
  const once = reconcileNoteIndex(twice, "referrer", [], [], [target]);
  assert.equal(once.b.referrerCounts?.referrer, 1);
  assert.deepEqual(once.b.referrers, ["referrer"]);
  const none = reconcileNoteIndex(once, "referrer", [], [], []);
  assert.deepEqual(none.b.referrers, []);
});

test("file, text, and attachment targets use durable index entries", () => {
  const index = reconcileNoteIndex(
    { file: { kind: "file", hostFileId: "file", referrers: [] } },
    "file",
    [{ bookmarkId: "text" }],
    [{ id: "attachment", name: "photo.png" }],
    [],
  );
  assert.equal(index.file.kind, "file");
  assert.equal(index.text.kind, "text");
  assert.equal(index.attachment.kind, "attachment");
  assert.equal(index.attachment.attachmentName, "photo.png");
});

test("snippets preserve exact offsets at boundaries and in RTL text", () => {
  const start = buildSnippetMatch("match followed by words", "match", 4)!;
  assert.equal(start.matchStart, 0);
  assert.equal(start.sourceOffset, 0);
  const rtl = buildSnippetMatch("לפני מילתמפתח אחרי", "מילתמפתח", 5)!;
  assert.equal(rtl.text.slice(rtl.matchStart, rtl.matchStart + rtl.matchLength), "מילתמפתח");
  assert.equal(rtl.sourceOffset, 5);
  const end = buildSnippetMatch("words before match", "match", 3)!;
  assert.equal(end.text.slice(end.matchStart, end.matchStart + end.matchLength), "match");
});
