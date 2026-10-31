/**
 * qrcode.js
 * -----------------------------------------------------------------------
 * Dependency-free QR Code encoder (ISO/IEC 18004), byte mode only,
 * versions 1-6 (up to ~106 bytes at EC level L — ample for a share link
 * like `https://host/?join=XXXXXX`). No external library, no network
 * fetch — the whole encoder (Reed-Solomon ECC, masking, format info) is
 * implemented inline so the share-link QR works offline and with no
 * dependency on a CDN being reachable.
 *
 * Exposes `window.QRCode`:
 *   QRCode.encode(text, ecLevel = 'M')   -> { matrix, size, version }
 *   QRCode.toSvgString(text, opts)       -> self-contained <svg>...</svg>
 *
 * If `text` doesn't fit in version 1-6 at the requested EC level, encode()
 * automatically retries at lower EC levels (M -> L) before giving up —
 * a plain share-link URL will never hit that ceiling in practice.
 * -----------------------------------------------------------------------
 */

(() => {
  'use strict';

  // =========================================================================
  // GF(256) tables for Reed-Solomon — QR uses primitive poly 0x11D, gen 2.
  // =========================================================================

  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (() => {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function gmul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  function rsGeneratorPoly(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        if (poly[j] !== 0) next[j + 1] ^= gmul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, ecLen) {
    const gen = rsGeneratorPoly(ecLen);
    const res = data.concat(new Array(ecLen).fill(0));
    for (let i = 0; i < data.length; i++) {
      const coef = res[i];
      if (coef === 0) continue;
      for (let j = 0; j < gen.length; j++) {
        res[i + j] ^= gmul(gen[j], coef);
      }
    }
    return res.slice(data.length);
  }

  // =========================================================================
  // Version tables (1-6 only — see file header for why).
  // blocks[level] = [ecPerBlock, [[numBlocks, dataPerBlock], ...]]
  // =========================================================================

  const VERSION_INFO = {
    1: { align: null, blocks: {
      L: [7, [[1, 19]]], M: [10, [[1, 16]]], Q: [13, [[1, 13]]], H: [17, [[1, 9]]],
    } },
    2: { align: 18, blocks: {
      L: [10, [[1, 34]]], M: [16, [[1, 28]]], Q: [22, [[1, 22]]], H: [28, [[1, 16]]],
    } },
    3: { align: 22, blocks: {
      L: [15, [[1, 55]]], M: [26, [[1, 44]]], Q: [18, [[2, 17]]], H: [22, [[2, 13]]],
    } },
    4: { align: 26, blocks: {
      L: [20, [[1, 80]]], M: [18, [[2, 32]]], Q: [26, [[2, 24]]], H: [16, [[4, 9]]],
    } },
    5: { align: 30, blocks: {
      L: [26, [[1, 108]]], M: [24, [[2, 43]]], Q: [18, [[2, 15], [2, 16]]], H: [22, [[2, 11], [2, 12]]],
    } },
    6: { align: 34, blocks: {
      L: [18, [[2, 68]]], M: [16, [[4, 27]]], Q: [24, [[4, 19]]], H: [28, [[4, 15]]],
    } },
  };

  const EC_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };
  const EC_ORDER = ['M', 'L', 'Q', 'H']; // fallback order encode() tries, M first

  function bchFormat(data5) {
    const g = 0b10100110111; // x^10+x^8+x^5+x^4+x^2+x+1
    const val = data5 << 10;
    let temp = val;
    for (let i = 4; i >= 0; i--) {
      if (temp & (1 << (i + 10))) temp ^= g << i;
    }
    return (val | temp) ^ 0b101010000010010;
  }

  function chooseVersion(dataLen, ecLevel) {
    for (let v = 1; v <= 6; v++) {
      const [, groups] = VERSION_INFO[v].blocks[ecLevel];
      const totalData = groups.reduce((s, [n, c]) => s + n * c, 0);
      const capBits = totalData * 8;
      const neededBits = 4 + 8 + dataLen * 8;
      if (neededBits <= capBits) return v;
    }
    return null;
  }

  function buildCodewords(dataBytes, version, ecLevel) {
    const [ecPerBlock, groups] = VERSION_INFO[version].blocks[ecLevel];
    const totalDataCodewords = groups.reduce((s, [n, c]) => s + n * c, 0);
    const capBits = totalDataCodewords * 8;

    const bits = [];
    const push = (val, n) => {
      for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1);
    };

    push(0b0100, 4); // byte mode
    push(dataBytes.length, 8); // char count (versions 1-9)
    for (const b of dataBytes) push(b, 8);

    const term = Math.min(4, capBits - bits.length);
    if (term > 0) push(0, term);
    while (bits.length % 8 !== 0) bits.push(0);

    const codewords = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      codewords.push(byte);
    }
    const padBytes = [0xec, 0x11];
    let pi = 0;
    while (codewords.length < totalDataCodewords) {
      codewords.push(padBytes[pi % 2]);
      pi++;
    }

    const blocks = [];
    let idx = 0;
    for (const [n, c] of groups) {
      for (let i = 0; i < n; i++) {
        blocks.push(codewords.slice(idx, idx + c));
        idx += c;
      }
    }

    const eccBlocks = blocks.map((b) => rsEncode(b.slice(), ecPerBlock));

    const final = [];
    const maxBlockLen = Math.max(...blocks.map((b) => b.length));
    for (let i = 0; i < maxBlockLen; i++) {
      for (const b of blocks) if (i < b.length) final.push(b[i]);
    }
    for (let i = 0; i < ecPerBlock; i++) {
      for (const eb of eccBlocks) final.push(eb[i]);
    }
    return final;
  }

  function maskFn(pattern, r, c) {
    switch (pattern) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return false;
    }
  }

  function makeMatrix(version, ecLevel, maskPattern, codewords) {
    const size = 17 + 4 * version;
    const M = Array.from({ length: size }, () => new Array(size).fill(null));
    const RES = Array.from({ length: size }, () => new Array(size).fill(false));

    const setM = (r, c, v) => {
      if (r < 0 || r >= size || c < 0 || c >= size) return;
      M[r][c] = v;
      RES[r][c] = true;
    };

    function placeFinder(r0, c0) {
      for (let r = -1; r <= 7; r++) {
        for (let c = -1; c <= 7; c++) {
          const rr = r0 + r, cc = c0 + c;
          if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
          const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6
            && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
          setM(rr, cc, inRing ? 1 : 0);
        }
      }
    }
    placeFinder(0, 0);
    placeFinder(0, size - 7);
    placeFinder(size - 7, 0);

    for (let i = 8; i < size - 8; i++) {
      const v = i % 2 === 0 ? 1 : 0;
      setM(6, i, v);
      setM(i, 6, v);
    }

    const align = VERSION_INFO[version].align;
    if (align !== null) {
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const isRing = Math.max(Math.abs(r), Math.abs(c)) === 2 || (r === 0 && c === 0);
          setM(align + r, align + c, isRing ? 1 : 0);
        }
      }
    }

    setM(4 * version + 9, 8, 1); // dark module

    // Reserve format-info cells (filled in for real after masking below).
    for (let i = 0; i < 6; i++) RES[8][i] = true;
    RES[8][7] = true; RES[8][8] = true; RES[7][8] = true;
    for (let i = 0; i < 6; i++) RES[i][8] = true;
    for (let i = size - 8; i < size; i++) RES[8][i] = true;
    for (let i = size - 7; i < size; i++) RES[i][8] = true;

    // Block those reserved cells from data placement now (RESERVED alone
    // isn't checked during the zigzag walk below — only `M[r][c] === null`
    // is — so without this the walk would treat them as free).
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (RES[r][c] && M[r][c] === null) M[r][c] = 0;
      }
    }

    const bits = [];
    for (const cw of codewords) {
      for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
    }

    let bitIdx = 0;
    let col = size - 1;
    let upward = true;
    while (col > 0) {
      if (col === 6) col -= 1;
      const cols = [col, col - 1];
      const rows = [];
      if (upward) for (let r = size - 1; r >= 0; r--) rows.push(r);
      else for (let r = 0; r < size; r++) rows.push(r);
      for (const r of rows) {
        for (const cc of cols) {
          if (M[r][cc] === null) {
            let bit = bitIdx < bits.length ? bits[bitIdx] : 0;
            bitIdx++;
            if (maskFn(maskPattern, r, cc)) bit ^= 1;
            M[r][cc] = bit;
          }
        }
      }
      upward = !upward;
      col -= 2;
    }

    const fmtData = (EC_BITS[ecLevel] << 3) | maskPattern;
    const fmtBits15 = bchFormat(fmtData);
    const fmt = [];
    for (let i = 14; i >= 0; i--) fmt.push((fmtBits15 >> i) & 1);

    for (let i = 0; i < 6; i++) M[8][i] = fmt[i];
    M[8][7] = fmt[6];
    M[8][8] = fmt[7];
    M[7][8] = fmt[8];
    for (let i = 9; i < 15; i++) M[14 - i][8] = fmt[i];

    for (let i = 0; i < 7; i++) M[size - 1 - i][8] = fmt[i];
    for (let i = 7; i < 15; i++) M[8][size - 15 + i] = fmt[i];

    return M;
  }

  function penalty(M) {
    const size = M.length;
    let score = 0;

    for (let r = 0; r < size; r++) {
      let run = 1;
      for (let c = 1; c < size; c++) {
        if (M[r][c] === M[r][c - 1]) run++;
        else { if (run >= 5) score += run - 2; run = 1; }
      }
      if (run >= 5) score += run - 2;
    }
    for (let c = 0; c < size; c++) {
      let run = 1;
      for (let r = 1; r < size; r++) {
        if (M[r][c] === M[r - 1][c]) run++;
        else { if (run >= 5) score += run - 2; run = 1; }
      }
      if (run >= 5) score += run - 2;
    }

    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = M[r][c];
        if (v === M[r][c + 1] && v === M[r + 1][c] && v === M[r + 1][c + 1]) score += 3;
      }
    }

    const pat1 = '1,0,1,1,1,0,1,0,0,0,0';
    const pat2 = '0,0,0,0,1,0,1,1,1,0,1';
    for (let r = 0; r < size; r++) {
      const row = M[r];
      for (let c = 0; c <= size - 11; c++) {
        const seg = row.slice(c, c + 11).join(',');
        if (seg === pat1 || seg === pat2) score += 40;
      }
    }
    for (let c = 0; c < size; c++) {
      const colVals = [];
      for (let r = 0; r < size; r++) colVals.push(M[r][c]);
      for (let r = 0; r <= size - 11; r++) {
        const seg = colVals.slice(r, r + 11).join(',');
        if (seg === pat1 || seg === pat2) score += 40;
      }
    }

    const total = size * size;
    let dark = 0;
    for (const row of M) for (const v of row) dark += v;
    const pct = Math.floor((dark * 100) / total);
    const prev = pct - (pct % 5);
    const next = prev + 5;
    score += Math.floor(Math.min(Math.abs(prev - 50), Math.abs(next - 50)) / 5) * 10;

    return score;
  }

  function encodeAtLevel(text, ecLevel) {
    const data = Array.from(new TextEncoder().encode(text));
    const version = chooseVersion(data.length, ecLevel);
    if (version === null) return null;
    const codewords = buildCodewords(data, version, ecLevel);
    let best = null;
    for (let pattern = 0; pattern < 8; pattern++) {
      const M = makeMatrix(version, ecLevel, pattern, codewords);
      const p = penalty(M);
      if (best === null || p < best.p) best = { p, M, version };
    }
    return { matrix: best.M, size: best.M.length, version: best.version };
  }

  /**
   * Encodes `text` as a QR matrix. Tries `ecLevel` first, then falls back
   * through EC_ORDER (lower levels = more data capacity) if the text is
   * too long to fit in versions 1-6 at the requested level. Throws only if
   * it doesn't fit at any level — a share-link URL never gets close.
   */
  function encode(text, ecLevel = 'M') {
    const order = [ecLevel, ...EC_ORDER.filter((l) => l !== ecLevel)];
    for (const level of order) {
      const result = encodeAtLevel(text, level);
      if (result) return { ...result, ecLevel: level };
    }
    throw new Error('text too long for a QR code at this size (try a shorter link)');
  }

  function toSvgString(text, opts = {}) {
    const { ecLevel = 'M', moduleSize = 4, margin = 4, dark = '#000000', light = 'none' } = opts;
    const { matrix, size } = encode(text, ecLevel);
    const dim = (size + margin * 2) * moduleSize;

    let path = '';
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (matrix[r][c]) {
          const x = (c + margin) * moduleSize;
          const y = (r + margin) * moduleSize;
          path += `M${x} ${y}h${moduleSize}v${moduleSize}h${-moduleSize}z`;
        }
      }
    }

    const bg = light === 'none' ? '' : `<rect width="${dim}" height="${dim}" fill="${light}"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" role="img" aria-label="QR code">${bg}<path d="${path}" fill="${dark}"/></svg>`;
  }

  window.QRCode = { encode, toSvgString };
})();
        
