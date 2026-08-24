import type { BookmarkRange, LinkRange } from "../types/vault";

// Loose shape of a legacy Tiptap/ProseMirror doc node, defined locally so this
// migration path has no runtime dependency on any @tiptap/* package.
export interface LegacyMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface LegacyNode {
  type?: string;
  text?: string;
  marks?: LegacyMark[];
  attrs?: Record<string, unknown>;
  content?: LegacyNode[];
}

const LEGACY_INDENT_UNIT_LENGTH = 4;
const LEAF_BLOCK_TYPES = new Set(["paragraph", "heading"]);

// Converts legacy margin-left-based `indent` node attributes (from before
// indentation became literal leading spaces) into literal leading spaces
// prepended to the node's text. Idempotent: nodes without the legacy
// attribute are left untouched.
function migrateLegacyIndent(node: LegacyNode): LegacyNode {
  const legacyIndent = node.attrs?.indent;
  let result = node;

  if (typeof legacyIndent === "number" && legacyIndent > 0) {
    const { indent: _indent, ...restAttrs } = node.attrs as Record<string, unknown>;
    const prefix = " ".repeat(legacyIndent * LEGACY_INDENT_UNIT_LENGTH);
    const content = [{ type: "text", text: prefix }, ...(node.content ?? [])];
    result = { ...node, attrs: restAttrs, content };
  }

  if (result.content) {
    result = { ...result, content: result.content.map(migrateLegacyIndent) };
  }

  return result;
}

interface SpanState {
  from: number;
  to: number;
}

interface WalkState {
  text: string;
  bookmarkSpans: Map<string, SpanState & { label: string }>;
  linkSpans: Map<string, SpanState & { targetBookmarkId: string }>;
}

function extendSpan<T extends SpanState>(map: Map<string, T>, id: string, start: number, end: number, extra: Omit<T, "from" | "to">) {
  const existing = map.get(id);
  if (existing) {
    existing.from = Math.min(existing.from, start);
    existing.to = Math.max(existing.to, end);
  } else {
    map.set(id, { ...(extra as T), from: start, to: end });
  }
}

function walkInline(nodes: LegacyNode[], state: WalkState) {
  for (const node of nodes) {
    if (node.type === "hardBreak") {
      state.text += "\n";
      continue;
    }
    if (typeof node.text === "string") {
      const start = state.text.length;
      state.text += node.text;
      const end = state.text.length;
      for (const mark of node.marks ?? []) {
        if (mark.type === "bookmark" && typeof mark.attrs?.bookmarkId === "string") {
          extendSpan(state.bookmarkSpans, mark.attrs.bookmarkId, start, end, {
            label: (mark.attrs.label as string) ?? "",
          });
        }
        if (mark.type === "link" && typeof mark.attrs?.linkId === "string" && typeof mark.attrs?.targetBookmarkId === "string") {
          extendSpan(state.linkSpans, mark.attrs.linkId, start, end, {
            targetBookmarkId: mark.attrs.targetBookmarkId,
          });
        }
      }
      continue;
    }
    if (node.content) walkInline(node.content, state);
  }
}

function emitLeafBlock(node: LegacyNode, state: WalkState, prefix: string) {
  if (state.text.length > 0) state.text += "\n";
  if (prefix) state.text += prefix;
  walkInline(node.content ?? [], state);
}

function walkListItem(item: LegacyNode, state: WalkState, marker: string) {
  const continuation = " ".repeat(marker.length);
  let first = true;
  for (const child of item.content ?? []) {
    walkNode(child, state, first ? marker : continuation);
    first = false;
  }
}

function walkNode(node: LegacyNode, state: WalkState, prefix: string) {
  switch (node.type) {
    case "bulletList":
      for (const item of node.content ?? []) walkListItem(item, state, `${prefix}- `);
      return;
    case "orderedList": {
      let n = 1;
      for (const item of node.content ?? []) {
        walkListItem(item, state, `${prefix}${n}. `);
        n++;
      }
      return;
    }
    case "blockquote":
      for (const child of node.content ?? []) walkNode(child, state, `${prefix}> `);
      return;
    default:
      if (LEAF_BLOCK_TYPES.has(node.type ?? "")) {
        emitLeafBlock(node, state, prefix);
      } else {
        for (const child of node.content ?? []) walkNode(child, state, prefix);
      }
  }
}

export interface MigratedContent {
  text: string;
  bookmarks: BookmarkRange[];
  links: LinkRange[];
}

// One-time conversion of a legacy rich-text doc (ProseMirror JSON: nested
// paragraphs/headings/lists/blockquotes with bookmark/link marks) into a flat
// plain-text buffer plus offset ranges for Monaco. Bold/underline/font-size
// formatting is dropped; list/blockquote structure is preserved as literal
// markdown-ish prefixes so the text itself isn't silently reshaped.
export function convertTiptapDocToPlainText(rawDoc: LegacyNode): MigratedContent {
  const migrated = migrateLegacyIndent(rawDoc);
  const state: WalkState = { text: "", bookmarkSpans: new Map(), linkSpans: new Map() };
  for (const child of migrated.content ?? []) walkNode(child, state, "");

  return {
    text: state.text,
    bookmarks: [...state.bookmarkSpans].map(([bookmarkId, s]) => ({
      bookmarkId,
      label: s.label,
      from: s.from,
      to: s.to,
    })),
    links: [...state.linkSpans].map(([linkId, s]) => ({
      linkId,
      target: { kind: "text" as const, bookmarkId: s.targetBookmarkId },
      targetBookmarkId: s.targetBookmarkId,
      from: s.from,
      to: s.to,
    })),
  };
}
