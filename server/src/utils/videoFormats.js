import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Every video container we accept, keyed by lower-case file extension.
 *
 * We do NOT trust the MIME type the browser sends (it is client-controlled and,
 * for formats like .mkv or .avi, often empty). Instead the format is decided by
 * the extension, and the file's first bytes must match that container's signature.
 * `mimeType` is the value WE send back when streaming.
 *
 * Note: accepting a format is not the same as browsers being able to PLAY it.
 * MP4/M4V/MOV/WebM/Ogg (and usually MKV in Chrome) play natively; AVI, WMV, FLV,
 * MPEG and TS need transcoding, so the watch page offers a download instead.
 */
export const VIDEO_FORMATS = {
  '.mp4': { mimeType: 'video/mp4', signature: 'isobmff' },
  '.m4v': { mimeType: 'video/mp4', signature: 'isobmff' },
  '.mov': { mimeType: 'video/quicktime', signature: 'quicktime' },
  '.3gp': { mimeType: 'video/3gpp', signature: 'isobmff' },
  '.3g2': { mimeType: 'video/3gpp2', signature: 'isobmff' },
  '.webm': { mimeType: 'video/webm', signature: 'ebml' },
  '.mkv': { mimeType: 'video/x-matroska', signature: 'ebml' },
  '.ogv': { mimeType: 'video/ogg', signature: 'ogg' },
  '.avi': { mimeType: 'video/x-msvideo', signature: 'avi' },
  '.wmv': { mimeType: 'video/x-ms-wmv', signature: 'asf' },
  '.asf': { mimeType: 'video/x-ms-asf', signature: 'asf' },
  '.flv': { mimeType: 'video/x-flv', signature: 'flv' },
  '.mpg': { mimeType: 'video/mpeg', signature: 'mpeg-ps' },
  '.mpeg': { mimeType: 'video/mpeg', signature: 'mpeg-ps' },
  '.ts': { mimeType: 'video/mp2t', signature: 'mpeg-ts' },
  '.mts': { mimeType: 'video/mp2t', signature: 'mpeg-ts' },
  '.m2ts': { mimeType: 'video/mp2t', signature: 'mpeg-ts' },
  // Containers that commonly carry "unusual" audio (AC3/LPCM on DVDs, RealAudio, ...):
  '.vob': { mimeType: 'video/mpeg', signature: 'mpeg-ps' }, // DVD video
  '.divx': { mimeType: 'video/x-msvideo', signature: 'avi' },
  '.f4v': { mimeType: 'video/mp4', signature: 'isobmff' },
  '.ogm': { mimeType: 'video/ogg', signature: 'ogg' },
  '.rm': { mimeType: 'application/vnd.rn-realmedia', signature: 'realmedia' },
  '.rmvb': { mimeType: 'application/vnd.rn-realmedia', signature: 'realmedia' },
};

export const SUPPORTED_EXTENSIONS = Object.keys(VIDEO_FORMATS);
export const SUPPORTED_MIME_TYPES = [...new Set(Object.values(VIDEO_FORMATS).map((f) => f.mimeType))];

/** Look up a format by filename; returns null for anything not on the allow-list. */
export function getVideoFormat(filename) {
  const ext = path.extname(String(filename)).toLowerCase();
  return Object.hasOwn(VIDEO_FORMATS, ext) ? { ext, ...VIDEO_FORMATS[ext] } : null;
}

const MOV_FIRST_BOXES = new Set(['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);
const ASF_GUID = Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]);
const TS_SYNC = 0x47; // every 188-byte MPEG-TS packet starts with this byte

// Each checker receives the first bytes of the file ("magic bytes").
const SIGNATURE_CHECKS = {
  // MP4 family: bytes 4-7 name the first box, which must be "ftyp".
  isobmff: (b) => b.toString('latin1', 4, 8) === 'ftyp',
  // Older QuickTime files may start with other boxes.
  quicktime: (b) => MOV_FIRST_BOXES.has(b.toString('latin1', 4, 8)),
  // WebM and MKV are both Matroska/EBML.
  ebml: (b) => b.readUInt32BE(0) === 0x1a45dfa3,
  ogg: (b) => b.toString('latin1', 0, 4) === 'OggS',
  avi: (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'AVI ',
  asf: (b) => b.subarray(0, 8).equals(ASF_GUID),
  flv: (b) => b.toString('latin1', 0, 3) === 'FLV',
  realmedia: (b) => b.toString('latin1', 0, 4) === '.RMF',
  // MPEG program stream pack header, or an MPEG video sequence header.
  'mpeg-ps': (b) => b.readUInt32BE(0) === 0x000001ba || b.readUInt32BE(0) === 0x000001b3,
  // Transport stream: sync byte repeating every 188 bytes (.ts),
  // or every 192 bytes with a 4-byte timestamp prefix (.m2ts/.mts).
  'mpeg-ts': (b) =>
    (b[0] === TS_SYNC && (b.length <= 188 || b[188] === TS_SYNC)) ||
    (b[4] === TS_SYNC && (b.length <= 196 || b[196] === TS_SYNC)),
};

/**
 * After the upload is on disk, read the first bytes and check they really look
 * like the container the extension claims. Cheap sanity check, not a full decode.
 */
export async function hasValidVideoSignature(filePath, format) {
  const handle = await fs.open(filePath, 'r');
  try {
    const header = Buffer.alloc(200);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 12) return false;
    return SIGNATURE_CHECKS[format.signature](header.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}
