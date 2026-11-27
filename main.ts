// png-squeeze v2: a lossless PNG compressor for make.fun's png-squeeze-01.
// Reads /input/<id>/image.png (1280x720 RGBA 8-bit), writes /output/<id>/image.png.
// Method: pick the smallest colour form per image (palette / grey / RGB / RGBA, with tRNS
// where it fits), pick each row's filter — fixed, by a cheap heuristic, or by brute force
// (each row's five filters weighed by zlib level 4 after the preceding 32 KiB) — then
// compress the filtered bytes with an original deflate: a hash-chain LZ77 matcher that
// keeps the longest match per distance range, a lazy parse to seed a cost model, and a
// shortest-path (optimal) parse run three times with the cost model re-estimated from
// the previous parse's tokens, in dynamic Huffman blocks. A zlib level 9 stream is kept
// as a fallback and the smaller of the two is written. Everything is deterministic:
// no clock, no randomness, no environment-dependent choice, so two runs emit identical
// bytes.
//
// v2 vs v1 (practice set, kit scorer): 722,208 -> 744,445, all 8 exact, 54.5 s
// for the set (wall 60 s), two fresh runs byte-identical. What changed:
// brute-force filter selection, a deeper hash chain (1024/512 by size),
// longest-match-per-distance-range candidates in the optimal parse, and three
// cost-model passes instead of one — the re-estimated model fixes the first
// model's bias toward long far matches, which is also what made the i007 alpha
// image lose to zlib level 9 in v1.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- PNG basics

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; ) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function pngOf(chunks) {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

// ---------------------------------------------------------------- PNG filters

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

// Sum of a filtered row's bytes read as signed values (-128..127), absolute.
function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// ---------------------------------------------------------------- PNG decode

function decodePng(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('input is not bytes');
  if (bytes.length < SIGNATURE.length || SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new Error('input does not start with the PNG signature');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = SIGNATURE.length;
  let header = null;
  let palette = null;
  let trns = null;
  const idat = [];
  let idatDone = false;
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    if (at + 12 > bytes.length) throw new Error('chunk cut short');
    const len = view.getUint32(at);
    if (len > 0x7fffffff || at + 12 + len > bytes.length) throw new Error('chunk claims bytes the file does not hold');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) throw new Error(`${type} chunk fails its CRC`);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type !== 'IDAT' && idat.length > 0) idatDone = true;
    if (type === 'IHDR') {
      if (header !== null) throw new Error('IHDR twice');
      if (len !== 13) throw new Error('IHDR is not 13 bytes');
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], colourType: data[9], compression: data[10], filter: data[11], interlace: data[12] };
      if (header.depth !== 8) throw new Error('bit depth is not 8');
      if (!(header.colourType in CHANNELS)) throw new Error('unknown colour type');
      if (header.compression !== 0 || header.filter !== 0 || header.interlace !== 0) throw new Error('unsupported compression/filter/interlace');
    } else if (type === 'PLTE') {
      if (palette !== null) throw new Error('PLTE twice');
      if (header.colourType !== 3) throw new Error('PLTE with a non-palette colour type');
      if (idat.length > 0) throw new Error('PLTE follows IDAT');
      if (len === 0 || len % 3 !== 0 || len > 768) throw new Error('PLTE is not 1 to 256 entries');
      palette = data;
    } else if (type === 'tRNS') {
      if (trns !== null) throw new Error('tRNS twice');
      if (idat.length > 0) throw new Error('tRNS follows IDAT');
      const ct = header.colourType;
      if (ct === 3) {
        if (palette === null) throw new Error('tRNS comes before PLTE');
        if (len > palette.length / 3) throw new Error('tRNS holds more entries than the palette');
      } else if (ct === 0 || ct === 2) {
        if (len !== (ct === 0 ? 2 : 6)) throw new Error('tRNS has the wrong length for its colour type');
      } else throw new Error('tRNS with an unsupported colour type');
      trns = data;
    } else if (type === 'IDAT') {
      if (idatDone) throw new Error('IDAT chunks are not in a row');
      if (header.colourType === 3 && palette === null) throw new Error('IDAT comes before PLTE');
      idat.push(data);
    } else if (type === 'IEND') {
      if (len !== 0) throw new Error('IEND is not empty');
      ended = true;
    } else {
      throw new Error(`unsupported chunk ${type}`);
    }
  }
  if (!ended) throw new Error('no IEND');
  if (idat.length === 0) throw new Error('no IDAT');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  if (raw.length !== expected) throw new Error('IDAT inflates to the wrong size');
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) throw new Error(`row ${y} has filter type ${ft}`);
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3];
      lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) throw new Error('palette index past the palette');
      rgba[d] = lut[e * 4];
      rgba[d + 1] = lut[e * 4 + 1];
      rgba[d + 2] = lut[e * 4 + 2];
      rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------- Image analysis

