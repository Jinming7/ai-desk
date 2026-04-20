import assert from "node:assert/strict";
import { test } from "node:test";
import { isPathIncluded } from "./path-glob.js";

test("isPathIncluded treats double-star slash as zero or more directories", () => {
  assert.equal(isPathIncluded("docs/20_AI_Support_Agent_Rebuild.md", ["docs/**/*.md"], []), true);
  assert.equal(isPathIncluded("docs/nested/setup.md", ["docs/**/*.md"], []), true);
  assert.equal(
    isPathIncluded("apps/api/src/db/migrations/015_github_repo_kb.sql", ["apps/api/src/db/migrations/**/*.sql"], []),
    true
  );
  assert.equal(isPathIncluded("apps/api/src/app.ts", ["apps/api/src/**/*.ts"], []), true);
  assert.equal(isPathIncluded("README.md", ["**/*.md"], []), true);
  assert.equal(isPathIncluded("docs/private/secret.md", ["docs/**/*.md"], ["docs/private/**"]), false);
});
