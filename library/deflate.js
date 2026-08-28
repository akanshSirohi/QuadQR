/**
 * Small synchronous RFC 1951 raw-DEFLATE codec used by QuadQR Compression 3.0.
 *
 * The compressor intentionally emits fixed-Huffman blocks only. This keeps the
 * implementation compact, deterministic, dependency-free, and usable in both
 * browsers and Node.js while still allowing DEFLATE's 32 KiB window and
 * 258-byte matches to compress repetitive payloads far better than the legacy
 * QuadQR LZSS stream.
 *
 * The decoder accepts stored and fixed-Huffman blocks produced by this module.
 * Dynamic-Huffman input is intentionally rejected because QuadQR's envelope
 * only needs to decode streams created by its own compressor.
 */

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(input);
}

export const DEFLATE_LEVEL_MIN = 1;
export const DEFLATE_LEVEL_MAX = 9;
export const DEFAULT_DEFLATE_LEVEL = 6;

function normalizeDeflateLevel(value = DEFAULT_DEFLATE_LEVEL) {
  const level = Number(value);
  assert(Number.isInteger(level), `DEFLATE level must be an integer ${DEFLATE_LEVEL_MIN}..${DEFLATE_LEVEL_MAX}.`);
  assert(
    level >= DEFLATE_LEVEL_MIN && level <= DEFLATE_LEVEL_MAX,
    `DEFLATE level must be ${DEFLATE_LEVEL_MIN}..${DEFLATE_LEVEL_MAX}.`
  );
  return level;
}

function deflateTuning(level) {
  // Higher levels spend progressively more CPU walking candidate chains and
  // performing lazy-match lookahead. The RFC 1951 stream stays compatible
  // regardless of level, so the decoder never needs this value.
  const candidateDepth = [0, 8, 16, 28, 48, 72, 96, 144, 224, 320][level];
  const lazyDepth = [0, 0, 0, 8, 12, 18, 24, 40, 64, 96][level];
  const lazyGain = level <= 3 ? 3 : level <= 6 ? 2 : 1;
  return { candidateDepth, lazyDepth, lazyGain };
}

function reverseBits(value, width) {
  let out = 0;
  for (let i = 0; i < width; i++) {
    out = (out << 1) | ((value >>> i) & 1);
  }
  return out >>> 0;
}

class BitWriter {
  constructor() {
    this.bytes = [];
    this.bitBuffer = 0;
    this.bitCount = 0;
  }

  writeBits(value, count) {
    let v = value >>> 0;
    for (let i = 0; i < count; i++) {
      this.bitBuffer |= ((v >>> i) & 1) << this.bitCount;
      this.bitCount++;
      if (this.bitCount === 8) {
        this.bytes.push(this.bitBuffer & 0xff);
        this.bitBuffer = 0;
        this.bitCount = 0;
      }
    }
  }

  finish() {
    if (this.bitCount) this.bytes.push(this.bitBuffer & 0xff);
    return Uint8Array.from(this.bytes);
  }
}

class BitReader {
  constructor(bytes) {
    this.bytes = asBytes(bytes);
    this.bytePos = 0;
    this.bitPos = 0;
  }

  readBits(count) {
    let value = 0;
    for (let i = 0; i < count; i++) {
      assert(this.bytePos < this.bytes.length, "DEFLATE stream is truncated.");
      const bit = (this.bytes[this.bytePos] >>> this.bitPos) & 1;
      value |= bit << i;
      this.bitPos++;
      if (this.bitPos === 8) {
        this.bitPos = 0;
        this.bytePos++;
      }
    }
    return value >>> 0;
  }

  alignByte() {
    if (this.bitPos) {
      this.bitPos = 0;
      this.bytePos++;
    }
  }
}

function fixedLiteralCode(symbol) {
  if (symbol <= 143) return { bits: reverseBits(0x30 + symbol, 8), width: 8 };
  if (symbol <= 255) return { bits: reverseBits(0x190 + (symbol - 144), 9), width: 9 };
  if (symbol <= 279) return { bits: reverseBits(symbol - 256, 7), width: 7 };
  assert(symbol <= 287, "Invalid fixed-Huffman literal/length symbol.");
  return { bits: reverseBits(0xc0 + (symbol - 280), 8), width: 8 };
}

const LENGTH_BASE = new Uint16Array([
  3, 4, 5, 6, 7, 8, 9, 10,
  11, 13, 15, 17,
  19, 23, 27, 31,
  35, 43, 51, 59,
  67, 83, 99, 115,
  131, 163, 195, 227,
  258
]);
const LENGTH_EXTRA = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0,
  1, 1, 1, 1,
  2, 2, 2, 2,
  3, 3, 3, 3,
  4, 4, 4, 4,
  5, 5, 5, 5,
  0
]);