function analyse(rgba) {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  const colours = many
    ? null
    : [...counts.keys()].map((c) => {
        const b = new Uint8Array(Uint32Array.of(c).buffer);
        return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
      });
  return { opaque, grey, colours };
}

// The one fully transparent value the image may key by tRNS instead of an alpha
// channel: every non-opaque pixel is that exact value at alpha 0, and no opaque pixel
// uses the same value. Null when there is none.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

// Palette entries in write order: transparent ones first (by alpha), then by `order`
// ('count' = most used first, 'luminance' = darkest first).
function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}

// The colour forms an image can be written in, each with the filter choices tried for it.
// A palette (type 3) when the image holds at most 256 colours; a channel form (grey 0,
// RGB 2, grey+alpha 4, RGBA 6) when it is grey or holds more colours, with a tRNS key
// when a single fully transparent value can stand in for the alpha channel.
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const [order, filters] of [
      ['count', [0]],
      ['luminance', [0, 'minsum', 'brute']],
    ]) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'] });
  return forms;
}

// ---------------------------------------------------------------- Filtering

// Cost of a filtered row by fewest distinct neighbouring byte pairs.
function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

// The raw data of an image of `samples` (height rows of width x bpp samples), each row
// behind its filter byte, by `choice`: a filter type (0 to 4) for every row, or 'minsum'
// (each row the type whose filtered bytes have the least signed sum), 'pairs' (each row
// the type with the fewest distinct neighbouring byte pairs), or 'brute' (each row the
// type whose filtered row, filter byte included, compresses smallest by zlib level 4
// after the 32 KiB written before it); the lower type on a tie.
function filtered(samples, width, height, bpp, choice) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t]);
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t]);
      else if (choice === 'pairs') cost = pairsOf(trial[t], seen, ++stamp);
      else {
        const before = raw.subarray(Math.max(0, at - 32768), at);
        const row = new Uint8Array(stride + 1);
        row[0] = t;
        row.set(trial[t], 1);
        cost = deflateSync(row, before.length === 0 ? { level: 4, memLevel: 9 } : { level: 4, memLevel: 9, dictionary: before }).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw[at] = type;
    raw.set(trial[type], at + 1);
  }
  return raw;
}

// Bytes a form's PLTE and tRNS chunks take in its file (12 bytes of length, type and
// CRC around each chunk's data).
const chunkBytes = (form) => (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

// ---------------------------------------------------------------- Deflate
//
// An original RFC 1951 deflate: a hash-chain LZ77 matcher, a lazy parse to seed a
// cost model, a shortest-path (optimal) parse over the longest and the closest match
// at each position, and dynamic Huffman blocks. Deterministic: fixed parameters,
// no clock, no randomness.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

function lenCodeOf(len) {
  let lo = 0;
  let hi = 28;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (LEN_BASE[mid] <= len) lo = mid;
    else hi = mid - 1;
  }
  return [257 + lo, LEN_EXTRA[lo], len - LEN_BASE[lo]];
}

