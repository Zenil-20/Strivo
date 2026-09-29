/**
 * Parse an HTTP Range header such as "bytes=0-1048575".
 *
 * Supported forms (single range only):
 *   bytes=500-999   -> bytes 500..999
 *   bytes=500-      -> from byte 500 to the end of the file
 *   bytes=-500      -> the last 500 bytes
 *
 * Returns { start, end } (both inclusive) or null when the range is malformed
 * or cannot be satisfied (the caller then answers 416).
 *
 * `maxChunk` caps how many bytes one response may contain. Browsers usually ask
 * for "bytes=0-" (everything); we answer with a smaller piece and the browser
 * simply requests the next range when it needs more data.
 */
export function parseRange(header, fileSize, maxChunk) {
  // Multi-range requests ("bytes=0-10,20-30") are not used by video players,
  // so we deliberately reject them — simpler code, one stream per request.
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || fileSize === 0) return null;

  const [, startText, endText] = match;
  if (startText === '' && endText === '') return null;

  let start;
  let end;

  if (startText === '') {
    // Suffix range: the last N bytes.
    const suffixLength = Number(endText);
    if (suffixLength === 0) return null;
    start = Math.max(fileSize - suffixLength, 0);
    end = fileSize - 1;
  } else {
    start = Number(startText);
    end = endText === '' ? fileSize - 1 : Math.min(Number(endText), fileSize - 1);
  }

  if (start >= fileSize || start > end) return null;

  // Safety: a zero or negative maxChunk (e.g. from a misconfigured env var that
  // rounds to 0 after Math.floor) would produce end = start - 1, which is invalid.
  // config.js enforces a minimum of 1, but guard here too as defence in depth.
  if (maxChunk <= 0) return null;

  end = Math.min(end, start + maxChunk - 1);
  return { start, end };
}