const DIST_BASE = new Uint16Array([
  1, 2, 3, 4,
  5, 7,
  9, 13,
  17, 25,
  33, 49,
  65, 97,
  129, 193,
  257, 385,
  513, 769,
  1025, 1537,
  2049, 3073,
  4097, 6145,
  8193, 12289,
  16385, 24577
]);
const DIST_EXTRA = new Uint8Array([
  0, 0, 0, 0,
  1, 1,
  2, 2,
  3, 3,
  4, 4,
  5, 5,
  6, 6,
  7, 7,
  8, 8,
  9, 9,
  10, 10,
  11, 11,
  12, 12,
  13, 13
]);

function lengthSymbol(length) {
  assert(length >= 3 && length <= 258, "DEFLATE match length must be 3..258.");
  if (length === 258) return { symbol: 285, extraBits: 0, extraValue: 0 };
  for (let i = 0; i < 28; i++) {
    const base = LENGTH_BASE[i];
    const extraBits = LENGTH_EXTRA[i];
    const max = base + ((1 << extraBits) - 1);
    if (length <= max) return { symbol: 257 + i, extraBits, extraValue: length - base };
  }
  throw new Error("Unable to encode DEFLATE match length.");
}

function distanceSymbol(distance) {
  assert(distance >= 1 && distance <= 32768, "DEFLATE match distance must be 1..32768.");
  for (let i = 0; i < DIST_BASE.length; i++) {
    const base = DIST_BASE[i];
    const extraBits = DIST_EXTRA[i];
    const max = base + ((1 << extraBits) - 1);
    if (distance <= max) return { symbol: i, extraBits, extraValue: distance - base };
  }
  throw new Error("Unable to encode DEFLATE match distance.");
}

function hash3(bytes, i) {
  if (i + 2 >= bytes.length) return -1;
  return (((bytes[i] * 251 + bytes[i + 1]) * 251 + bytes[i + 2]) >>> 0) & 0xffff;
}

function emitLiteral(writer, value) {
  const code = fixedLiteralCode(value);
  writer.writeBits(code.bits, code.width);
}

function emitMatch(writer, length, distance) {
  const len = lengthSymbol(length);
  const lenCode = fixedLiteralCode(len.symbol);
  writer.writeBits(lenCode.bits, lenCode.width);
  if (len.extraBits) writer.writeBits(len.extraValue, len.extraBits);

  const dist = distanceSymbol(distance);
  writer.writeBits(reverseBits(dist.symbol, 5), 5);
  if (dist.extraBits) writer.writeBits(dist.extraValue, dist.extraBits);
}

/**
 * Compress bytes as a raw RFC 1951 DEFLATE stream using one final
 * fixed-Huffman block. The function is synchronous and runtime-neutral.
 */
export function compressDeflatePayload(input, options = {}) {
  const bytes = asBytes(input);
  const level = normalizeDeflateLevel(
    typeof options === "number" ? options : (options.level ?? options.compressionLevel ?? DEFAULT_DEFLATE_LEVEL)
  );
  const { candidateDepth, lazyDepth, lazyGain } = deflateTuning(level);
  const writer = new BitWriter();

  // BFINAL=1, BTYPE=01 (fixed Huffman). Bits are written LSB-first.
  writer.writeBits(1, 1);
  writer.writeBits(1, 2);

  const recent = new Map();
  const WINDOW = 32768;
  const MAX_MATCH = 258;
  const HISTORY_LIMIT = Math.max(candidateDepth, lazyDepth, 8);

  const remember = (position) => {
    const hash = hash3(bytes, position);
    if (hash < 0) return;
    let list = recent.get(hash);
    if (!list) recent.set(hash, list = []);
    list.push(position);
    while (list.length > HISTORY_LIMIT) list.shift();
    const minimum = position - WINDOW;
    while (list.length && list[0] < minimum) list.shift();
  };

  const findBest = (position, maxCandidates) => {
    let bestLength = 0;
    let bestDistance = 0;
    const hash = hash3(bytes, position);
    const candidates = hash >= 0 ? (recent.get(hash) ?? []) : [];
    for (let ci = candidates.length - 1, checked = 0; ci >= 0 && checked < maxCandidates; ci--, checked++) {
      const candidate = candidates[ci];
      const distance = position - candidate;
      if (distance <= 0 || distance > WINDOW) continue;
      let length = 0;
      const limit = Math.min(MAX_MATCH, bytes.length - position);
      while (length < limit && bytes[candidate + (length % distance)] === bytes[position + length]) length++;
      if (length >= 3 && length > bestLength) {
        bestLength = length;
        bestDistance = distance;
        if (length === limit) break;
      }
    }
    return { length: bestLength, distance: bestDistance };
  };

  let pos = 0;
  while (pos < bytes.length) {
    let best = findBest(pos, candidateDepth);

    // Levels 3+ may defer a match when the next byte starts a meaningfully
    // longer one. Stronger levels search deeper and accept a smaller gain.
    if (best.length >= 3 && lazyDepth > 0 && pos + 1 < bytes.length) {
      const next = findBest(pos + 1, lazyDepth);
      if (next.length > best.length + lazyGain) best = { length: 0, distance: 0 };
    }

    if (best.length >= 3) {
      emitMatch(writer, best.length, best.distance);
      for (let i = 0; i < best.length; i++) remember(pos + i);
      pos += best.length;
    } else {
      emitLiteral(writer, bytes[pos]);
      remember(pos);
      pos++;
    }
  }

  // End-of-block symbol.
  const end = fixedLiteralCode(256);
  writer.writeBits(end.bits, end.width);
  return writer.finish();
}