function distCodeOf(dist) {
  let lo = 0;
  let hi = 29;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (DIST_BASE[mid] <= dist) lo = mid;
    else hi = mid - 1;
  }
  return [lo, DIST_EXTRA[lo], dist - DIST_BASE[lo]];
}

class BitWriter {
  constructor(capacity) {
    this.buf = new Uint8Array(Math.max(1024, capacity));
    this.len = 0;
    this.acc = 0;
    this.nbits = 0;
  }
  write(code, n) {
    this.acc |= code << this.nbits;
    this.nbits += n;
    while (this.nbits >= 8) {
      this.buf[this.len++] = this.acc & 0xff;
      this.acc >>>= 8;
      this.nbits -= 8;
    }
  }
  align() {
    if (this.nbits > 0) {
      this.buf[this.len++] = this.acc & 0xff;
      this.acc = 0;
      this.nbits = 0;
    }
  }
  result() {
    return this.buf.subarray(0, this.len);
  }
}

function reverseBits(code, len) {
  let r = 0;
  for (let i = 0; i < len; i++) {
    r = (r << 1) | ((code >> i) & 1);
  }
  return r;
}

// Optimal Huffman code lengths for `freqs` (0 = unused), capped at maxBits and
// completed to a full prefix code (Kraft sum exactly 1), so a decoder accepts them.
function huffmanLengths(freqs, maxBits) {
  const n = freqs.length;
  const lengths = new Array(n).fill(0);
  const used = [];
  for (let s = 0; s < n; s++) if (freqs[s] > 0) used.push(s);
  if (used.length === 0) return lengths;
  if (used.length === 1) {
    lengths[used[0]] = 1;
    return lengths;
  }
  // Heap-based optimal lengths (unconstrained), built bottom-up.
  const heap = used.map((s) => ({ w: freqs[s], syms: [s] }));
  heap.sort((a, b) => a.w - b.w);
  while (heap.length > 1) {
    const a = heap.shift();
    const b = heap.shift();
    for (const s of a.syms) lengths[s]++;
    for (const s of b.syms) lengths[s]++;
    const m = { w: a.w + b.w, syms: a.syms.concat(b.syms) };
    let i = heap.findIndex((x) => x.w > m.w);
    if (i < 0) i = heap.length;
    heap.splice(i, 0, m);
  }
  // Enforce the length limit, then complete the code (Kraft == 1): inflate rejects an
  // incomplete code, so a length-limited code must end up complete, not merely <= 1.
  // An unconstrained optimal code is already complete, so return it untouched.
  let over = false;
  for (const s of used) if (lengths[s] > maxBits) {
    lengths[s] = maxBits;
    over = true;
  }
  if (!over) return lengths;
  const kraftOf = () => {
    let s = 0;
    for (const u of used) s += Math.pow(2, -lengths[u]);
    return s;
  };
  // Lengthen the cheapest codes (least frequency per Kraft saved) until Kraft <= 1.
  let guard = 0;
  while (kraftOf() > 1 + 1e-12 && guard++ < 100000) {
    let best = -1;
    let bestKey = Infinity;
    for (const u of used) {
      if (lengths[u] >= maxBits) continue;
      const key = freqs[u] * Math.pow(2, lengths[u] + 1);
      if (key < bestKey) {
        bestKey = key;
        best = u;
      }
    }
    if (best < 0) break;
    lengths[best]++;
  }
  // Complete it: shorten a code at the deepest depth until Kraft == 1.
  guard = 0;
  while (kraftOf() < 1 - 1e-12 && guard++ < 100000) {
    let d = 0;
    for (const u of used) if (lengths[u] > d) d = lengths[u];
    let best = -1;
    let bestFreq = -1;
    for (const u of used) {
      if (lengths[u] === d && freqs[u] > bestFreq) {
        bestFreq = freqs[u];
        best = u;
      }
    }
    if (best < 0 || d <= 1) break;
    lengths[best]--;
  }
  // Reassign the finished length multiset by frequency (most frequent gets the
  // shortest code): the multiset (and so Kraft == 1) is unchanged, and the cost is
  // minimal for it.
  const sortedSyms = [...used].sort((a, b) => freqs[b] - freqs[a] || a - b);
  const sortedLens = used.map((s) => lengths[s]).sort((a, b) => a - b);
  const final = new Array(n).fill(0);
  for (let i = 0; i < used.length; i++) final[sortedSyms[i]] = sortedLens[i];
  return final;
}

