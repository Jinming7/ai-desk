import type { KbFullSyncShardKey, KbManifestBuildStatus, KbSyncManifestItem } from "./types.js";

export const FULL_SYNC_MANIFEST_INSERT_BATCH_SIZE = 200;

export type FullSyncManifestItemInput = {
  path: string;
  shardKey: KbFullSyncShardKey | null;
  sourceFamily?: KbSyncManifestItem["source_family"];
  contentChecksum?: string | null;
  sourceAcquisitionMode?: KbSyncManifestItem["source_acquisition_mode"];
  blobSha: string;
  sizeBytes: number;
  needsRebuild: boolean;
  reuseReason?: string | null;
  skipReason?: string | null;
  buildStatus?: KbManifestBuildStatus;
};

export function chunkFullSyncManifestItems(
  manifestItems: FullSyncManifestItemInput[],
  batchSize = FULL_SYNC_MANIFEST_INSERT_BATCH_SIZE
): FullSyncManifestItemInput[][] {
  const normalizedBatchSize = Math.max(1, Math.trunc(batchSize));
  const batches: FullSyncManifestItemInput[][] = [];

  for (let index = 0; index < manifestItems.length; index += normalizedBatchSize) {
    batches.push(manifestItems.slice(index, index + normalizedBatchSize));
  }

  return batches;
}
