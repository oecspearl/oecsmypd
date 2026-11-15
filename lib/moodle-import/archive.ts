/**
 * Reads a Moodle `.mbz` backup (a gzip-compressed POSIX tar) into an
 * addressable, in-memory file map. Pure Node (zlib) — no external tar lib.
 */

import { gunzipSync } from "node:zlib";

/** Normalise a tar entry path: strip a leading "./" or "/". */
function normalise(path: string): string {
  return path.replace(/^\.\//, "").replace(/^\/+/, "");
}

/** Parse a raw (uncompressed) tar buffer into path → content. */
function parseTar(buffer: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    // Two consecutive zero blocks mark the end of the archive.
    if (header.every((b) => b === 0)) break;

    let name = header.subarray(0, 100).toString("ascii").replace(/\0.*$/, "");

    // ustar prefix (bytes 345-499) extends long paths.
    const magic = header.subarray(257, 263).toString("ascii");
    if (magic.startsWith("ustar")) {
      const prefix = header.subarray(345, 500).toString("ascii").replace(/\0.*$/, "");
      if (prefix) name = `${prefix}/${name}`;
    }

    const sizeField = header.subarray(124, 136).toString("ascii").replace(/[\0 ]/g, "");
    const size = parseInt(sizeField, 8) || 0;
    const typeFlag = header[156];

    offset += 512;

    // '0' (48) or NUL (0) = regular file.
    if ((typeFlag === 48 || typeFlag === 0) && name && size > 0) {
      files.set(normalise(name), buffer.subarray(offset, offset + size));
    }

    // Advance past the file body, padded to a 512-byte boundary.
    offset += Math.ceil(size / 512) * 512;
  }

  return files;
}

export class MoodleArchive {
  private readonly files: Map<string, Buffer>;

  constructor(mbz: Buffer) {
    this.files = parseTar(gunzipSync(mbz));
  }

  /** All file paths in the archive. */
  list(): string[] {
    return [...this.files.keys()];
  }

  has(path: string): boolean {
    return this.files.has(normalise(path));
  }

  readBuffer(path: string): Buffer | null {
    return this.files.get(normalise(path)) ?? null;
  }

  readText(path: string): string | null {
    const buf = this.readBuffer(path);
    return buf === null ? null : buf.toString("utf8");
  }
}