const FIXED_DECODE = (() => {
  const byLength = new Map();
  for (let symbol = 0; symbol <= 287; symbol++) {
    const { bits, width } = fixedLiteralCode(symbol);
    let map = byLength.get(width);
    if (!map) byLength.set(width, map = new Map());
    map.set(bits, symbol);
  }
  return byLength;
})();

function readFixedSymbol(reader) {
  let code = 0;
  for (let width = 1; width <= 9; width++) {
    code |= reader.readBits(1) << (width - 1);
    const symbol = FIXED_DECODE.get(width)?.get(code);
    if (symbol != null) return symbol;
  }
  throw new Error("Invalid fixed-Huffman code in DEFLATE stream.");
}

function readStoredBlock(reader, out) {
  reader.alignByte();
  assert(reader.bytePos + 4 <= reader.bytes.length, "Stored DEFLATE block is truncated.");
  const len = reader.bytes[reader.bytePos] | (reader.bytes[reader.bytePos + 1] << 8);
  const nlen = reader.bytes[reader.bytePos + 2] | (reader.bytes[reader.bytePos + 3] << 8);
  reader.bytePos += 4;
  assert(((len ^ 0xffff) & 0xffff) === nlen, "Stored DEFLATE block length checksum is invalid.");
  assert(reader.bytePos + len <= reader.bytes.length, "Stored DEFLATE block payload is truncated.");
  for (let i = 0; i < len; i++) out.push(reader.bytes[reader.bytePos++]);
}

/** Decode raw DEFLATE streams produced by compressDeflatePayload(). */
export function decompressDeflatePayload(input, expectedLength = null) {
  const reader = new BitReader(input);
  const out = [];
  let finalBlock = false;

  while (!finalBlock) {
    finalBlock = reader.readBits(1) === 1;
    const blockType = reader.readBits(2);
    if (blockType === 0) {
      readStoredBlock(reader, out);
      continue;
    }
    assert(blockType === 1, "QuadQR DEFLATE decoder supports stored and fixed-Huffman blocks only.");

    while (true) {
      const symbol = readFixedSymbol(reader);
      if (symbol < 256) {
        out.push(symbol);
        continue;
      }
      if (symbol === 256) break;
      assert(symbol >= 257 && symbol <= 285, "Invalid DEFLATE length symbol.");

      const lengthIndex = symbol - 257;
      const lengthBase = LENGTH_BASE[lengthIndex];
      const lengthExtra = LENGTH_EXTRA[lengthIndex];
      const length = lengthBase + (lengthExtra ? reader.readBits(lengthExtra) : 0);

      const reversedDistanceCode = reader.readBits(5);
      let distanceCode = -1;
      for (let code = 0; code < 30; code++) {
        if (reverseBits(code, 5) === reversedDistanceCode) {
          distanceCode = code;
          break;
        }
      }
      assert(distanceCode >= 0, "Invalid DEFLATE distance symbol.");
      const distanceBase = DIST_BASE[distanceCode];
      const distanceExtra = DIST_EXTRA[distanceCode];
      const distance = distanceBase + (distanceExtra ? reader.readBits(distanceExtra) : 0);
      assert(distance > 0 && distance <= out.length, "DEFLATE stream contains an invalid back-reference.");

      for (let i = 0; i < length; i++) out.push(out[out.length - distance]);
      if (expectedLength != null) assert(out.length <= expectedLength, "DEFLATE payload expands beyond the expected length.");
    }
  }

  if (expectedLength != null) assert(out.length === expectedLength, "DEFLATE payload length mismatch.");
  return Uint8Array.from(out);
}
