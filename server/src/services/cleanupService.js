import fs from 'node:fs/promises';
import path from 'node:path';
import { Video } from '../models/Video.js';
import { isStoredSubtitleName, isStoredVideoName, removeFileQuietly } from './storageService.js';

// Files younger than this may belong to an upload or conversion that is still in progress.
const MIN_ORPHAN_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * Simple consistency check between disk and MongoDB (no background worker):
 *  - video / subtitle files with no DB record (e.g. server crashed mid-upload) are deleted
 *  - DB records whose video file is gone are deleted (they could never be played);
 *    their subtitle files become orphans and are removed by a later run
 */
export async function cleanupOrphans(config) {
  const entries = await fs.readdir(config.storageDir, { withFileTypes: true });
  const filesOnDisk = entries
    .filter((e) => e.isFile() && (isStoredVideoName(e.name) || isStoredSubtitleName(e.name)))
    .map((e) => e.name);

  const videos = await Video.find({}, { storedName: 1, subtitles: 1 }).lean();
  const knownNames = new Set(videos.flatMap((v) => [v.storedName, ...(v.subtitles ?? []).map((s) => s.file)]));
  const diskNames = new Set(filesOnDisk);

  let removedFiles = 0;
  for (const name of filesOnDisk) {
    if (knownNames.has(name)) continue;
    const filePath = path.join(config.storageDir, name);
    const { mtimeMs } = await fs.stat(filePath);
    if (Date.now() - mtimeMs < MIN_ORPHAN_AGE_MS) continue;
    if (await removeFileQuietly(filePath)) removedFiles += 1;
  }

  const brokenIds = videos.filter((v) => !diskNames.has(v.storedName)).map((v) => v._id);
  if (brokenIds.length) await Video.deleteMany({ _id: { $in: brokenIds } });

  console.log(`[cleanup] removed ${removedFiles} orphan file(s), ${brokenIds.length} broken record(s)`);
  return { removedFiles, removedRecords: brokenIds.length };
}
