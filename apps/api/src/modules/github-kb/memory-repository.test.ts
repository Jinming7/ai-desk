import assert from "node:assert/strict";
import { test } from "node:test";
import { attachBuildVersionToDocMetadata } from "./memory-repository.js";

test("attachBuildVersionToDocMetadata injects publication build_version into memory-backed hit metadata", () => {
  const result = attachBuildVersionToDocMetadata("build-v1", {
    sourceFamily: "doc_page",
    parser: "markdown-ast-lite"
  });

  assert.deepEqual(result, {
    build_version: "build-v1",
    sourceFamily: "doc_page",
    parser: "markdown-ast-lite"
  });
});