function buildCodes(lengths) {
  const max = Math.max(0, ...lengths);
  const blCount = new Array(max + 1).fill(0);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const next = new Array(max + 1).fill(0);
  let code = 0;
  for (let bits = 1; bits <= max; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    next[bits] = code;
  }
  const codes = new Array(lengths.length).fill(0);
  for (let s = 0; s < lengths.length; s++) {
    const l = lengths[s];
    if (l > 0) codes[s] = reverseBits(next[l]++, l);
  }
  return codes;
}

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Run-length encode a code-length array into (symbol, extraBits, extraValue) triples.
function rleCodeLengths(lengths) {
  const out = [];
  let i = 0;
  while (i < lengths.length) {
    const v = lengths[i];
    let run = 1;
    while (i + run < lengths.length && lengths[i + run] === v) run++;
    if (v === 0) {
      let left = run;
      while (left >= 11) {
        const take = Math.min(left, 138);
        out.push([18, 7, take - 11]);
        left -= take;
      }
      if (left >= 3) {
        out.push([17, 3, left - 3]);
        left = 0;
      }
      while (left > 0) {
        out.push([0, 0, 0]);
        left--;
      }
    } else {
      out.push([v, 0, 0]);
      let left = run - 1;
      while (left >= 3) {
        const take = Math.min(left, 6);
        out.push([16, 2, take - 3]);
        left -= take;
      }
      while (left > 0) {
        out.push([v, 0, 0]);
        left--;
      }
    }
    i += run;
  }
  return out;
}

// The code-length code for a set of RLE triples: lengths for the 19 CL symbols.
function codeLengthCode(triples) {
  const freqs = new Array(19).fill(0);
  for (const [s] of triples) freqs[s]++;
  const lengths = huffmanLengths(freqs, 7);
  let n = 19;
  while (n > 4 && lengths[CL_ORDER[n - 1]] === 0) n--;
  return { lengths, count: n };
}

const WINDOW = 32768;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
const HASH_BITS = 16;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;

function hash3(d, pos) {
  const v = (d[pos] << 16) | (d[pos + 1] << 8) | d[pos + 2];
  return (Math.imul(v, 2654435761) >>> (32 - HASH_BITS)) & HASH_MASK;
}

// Distance-range bucket of a match distance: 0:<32, 1:<256, 2:<2048, 3:<16384, 4:>=16384.
function bucketOf(dist) {
  return dist < 32 ? 0 : dist < 256 ? 1 : dist < 2048 ? 2 : dist < 16384 ? 3 : 4;
}

