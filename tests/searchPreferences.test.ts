import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SEARCH_SCOPES, parseSearchScopes, toggleSearchScope } from "../src/lib/searchPreferences.ts";

test("search scopes default when absent or invalid", () => {
  assert.deepEqual(parseSearchScopes(null), DEFAULT_SEARCH_SCOPES);
  assert.deepEqual(parseSearchScopes("not json"), DEFAULT_SEARCH_SCOPES);
  assert.deepEqual(parseSearchScopes('{"content":true}'), DEFAULT_SEARCH_SCOPES);
  assert.deepEqual(parseSearchScopes('{"content":false,"attachments":false,"names":false}'), DEFAULT_SEARCH_SCOPES);
});

test("search scopes parse valid preferences", () => {
  assert.deepEqual(parseSearchScopes('{"content":false,"attachments":true,"names":false}'), {
    content: false, attachments: true, names: false,
  });
});

test("the final search scope cannot be disabled", () => {
  const onlyNames = { content: false, attachments: false, names: true };
  assert.strictEqual(toggleSearchScope(onlyNames, "names"), onlyNames);
  assert.deepEqual(toggleSearchScope(onlyNames, "content"), { content: true, attachments: false, names: true });
});
