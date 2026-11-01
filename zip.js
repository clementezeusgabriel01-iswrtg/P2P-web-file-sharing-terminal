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
 * Exposes `window.ZipWriter.createZipBlob(entries, options)`:
 *   entries: [{ name: 'folder/file.txt', data: Uint8Array|ArrayBuffer }, ...]
 *   options: { password?: string }
 *   returns: Promise<Blob> (type 'application/zip')
 *
 * `name` should use forward slashes for nested paths — that's what the
 * ZIP spec expects regardless of platform.
 *
 * Password protection uses traditional "ZipCrypto" (PKWARE's original
 * stream cipher, APPNOTE.TXT §6.1) rather than WinZip's AES scheme —
 * weaker, but openable by every common unzip tool (Windows Explorer,
 * macOS Archive Utility, unzip(1)) without a plugin. Good enough to keep
 * casual/automated access out; not a substitute for actually-sensitive
 * encryption. Each entry gets its own random 12-byte encryption header,
 * so two entries encrypted with the same password still produce
 * different ciphertext.
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
  // ZipCrypto (traditional PKZIP encryption) — see file header for why
  // this scheme and not AES. One step of the CRC32 update, *not* the full
  // crc32() above (no initial/final complement) — this is the building
  // block the cipher's key schedule is defined in terms of.
  // =========================================================================

  function crc32Step(crc, b) {
    return (CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)) >>> 0;
  }

  class ZipCryptoKeys {
    constructor(passwordBytes) {
      this.k0 = 0x12345678;
      this.k1 = 0x23456789;
      this.k2 = 0x34567890;
      for (let i = 0; i < passwordBytes.length; i++) this.update(passwordBytes[i]);
    }
    update(b) {
      this.k0 = crc32Step(this.k0, b);
      this.k1 = (this.k1 + (this.k0 & 0xff)) >>> 0;
      this.k1 = (Math.imul(this.k1, 134775813) + 1) >>> 0;
      this.k2 = crc32Step(this.k2, (this.k1 >>> 24) & 0xff);
    }
    keystreamByte() {
      const temp = (this.k2 | 2) & 0xffff;
      return ((temp * (temp ^ 1)) >>> 8) & 0xff;
    }
  }

  /** Encrypts `data` in place (conceptually — returns a new array) under `keys`, advancing them as it goes. */
  function zipCryptoEncrypt(keys, data) {
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      const b = data[i];
      out[i] = b ^ keys.keystreamByte();
      keys.update(b); // advance using the *plaintext* byte, same on encrypt and decrypt
    }
    return out;
  }

  /**
   * Wraps `payload` (the already-compressed-or-stored entry bytes) in a
   * ZipCrypto-encrypted blob: a random 12-byte header (whose last byte is
   * swapped for the high byte of the entry's CRC-32, the standard
   * integrity check unzip tools use to validate the password) followed by
   * the encrypted payload itself.
   */
  function zipCryptoEncryptEntry(password, payload, crc) {
    const header = crypto.getRandomValues(new Uint8Array(12));
    header[11] = (crc >>> 24) & 0xff;
    const keys = new ZipCryptoKeys(new TextEncoder().encode(password));
    const encHeader = zipCryptoEncrypt(keys, header);
    const encPayload = zipCryptoEncrypt(keys, payload);
    const out = new Uint8Array(encHeader.length + encPayload.length);
    out.set(encHeader, 0);
    out.set(encPayload, encHeader.length);
    return out;
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
   *
   * options.password, if non-empty, encrypts every entry with ZipCrypto
   * (see the file header for the tradeoffs of that scheme) and sets
   * general-purpose flag bit 0 so unzip tools prompt for a password.
   */
  async function createZipBlob(entries, options = {}) {
    const password = options.password || '';
    const encoder = new TextEncoder();
    const now = new Date();
    const { time: dosTime, date: dosDate } = dosDateTime(now);
    const gpFlag = 0x0800 | (password ? 0x0001 : 0); // UTF-8 names, + encrypted bit

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
      const rawSize = raw.length; // uncompressed size field is unaffected by encryption

      if (password) {
        payload = zipCryptoEncryptEntry(password, payload, crc);
      }

      const localOffset = localWriter.length;

      localWriter.u32(0x04034b50);
      localWriter.u16(20);           // version needed
      localWriter.u16(gpFlag);
      localWriter.u16(method);
      localWriter.u16(dosTime);
      localWriter.u16(dosDate);
      localWriter.u32(crc);
      localWriter.u32(payload.length);
      localWriter.u32(rawSize);
      localWriter.u16(nameBytes.length);
      localWriter.u16(0);            // extra field length
      localWriter.bytes(nameBytes);
      localWriter.bytes(payload);

      central.push({ nameBytes, crc, compSize: payload.length, rawSize, method, localOffset });
    }

    const centralWriter = new ByteWriter();
    for (const e of central) {
      centralWriter.u32(0x02014b50);
      centralWriter.u16(20);         // version made by
      centralWriter.u16(20);         // version needed
      centralWriter.u16(gpFlag);
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