// The longest match and the closest match (smallest distance with length >= 3) at
// every position of `data`, from a 3-byte hash chain over the previous 32 KiB —
// plus, per position, the longest match in each of five distance ranges, so the
// parse can trade a slightly shorter match for a much cheaper distance. The length
// count starts at 0, not 3: a hash collision can put two different three-byte
// sequences in one chain, so the first three bytes must be compared like the rest.
function findMatches(data, maxChain) {
  const N = data.length;
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(N).fill(-1);
  const mLen = new Uint16Array(N);
  const mDist = new Uint16Array(N);
  const cLen = new Uint16Array(N);
  const cDist = new Uint16Array(N);
  const bLen = new Uint16Array(5 * N);
  const bDist = new Uint16Array(5 * N);
  const limit = N - MIN_MATCH;
  for (let pos = 0; pos <= limit; pos++) {
    const h = hash3(data, pos);
    let cur = head[h];
    const maxPossible = Math.min(MAX_MATCH, N - pos);
    let bestLen = 0;
    let bestDist = 0;
    let closeLen = 0;
    let closeDist = 0;
    let chain = 0;
    const earliest = pos - WINDOW;
    while (cur >= 0 && cur > earliest && chain < maxChain) {
      chain++;
      if (bestLen > 0 && data[cur + bestLen] !== data[pos + bestLen]) {
        cur = prev[cur];
        continue;
      }
      let len = 0;
      while (len < maxPossible && data[cur + len] === data[pos + len]) len++;
      if (len >= MIN_MATCH) {
        const dist = pos - cur;
        if (len > bestLen) {
          bestLen = len;
          bestDist = dist;
          if (len >= maxPossible) break;
        }
        if (closeLen === 0 || dist < closeDist) {
          closeLen = len;
          closeDist = dist;
        }
        const b = bucketOf(dist);
        if (len > bLen[b * N + pos]) {
          bLen[b * N + pos] = len;
          bDist[b * N + pos] = dist;
        }
      }
      cur = prev[cur];
    }
    mLen[pos] = bestLen;
    mDist[pos] = bestDist;
    cLen[pos] = closeLen;
    cDist[pos] = closeDist;
    prev[pos] = head[h];
    head[h] = pos;
  }
  return { mLen, mDist, cLen, cDist, bLen, bDist };
}

// A lazy parse: at each position, take the match unless the next position has a
// longer one (then emit one literal and move on). Tokens are {tEnd, tLen, tDist,
// count}: tLen 0 is a literal (value in tDist), else a match of length tLen at
// distance tDist; tEnd is the input position just after the token.
function lazyParse(data, cand) {
  const N = data.length;
  const { mLen, mDist } = cand;
  const cap = Math.max(1024, N >>> 2);
  let tEnd = new Int32Array(cap);
  let tLen = new Int32Array(cap);
  let tDist = new Int32Array(cap);
  let count = 0;
  const push = (end, len, dist) => {
    if (count === tEnd.length) {
      const n2 = new Int32Array(count * 2);
      n2.set(tEnd);
      tEnd = n2;
      const l2 = new Int32Array(count * 2);
      l2.set(tLen);
      tLen = l2;
      const d2 = new Int32Array(count * 2);
      d2.set(tDist);
      tDist = d2;
    }
    tEnd[count] = end;
    tLen[count] = len;
    tDist[count] = dist;
    count++;
  };
  let pos = 0;
  let prevLen = mLen[0];
  let prevDist = mDist[0];
  while (pos < N) {
    const curLen = pos + 1 < N ? mLen[pos + 1] : 0;
    const curDist = mDist[pos + 1];
    if (curLen > prevLen) {
      push(pos + 1, 0, data[pos]);
      pos++;
      prevLen = curLen;
      prevDist = curDist;
    } else if (prevLen >= MIN_MATCH) {
      push(pos + prevLen, prevLen, prevDist);
      pos += prevLen;
      if (pos < N) {
        prevLen = mLen[pos];
        prevDist = mDist[pos];
      }
    } else {
      push(pos + 1, 0, data[pos]);
      pos++;
      if (pos < N) {
        prevLen = mLen[pos];
        prevDist = mDist[pos];
      }
    }
  }
  return { tEnd: tEnd.subarray(0, count), tLen: tLen.subarray(0, count), tDist: tDist.subarray(0, count), count };
}

