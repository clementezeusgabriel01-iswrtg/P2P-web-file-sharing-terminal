/**
 * zip.js
 * -----------------------------------------------------------------------
 * Dependency-free ZIP writer for bundling multiple files / dropped folders
 * into one archive before handing them to the existing single-file P2P
 * transfer pipeline in client.js. No external library:
 *   - compression uses the browser's native CompressionStream('deflate-raw')
 *     when available, falling back to uncompressed "store" mode otherwise
 *     (still a fully valid, universally-openable .zip — just bigger).
 *   - CRC-32 is computed with the standard zlib polynomial table.
 *
 * Exposes `window.ZipWriter.createZipBlob(entries)`:
 *   entries: [{ name: 'folder/file.txt', data: Uint8Array|ArrayBuffer }, ...]
 *   returns: Promise<Blob> (type 'application/zip')
 *
 * `name` should use forward slashes for nested paths — that's what the
 * ZIP spec expects regardless of platform.
 * -----------------------------------------------------------------------
 */

(() => {
  'use strict';

  // =========================================================================
  // CRC-32 (standard zlib/PKZIP polynomial 0xEDB88320)
  // =========================================================================

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  // =========================================================================
  // Optional native deflate — falls back to "store" (no compression) if
  // CompressionStream isn't available or the stream throws for any reason.
  // =========================================================================

  async function deflateRaw(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    try {
      const cs = new CompressionStream('deflate-raw');
      const writer = cs.writable.getWriter();
      writer.write(bytes);
      writer.close();
      const reader = cs.readable.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
      }
      const out = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) { out.set(c, offset); offset += c.length; }
      return out;
    } catch {
      return null;
    }
  }

  // =========================================================================
  // Little-endian byte writer
  // =========================================================================

  class ByteWriter {
    constructor() {
      this.chunks = [];
      this.length = 0;
    }
    push(uint8arr) {
      this.chunks.push(uint8arr);
      this.length += uint8arr.length;
    }
    u16(v) { this.push(new Uint8Array([v & 0xff, (v >>> 8) & 0xff])); }
    u32(v) { this.push(new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff])); }
    bytes(uint8arr) { this.push(uint8arr); }
    toUint8Array() {
      const out = new Uint8Array(this.length);
      let offset = 0;
      for (const c of this.chunks) { out.set(c, offset); offset += c.length; }
      return out;
    }
  }

  function dosDateTime(date) {
    const time = ((date.getHours() & 0x1f) << 11)
      | ((date.getMinutes() & 0x3f) << 5)
      | ((Math.floor(date.getSeconds() / 2)) & 0x1f);
    const dosDate = (((date.getFullYear() - 1980) & 0x7f) << 9)
      | (((date.getMonth() + 1) & 0xf) << 5)
      | (date.getDate() & 0x1f);
    return { time, date: dosDate };
  }

  /**
   * Builds a ZIP archive from `entries` and returns it as a Blob.
   * Each entry is compressed independently (deflate-raw if supported, else
   * stored) so a failure on one file's stream doesn't affect the others.
   */
  async function createZipBlob(entries) {
    const encoder = new TextEncoder();
    const now = new Date();
    const { time: dosTime, date: dosDate } = dosDateTime(now);

    const localWriter = new ByteWriter();
    const central = [];

    for (const { name, data } of entries) {
      const nameBytes = encoder.encode(name.replace(/\\/g, '/').replace(/^\/+/, ''));
      const raw = data instanceof Uint8Array ? data : new Uint8Array(data);
      const crc = crc32(raw);

      let method = 0; // store
      let payload = raw;
      const compressed = await deflateRaw(raw);
      if (compressed && compressed.length < raw.length) {
        method = 8; // deflate
        payload = compressed;
      }

      const localOffset = localWriter.length;

      localWriter.u32(0x04034b50);
      localWriter.u16(20);           // version needed
      localWriter.u16(0x0800);       // general purpose flag: UTF-8 filenames
      localWriter.u16(method);
      localWriter.u16(dosTime);
      localWriter.u16(dosDate);
      localWriter.u32(crc);
      localWriter.u32(payload.length);
      localWriter.u32(raw.length);
      localWriter.u16(nameBytes.length);
      localWriter.u16(0);            // extra field length
      localWriter.bytes(nameBytes);
      localWriter.bytes(payload);

      central.push({ nameBytes, crc, compSize: payload.length, rawSize: raw.length, method, localOffset });
    }

    const centralWriter = new ByteWriter();
    for (const e of central) {
      centralWriter.u32(0x02014b50);
      centralWriter.u16(20);         // version made by
      centralWriter.u16(20);         // version needed
      centralWriter.u16(0x0800);
      centralWriter.u16(e.method);
      centralWriter.u16(dosTime);
      centralWriter.u16(dosDate);
      centralWriter.u32(e.crc);
      centralWriter.u32(e.compSize);
      centralWriter.u32(e.rawSize);
      centralWriter.u16(e.nameBytes.length);
      centralWriter.u16(0);          // extra field length
      centralWriter.u16(0);          // comment length
      centralWriter.u16(0);          // disk number start
      centralWriter.u16(0);          // internal file attributes
      centralWriter.u32(0);          // external file attributes
      centralWriter.u32(e.localOffset);
      centralWriter.bytes(e.nameBytes);
    }

    const endWriter = new ByteWriter();
    endWriter.u32(0x06054b50);
    endWriter.u16(0);                // disk number
    endWriter.u16(0);                // disk where central dir starts
    endWriter.u16(central.length);   // records on this disk
    endWriter.u16(central.length);   // total records
    endWriter.u32(centralWriter.length);
    endWriter.u32(localWriter.length);
    endWriter.u16(0);                // comment length

    const blob = new Blob(
      [localWriter.toUint8Array(), centralWriter.toUint8Array(), endWriter.toUint8Array()],
      { type: 'application/zip' },
    );
    return blob;
  }

  window.ZipWriter = { createZipBlob };
})();
  
