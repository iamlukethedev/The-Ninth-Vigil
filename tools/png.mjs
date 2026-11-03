#!/usr/bin/env node
/**
 * A minimal PNG codec — decode for the diff gate, encode for its diff image.
 *
 * WHY THIS EXISTS. `tools/diff.mjs` has to read the committed baselines in
 * `shots/` and write a diff PNG, and the project's first hard rule is no new
 * dependencies. `node:zlib` already has `inflateSync` and `deflateSync`, which
 * is the whole compression half of PNG; the remaining half is chunk parsing,
 * five row filters, and a CRC. That is small enough to own, and owning it means
 * the diff tool runs without a browser, without a dev server and without a
 * canvas — which is what lets `tools/diff.test.mjs` run in CI against
 * synthetic fixtures instead of needing a GPU.
 *
 * SCOPE. Deliberately narrow: 8-bit, non-interlaced PNGs in colour types
 * 0 (grey), 2 (RGB), 3 (palette) and 6 (RGBA) decoded to RGBA; anything else
 * throws with the reason rather than guessing. That covers every PNG Playwright
 * produces (type 2 or 6 at depth 8) and every PNG this repo commits. 16-bit
 * and Adam7 are not needed by anything here, and a half-implemented version of
 * them would silently produce wrong pixels, which is worse than refusing.
 */
import { inflateSync, deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* --- CRC32 -------------------------------------------------------------- */

let CRC_TABLE = null;

function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c;
  }
  return CRC_TABLE;
}

function crc32(buf) {
  const t = crcTable();
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* --- decode ------------------------------------------------------------- */

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Decode a PNG buffer to RGBA.
 *
 * @param {Buffer} buf
 * @returns {{width: number, height: number, rgba: Uint8Array, colorType: number}}
 */
export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('not a PNG (bad signature)');
  }

  let pos = 8;
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  let palette = null;
  const idat = [];

  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len; // length + type + body + crc

    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colorType = body[9];
      if (body[10] !== 0) throw new Error(`unsupported compression method ${body[10]}`);
      if (body[11] !== 0) throw new Error(`unsupported filter method ${body[11]}`);
      interlace = body[12];
    } else if (type === 'PLTE') {
      palette = body;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!width || !height) throw new Error('no IHDR chunk');
  if (depth !== 8) throw new Error(`unsupported bit depth ${depth} (only 8-bit is implemented)`);
  if (interlace !== 0) throw new Error('interlaced PNGs are not supported');
  if (!(colorType in CHANNELS)) throw new Error(`unsupported colour type ${colorType}`);
  if (colorType === 3 && !palette) throw new Error('palette PNG with no PLTE chunk');
  if (!idat.length) throw new Error('no IDAT chunk');

  const channels = CHANNELS[colorType];
  const raw = inflateSync(Buffer.concat(idat));

  /* Each scanline is one filter byte followed by width * channels bytes. The
     inflate output must be exactly that size; a mismatch means the file is
     truncated or the assumptions above are wrong, and both deserve an error
     rather than a partially-decoded frame that silently biases the diff. */
  const stride = width * channels;
  const expected = (stride + 1) * height;
  if (raw.length !== expected) {
    throw new Error(`IDAT inflated to ${raw.length} bytes, expected ${expected} (${width}x${height}, ${channels}ch)`);
  }

  const out = new Uint8Array(width * height * 4);
  const prior = new Uint8Array(stride);
  const cur = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const off = y * (stride + 1);
    const filter = raw[off];
    raw.copy(cur, 0, off + 1, off + 1 + stride);
    unfilter(filter, cur, prior, channels, y);

    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      switch (colorType) {
        case 0:
          out[d] = out[d + 1] = out[d + 2] = cur[s];
          out[d + 3] = 255;
          break;
        case 4:
          out[d] = out[d + 1] = out[d + 2] = cur[s];
          out[d + 3] = cur[s + 1];
          break;
        case 2:
          out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2];
          out[d + 3] = 255;
          break;
        case 3: {
          const p = cur[s] * 3;
          out[d] = palette[p]; out[d + 1] = palette[p + 1]; out[d + 2] = palette[p + 2];
          out[d + 3] = 255;
          break;
        }
        case 6:
          out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]; out[d + 3] = cur[s + 3];
          break;
      }
    }
    prior.set(cur);
  }

  return { width, height, rgba: out, colorType };
}

/** Apply one of the five PNG row filters in place. */
function unfilter(filter, cur, prior, bpp, row) {
  const n = cur.length;
  switch (filter) {
    case 0: // None
      return;
    case 1: // Sub
      for (let i = bpp; i < n; i++) cur[i] = (cur[i] + cur[i - bpp]) & 0xff;
      return;
    case 2: // Up
      for (let i = 0; i < n; i++) cur[i] = (cur[i] + prior[i]) & 0xff;
      return;
    case 3: // Average
      for (let i = 0; i < n; i++) {
        const left = i >= bpp ? cur[i - bpp] : 0;
        cur[i] = (cur[i] + ((left + prior[i]) >> 1)) & 0xff;
      }
      return;
    case 4: { // Paeth
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = prior[i];
        const c = i >= bpp ? prior[i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        cur[i] = (cur[i] + pred) & 0xff;
      }
      return;
    }
    default:
      throw new Error(`unknown PNG filter ${filter} on row ${row}`);
  }
}

/* --- encode ------------------------------------------------------------- */

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/**
 * Encode RGBA bytes as a PNG.
 *
 * Filter 0 on every row, deliberately: the output is a diff image that a human
 * opens once, so decode speed matters more than a few hundred KB, and a
 * per-row filter heuristic would be more code to be wrong in.
 *
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array|Uint8ClampedArray} rgba
 * @returns {Buffer}
 */
export function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`rgba length ${rgba.length} does not match ${width}x${height}x4`);
  }

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