// A bit-cost model for the optimal parse, from a token stream's symbol frequencies:
// the actual Huffman code lengths those frequencies imply (capped at 15), so the
// model's costs match the lengths the encoder will really write. A match's cost is
// its length code's length plus its full extra bits, plus its distance code's length
// plus its full extra bits.
function costModelFromTokens(tokens) {
  const litFreq = new Array(286).fill(0);
  const distFreq = new Array(30).fill(0);
  for (let t = 0; t < tokens.count; t++) {
    if (tokens.tLen[t] === 0) litFreq[tokens.tDist[t]]++;
    else {
      const [lc] = lenCodeOf(tokens.tLen[t]);
      litFreq[lc]++;
      const [dc] = distCodeOf(tokens.tDist[t]);
      distFreq[dc]++;
    }
  }
  litFreq[256]++;
  const litLen = huffmanLengths(litFreq, 15);
  const distLen = huffmanLengths(distFreq, 15);
  const litCost = new Float64Array(286);
  for (let s = 0; s < 286; s++) litCost[s] = litLen[s] > 0 ? litLen[s] : 12;
  const distCost = new Float64Array(30);
  for (let s = 0; s < 30; s++) distCost[s] = distLen[s] > 0 ? distLen[s] : 12;
  const lenCostFull = new Float64Array(29);
  for (let i = 0; i < 29; i++) lenCostFull[i] = litCost[257 + i] + LEN_EXTRA[i];
  const distCostFull = new Float64Array(30);
  for (let i = 0; i < 30; i++) distCostFull[i] = distCost[i] + DIST_EXTRA[i];
  return { litCost, lenCostFull, distCostFull };
}

// The shortest-path parse: at each position, the cheapest of one literal, the
// longest match, the closest match, or the longest match in each distance range,
// under the cost model. Reconstructs tokens by walking back from the end.
function dpParse(data, cand, model) {
  const N = data.length;
  const { mLen, mDist, cLen, cDist, bLen, bDist } = cand;
  const { litCost, lenCostFull, distCostFull } = model;
  // Cost of a match of each length and each distance, precomputed so the inner
  // loop is array lookups instead of length/dist code searches.
  const lenCostByLen = new Float64Array(259);
  for (let len = 3; len <= 258; len++) {
    const [lc] = lenCodeOf(len);
    lenCostByLen[len] = lenCostFull[lc - 257];
  }
  const distCostByDist = new Float64Array(WINDOW + 1);
  for (let dist = 1; dist <= WINDOW; dist++) {
    const [dc] = distCodeOf(dist);
    distCostByDist[dist] = distCostFull[dc];
  }
  const cost = new Float64Array(N + 1).fill(Infinity);
  const back = new Int32Array(N + 1);
  const backLen = new Uint16Array(N + 1);
  const backDist = new Uint16Array(N + 1);
  cost[0] = 0;
  for (let i = 0; i < N; i++) {
    const ci = cost[i];
    if (!isFinite(ci)) continue;
    const lc = ci + litCost[data[i]];
    if (lc < cost[i + 1]) {
      cost[i + 1] = lc;
      back[i + 1] = i;
      backLen[i + 1] = 0;
    }
    const tryMatch = (len, dist) => {
      if (len < MIN_MATCH) return;
      const mc = ci + lenCostByLen[len] + distCostByDist[dist];
      const j = i + len;
      if (mc < cost[j]) {
        cost[j] = mc;
        back[j] = i;
        backLen[j] = len;
        backDist[j] = dist;
      }
    };
    tryMatch(mLen[i], mDist[i]);
    if (cLen[i] >= MIN_MATCH && (cLen[i] !== mLen[i] || cDist[i] !== mDist[i])) tryMatch(cLen[i], cDist[i]);
    for (let b = 0; b < 5; b++) {
      const len = bLen[b * N + i];
      const dist = bDist[b * N + i];
      if (len >= MIN_MATCH && len !== mLen[i]) tryMatch(len, dist);
    }
  }
  const rev = [];
  let p = N;
  while (p > 0) {
    const b = back[p];
    if (backLen[p] === 0) rev.push([p, 0, data[b]]);
    else rev.push([p, backLen[p], backDist[p]]);
    p = b;
  }
  rev.reverse();
  const count = rev.length;
  const tEnd = new Int32Array(count);
  const tLen = new Int32Array(count);
  const tDist = new Int32Array(count);
  for (let t = 0; t < count; t++) {
    tEnd[t] = rev[t][0];
    tLen[t] = rev[t][1];
    tDist[t] = rev[t][2];
  }
  return { tEnd, tLen, tDist, count };
}

