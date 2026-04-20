import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { searchLocalDocs } from "./local-docs.js";

async function createFixtureRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "local-docs-test-"));
}

async function writeFixture(rootDir: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(rootDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

test("searchLocalDocs prioritizes issue-comment scope evidence", async () => {
  const rootDir = await createFixtureRoot();
  try {
    await writeFixture(
      rootDir,
      "open-docs/docs/openapi/api/issue-comment.info.mdx",
      `---
id: issue-comment
title: "Issue Comment"
---

# Issue Comment

## Authentication

Scopes:

- write:project:issue-comment: Add, edit, delete issue comments
- read:project:issue-comment: Access issue comment
`
    );

    await writeFixture(
      rootDir,
      "open-docs/docs/openapi/auth/scope.md",
      `# Scopes

## Scope list

- write:project:issue-comment
- read:project:issue-comment
`
    );

    const hits = await searchLocalDocs("What scope is required to create an issue comment via OpenAPI?", "en", 3, { rootDir });

    assert.equal(hits[0]?.path, "open-docs/docs/openapi/api/issue-comment.info.mdx");
    assert.match(hits[0]?.snippet ?? "", /write:project:issue-comment/);
    assert.equal(hits[0]?.sourceUrl, "https://docs.ones.com/developer/openapi/api/issue-comment");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("searchLocalDocs prioritizes GitHub callback troubleshooting evidence over generic page docs", async () => {
  const rootDir = await createFixtureRoot();
  try {
    await writeFixture(
      rootDir,
      "docs/ones-devops/code-integration/github-and-public-gitlab.mdx",
      `---
title: "GitHub 和公共 GitLab"
---

# GitHub 和公共 GitLab

## 链接仓库

使用 OAuth 授权 GitHub/GitLab。
如果授权完成后无法返回 ONES，或者回调页面显示 page not found，请检查 Redirect URI、Webhook 回调地址，以及 baseURL 配置是否一致。
`
    );

    await writeFixture(
      rootDir,
      "open-docs/docs/openapi/api/page.info.mdx",
      `---
id: page
title: "Page"
---

# Page

This resource represents pages.
`
    );

    const hits = await searchLocalDocs("GitHub 集成授权后回调页面显示 page not found，怎么排查？", "zh", 3, { rootDir });

    assert.equal(hits[0]?.path, "docs/ones-devops/code-integration/github-and-public-gitlab.mdx");
    assert.match(hits[0]?.snippet ?? "", /Redirect URI|回调地址|page not found/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("searchLocalDocs rejects weakly-related hits when the query has no anchor token match", async () => {
  const rootDir = await createFixtureRoot();
  try {
    await writeFixture(
      rootDir,
      "docs/account-settings/account-info/email.mdx",
      `---
title: "Email"
---

# Email

The email address within ONES.com does not differentiate between uppercase and lowercase characters.
`
    );

    const hits = await searchLocalDocs("thisquerywillnotmatchkbx procedure step", "en", 3, { rootDir });

    assert.equal(hits.length, 0);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
