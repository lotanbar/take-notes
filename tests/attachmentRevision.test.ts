import assert from "node:assert/strict";
import test from "node:test";
import type { Attachment, NodeContent } from "../src/types/vault.ts";
import { preserveNewerAttachments, withChangedAttachments } from "../src/lib/attachmentRevision.ts";

const oldAttachment: Attachment = {
  id: "links",
  name: "links.docx",
  mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  size: 10,
  data: "old",
};

function content(attachment: Attachment, attachmentRevision: number): NodeContent {
  return { text: "note", bookmarks: [], links: [], attachments: [attachment], attachmentRevision };
}

test("an attachment edit advances its durable revision", () => {
  const updated = { ...oldAttachment, size: 20, data: "updated" };
  const result = withChangedAttachments(content(oldAttachment, 100), [updated], 50);
  assert.equal(result.attachmentRevision, 101);
  assert.deepEqual(result.attachments, [updated]);
});

test("a stale text save cannot roll back newer attachment bytes", () => {
  const updated = { ...oldAttachment, size: 20, data: "updated" };
  const staleTextSave = { ...content(oldAttachment, 100), text: "new text" };
  const stored = content(updated, 101);
  const result = preserveNewerAttachments(staleTextSave, stored);
  assert.equal(result.text, "new text");
  assert.equal(result.attachmentRevision, 101);
  assert.deepEqual(result.attachments, [updated]);
});

test("a genuinely newer attachment change is kept", () => {
  const updated = { ...oldAttachment, data: "newest" };
  const incoming = content(updated, 102);
  assert.equal(preserveNewerAttachments(incoming, content(oldAttachment, 101)), incoming);
});