// One dynamic-Huffman deflate block over tokens[start, end).
function encodeBlock(bw, tokens, start, end, isLast) {
  const { tLen, tDist } = tokens;
  const litFreq = new Array(286).fill(0);
  const distFreq = new Array(30).fill(0);
  for (let t = start; t < end; t++) {
    if (tLen[t] === 0) litFreq[tDist[t]]++;
    else {
      const [lc] = lenCodeOf(tLen[t]);
      litFreq[lc]++;
      const [dc] = distCodeOf(tDist[t]);
      distFreq[dc]++;
    }
  }
  litFreq[256] = 1;
  let nDist = 30;
  while (nDist > 1 && distFreq[nDist - 1] === 0) nDist--;
  if (nDist === 1 && distFreq[0] === 0) {
    distFreq[0] = 1;
    nDist = 1;
  }
  const litLens = huffmanLengths(litFreq, 15);
  const distLens = huffmanLengths(distFreq, 15);
  let nLit = 286;
  while (nLit > 257 && litLens[nLit - 1] === 0) nLit--;
  const all = litLens.slice(0, nLit).concat(distLens.slice(0, nDist));
  const triples = rleCodeLengths(all);
  const cl = codeLengthCode(triples);
  const litCodes = buildCodes(litLens);
  const distCodes = buildCodes(distLens);
  const clCodes = buildCodes(cl.lengths);
  bw.write(isLast ? 1 : 0, 1);
  bw.write(2, 2);
  bw.write(nLit - 257, 5);
  bw.write(nDist - 1, 5);
  bw.write(cl.count - 4, 4);
  for (let i = 0; i < cl.count; i++) bw.write(cl.lengths[CL_ORDER[i]], 3);
  for (const [sym, extraBits, extraVal] of triples) {
    bw.write(clCodes[sym], cl.lengths[sym]);
    if (extraBits > 0) bw.write(extraVal, extraBits);
  }
  for (let t = start; t < end; t++) {
    if (tLen[t] === 0) {
      bw.write(litCodes[tDist[t]], litLens[tDist[t]]);
    } else {
      const [lc, le, lv] = lenCodeOf(tLen[t]);
      bw.write(litCodes[lc], litLens[lc]);
      if (le > 0) bw.write(lv, le);
      const [dc, de, dv] = distCodeOf(tDist[t]);
      bw.write(distCodes[dc], distLens[dc]);
      if (de > 0) bw.write(dv, de);
    }
  }
  bw.write(litCodes[256], litLens[256]);
}

// The raw deflate stream of `data`: match, lazy-parse, build a cost model, then run
// the optimal parse three times, re-estimating the cost model from the previous
// parse's tokens each time — the parse converges by the third pass (a fourth and
// fifth pass write identical bytes), and the re-estimated model is what fixes the
// first model's bias toward long far matches. Then encode in fixed-size blocks.
// `maxChain` caps the match search; `blockBytes` caps each block's input span.
function deflateRaw(data, maxChain, blockBytes) {
  const cand = findMatches(data, maxChain);
  const lazy = lazyParse(data, cand);
  let model = costModelFromTokens(lazy);
  let tokens = dpParse(data, cand, model);
  for (let pass = 1; pass < 3; pass++) {
    model = costModelFromTokens(tokens);
    tokens = dpParse(data, cand, model);
  }
  const bw = new BitWriter(Math.max(1024, data.length));
  let start = 0;
  let blockStartPos = 0;
  while (start < tokens.count) {
    const target = blockStartPos + blockBytes;
    let end = start;
    while (end < tokens.count && tokens.tEnd[end] <= target) end++;
    if (end === start) end = start + 1;
    const isLast = end >= tokens.count;
    encodeBlock(bw, tokens, start, end, isLast);
    blockStartPos = tokens.tEnd[end - 1];
    start = end;
  }
  bw.align();
  return bw.result();
}

