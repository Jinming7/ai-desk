import assert from "node:assert/strict";
import { test } from "node:test";
import { buildQueryAnchoredSnippet, resolveBootstrapIncludePaths } from "./service.js";

test("resolveBootstrapIncludePaths falls back to markdown and mdx coverage", () => {
  assert.deepEqual(resolveBootstrapIncludePaths(""), ["**/*.md", "**/*.mdx"]);
  assert.deepEqual(resolveBootstrapIncludePaths("docs/**/*.mdx"), ["docs/**/*.mdx"]);
});

test("buildQueryAnchoredSnippet exposes later callback evidence instead of chunk prefix", () => {
  const raw = `
Intro paragraph about repository linking and account authorization.

Some generic setup explanation appears first and does not answer the troubleshooting case.

If the authorization completes but ONES does not return, or the callback page shows page not found,
check whether Redirect URI, webhook callback address, and baseURL point to the same environment.
`;

  const snippet = buildQueryAnchoredSnippet(raw, ["github", "callback", "page not found", "redirect uri", "baseurl"]);

  assert.match(snippet, /page not found/i);
  assert.match(snippet, /Redirect URI/i);
  assert.doesNotMatch(snippet, /^Intro paragraph/i);
});
