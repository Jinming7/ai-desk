import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FULL_SYNC_MANIFEST_INSERT_BATCH_SIZE,
  chunkFullSyncManifestItems
} from "./full-sync-manifest-batching.js";

function createManifestItem(index: number) {
  const suffix = String(index).padStart(4, "0");
  return {
    path: `docs/item-${suffix}.mdx`,
    shardKey: "docs" as const,
    sourceFamily: "doc_page" as const,
    contentChecksum: `checksum-${suffix}`,
    sourceAcquisitionMode: "remote" as const,
    blobSha: `blob-${suffix}`,
    sizeBytes: index + 1,
    needsRebuild: index % 2 === 0,
    reuseReason: index % 2 === 0 ? null : "unchanged",
    skipReason: null,
    buildStatus: "pending" as const
  };
}

test("chunkFullSyncManifestItems splits large manifests into bounded batches while preserving order", () => {
  const total = FULL_SYNC_MANIFEST_INSERT_BATCH_SIZE * 2 + 1;
  const manifestItems = Array.from({ length: total }, (_, index) => createManifestItem(index));

  const batches = chunkFullSyncManifestItems(manifestItems);

  assert.deepEqual(
    batches.map((batch) => batch.length),
    [FULL_SYNC_MANIFEST_INSERT_BATCH_SIZE, FULL_SYNC_MANIFEST_INSERT_BATCH_SIZE, 1]
  );
  assert.equal(batches[0]?.[0]?.path, "docs/item-0000.mdx");
  assert.equal(batches[1]?.[0]?.path, `docs/item-${String(FULL_SYNC_MANIFEST_INSERT_BATCH_SIZE).padStart(4, "0")}.mdx`);
  assert.equal(batches[2]?.[0]?.path, `docs/item-${String(total - 1).padStart(4, "0")}.mdx`);
});

test("chunkFullSyncManifestItems preserves skipped manifest entries with null shard keys", () => {
  const skippedEntry = {
    path: "README.md",
    shardKey: null,
    sourceFamily: null,
    contentChecksum: "checksum-readme",
    sourceAcquisitionMode: "remote" as const,
    blobSha: "blob-readme",
    sizeBytes: 12,
    needsRebuild: false,
    reuseReason: null,
    skipReason: "outside_docs_com_scope",
    buildStatus: "skipped" as const
  };

  const batches = chunkFullSyncManifestItems([createManifestItem(0), skippedEntry], 1);

  assert.equal(batches.length, 2);
  assert.deepEqual(batches[1]?.[0], skippedEntry);
});