// A zlib stream (header 0x78 0xDA + deflate + Adler-32) around a raw deflate stream.
function zlibWrap(deflated, raw) {
  const out = new Uint8Array(deflated.length + 6);
  out[0] = 0x78;
  out[1] = 0xda;
  out.set(deflated, 2);
  const a = adler32(raw);
  out[out.length - 4] = (a >>> 24) & 0xff;
  out[out.length - 3] = (a >>> 16) & 0xff;
  out[out.length - 2] = (a >>> 8) & 0xff;
  out[out.length - 1] = a & 0xff;
  return out;
}

// The match search depth by filtered size: 1024 for the smaller streams, 512 for
// the larger ones. A 1024 chain everywhere costs ~75 s on this machine — past the
// 60 s wall, which earns nothing — while 512 on the large streams costs only
// ~3,900 bytes over the eight images and buys the ~20 s the wall needs. (A 2048
// chain buys ~500 bytes for nearly twice the matcher time; a chain cut once a
// length-32 match is found costs up to 2,176 bytes at three cost-model passes;
// 384 on the largest streams was tried and saved no measurable time.)
function chainFor(dataLength) {
  return dataLength <= 1500000 ? 1024 : 512;
}

// Compress `data` with the original deflate, and with zlib level 9 as a fallback;
// return the smaller stream.
function compressBest(data) {
  const mine = zlibWrap(deflateRaw(data, chainFor(data.length), 262144), data);
  const theirs = deflateSync(data, { level: 9, memLevel: 9 });
  return mine.length <= theirs.length ? mine : theirs;
}

// ---------------------------------------------------------------- Screen and main

// The PNG of an image of `form` whose IDAT holds the zlib stream `idat`.
function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// Pick an image's best (form, filter choice): each choice's filtered data weighed by
// zlib level 6 plus its PLTE/tRNS chunk bytes, the smallest winning, the first on a tie.
// Brute force is only tried for a form whose best so far is a heuristic (minsum or
// pairs): measured over the practice set, brute force never beats a fixed filter,
// and only wins where a heuristic won — so skipping it elsewhere saves seconds at
// no cost in bytes.
function screen(rgba, width, height) {
  let best = null;
  for (const form of formsOf(rgba)) {
    const size = height * (width * form.bpp + 1);
    const chunks = chunkBytes(form);
    let formBest = null;
    for (const choice of form.filters) {
      if (choice === 'brute') continue;
      const data = filtered(form.samples, width, height, form.bpp, choice);
      const zlib = deflateSync(data, { level: 6, memLevel: 8 });
      const bytes = zlib.length + chunks;
      if (formBest === null || bytes < formBest.bytes) {
        formBest = { form, choice, data, bytes };
      }
    }
    if (form.filters.includes('brute') && formBest !== null && (formBest.choice === 'minsum' || formBest.choice === 'pairs')) {
      const data = filtered(form.samples, width, height, form.bpp, 'brute');
      const zlib = deflateSync(data, { level: 6, memLevel: 8 });
      const bytes = zlib.length + chunks;
      if (bytes < formBest.bytes) {
        formBest = { form, choice: 'brute', data, bytes };
      }
    }
    if (formBest !== null && (best === null || formBest.bytes < best.bytes)) {
      best = formBest;
    }
  }
  return best;
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const { width, height, rgba } = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  const { form, data } = screen(rgba, width, height);
  const stream = compressBest(data);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), pngOfForm(width, height, form, stream));
}
