/**
 * QuadQR
 *
 * Experimental RGBW / Triangle16 matrix code written in pure JavaScript.
 *
 * Core format:
 * - RGBW profile: Red / Green / Blue / White, exactly 2 bits per data cell
 * - Triangle16 profile: two fixed RGBW triangle regions, 16 states / 4 bits per body data cell
 * - GF(256) Reed-Solomon ECC over byte symbols
 * - interleaved body ECC blocks
 * - zero-overhead spectral-spatial cell placement
 * - confidence-aware Reed-Solomon error/erasure recovery
 * - protected bootstrap/header
 * - version-dependent distributed alignment patterns for perspective recovery
 * - camera color calibration and image scanning
 */

import {
  MAX_CODEWORD_SYMBOLS,
  rsEncode,
  rsDecode
} from "./reed-solomon.js";
import {
  alignmentPatternCentersForVersion,
  alignmentPatternIsBlack,
  alignmentPatternRadius,
  ALIGNMENT_PROFILE_STANDARD_5,
  ALIGNMENT_PROFILE_LEGACY_3,
  sizeForVersion,
  versionFromSize
} from "./geometry.js";
import {
  detectCodeGeometry,
  computeHomography,
  projectPoint,
  samplePerspectiveMatrix,
  samplePerspectiveTriangleMatrix,
  rectifyImageData,
  sampleObservedPalette,
  spatiallyNormalizeRgbGrid,
  autoToneContrastColorRgbGrid,
  autoToneContrastColorImageData,
  autoColorImageData,
  findActiveBounds,
  sampleAxisAlignedGrid,
  sampleAxisAlignedTriangleGrid
} from "./vision.js";
import {
  decryptSecurePayload,
  encryptSecurePayload,
  inspectSecureEnvelope,
  SECURITY_MODES,
  SECURITY_ALGORITHMS,
  SECURE_PAYLOAD_VERSION,
  DEFAULT_PBKDF2_ITERATIONS,
  generateRaw256Key,
  normalizeRaw256Key,
  bytesToHex,
  estimateSecureEnvelopeOverhead
} from "./security.js";
import {
  compressDeflatePayload as compressDeflateBytes,
  decompressDeflatePayload as decompressDeflateBytes,
  DEFAULT_DEFLATE_LEVEL,
  DEFLATE_LEVEL_MIN,
  DEFLATE_LEVEL_MAX
} from "./deflate.js";
import {
  compressBrotliPayload as compressBrotliBytes,
  decompressBrotliPayload as decompressBrotliBytes,
  DEFAULT_BROTLI_QUALITY,
  BROTLI_QUALITY_MIN,
  BROTLI_QUALITY_MAX
} from "./brotli.js";

export const FORMAT_VERSION = 6;
export const LEGACY_FORMAT_VERSION = 5;
export const MIN_VERSION = 1;
export const MAX_VERSION = 40;
export const DEFAULT_ECC_LEVEL = "M";

export const RENDER_MODES = Object.freeze({
  SCREEN: "screen",
  PRINT: "print"
});

export const CELL_ENCODINGS = Object.freeze({
  RGBW: "rgbw",
  TRIANGLE16: "triangle16"
});


// Print-safe defaults deliberately use darker, more ink-tolerant primaries and
// a true white background. Applications can still override individual colors.
export const PRINT_PALETTE = Object.freeze({
  black: "#000000",
  white: "#ffffff",
  red: "#d71932",
  green: "#087f3e",
  blue: "#174ea6"
});

export const COMPRESSION_MODES = Object.freeze({
  NONE: "none",
  AUTO: "auto",
  SMART: "smart",
  LZ: "lz",
  DEFLATE: "deflate",
  BROTLI: "brotli"
});

export const LZ_LEVEL_MIN = 1;
export const LZ_LEVEL_MAX = 9;
export const DEFAULT_LZ_LEVEL = 6;

export const COMPRESSION_LEVELS = Object.freeze({
  lz: Object.freeze({ min: LZ_LEVEL_MIN, max: LZ_LEVEL_MAX, default: DEFAULT_LZ_LEVEL }),
  deflate: Object.freeze({ min: DEFLATE_LEVEL_MIN, max: DEFLATE_LEVEL_MAX, default: DEFAULT_DEFLATE_LEVEL }),
  brotli: Object.freeze({ min: BROTLI_QUALITY_MIN, max: BROTLI_QUALITY_MAX, default: DEFAULT_BROTLI_QUALITY }),
  auto: Object.freeze({ lz: DEFAULT_LZ_LEVEL, deflate: DEFAULT_DEFLATE_LEVEL, brotli: 6 }),
  smart: Object.freeze({
    initialLz: DEFAULT_LZ_LEVEL,
    initialDeflate: DEFAULT_DEFLATE_LEVEL,
    initialBrotli: 6,
    strongDeflate: 8,
    strongBrotli: 9,
    maximumDeflate: 9,
    maximumBrotli: 11
  })
});
export const SIGNATURE_ALGORITHMS = Object.freeze({ ED25519: "Ed25519" });

// Data cells are the four values 0..3. Structural white deliberately shares
// value 3 with data-white because both render and scan identically.
export const CELL = Object.freeze({
  BLACK: -1,
  RED: 0,
  GREEN: 1,
  BLUE: 2,
  WHITE: 3
});

export const DEFAULT_PALETTE = Object.freeze({
  black: "#000000",
  white: "#ffffff",
  red: "#ef233c",
  green: "#16a34a",
  blue: "#2563eb"
});

export const RENDER_STYLES = Object.freeze({
  CLASSIC: "classic",
  DEPTH: "depth",
  SOFT: "soft",
  INSET: "inset"
});

export const ECC_LEVELS = Object.freeze({
  L: Object.freeze({ id: 0, paritySymbols: 12, correctableSymbolsPerBlock: 6 }),
  M: Object.freeze({ id: 1, paritySymbols: 24, correctableSymbolsPerBlock: 12 }),
  Q: Object.freeze({ id: 2, paritySymbols: 36, correctableSymbolsPerBlock: 18 }),
  H: Object.freeze({ id: 3, paritySymbols: 48, correctableSymbolsPerBlock: 24 })
});

const ECC_BY_ID = Object.freeze(
  Object.fromEntries(Object.entries(ECC_LEVELS).map(([name, info]) => [info.id, name]))
);

const MAGIC = new Uint8Array([0x51, 0x51, 0x52, 0x57]); // QQRW (QuadQR RGBW)
const HEADER_BYTES = 10;
const HEADER_RS_PARITY = 8;
const HEADER_CODEWORD_BYTES = HEADER_BYTES + HEADER_RS_PARITY;
const RGBW_CELLS_PER_BYTE = 4;
const TRIANGLE16_CELLS_PER_BYTE = 2;
const CELLS_PER_BYTE = RGBW_CELLS_PER_BYTE; // legacy internal alias
const HEADER_CODEWORD_CELLS = HEADER_CODEWORD_BYTES * RGBW_CELLS_PER_BYTE;

// Version 1 is a deliberately compact small-symbol profile. A 21x21 matrix
// cannot afford the normal 18-byte protected header plus a 24-byte M body
// parity block. The matrix size already identifies v1, so it uses a compact
// 4-byte logical header protected by 4 RS parity bytes and size-appropriate
// body parity. Larger versions keep the normal framing unchanged.
const COMPACT_VERSION = 1;
const COMPACT_HEADER_MAGIC = 0xc3;
const COMPACT_HEADER_BYTES = 4;
const COMPACT_HEADER_RS_PARITY = 4;
const COMPACT_HEADER_CODEWORD_BYTES = COMPACT_HEADER_BYTES + COMPACT_HEADER_RS_PARITY;
const COMPACT_HEADER_CODEWORD_CELLS = COMPACT_HEADER_CODEWORD_BYTES * RGBW_CELLS_PER_BYTE;
const COMPACT_ECC_LEVELS = Object.freeze({
  L: Object.freeze({ paritySymbols: 4, correctableSymbolsPerBlock: 2 }),
  M: Object.freeze({ paritySymbols: 8, correctableSymbolsPerBlock: 4 }),
  Q: Object.freeze({ paritySymbols: 12, correctableSymbolsPerBlock: 6 }),
  H: Object.freeze({ paritySymbols: 16, correctableSymbolsPerBlock: 8 })
});

const CRC_BYTES = 4;
const TEXT_FLAG = 1;
const SECURE_FLAG = 1 << 3;
const EXTENDED_PAYLOAD_FLAG = 1 << 4;
const SIGNED_FLAG = 1 << 5;
const TRIANGLE16_FLAG = 1 << 6;

// Internal payload extension envelope. This is deliberately not a public
// payload mode or content-type system. It exists only when compression or
// signing needs metadata around an otherwise normal text/binary payload.
const PAYLOAD_ENVELOPE_VERSION = 3;
const PAYLOAD_ENVELOPE_MAGIC = new Uint8Array([0x51, 0x50, 0x58, 0x31]); // QPX1
const PAYLOAD_ENVELOPE_HEADER_BYTES = 16;
const PAYLOAD_ENVELOPE_SIGNED_FLAG = 1;
const PAYLOAD_ENVELOPE_COMPRESSED_FLAG = 1 << 1;
const PAYLOAD_ENVELOPE_EMBEDDED_KEY_FLAG = 1 << 2;
const PAYLOAD_ENVELOPE_COMPRESSION_IDS = Object.freeze({ none: 0, lz: 1, deflate: 2, brotli: 3 });
const PAYLOAD_ENVELOPE_COMPRESSION_BY_ID = Object.freeze({ 0: "none", 1: "lz", 2: "deflate", 3: "brotli" });
const PAYLOAD_ENVELOPE_SIGNATURE_IDS = Object.freeze({ none: 0, Ed25519: 1 });
const PAYLOAD_ENVELOPE_SIGNATURE_BY_ID = Object.freeze({ 0: null, 1: "Ed25519" });
const ECC_SHIFT = 1;
const ECC_MASK = 0b00000110;

const textEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
const textDecoder = typeof TextDecoder !== "undefined"
  ? new TextDecoder("utf-8", { fatal: false })
  : null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function getTextEncoder() {
  assert(textEncoder, "TextEncoder is required in this environment.");
  return textEncoder;
}

function getTextDecoder() {
  assert(textDecoder, "TextDecoder is required in this environment.");
  return textDecoder;
}

function cloneMatrix(matrix) {
  return matrix.map((row) => row.slice());
}

function make2D(size, valueFactory) {
  return Array.from({ length: size }, (_, r) =>
    Array.from({ length: size }, (_, c) =>
      typeof valueFactory === "function" ? valueFactory(r, c) : valueFactory
    )
  );
}

function validateVersion(version) {
  assert(Number.isInteger(version), "Version must be an integer.");
  assert(
    version >= MIN_VERSION && version <= MAX_VERSION,
    `Version must be ${MIN_VERSION}..${MAX_VERSION}.`
  );
}

function normalizeEccLevel(level = DEFAULT_ECC_LEVEL) {
  const value = String(level).toUpperCase();
  assert(ECC_LEVELS[value], `ECC level must be one of ${Object.keys(ECC_LEVELS).join(", ")}.`);
  return value;
}

function normalizeCellEncoding(value = CELL_ENCODINGS.RGBW) {
  const key = String(value).toLowerCase();
  assert(
    key === CELL_ENCODINGS.RGBW || key === CELL_ENCODINGS.TRIANGLE16,
    `Internal cell encoding must be ${CELL_ENCODINGS.RGBW} or ${CELL_ENCODINGS.TRIANGLE16}.`
  );
  return key;
}

// Public API presents Triangle16 as one experimental High Density Mode toggle.
// cellEncoding remains an internal/backward-compatible detail so existing
// experimental branch symbols and renderer metadata continue to work.
function cellEncodingFromOptions(options = {}) {
  if (typeof options.highDensity === "boolean") {
    return options.highDensity ? CELL_ENCODINGS.TRIANGLE16 : CELL_ENCODINGS.RGBW;
  }
  return normalizeCellEncoding(options.cellEncoding ?? CELL_ENCODINGS.RGBW);
}

function cellsPerByteForEncoding(cellEncoding = CELL_ENCODINGS.RGBW) {
  return normalizeCellEncoding(cellEncoding) === CELL_ENCODINGS.TRIANGLE16
    ? TRIANGLE16_CELLS_PER_BYTE
    : RGBW_CELLS_PER_BYTE;
}

function packTriangleCell(first, second) {
  assert(first >= 0 && first <= 3 && second >= 0 && second <= 3, "Invalid Triangle16 color.");
  return ((first & 3) << 2) | (second & 3);
}

function unpackTriangleCell(value) {
  assert(Number.isInteger(value) && value >= 0 && value <= 15, "Invalid Triangle16 data cell.");
  return { first: (value >>> 2) & 3, second: value & 3 };
}

function solidTriangleCell(color) {
  return packTriangleCell(color, color);
}

function concatBytes(...arrays) {
  const total = arrays.reduce((sum, item) => sum + item.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const item of arrays) {
    out.set(item, offset);
    offset += item.length;
  }
  return out;
}

function u32be(value) {
  const v = value >>> 0;
  return new Uint8Array([
    (v >>> 24) & 0xff,
    (v >>> 16) & 0xff,
    (v >>> 8) & 0xff,
    v & 0xff
  ]);
}

function readU32be(bytes, offset = 0) {
  return (
    ((bytes[offset] << 24) >>> 0) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  ) >>> 0;
}

function u16be(value) {
  const v = Number(value) >>> 0;
  assert(v <= 0xffff, "Value does not fit in uint16.");
  return new Uint8Array([(v >>> 8) & 0xff, v & 0xff]);
}

function readU16be(bytes, offset = 0) {
  return ((bytes[offset] << 8) | bytes[offset + 1]) >>> 0;
}

function normalizeCompressionMode(value = "none") {
  const key = String(value).toLowerCase();
  assert(["none", "auto", "smart", "lz", "deflate", "brotli"].includes(key), "compression must be none, auto, smart, lz, deflate, or brotli.");
  return key;
}

function normalizeExplicitCompressionLevel(mode, options = {}) {
  const generic = options.compressionLevel;
  if (mode === "lz") {
    const value = Number(generic ?? options.lzLevel ?? DEFAULT_LZ_LEVEL);
    assert(Number.isInteger(value) && value >= LZ_LEVEL_MIN && value <= LZ_LEVEL_MAX, `LZ compressionLevel must be ${LZ_LEVEL_MIN}..${LZ_LEVEL_MAX}.`);
    return value;
  }
  if (mode === "deflate") {
    const value = Number(generic ?? options.deflateLevel ?? DEFAULT_DEFLATE_LEVEL);
    assert(Number.isInteger(value) && value >= DEFLATE_LEVEL_MIN && value <= DEFLATE_LEVEL_MAX, `DEFLATE compressionLevel must be ${DEFLATE_LEVEL_MIN}..${DEFLATE_LEVEL_MAX}.`);
    return value;
  }
  if (mode === "brotli") {
    const value = Number(generic ?? options.brotliQuality ?? DEFAULT_BROTLI_QUALITY);
    assert(Number.isInteger(value) && value >= BROTLI_QUALITY_MIN && value <= BROTLI_QUALITY_MAX, `Brotli compressionLevel must be ${BROTLI_QUALITY_MIN}..${BROTLI_QUALITY_MAX}.`);
    return value;
  }
  if (generic != null || options.lzLevel != null || options.deflateLevel != null || options.brotliQuality != null) {
    assert(
      mode === "auto" || mode === "smart",
      "compressionLevel is only meaningful with compression: lz, compression: deflate, or compression: brotli."
    );
  }
  return null;
}

function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(input);
}

/** Portable LZSS-style compressor used by QuadQR payload compression.
 * Levels 1..9 only change encoder search effort. The wire format is unchanged,
 * so every level is decoded by the same legacy LZ decoder. Level 6 preserves
 * the historical QuadQR search depth and is the default.
 */
export function compressPayload(input, options = {}) {
  const bytes = asBytes(input);
  const requestedLevel = typeof options === "number"
    ? options
    : (options.level ?? options.compressionLevel ?? DEFAULT_LZ_LEVEL);
  const level = Number(requestedLevel);
  assert(Number.isInteger(level) && level >= LZ_LEVEL_MIN && level <= LZ_LEVEL_MAX, `LZ level must be ${LZ_LEVEL_MIN}..${LZ_LEVEL_MAX}.`);

  // Level 6 deliberately matches the original compressor's 32-candidate
  // history exactly. Higher levels walk deeper chains and add bounded lazy
  // lookahead, while lower levels reduce CPU work for faster encoding.
  const candidateDepth = [0, 4, 8, 12, 16, 24, 32, 48, 64, 96][level];
  const lazyDepth = [0, 0, 0, 0, 0, 0, 0, 12, 24, 48][level];
  const lazyGain = level >= 9 ? 0 : level >= 7 ? 1 : 2;
  const historyLimit = Math.max(candidateDepth, lazyDepth, 4);

  const out = [];
  const recent = new Map();
  let pos = 0;

  const keyAt = (i) => i + 2 < bytes.length ? ((bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]) : -1;
  const remember = (i) => {
    const key = keyAt(i);
    if (key < 0) return;
    let list = recent.get(key);
    if (!list) recent.set(key, list = []);
    list.push(i);
    while (list.length > historyLimit) list.shift();
    while (list.length && i - list[0] > 4095) list.shift();
  };

  const findBest = (position, maxCandidates) => {
    let bestLength = 0;
    let bestOffset = 0;
    const key = keyAt(position);
    const candidates = key >= 0 ? (recent.get(key) ?? []) : [];
    for (let ci = candidates.length - 1, checked = 0; ci >= 0 && checked < maxCandidates; ci--, checked++) {
      const candidate = candidates[ci];
      const offset = position - candidate;
      if (offset <= 0 || offset > 4095) continue;
      let length = 0;
      while (length < 18 && position + length < bytes.length && bytes[candidate + length] === bytes[position + length]) length++;
      if (length >= 3 && length > bestLength) {
        bestLength = length;
        bestOffset = offset;
        if (length === 18) break;
      }
    }
    return { length: bestLength, offset: bestOffset };
  };

  while (pos < bytes.length) {
    const flagIndex = out.length;
    out.push(0);
    let flags = 0;
    for (let token = 0; token < 8 && pos < bytes.length; token++) {
      let best = findBest(pos, candidateDepth);

      // Strong levels may emit one literal when the next byte begins a
      // meaningfully longer match. This changes encoder effort only.
      if (best.length >= 3 && lazyDepth > 0 && pos + 1 < bytes.length) {
        const next = findBest(pos + 1, lazyDepth);
        if (next.length > best.length + lazyGain) best = { length: 0, offset: 0 };
      }

      if (best.length >= 3) {
        flags |= (1 << token);
        const encoded = ((best.offset & 0x0fff) << 4) | ((best.length - 3) & 0x0f);
        out.push((encoded >>> 8) & 0xff, encoded & 0xff);
        for (let i = 0; i < best.length; i++) remember(pos + i);
        pos += best.length;
      } else {
        out.push(bytes[pos]);
        remember(pos);
        pos++;
      }
    }
    out[flagIndex] = flags;
  }
  return Uint8Array.from(out);
}

export function decompressPayload(input, expectedLength = null) {
  const bytes = asBytes(input);
  const out = [];
  let pos = 0;
  while (pos < bytes.length) {
    const flags = bytes[pos++];
    for (let token = 0; token < 8 && pos < bytes.length; token++) {
      if (flags & (1 << token)) {
        assert(pos + 1 < bytes.length, "Compressed payload is truncated.");
        const encoded = (bytes[pos++] << 8) | bytes[pos++];
        const offset = (encoded >>> 4) & 0x0fff;
        const length = (encoded & 0x0f) + 3;
        assert(offset > 0 && offset <= out.length, "Compressed payload has an invalid back-reference.");
        for (let i = 0; i < length; i++) out.push(out[out.length - offset]);
      } else {
        out.push(bytes[pos++]);
      }
      if (expectedLength != null && out.length >= expectedLength) break;
    }
  }
  if (expectedLength != null) assert(out.length === expectedLength, "Decompressed payload length mismatch.");
  return Uint8Array.from(out);
}

/** Raw RFC 1951 fixed-Huffman DEFLATE helper used by Compression 3.0. */
export function compressDeflatePayload(input, options = {}) {
  return compressDeflateBytes(asBytes(input), options);
}

/** Restore a raw DEFLATE payload produced by compressDeflatePayload(). */
export function decompressDeflatePayload(input, expectedLength = null) {
  return decompressDeflateBytes(asBytes(input), expectedLength);
}

/** Portable Brotli helper used by Compression 3.0 in browsers and Node.js. */
export function compressBrotliPayload(input, options = {}) {
  return compressBrotliBytes(asBytes(input), options);
}

/** Restore a Brotli payload produced by compressBrotliPayload(). */
export function decompressBrotliPayload(input, expectedLength = null) {
  return decompressBrotliBytes(asBytes(input), expectedLength);
}

function makeCompressionCandidate(payload, compression, compressionLevel = null) {
  if (compression === "none") return { body: payload, compression: "none", compressionLevel: null };
  if (compression === "lz") {
    return {
      body: compressPayload(payload, { level: compressionLevel ?? DEFAULT_LZ_LEVEL }),
      compression: "lz",
      compressionLevel: compressionLevel ?? DEFAULT_LZ_LEVEL
    };
  }
  if (compression === "deflate") {
    return {
      body: compressDeflatePayload(payload, { level: compressionLevel ?? DEFAULT_DEFLATE_LEVEL }),
      compression: "deflate",
      compressionLevel: compressionLevel ?? DEFAULT_DEFLATE_LEVEL
    };
  }
  if (compression === "brotli") {
    return {
      body: compressBrotliPayload(payload, { quality: compressionLevel ?? DEFAULT_BROTLI_QUALITY }),
      compression: "brotli",
      compressionLevel: compressionLevel ?? DEFAULT_BROTLI_QUALITY
    };
  }
  throw new Error(`Unsupported compression candidate ${compression}.`);
}

function candidateFinalPayloadLength(candidate, payload, options = {}) {
  const outerFixedBytes = Math.max(0, Number(options.outerFixedBytes ?? 0) || 0);
  if (options.envelopeAlreadyRequired) {
    const envelopeFixedBytes = Math.max(
      PAYLOAD_ENVELOPE_HEADER_BYTES,
      Number(options.envelopeFixedBytes ?? PAYLOAD_ENVELOPE_HEADER_BYTES) || PAYLOAD_ENVELOPE_HEADER_BYTES
    );
    return outerFixedBytes + envelopeFixedBytes + candidate.body.length;
  }
  const innerBytes = candidate.compression === "none"
    ? candidate.body.length
    : PAYLOAD_ENVELOPE_HEADER_BYTES + candidate.body.length;
  return outerFixedBytes + innerBytes;
}

function compareCompressionCandidates(a, b) {
  if (a.finalLength !== b.finalLength) return a.finalLength - b.finalLength;
  // Prefer the cheaper decoder when storage is exactly tied.
  const rank = { none: 0, lz: 1, deflate: 2, brotli: 3 };
  return (rank[a.compression] ?? 9) - (rank[b.compression] ?? 9);
}

function annotateCompressionCandidate(candidate, payload, options = {}) {
  return { ...candidate, finalLength: candidateFinalPayloadLength(candidate, payload, options) };
}

function safeChooseCompressionVersion(payloadLength, versionOptions = {}) {
  try {
    return chooseVersion(payloadLength, versionOptions);
  } catch {
    return null;
  }
}

function smartCompressionTarget(candidate, versionOptions = {}) {
  const requested = versionOptions.version ?? "auto";
  const minVersion = versionOptions.minVersion ?? MIN_VERSION;
  const maxVersion = versionOptions.maxVersion ?? MAX_VERSION;

  // A fixed version cannot become physically smaller, but Smart may still
  // spend extra CPU when stronger compression is needed to make that exact
  // requested version fit.
  if (requested !== "auto") {
    validateVersion(requested);
    const info = getVersionInfo(requested, versionOptions);
    if (candidate.finalLength <= info.capacityBytes) return null;
    const gapBytes = candidate.finalLength - info.capacityBytes;
    return {
      currentVersion: null,
      targetVersion: requested,
      targetCapacityBytes: info.capacityBytes,
      gapBytes,
      gapRatio: candidate.finalLength > 0 ? gapBytes / candidate.finalLength : 0
    };
  }

  const currentVersion = safeChooseCompressionVersion(candidate.finalLength, versionOptions);
  const targetVersion = currentVersion == null ? maxVersion : currentVersion - 1;
  if (targetVersion < minVersion) return null;
  const info = getVersionInfo(targetVersion, versionOptions);
  const gapBytes = Math.max(0, candidate.finalLength - info.capacityBytes);
  return {
    currentVersion,
    targetVersion,
    targetCapacityBytes: info.capacityBytes,
    gapBytes,
    gapRatio: candidate.finalLength > 0 ? gapBytes / candidate.finalLength : 0
  };
}

function compressionCandidates(payload, options = {}) {
  return [
    makeCompressionCandidate(payload, "none"),
    makeCompressionCandidate(payload, "lz", DEFAULT_LZ_LEVEL),
    makeCompressionCandidate(payload, "deflate", DEFAULT_DEFLATE_LEVEL),
    makeCompressionCandidate(payload, "brotli", 6)
  ].map((candidate) => annotateCompressionCandidate(candidate, payload, options));
}

function chooseBestCompressionCandidate(candidates) {
  return candidates.slice().sort(compareCompressionCandidates)[0];
}

function prepareSmartCompressedBody(payload, options = {}) {
  const versionOptions = options.versionOptions ?? {};
  const tried = [];
  const seen = new Set();
  const add = (compression, level = null) => {
    const key = `${compression}:${level ?? ""}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const candidate = annotateCompressionCandidate(makeCompressionCandidate(payload, compression, level), payload, options);
    tried.push(candidate);
    return candidate;
  };

  add("none");
  add("lz", DEFAULT_LZ_LEVEL);
  add("deflate", DEFAULT_DEFLATE_LEVEL);
  add("brotli", 6);
  let best = chooseBestCompressionCandidate(tried);
  const initialVersion = safeChooseCompressionVersion(best.finalLength, versionOptions);

  // Smart is intentionally CPU-heavy, but it still avoids maximum-quality
  // passes when the next smaller matrix is far outside realistic reach.
  let target = smartCompressionTarget(best, versionOptions);
  if (target && (target.gapRatio <= 0.30 || target.gapBytes <= 192)) {
    add("deflate", 8);
    add("brotli", 9);
    best = chooseBestCompressionCandidate(tried);
    target = smartCompressionTarget(best, versionOptions);

    // Maximum passes are reserved for a genuinely close version boundary, or
    // when the strong pass already crossed one boundary and another is close.
    if (target && (target.gapRatio <= 0.16 || target.gapBytes <= 96)) {
      add("deflate", 9);
      add("brotli", 11);
      best = chooseBestCompressionCandidate(tried);
    }
  }

  const finalVersion = safeChooseCompressionVersion(best.finalLength, versionOptions);
  return {
    ...best,
    compressionStrategy: "smart",
    smartCompression: {
      cpuHeavy: true,
      initialVersion,
      finalVersion,
      levelsTried: tried
        .filter((candidate) => candidate.compression === "deflate" || candidate.compression === "brotli")
        .map((candidate) => ({ algorithm: candidate.compression, level: candidate.compressionLevel, bytes: candidate.body.length, finalBytes: candidate.finalLength }))
    }
  };
}

function prepareCompressedBody(payload, compression = "none", options = {}) {
  const mode = normalizeCompressionMode(compression);
  if (mode === "none") return { ...makeCompressionCandidate(payload, "none"), compressionStrategy: "none" };
  if (mode === "lz") {
    const level = normalizeExplicitCompressionLevel(mode, options);
    return { ...makeCompressionCandidate(payload, "lz", level), compressionStrategy: "explicit" };
  }
  if (mode === "deflate") {
    const level = normalizeExplicitCompressionLevel(mode, options);
    return { ...makeCompressionCandidate(payload, "deflate", level), compressionStrategy: "explicit" };
  }
  if (mode === "brotli") {
    const level = normalizeExplicitCompressionLevel(mode, options);
    return { ...makeCompressionCandidate(payload, "brotli", level), compressionStrategy: "explicit" };
  }
  if (mode === "smart") return prepareSmartCompressedBody(payload, options);

  // Auto deliberately performs one balanced pass per codec. It is the fast
  // default; Smart is the opt-in mode that spends extra CPU near QR-version
  // boundaries.
  const best = chooseBestCompressionCandidate(compressionCandidates(payload, options));
  return { ...best, compressionStrategy: "auto" };
}


function normalizeSigningKeyId(value) {
  if (value == null || value === false || value === "") return new Uint8Array(0);
  const bytes = typeof value === "string" ? getTextEncoder().encode(value) : asBytes(value);
  assert(bytes.length <= 64, "Signing key ID must be 64 bytes or fewer.");
  return bytes;
}

function makePayloadEnvelopeHeader({ compression, flags = 0, originalLength, keyIdLength = 0, publicKeyLength = 0, signatureLength = 0, signatureAlgorithm = null, version = PAYLOAD_ENVELOPE_VERSION }) {
  assert(keyIdLength <= 0xff, "Signing key ID is too long.");
  assert(publicKeyLength <= 0xff, "Signing public key is too large.");
  assert(signatureLength <= 0xff, "Signature is too large.");
  const header = new Uint8Array(PAYLOAD_ENVELOPE_HEADER_BYTES);
  header.set(PAYLOAD_ENVELOPE_MAGIC, 0);
  header[4] = version;
  header[5] = flags & 0xff;
  header[6] = PAYLOAD_ENVELOPE_COMPRESSION_IDS[compression];
  header[7] = PAYLOAD_ENVELOPE_SIGNATURE_IDS[signatureAlgorithm ?? "none"] ?? 0;
  header.set(u32be(originalLength), 8);
  header[12] = keyIdLength;
  header[13] = publicKeyLength;
  header[14] = signatureLength;
  header[15] = 0;
  return header;
}

function isPayloadEnvelope(input) {
  const bytes = asBytes(input);
  return bytes.length >= PAYLOAD_ENVELOPE_HEADER_BYTES && PAYLOAD_ENVELOPE_MAGIC.every((value, index) => bytes[index] === value);
}

function packPreparedPayloadEnvelope(payload, prepared) {
  const flags = prepared.compression !== "none" ? PAYLOAD_ENVELOPE_COMPRESSED_FLAG : 0;
  const header = makePayloadEnvelopeHeader({
    compression: prepared.compression,
    flags,
    originalLength: payload.length
  });
  return concatBytes(header, prepared.body);
}

function packPayloadEnvelope(input, options = {}) {
  const payload = asBytes(input);
  const prepared = prepareCompressedBody(payload, options.compression ?? "none", options);
  return packPreparedPayloadEnvelope(payload, prepared);
}

function parsePayloadEnvelope(input) {
  const container = asBytes(input);
  assert(isPayloadEnvelope(container), "Payload extension envelope is not recognized.");
  const version = container[4];
  assert(version >= 1 && version <= PAYLOAD_ENVELOPE_VERSION, `Unsupported payload extension version ${version}.`);
  const flags = container[5];
  const compression = PAYLOAD_ENVELOPE_COMPRESSION_BY_ID[container[6]];
  assert(compression != null, `Unknown payload compression id ${container[6]}.`);
  const signatureAlgorithm = PAYLOAD_ENVELOPE_SIGNATURE_BY_ID[container[7]];
  const originalLength = readU32be(container, 8);
  const metadataLength = container[12];
  const publicKeyLength = container[13];
  const signatureLength = container[14];
  let offset = PAYLOAD_ENVELOPE_HEADER_BYTES;
  const endMetadata = offset + metadataLength;
  const endPublicKey = endMetadata + publicKeyLength;
  const endSignature = endPublicKey + signatureLength;
  assert(endSignature <= container.length, "Payload extension length fields exceed the envelope size.");
  const metadataBytes = container.slice(offset, endMetadata);
  const publicKey = container.slice(endMetadata, endPublicKey);
  const signature = container.slice(endPublicKey, endSignature);
  const stored = container.slice(endSignature);
  const payload = compression === "lz"
    ? decompressPayload(stored, originalLength)
    : compression === "deflate"
      ? decompressDeflatePayload(stored, originalLength)
      : compression === "brotli"
        ? decompressBrotliPayload(stored, originalLength)
        : stored;
  assert(payload.length === originalLength, "Payload length mismatch after extension decoding.");
  const signed = Boolean(flags & PAYLOAD_ENVELOPE_SIGNED_FLAG);
  const signedBytes = signed ? concatBytes(container.slice(0, PAYLOAD_ENVELOPE_HEADER_BYTES), metadataBytes, publicKey, stored) : null;

  // v1 used byte 12 for a human-readable signer label and always embedded
  // the public key. v2 uses the same field for a compact key ID and makes
  // public-key embedding optional.
  const legacySigner = version === 1 && metadataLength ? getTextDecoder().decode(metadataBytes) : null;
  const keyId = version >= 2 && metadataLength ? getTextDecoder().decode(metadataBytes) : null;
  const keyIdHex = version >= 2 && metadataLength
    ? Array.from(metadataBytes, (value) => value.toString(16).padStart(2, "0")).join("")
    : null;

  return {
    container,
    version,
    compression,
    compressed: compression !== "none",
    originalBytes: originalLength,
    storedBytes: stored.length,
    savedBytes: originalLength - stored.length,
    payload,
    signed,
    signer: legacySigner,
    keyId,
    keyIdHex,
    publicKey,
    hasEmbeddedPublicKey: publicKey.length > 0,
    signature,
    signatureAlgorithm,
    signedBytes,
    signatureVerified: signed ? null : undefined,
    signatureTrusted: signed ? null : undefined
  };
}

function subtleCrypto() {
  const subtle = globalThis.crypto?.subtle;
  assert(subtle, "Web Crypto is required for QuadQR signing.");
  return subtle;
}

async function normalizeEd25519PublicKey(key) {
  const subtle = subtleCrypto();
  if (typeof CryptoKey !== "undefined" && key instanceof CryptoKey) return key;
  if (key && typeof key === "object" && key.type === "public" && key.algorithm?.name === "Ed25519") return key;
  const bytes = asBytes(key);
  assert(bytes.length === 32, "Ed25519 public key must be a 32-byte raw key or CryptoKey.");
  return subtle.importKey("raw", bytes, { name: "Ed25519" }, true, ["verify"]);
}

async function normalizeEd25519PrivateKey(key) {
  const subtle = subtleCrypto();
  if (typeof CryptoKey !== "undefined" && key instanceof CryptoKey) return key;
  if (key && typeof key === "object" && key.type === "private" && key.algorithm?.name === "Ed25519") return key;
  const bytes = asBytes(key);
  return subtle.importKey("pkcs8", bytes, { name: "Ed25519" }, false, ["sign"]);
}

export async function deriveSigningKeyId(publicKey, bytes = 8) {
  const subtle = subtleCrypto();
  const normalized = await normalizeEd25519PublicKey(publicKey);
  const raw = new Uint8Array(await subtle.exportKey("raw", normalized));
  const digest = new Uint8Array(await subtle.digest("SHA-256", raw));
  const count = Math.max(4, Math.min(16, Math.floor(bytes)));
  return Array.from(digest.slice(0, count), (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function generateSigningKeyPair() {
  const subtle = subtleCrypto();
  const pair = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKeyBytes = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  const privateKeyPkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", pair.privateKey));
  const keyId = await deriveSigningKeyId(pair.publicKey);
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    privateKeyPkcs8,
    publicKeyBytes,
    keyId,
    algorithm: "Ed25519"
  };
}

async function packSignedPayloadEnvelope(input, options = {}) {
  const payload = asBytes(input);
  assert(options.privateKey, "privateKey is required to sign a QuadQR payload.");
  const subtle = subtleCrypto();
  const keyIdBytes = normalizeSigningKeyId(options.keyId);

  let publicKeyBytes = new Uint8Array(0);
  if (options.embedPublicKey) {
    assert(options.publicKey, "publicKey is required when embedPublicKey is enabled.");
    const publicKeyObject = await normalizeEd25519PublicKey(options.publicKey);
    publicKeyBytes = new Uint8Array(await subtle.exportKey("raw", publicKeyObject));
  }

  const signedEnvelopeFixedBytes = PAYLOAD_ENVELOPE_HEADER_BYTES + keyIdBytes.length + publicKeyBytes.length + 64;
  const prepared = prepareCompressedBody(payload, options.compression ?? "auto", {
    ...options,
    envelopeAlreadyRequired: true,
    envelopeFixedBytes: signedEnvelopeFixedBytes,
    versionOptions: options.versionOptions ?? options
  });

  const flags = PAYLOAD_ENVELOPE_SIGNED_FLAG |
    (prepared.compression !== "none" ? PAYLOAD_ENVELOPE_COMPRESSED_FLAG : 0) |
    (publicKeyBytes.length ? PAYLOAD_ENVELOPE_EMBEDDED_KEY_FLAG : 0);
  const header = makePayloadEnvelopeHeader({
    compression: prepared.compression,
    flags,
    originalLength: payload.length,
    keyIdLength: keyIdBytes.length,
    publicKeyLength: publicKeyBytes.length,
    signatureLength: 64,
    signatureAlgorithm: "Ed25519"
  });
  const signedBytes = concatBytes(header, keyIdBytes, publicKeyBytes, prepared.body);
  const privateKey = await normalizeEd25519PrivateKey(options.privateKey);
  const signature = new Uint8Array(await subtle.sign({ name: "Ed25519" }, privateKey, signedBytes));
  assert(signature.length === 64, "Unexpected Ed25519 signature length.");
  return {
    envelope: concatBytes(header, keyIdBytes, publicKeyBytes, signature, prepared.body),
    compression: prepared.compression,
    compressionLevel: prepared.compressionLevel ?? null,
    compressionStrategy: prepared.compressionStrategy ?? null,
    smartCompression: prepared.smartCompression ?? null
  };
}

function lookupTrustedSigningKey(trustedKeys, keyId) {
  if (!trustedKeys || !keyId) return null;
  if (trustedKeys instanceof Map) return trustedKeys.get(keyId) ?? null;
  if (typeof trustedKeys === "object") return trustedKeys[keyId] ?? null;
  return null;
}

async function verifyPayloadEnvelopeSignature(input, options = {}) {
  const parsed = input?.container && input?.signedBytes ? input : parsePayloadEnvelope(input);
  assert(parsed.signed, "QuadQR payload is not signed.");
  assert(parsed.signatureAlgorithm === "Ed25519", "Unsupported signature algorithm.");
  const subtle = subtleCrypto();

  let trusted = options.publicKey ?? options.trustedPublicKey ?? lookupTrustedSigningKey(options.trustedKeys, parsed.keyId);
  let trustSource = trusted ? "external" : null;

  // Legacy v1 symbols embedded the public key by default, so preserve their
  // historical self-verification behavior. v2+ require explicit opt-in.
  if (!trusted && parsed.publicKey.length && (parsed.version === 1 || options.allowEmbeddedKey === true)) {
    trusted = parsed.publicKey;
    trustSource = "embedded";
  }

  assert(
    trusted,
    parsed.keyId
      ? `A trusted Ed25519 public key is required to verify signing key ID "${parsed.keyId}".`
      : "A trusted Ed25519 public key is required to verify this signed QuadQR."
  );

  const publicKey = await normalizeEd25519PublicKey(trusted);
  if (trustSource === "external" && parsed.publicKey.length) {
    const trustedBytes = new Uint8Array(await subtle.exportKey("raw", publicKey));
    assert(
      trustedBytes.length === parsed.publicKey.length && trustedBytes.every((value, index) => value === parsed.publicKey[index]),
      "Embedded signing key does not match the trusted public key."
    );
  }

  const verified = await subtle.verify({ name: "Ed25519" }, publicKey, parsed.signature, parsed.signedBytes);
  return {
    verified,
    trusted: verified && trustSource === "external",
    trustSource,
    keyId: parsed.keyId ?? null
  };
}

function prepareOptionalCompressedPayload(input, compression = "none", options = {}) {
  const payload = asBytes(input);
  const mode = normalizeCompressionMode(compression);
  if (mode === "none") {
    return { payload, extended: false, compression: "none", compressionLevel: null, compressionStrategy: "none", smartCompression: null };
  }
  const prepared = prepareCompressedBody(payload, mode, { ...options, versionOptions: options.versionOptions ?? options });
  // Auto and Smart are truly zero-overhead when compression does not help.
  if ((mode === "auto" || mode === "smart") && prepared.compression === "none") {
    return {
      payload,
      extended: false,
      compression: "none",
      compressionLevel: null,
      compressionStrategy: prepared.compressionStrategy,
      smartCompression: prepared.smartCompression ?? null
    };
  }
  return {
    payload: packPreparedPayloadEnvelope(payload, prepared),
    extended: true,
    compression: prepared.compression,
    compressionLevel: prepared.compressionLevel ?? null,
    compressionStrategy: prepared.compressionStrategy ?? mode,
    smartCompression: prepared.smartCompression ?? null
  };
}

let CRC_TABLE = null;
let CRC32_ACCELERATOR = null;

/**
 * Install or clear an optional synchronous CRC-32 accelerator.
 * QuadQR's prebuilt WASM helper uses this hook after initWasm() succeeds.
 * The JavaScript implementation remains the default and fallback.
 */
export function installCrc32Accelerator(accelerator = null) {
  assert(
    accelerator == null || typeof accelerator === "function",
    "CRC-32 accelerator must be a function or null."
  );
  CRC32_ACCELERATOR = accelerator;
}

function getCrcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    CRC_TABLE[n] = c >>> 0;
  }
  return CRC_TABLE;
}

export function crc32(bytes) {
  if (CRC32_ACCELERATOR) return CRC32_ACCELERATOR(bytes) >>> 0;
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function bytesToCells(bytes, cellEncoding = CELL_ENCODINGS.RGBW) {
  const encoding = normalizeCellEncoding(cellEncoding);
  if (encoding === CELL_ENCODINGS.TRIANGLE16) {
    const out = new Array(bytes.length * TRIANGLE16_CELLS_PER_BYTE);
    let cursor = 0;
    for (const byte of bytes) {
      out[cursor++] = (byte >>> 4) & 0x0f;
      out[cursor++] = byte & 0x0f;
    }
    return out;
  }

  const out = new Array(bytes.length * RGBW_CELLS_PER_BYTE);
  let cursor = 0;
  for (const byte of bytes) {
    out[cursor++] = (byte >>> 6) & 0b11;
    out[cursor++] = (byte >>> 4) & 0b11;
    out[cursor++] = (byte >>> 2) & 0b11;
    out[cursor++] = byte & 0b11;
  }
  return out;
}

function bytesToProtectedHeaderCells(bytes, cellEncoding = CELL_ENCODINGS.RGBW) {
  const base = bytesToCells(bytes, CELL_ENCODINGS.RGBW);
  if (normalizeCellEncoding(cellEncoding) !== CELL_ENCODINGS.TRIANGLE16) return base;
  // Triangle16 deliberately keeps the protected bootstrap/header as solid-color
  // modules. This costs a few cells but makes mode detection and damaged-camera
  // recovery substantially more reliable.
  return base.map(solidTriangleCell);
}

function cellsToBytes(cells, byteCount, cellEncoding = CELL_ENCODINGS.RGBW) {
  const encoding = normalizeCellEncoding(cellEncoding);
  const cellsPerByte = cellsPerByteForEncoding(encoding);
  const count = byteCount ?? Math.floor(cells.length / cellsPerByte);
  assert(cells.length >= count * cellsPerByte, "Not enough data cells to rebuild bytes.");
  const out = new Uint8Array(count);

  if (encoding === CELL_ENCODINGS.TRIANGLE16) {
    for (let i = 0; i < count; i++) {
      const offset = i * TRIANGLE16_CELLS_PER_BYTE;
      const a = cells[offset];
      const b = cells[offset + 1];
      assert(Number.isInteger(a) && a >= 0 && a <= 15, "Invalid Triangle16 data cell.");
      assert(Number.isInteger(b) && b >= 0 && b <= 15, "Invalid Triangle16 data cell.");
      out[i] = (a << 4) | b;
    }
    return out;
  }

  for (let i = 0; i < count; i++) {
    const offset = i * RGBW_CELLS_PER_BYTE;
    const a = cells[offset];
    const b = cells[offset + 1];
    const c = cells[offset + 2];
    const d = cells[offset + 3];
    for (const value of [a, b, c, d]) {
      assert(Number.isInteger(value) && value >= 0 && value <= 3, "Invalid RGBW data cell.");
    }
    out[i] = (a << 6) | (b << 4) | (c << 2) | d;
  }
  return out;
}

function protectedHeaderCellsToBytes(cells, byteCount, cellEncoding = CELL_ENCODINGS.RGBW) {
  if (normalizeCellEncoding(cellEncoding) !== CELL_ENCODINGS.TRIANGLE16) {
    return cellsToBytes(cells, byteCount, CELL_ENCODINGS.RGBW);
  }
  const colors = cells.map((value) => {
    const pair = unpackTriangleCell(value);
    if (pair.first !== pair.second) throw new Error("Triangle16 protected header lost solid-color integrity.");
    return pair.first;
  });
  return cellsToBytes(colors, byteCount, CELL_ENCODINGS.RGBW);
}

function flagsFor(text, eccLevel, secure = false, extended = false, signed = false, cellEncoding = CELL_ENCODINGS.RGBW) {
  return (text ? TEXT_FLAG : 0) |
    (secure ? SECURE_FLAG : 0) |
    (extended ? EXTENDED_PAYLOAD_FLAG : 0) |
    (signed ? SIGNED_FLAG : 0) |
    (normalizeCellEncoding(cellEncoding) === CELL_ENCODINGS.TRIANGLE16 ? TRIANGLE16_FLAG : 0) |
    ((ECC_LEVELS[eccLevel].id << ECC_SHIFT) & ECC_MASK);
}

function cellEncodingFromFlags(flags) {
  return (flags & TRIANGLE16_FLAG) !== 0 ? CELL_ENCODINGS.TRIANGLE16 : CELL_ENCODINGS.RGBW;
}

function eccFromFlags(flags) {
  const id = (flags & ECC_MASK) >> ECC_SHIFT;
  const name = ECC_BY_ID[id];
  if (!name) throw new Error(`Unknown ECC profile id ${id}.`);
  return name;
}

function getHeaderPlan(version) {
  if (version === COMPACT_VERSION) {
    return {
      compact: true,
      headerBytes: COMPACT_HEADER_BYTES,
      paritySymbols: COMPACT_HEADER_RS_PARITY,
      codewordBytes: COMPACT_HEADER_CODEWORD_BYTES,
      codewordCells: COMPACT_HEADER_CODEWORD_CELLS,
      correctableSymbols: COMPACT_HEADER_RS_PARITY / 2
    };
  }
  return {
    compact: false,
    headerBytes: HEADER_BYTES,
    paritySymbols: HEADER_RS_PARITY,
    codewordBytes: HEADER_CODEWORD_BYTES,
    codewordCells: HEADER_CODEWORD_CELLS,
    correctableSymbols: HEADER_RS_PARITY / 2
  };
}

function getEffectiveEcc(version, eccLevel) {
  const normalized = normalizeEccLevel(eccLevel);
  return version === COMPACT_VERSION ? COMPACT_ECC_LEVELS[normalized] : ECC_LEVELS[normalized];
}

function makeHeader(payloadLength, flags, version, formatVersion = FORMAT_VERSION) {
  assert(payloadLength >= 0 && payloadLength <= 0xffffffff, "Payload is too large.");

  if (version === COMPACT_VERSION) {
    assert(payloadLength <= 0xff, "Version 1 compact header supports payloads up to 255 bytes.");
    const header = new Uint8Array(COMPACT_HEADER_BYTES);
    header[0] = COMPACT_HEADER_MAGIC;
    header[1] = flags & 0xff;
    header[2] = payloadLength & 0xff;
    header[3] = (payloadLength ^ 0xff) & 0xff;
    return header;
  }

  const header = new Uint8Array(HEADER_BYTES);
  header.set(MAGIC, 0);
  header[4] = formatVersion;
  header[5] = flags & 0xff;
  header.set(u32be(payloadLength), 6);
  return header;
}

function magicMatches(header) {
  return MAGIC.every((value, index) => header[index] === value);
}

function parseHeader(header, version) {
  if (version === COMPACT_VERSION) {
    if (
      header.length !== COMPACT_HEADER_BYTES ||
      header[0] !== COMPACT_HEADER_MAGIC ||
      header[3] !== ((header[2] ^ 0xff) & 0xff)
    ) {
      throw new Error("QuadQR compact header mismatch.");
    }
    return { flags: header[1], payloadLength: header[2] };
  }

  const formatVersion = header[4];
  if (!magicMatches(header) || (formatVersion !== FORMAT_VERSION && formatVersion !== LEGACY_FORMAT_VERSION)) {
    throw new Error("QuadQR magic/version mismatch.");
  }
  return { formatVersion, flags: header[5], payloadLength: readU32be(header, 6) };
}

function alignmentProfileForFormat(formatVersion = FORMAT_VERSION) {
  return formatVersion === LEGACY_FORMAT_VERSION
    ? ALIGNMENT_PROFILE_LEGACY_3
    : ALIGNMENT_PROFILE_STANDARD_5;
}

function createLayout(version, options = {}) {
  validateVersion(version);
  const alignmentProfile = options.alignmentProfile ?? alignmentProfileForFormat(options.formatVersion ?? FORMAT_VERSION);
  const size = sizeForVersion(version);
  const matrix = make2D(size, CELL.WHITE);
  const reserved = make2D(size, false);
  const calibration = { red: [], green: [], blue: [], black: [], white: [] };

  function reserveAndSet(row, col, value, calibrationKey = null) {
    if (row < 0 || col < 0 || row >= size || col >= size) return;
    reserved[row][col] = true;
    matrix[row][col] = value;
    if (calibrationKey) calibration[calibrationKey].push([row, col]);
  }

  function drawFinder(top, left) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = top + r;
        const cc = left + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        if (r === -1 || c === -1 || r === 7 || c === 7) {
          reserveAndSet(rr, cc, CELL.WHITE, "white");
        }
      }
    }

    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const outer = r === 0 || c === 0 || r === 6 || c === 6;
        const center = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        const black = outer || center;
        reserveAndSet(top + r, left + c, black ? CELL.BLACK : CELL.WHITE, black ? "black" : "white");
      }
    }
  }

  function drawAlignmentPattern(definition) {
    const { row: centerRow, col: centerCol, separator = false } = definition;
    const radius = alignmentPatternRadius(definition);

    if (separator) {
      const separatorRadius = radius + 1;
      for (let r = -separatorRadius; r <= separatorRadius; r++) {
        for (let c = -separatorRadius; c <= separatorRadius; c++) {
          if (Math.abs(r) === separatorRadius || Math.abs(c) === separatorRadius) {
            reserveAndSet(centerRow + r, centerCol + c, CELL.WHITE, "white");
          }
        }
      }
    }

    for (let r = -radius; r <= radius; r++) {
      for (let c = -radius; c <= radius; c++) {
        const black = alignmentPatternIsBlack(definition, r, c);
        reserveAndSet(
          centerRow + r,
          centerCol + c,
          black ? CELL.BLACK : CELL.WHITE,
          black ? "black" : "white"
        );
      }
    }

    return {
      row: centerRow,
      col: centerCol,
      size: definition.size,
      primary: Boolean(definition.primary),
      center: [centerCol + 0.5, centerRow + 0.5],
      bootstrap: Boolean(definition.bootstrap),
      separator: Boolean(separator)
    };
  }

  function isAreaFree(row0, col0, height, width) {
    if (row0 < 0 || col0 < 0 || row0 + height > size || col0 + width > size) return false;
    for (let r = row0; r < row0 + height; r++) {
      for (let c = col0; c < col0 + width; c++) {
        if (reserved[r][c]) return false;
      }
    }
    return true;
  }

  function findCalibrationStripOrigin() {
    const preferred = { row: size - 6, col: size - 13 };
    if (isAreaFree(preferred.row, preferred.col, 2, 6)) return preferred;

    // Keep the swatches away from the three large finders and timing axes, but
    // allow their location to move when a version's alignment grid occupies
    // the old bottom-right calibration area.
    for (let row = size - 8; row >= 8; row--) {
      for (let col = size - 8; col >= 8; col--) {
        if (isAreaFree(row, col, 2, 6)) return { row, col };
      }
    }

    throw new Error(`Unable to reserve QuadQR calibration strip for version ${version}.`);
  }

  function drawCalibrationStrip() {
    const origin = findCalibrationStripOrigin();
    const entries = [
      { key: "red", cell: CELL.RED, offset: 0 },
      { key: "green", cell: CELL.GREEN, offset: 2 },
      { key: "blue", cell: CELL.BLUE, offset: 4 }
    ];

    for (const entry of entries) {
      for (const row of [origin.row, origin.row + 1]) {
        for (let dc = 0; dc < 2; dc++) {
          reserveAndSet(row, origin.col + entry.offset + dc, entry.cell, entry.key);
        }
      }
    }
    return { top: origin.row, left: origin.col, width: 6, height: 2 };
  }

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  for (let col = 8; col < size - 8; col++) {
    reserveAndSet(6, col, col % 2 === 0 ? CELL.BLACK : CELL.WHITE);
  }
  for (let row = 8; row < size - 8; row++) {
    reserveAndSet(row, 6, row % 2 === 0 ? CELL.BLACK : CELL.WHITE);
  }

  const alignments = alignmentPatternCentersForVersion(version, { profile: alignmentProfile }).map(drawAlignmentPattern);
  const alignment = alignments[alignments.length - 1];
  const calibrationStrip = drawCalibrationStrip();

  const dataPositions = [];
  let upward = true;
  let col = size - 1;
  while (col >= 0) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let dx = 0; dx < 2; dx++) {
        const c = col - dx;
        if (c < 0) continue;
        if (!reserved[row][c]) dataPositions.push([row, c]);
      }
    }
    upward = !upward;
    col -= 2;
  }

  return {
    version,
    size,
    alignmentProfile,
    matrix,
    reserved,
    dataPositions,
    calibration,
    calibrationStrip,
    alignment,
    alignments
  };
}

function maskValue(row, col, maskId) {
  switch (maskId) {
    case 0: return (row + col) & 3;
    case 1: return (2 * row + col) & 3;
    case 2: return (row + 2 * col) & 3;
    case 3: return (row * col + row + col) & 3;
    default: throw new Error(`Unknown mask ${maskId}.`);
  }
}

function makePaddingCells(count, seed, cellEncoding = CELL_ENCODINGS.RGBW) {
  const encoding = normalizeCellEncoding(cellEncoding);
  let state = (seed >>> 0) || 0x6d2b79f5;
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = encoding === CELL_ENCODINGS.TRIANGLE16 ? (state & 0x0f) : (state & 3);
  }
  return out;
}

function triangleMaskValue(row, col, maskId) {
  const first = maskValue(row, col, maskId);
  const second = maskValue(row + 1, col + 2, (maskId + 1) & 3);
  return packTriangleCell(first, second);
}

function applyCellMask(value, row, col, maskId, cellEncoding, protectedHeader = false) {
  if (cellEncoding !== CELL_ENCODINGS.TRIANGLE16) return value ^ maskValue(row, col, maskId);
  if (protectedHeader) {
    const pair = unpackTriangleCell(value);
    if (pair.first !== pair.second) throw new Error("Triangle16 protected header must use solid-color cells.");
    return solidTriangleCell(pair.first ^ maskValue(row, col, maskId));
  }
  return value ^ triangleMaskValue(row, col, maskId);
}

const SPECTRAL_PERMUTATION_CACHE = new Map();

function spectralPermutation(length, version) {
  const cacheKey = `${version}:${length}`;
  const cached = SPECTRAL_PERMUTATION_CACHE.get(cacheKey);
  if (cached) return cached;

  const permutation = Array.from({ length }, (_, index) => index);
  let state = (0x9e3779b9 ^ Math.imul(version + 1, 0x85ebca6b) ^ Math.imul(length + 17, 0xc2b2ae35)) >>> 0;

  function nextRandom() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  }

  // Deterministic Fisher-Yates shuffle. The mapping costs no cells and makes
  // neighboring logical symbols land at widely separated physical modules.
  for (let index = length - 1; index > 0; index--) {
    const swapIndex = nextRandom() % (index + 1);
    [permutation[index], permutation[swapIndex]] = [permutation[swapIndex], permutation[index]];
  }
  SPECTRAL_PERMUTATION_CACHE.set(cacheKey, permutation);
  return permutation;
}

function applyData(
  layout,
  rawCells,
  maskId,
  spectralInterleaving = true,
  cellEncoding = CELL_ENCODINGS.RGBW,
  protectedHeaderCells = getHeaderPlan(layout.version).codewordCells
) {
  const encoding = normalizeCellEncoding(cellEncoding);
  const matrix = cloneMatrix(layout.matrix);
  const permutation = spectralInterleaving
    ? spectralPermutation(layout.dataPositions.length, layout.version)
    : null;

  for (let logicalIndex = 0; logicalIndex < layout.dataPositions.length; logicalIndex++) {
    const physicalIndex = permutation ? permutation[logicalIndex] : logicalIndex;
    const [row, col] = layout.dataPositions[physicalIndex];
    matrix[row][col] = applyCellMask(
      rawCells[logicalIndex],
      row,
      col,
      maskId,
      encoding,
      encoding === CELL_ENCODINGS.TRIANGLE16 && logicalIndex < protectedHeaderCells
    );
  }
  return matrix;
}

function dataCellPenalty(matrix, reserved, cellEncoding = CELL_ENCODINGS.RGBW) {
  const encoding = normalizeCellEncoding(cellEncoding);
  const size = matrix.length;
  let penalty = 0;
  const colorCounts = [0, 0, 0, 0];
  let colorCount = 0;

  const symbolAt = (r, c) => matrix[r][c];
  const addColors = (value) => {
    if (encoding === CELL_ENCODINGS.TRIANGLE16) {
      const pair = unpackTriangleCell(value);
      colorCounts[pair.first]++;
      colorCounts[pair.second]++;
      colorCount += 2;
    } else {
      colorCounts[value]++;
      colorCount++;
    }
  };

  for (let r = 0; r < size; r++) {
    let previous = null;
    let run = 0;
    for (let c = 0; c < size; c++) {
      if (reserved[r][c]) {
        previous = null;
        run = 0;
        continue;
      }
      const value = symbolAt(r, c);
      addColors(value);
      if (value === previous) {
        run++;
        if (run >= 4) penalty += 2;
      } else {
        previous = value;
        run = 1;
      }
    }
  }

  for (let c = 0; c < size; c++) {
    let previous = null;
    let run = 0;
    for (let r = 0; r < size; r++) {
      if (reserved[r][c]) {
        previous = null;
        run = 0;
        continue;
      }
      const value = symbolAt(r, c);
      if (value === previous) {
        run++;
        if (run >= 4) penalty += 2;
      } else {
        previous = value;
        run = 1;
      }
    }
  }

  if (colorCount > 0) {
    const ideal = colorCount / 4;
    penalty += colorCounts.reduce((sum, count) => sum + Math.abs(count - ideal), 0) / 2;
  }
  return penalty;
}

function interleaveBlocks(blocks) {
  const maxLength = Math.max(...blocks.map((block) => block.length), 0);
  const out = [];
  for (let index = 0; index < maxLength; index++) {
    for (const block of blocks) {
      if (index < block.length) out.push(block[index]);
    }
  }
  return out;
}

function deinterleaveBlocks(stream, blockLengths) {
  const blocks = blockLengths.map((length) => new Array(length));
  let cursor = 0;
  const maxLength = Math.max(...blockLengths, 0);
  for (let index = 0; index < maxLength; index++) {
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
      if (index < blockLengths[blockIndex]) blocks[blockIndex][index] = stream[cursor++];
    }
  }
  assert(cursor === stream.length, "Interleaved RS symbol length mismatch.");
  return blocks;
}

function getBodyRsPlan(payloadLength, eccLevel, version = 2, cellEncoding = CELL_ENCODINGS.RGBW) {
  const ecc = getEffectiveEcc(version, eccLevel);
  const bodyByteCount = payloadLength + CRC_BYTES;
  const dataSymbols = bodyByteCount;
  const maxDataPerBlock = MAX_CODEWORD_SYMBOLS - ecc.paritySymbols;
  const dataBlockLengths = [];
  let remaining = dataSymbols;
  while (remaining > 0) {
    const length = Math.min(maxDataPerBlock, remaining);
    dataBlockLengths.push(length);
    remaining -= length;
  }
  const codewordBlockLengths = dataBlockLengths.map((length) => length + ecc.paritySymbols);
  const encodedSymbols = codewordBlockLengths.reduce((sum, value) => sum + value, 0);
  return {
    bodyByteCount,
    dataSymbols,
    paritySymbols: ecc.paritySymbols,
    correctableSymbolsPerBlock: ecc.correctableSymbolsPerBlock,
    dataBlockLengths,
    codewordBlockLengths,
    encodedSymbols,
    encodedCells: encodedSymbols * cellsPerByteForEncoding(cellEncoding)
  };
}

function streamCellCount(payloadLength, eccLevel, version, cellEncoding = CELL_ENCODINGS.RGBW) {
  return getHeaderPlan(version).codewordCells +
    getBodyRsPlan(payloadLength, eccLevel, version, cellEncoding).encodedCells;
}

function streamFitsLayout(layout, eccLevel, payloadLength, version, cellEncoding = CELL_ENCODINGS.RGBW) {
  return streamCellCount(payloadLength, eccLevel, version, cellEncoding) <= layout.dataPositions.length;
}

function getCapacityForLayout(layout, eccLevel, version, cellEncoding = CELL_ENCODINGS.RGBW) {
  const encoding = normalizeCellEncoding(cellEncoding);
  if (!streamFitsLayout(layout, eccLevel, 0, version, encoding)) return 0;
  let low = 0;
  let high = Math.floor(layout.dataPositions.length / cellsPerByteForEncoding(encoding));
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (streamFitsLayout(layout, eccLevel, mid, version, encoding)) low = mid;
    else high = mid - 1;
  }
  return low;
}

export function getVersionInfo(version, options = {}) {
  validateVersion(version);
  const eccLevel = normalizeEccLevel(options.ecc ?? DEFAULT_ECC_LEVEL);
  const cellEncoding = cellEncodingFromOptions(options);
  const layout = createLayout(version);
  const headerPlan = getHeaderPlan(version);
  const effectiveEcc = getEffectiveEcc(version, eccLevel);
  return {
    version,
    formatVersion: FORMAT_VERSION,
    eccLevel,
    size: layout.size,
    dataCells: layout.dataPositions.length,
    theoreticalBits: layout.dataPositions.length * (cellEncoding === CELL_ENCODINGS.TRIANGLE16 ? 4 : 2),
    capacityBytes: getCapacityForLayout(layout, eccLevel, version, cellEncoding),
    headerCells: headerPlan.codewordCells,
    headerBytes: headerPlan.headerBytes,
    headerParitySymbols: headerPlan.paritySymbols,
    bodyParitySymbols: effectiveEcc.paritySymbols,
    correctableHeaderSymbols: headerPlan.correctableSymbols,
    correctableSymbolsPerBlock: effectiveEcc.correctableSymbolsPerBlock,
    compactSmallSymbol: version === COMPACT_VERSION,
    calibrationCells: 12,
    hasAlignmentMarker: true,
    alignmentPatterns: layout.alignments.length,
    alignmentCenters: layout.alignments.map(({ row, col }) => [row, col]),
    bitsPerDataCell: cellEncoding === CELL_ENCODINGS.TRIANGLE16 ? 4 : 2,
    highDensity: cellEncoding === CELL_ENCODINGS.TRIANGLE16,
    cellEncoding,
    colors: 4,
    statesPerDataCell: cellEncoding === CELL_ENCODINGS.TRIANGLE16 ? 16 : 4,
    spectralInterleaving: true,
    confidenceAwareEcc: true
  };
}

function chooseVersion(payloadLength, options = {}) {
  const requested = options.version ?? "auto";
  const minVersion = options.minVersion ?? MIN_VERSION;
  const maxVersion = options.maxVersion ?? MAX_VERSION;
  const ecc = normalizeEccLevel(options.ecc ?? DEFAULT_ECC_LEVEL);
  const cellEncoding = cellEncodingFromOptions(options);

  validateVersion(minVersion);
  validateVersion(maxVersion);
  assert(minVersion <= maxVersion, "minVersion must be <= maxVersion.");

  if (requested !== "auto") {
    validateVersion(requested);
    assert(requested >= minVersion && requested <= maxVersion, "Requested version is outside selected bounds.");
    const info = getVersionInfo(requested, { ecc, cellEncoding });
    const layout = createLayout(requested);
    assert(
      payloadLength <= info.capacityBytes && streamFitsLayout(layout, ecc, payloadLength, requested, cellEncoding),
      `Payload does not fit version ${requested} with ${ecc} ECC. Maximum is ${info.capacityBytes} bytes.`
    );
    return requested;
  }

  for (let version = minVersion; version <= maxVersion; version++) {
    const layout = createLayout(version);
    if (streamFitsLayout(layout, ecc, payloadLength, version, cellEncoding)) return version;
  }
  throw new Error(`Payload is too large for versions ${minVersion}..${maxVersion}.`);
}

function encodeProtectedHeader(header, version, cellEncoding = CELL_ENCODINGS.RGBW) {
  const plan = getHeaderPlan(version);
  const codeword = rsEncode(Array.from(header), plan.paritySymbols);
  assert(codeword.length === plan.codewordBytes, "Header RS symbol calculation mismatch.");
  return bytesToProtectedHeaderCells(codeword, cellEncoding);
}

function encodeProtectedBody(bodyBytes, eccLevel, version, cellEncoding = CELL_ENCODINGS.RGBW) {
  const plan = getBodyRsPlan(bodyBytes.length - CRC_BYTES, eccLevel, version, cellEncoding);
  assert(bodyBytes.length === plan.dataSymbols, "Body RS symbol calculation mismatch.");

  const blocks = [];
  let offset = 0;
  for (const length of plan.dataBlockLengths) {
    blocks.push(rsEncode(Array.from(bodyBytes.slice(offset, offset + length)), plan.paritySymbols));
    offset += length;
  }
  return { cells: bytesToCells(interleaveBlocks(blocks), cellEncoding), plan };
}

function finalizeMatrix(layout, rawCells, meta) {
  let bestMaskId = 0;
  let bestMatrix = null;
  let bestPenalty = Infinity;

  const cellEncoding = normalizeCellEncoding(meta.cellEncoding ?? CELL_ENCODINGS.RGBW);
  for (let maskId = 0; maskId < 4; maskId++) {
    const candidate = applyData(layout, rawCells, maskId, true, cellEncoding);
    const penalty = dataCellPenalty(candidate, layout.reserved, cellEncoding);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMaskId = maskId;
      bestMatrix = candidate;
    }
  }

  const info = getVersionInfo(meta.version, { ecc: meta.eccLevel, cellEncoding });
  return {
    format: "QuadQR",
    formatVersion: FORMAT_VERSION,
    version: meta.version,
    size: layout.size,
    matrix: bestMatrix,
    maskId: bestMaskId,
    payloadBytes: meta.payloadBytes,
    sourcePayloadBytes: meta.sourcePayloadBytes ?? meta.payloadBytes,
    secure: Boolean(meta.secure),
    compressed: meta.compression != null && meta.compression !== "none",
    compression: meta.compression ?? "none",
    compressionLevel: meta.compressionLevel ?? null,
    compressionStrategy: meta.compressionStrategy ?? null,
    smartCompression: meta.smartCompression ?? null,
    signed: Boolean(meta.signed),
    signingKeyId: meta.signingKeyId ?? null,
    hasEmbeddedPublicKey: Boolean(meta.hasEmbeddedPublicKey),
    requiresDecryption: Boolean(meta.secure),
    security: meta.security ?? null,
    meaningfulCells: meta.meaningfulCells,
    dataCells: layout.dataPositions.length,
    capacityBytes: info.capacityBytes,
    alignmentPatterns: layout.alignments.length,
    utilization: meta.meaningfulCells / layout.dataPositions.length,
    bitsPerDataCell: cellEncoding === CELL_ENCODINGS.TRIANGLE16 ? 4 : 2,
    highDensity: cellEncoding === CELL_ENCODINGS.TRIANGLE16,
    cellEncoding,
    statesPerDataCell: cellEncoding === CELL_ENCODINGS.TRIANGLE16 ? 16 : 4,
    eccLevel: meta.eccLevel,
    eccParitySymbols: meta.eccParitySymbols,
    eccBlocks: meta.eccBlocks,
    correctableSymbolsPerBlock: meta.correctableSymbolsPerBlock,
    spectralInterleaving: true,
    confidenceAwareEcc: true,
    crc32: meta.crc >>> 0
  };
}

function encodePreparedBytes(input, options = {}) {
  if (options.formatVersion != null && options.formatVersion !== FORMAT_VERSION) {
    throw new Error(`Only QuadQR format version ${FORMAT_VERSION} is supported.`);
  }

  const payload = asBytes(input);
  const eccLevel = normalizeEccLevel(options.ecc ?? DEFAULT_ECC_LEVEL);
  const secure = Boolean(options.secure);
  const extended = Boolean(options.extended);
  const signed = Boolean(options.signed);
  const cellEncoding = cellEncodingFromOptions(options);
  const flags = flagsFor(Boolean(options.text), eccLevel, secure, extended, signed, cellEncoding);
  const version = chooseVersion(payload.length, { ...options, ecc: eccLevel, cellEncoding });
  const layout = createLayout(version);
  const header = makeHeader(payload.length, flags, version);
  const crc = crc32(concatBytes(header, payload));
  const headerCells = encodeProtectedHeader(header, version, cellEncoding);
  const bodyEncoded = encodeProtectedBody(concatBytes(payload, u32be(crc)), eccLevel, version, cellEncoding);
  const meaningfulCells = headerCells.concat(bodyEncoded.cells);
  assert(meaningfulCells.length <= layout.dataPositions.length, "Internal QuadQR capacity calculation error.");

  const padding = makePaddingCells(
    layout.dataPositions.length - meaningfulCells.length,
    crc ^ payload.length ^ (version << 24) ^ (ECC_LEVELS[eccLevel].id << 16),
    cellEncoding
  );

  return finalizeMatrix(layout, meaningfulCells.concat(padding), {
    version,
    cellEncoding,
    payloadBytes: payload.length,
    sourcePayloadBytes: options.sourcePayloadBytes ?? payload.length,
    secure,
    extended,
    signed,
    compression: options.compressionMetadata ?? "none",
    compressionLevel: options.compressionLevelMetadata ?? null,
    compressionStrategy: options.compressionStrategyMetadata ?? null,
    smartCompression: options.smartCompressionMetadata ?? null,
    signingKeyId: options.signingKeyId ?? null,
    hasEmbeddedPublicKey: Boolean(options.hasEmbeddedPublicKey),
    security: options.securityMetadata ?? null,
    meaningfulCells: meaningfulCells.length,
    eccLevel,
    eccParitySymbols: bodyEncoded.plan.paritySymbols,
    eccBlocks: bodyEncoded.plan.dataBlockLengths.length,
    correctableSymbolsPerBlock: bodyEncoded.plan.correctableSymbolsPerBlock,
    crc
  });
}

export function encodeText(text, options = {}) {
  assert(typeof text === "string", "encodeText expects a string.");
  const source = getTextEncoder().encode(text);
  const prepared = prepareOptionalCompressedPayload(source, options.compression ?? "none", options);
  return encodePreparedBytes(prepared.payload, {
    ...options,
    text: true,
    extended: prepared.extended,
    sourcePayloadBytes: source.length,
    compressionMetadata: prepared.compression,
    compressionLevelMetadata: prepared.compressionLevel,
    compressionStrategyMetadata: prepared.compressionStrategy,
    smartCompressionMetadata: prepared.smartCompression
  });
}

export function encodeBytes(input, options = {}) {
  const source = asBytes(input);
  const prepared = prepareOptionalCompressedPayload(source, options.compression ?? "none", options);
  return encodePreparedBytes(prepared.payload, {
    ...options,
    text: Boolean(options.text),
    extended: prepared.extended,
    sourcePayloadBytes: source.length,
    compressionMetadata: prepared.compression,
    compressionLevelMetadata: prepared.compressionLevel,
    compressionStrategyMetadata: prepared.compressionStrategy,
    smartCompressionMetadata: prepared.smartCompression
  });
}

/** Explicit Uint8Array convenience API. Equivalent to encodeBytes(). */
export function encodeUint8Array(input, options = {}) {
  return encodeBytes(asBytes(input), options);
}

/** Encode and sign a normal payload using an internal Ed25519 envelope. */
export async function encodeSignedBytes(input, options = {}) {
  const source = asBytes(input);
  const packed = await packSignedPayloadEnvelope(source, options);
  const parsed = parsePayloadEnvelope(packed.envelope);
  return encodePreparedBytes(packed.envelope, {
    ...options,
    text: Boolean(options.text),
    extended: true,
    signed: true,
    sourcePayloadBytes: source.length,
    compressionMetadata: parsed.compression,
    compressionLevelMetadata: packed.compressionLevel,
    compressionStrategyMetadata: packed.compressionStrategy,
    smartCompressionMetadata: packed.smartCompression,
    signingKeyId: parsed.keyId,
    hasEmbeddedPublicKey: parsed.hasEmbeddedPublicKey
  });
}

export async function encodeSignedText(text, options = {}) {
  assert(typeof text === "string", "encodeSignedText expects a string.");
  return encodeSignedBytes(getTextEncoder().encode(text), { ...options, text: true });
}


/**
 * Encode text using the optional QuadQR Secure Payload v1 layer.
 * This API is async because Web Crypto performs AES-GCM and password KDF work asynchronously.
 */
export async function encodeSecureText(text, options = {}) {
  assert(typeof text === "string", "encodeSecureText expects a string.");
  return encodeSecureBytes(getTextEncoder().encode(text), { ...options, text: true });
}

/** Encode arbitrary bytes using password or raw 256-bit key security. */
export async function encodeSecureBytes(input, options = {}) {
  const sourcePayload = asBytes(input);
  const security = options.security ?? {};
  const secureOuterFixedBytes = estimateSecureEnvelopeOverhead(security);
  let protectedPayload = sourcePayload;
  let extended = false;
  let signed = false;
  let compression = "none";
  let compressionLevel = null;
  let compressionStrategy = null;
  let smartCompression = null;
  let signingKeyId = null;
  let hasEmbeddedPublicKey = false;

  if (options.signing) {
    const packed = await packSignedPayloadEnvelope(sourcePayload, {
      ...options,
      ...options.signing,
      compression: options.compression ?? "auto",
      outerFixedBytes: secureOuterFixedBytes,
      versionOptions: options
    });
    protectedPayload = packed.envelope;
    const parsed = parsePayloadEnvelope(protectedPayload);
    extended = true;
    signed = true;
    compression = parsed.compression;
    compressionLevel = packed.compressionLevel;
    compressionStrategy = packed.compressionStrategy;
    smartCompression = packed.smartCompression;
    signingKeyId = parsed.keyId;
    hasEmbeddedPublicKey = parsed.hasEmbeddedPublicKey;
  } else {
    const prepared = prepareOptionalCompressedPayload(sourcePayload, options.compression ?? "none", {
      ...options,
      outerFixedBytes: secureOuterFixedBytes,
      versionOptions: options
    });
    protectedPayload = prepared.payload;
    extended = prepared.extended;
    compression = prepared.compression;
    compressionLevel = prepared.compressionLevel;
    compressionStrategy = prepared.compressionStrategy;
    smartCompression = prepared.smartCompression;
  }

  const encrypted = await encryptSecurePayload(protectedPayload, security);
  return encodePreparedBytes(encrypted.envelope, {
    ...options,
    text: Boolean(options.text),
    secure: true,
    extended,
    signed,
    sourcePayloadBytes: sourcePayload.length,
    compressionMetadata: compression,
    compressionLevelMetadata: compressionLevel,
    compressionStrategyMetadata: compressionStrategy,
    smartCompressionMetadata: smartCompression,
    signingKeyId,
    hasEmbeddedPublicKey,
    securityMetadata: encrypted.metadata
  });
}

/**
 * Decrypt a result returned by decodeMatrix/scanImageData/scanFile.
 * Compression and signatures are automatically unwrapped after decryption.
 */
export async function decryptDecoded(result, security = {}) {
  assert(result?.secure && result?.payload, "decryptDecoded expects an encrypted QuadQR decode result.");
  const plaintext = await decryptSecurePayload(result.payload, security);
  const isText = (result.flags & TEXT_FLAG) !== 0;
  const extended = (result.flags & EXTENDED_PAYLOAD_FLAG) !== 0;
  const envelope = extended ? parsePayloadEnvelope(plaintext) : null;
  const payload = envelope ? envelope.payload : plaintext;
  return {
    ...result,
    encryptedPayload: result.payload,
    encryptedPayloadBytes: result.payload.length,
    protectedPayload: envelope ? plaintext : undefined,
    payload,
    text: isText ? getTextDecoder().decode(payload) : null,
    compressed: envelope?.compressed ?? false,
    compression: envelope?.compression ?? "none",
    signed: envelope?.signed ?? result.signed ?? false,
    signatureVerified: envelope?.signatureVerified ?? result.signatureVerified,
    signatureTrusted: envelope?.signatureTrusted ?? result.signatureTrusted,
    signingKeyId: envelope?.keyId ?? result.signingKeyId ?? null,
    hasEmbeddedPublicKey: envelope?.hasEmbeddedPublicKey ?? result.hasEmbeddedPublicKey ?? false,
    signer: envelope?.signer ?? result.signer ?? null,
    decrypted: true,
    requiresDecryption: false,
    security: { ...result.security, decrypted: true }
  };
}

export {
  SECURITY_MODES,
  SECURITY_ALGORITHMS,
  SECURE_PAYLOAD_VERSION,
  DEFAULT_PBKDF2_ITERATIONS,
  generateRaw256Key,
  normalizeRaw256Key,
  bytesToHex
};

function finderMismatchRatio(matrix, top, left) {
  let mismatches = 0;
  let total = 0;
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const outer = r === 0 || c === 0 || r === 6 || c === 6;
      const center = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      const expected = outer || center ? CELL.BLACK : CELL.WHITE;
      total++;
      if (matrix[top + r]?.[left + c] !== expected) mismatches++;
    }
  }
  return mismatches / total;
}

function alignmentPatternMismatchRatio(matrix, pattern) {
  let mismatches = 0;
  let total = 0;
  const radius = alignmentPatternRadius(pattern);
  for (let r = -radius; r <= radius; r++) {
    for (let c = -radius; c <= radius; c++) {
      const black = alignmentPatternIsBlack(pattern, r, c);
      const expected = black ? CELL.BLACK : CELL.WHITE;
      total++;
      if (matrix[pattern.row + r]?.[pattern.col + c] !== expected) mismatches++;
    }
  }
  return mismatches / total;
}

function alignmentGridMismatchRatio(matrix, version, alignmentProfile = ALIGNMENT_PROFILE_STANDARD_5) {
  const patterns = alignmentPatternCentersForVersion(version, { profile: alignmentProfile });
  let weightedMismatch = 0;
  let totalWeight = 0;
  for (const pattern of patterns) {
    // Give the 5x5 primary marker a little more influence than compact 3x3 markers.
    const weight = pattern.primary ? 2 : 1;
    weightedMismatch += alignmentPatternMismatchRatio(matrix, pattern) * weight;
    totalWeight += weight;
  }
  return totalWeight ? weightedMismatch / totalWeight : 0;
}

function validateStructure(matrix, tolerance = 0, alignmentProfile = ALIGNMENT_PROFILE_STANDARD_5) {
  const size = matrix.length;
  if (size < 21 || matrix.some((row) => row.length !== size)) return false;
  const version = versionFromSize(size);
  if (!version) return false;
  const finderRatios = [
    finderMismatchRatio(matrix, 0, 0),
    finderMismatchRatio(matrix, 0, size - 7),
    finderMismatchRatio(matrix, size - 7, 0)
  ];
  if (finderRatios.some((ratio) => ratio > tolerance)) return false;

  const alignmentTolerance = Math.max(tolerance, 0.12);
  const primary = alignmentPatternCentersForVersion(version, { profile: alignmentProfile }).at(-1);
  if (primary && alignmentPatternMismatchRatio(matrix, primary) > alignmentTolerance) {
    return false;
  }
  if (alignmentGridMismatchRatio(matrix, version, alignmentProfile) > alignmentTolerance) return false;
  return true;
}

function rotate90(matrix) {
  const size = matrix.length;
  const out = make2D(size, CELL.WHITE);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) out[c][size - 1 - r] = matrix[r][c];
  }
  return out;
}

function extractVisibleCells(matrix, layout, cellEncoding = CELL_ENCODINGS.RGBW) {
  const encoding = normalizeCellEncoding(cellEncoding);
  const maxValue = encoding === CELL_ENCODINGS.TRIANGLE16 ? 15 : 3;
  const out = [];
  for (const [row, col] of layout.dataPositions) {
    const value = matrix[row][col];
    if (!Number.isInteger(value) || value < 0 || value > maxValue) {
      throw new Error(`Data region contains an invalid ${encoding === CELL_ENCODINGS.TRIANGLE16 ? "Triangle16" : "RGBW"} data cell.`);
    }
    out.push(value);
  }
  return out;
}

function unmaskCells(visibleCells, positions, maskId) {
  return visibleCells.map((value, index) => {
    const [row, col] = positions[index];
    return value ^ maskValue(row, col, maskId);
  });
}

function unmaskAndRestoreLogicalCells(
  visibleCells,
  positions,
  maskId,
  version,
  spectralInterleaving,
  cellEncoding = CELL_ENCODINGS.RGBW
) {
  const encoding = normalizeCellEncoding(cellEncoding);
  const permutation = spectralInterleaving ? spectralPermutation(visibleCells.length, version) : null;
  const logical = new Array(visibleCells.length);
  const headerCells = getHeaderPlan(version).codewordCells;

  for (let logicalIndex = 0; logicalIndex < visibleCells.length; logicalIndex++) {
    const physicalIndex = permutation ? permutation[logicalIndex] : logicalIndex;
    const [row, col] = positions[physicalIndex];
    logical[logicalIndex] = applyCellMask(
      visibleCells[physicalIndex],
      row,
      col,
      maskId,
      encoding,
      encoding === CELL_ENCODINGS.TRIANGLE16 && logicalIndex < headerCells
    );
  }
  return logical;
}

function restoreLogicalOrder(physicalValues, version, spectralInterleaving) {
  if (!spectralInterleaving) return physicalValues.slice();
  const permutation = spectralPermutation(physicalValues.length, version);
  const logical = new Array(physicalValues.length);
  for (let logicalIndex = 0; logicalIndex < permutation.length; logicalIndex++) {
    logical[logicalIndex] = physicalValues[permutation[logicalIndex]];
  }
  return logical;
}

function cellsToSymbolConfidences(
  confidences,
  byteCount,
  cellsPerByte = RGBW_CELLS_PER_BYTE
) {
  if (!confidences) return null;
  if (confidences.length < byteCount * cellsPerByte) return null;
  const out = new Array(byteCount);
  for (let symbolIndex = 0; symbolIndex < byteCount; symbolIndex++) {
    const offset = symbolIndex * cellsPerByte;
    let value = 1;
    for (let cellIndex = 0; cellIndex < cellsPerByte; cellIndex++) {
      value = Math.min(value, confidences[offset + cellIndex] ?? 1);
    }
    out[symbolIndex] = value;
  }
  return out;
}

function decodeRsAdaptive(codeword, paritySymbols, symbolConfidences, options = {}) {
  try {
    return { ...rsDecode(codeword, paritySymbols), confidenceAssisted: false };
  } catch (hardError) {
    if (!symbolConfidences || symbolConfidences.length !== codeword.length) throw hardError;

    const maxErasureConfidence = options.maxErasureConfidence ?? 0.68;
    const ranked = symbolConfidences
      .map((confidence, position) => ({ confidence: Number.isFinite(confidence) ? confidence : 1, position }))
      .filter(({ confidence }) => confidence <= maxErasureConfidence)
      .sort((a, b) => (a.confidence - b.confidence) || (a.position - b.position));

    const limit = Math.min(paritySymbols, ranked.length);
    let lastError = hardError;
    // Start with the least-confident symbol and progressively promote more
    // uncertain symbols to erasures. Syndrome verification inside rsDecode
    // prevents accepting an invalid correction.
    for (let count = 1; count <= limit; count++) {
      const erasurePositions = ranked.slice(0, count).map(({ position }) => position);
      try {
        return {
          ...rsDecode(codeword, paritySymbols, { erasurePositions }),
          confidenceAssisted: true
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
}

function decodeProtectedHeader(rawCells, version, rawConfidences = null, options = {}, cellEncoding = CELL_ENCODINGS.RGBW) {
  const plan = getHeaderPlan(version);
  const headerCells = rawCells.slice(0, plan.codewordCells);
  const codeword = Array.from(protectedHeaderCellsToBytes(headerCells, plan.codewordBytes, cellEncoding));
  const confidences = cellsToSymbolConfidences(rawConfidences?.slice(0, plan.codewordCells), plan.codewordBytes, RGBW_CELLS_PER_BYTE);
  const decoded = decodeRsAdaptive(codeword, plan.paritySymbols, confidences, options);
  const header = new Uint8Array(decoded.data);
  const parsed = parseHeader(header, version);
  return {
    header,
    ...parsed,
    correctedSymbols: decoded.correctedSymbols,
    erasureSymbols: decoded.erasureSymbols ?? 0,
    unknownErrorSymbols: decoded.unknownErrorSymbols ?? decoded.correctedSymbols,
    confidenceAssisted: decoded.confidenceAssisted,
    plan
  };
}

function decodeProtectedBody(rawCells, payloadLength, eccLevel, version, rawConfidences = null, options = {}, cellEncoding = CELL_ENCODINGS.RGBW) {
  const plan = getBodyRsPlan(payloadLength, eccLevel, version, cellEncoding);
  const bodyStart = getHeaderPlan(version).codewordCells;
  const encodedCells = rawCells.slice(bodyStart, bodyStart + plan.encodedCells);
  if (encodedCells.length !== plan.encodedCells) throw new Error("Protected body is incomplete.");

  const encodedSymbols = Array.from(cellsToBytes(encodedCells, plan.encodedSymbols, cellEncoding));
  const symbolConfidences = cellsToSymbolConfidences(
    rawConfidences?.slice(bodyStart, bodyStart + plan.encodedCells),
    plan.encodedSymbols,
    cellsPerByteForEncoding(cellEncoding)
  );
  const blocks = deinterleaveBlocks(encodedSymbols, plan.codewordBlockLengths);
  const confidenceBlocks = symbolConfidences
    ? deinterleaveBlocks(symbolConfidences, plan.codewordBlockLengths)
    : blocks.map(() => null);
  const decodedDataSymbols = [];
  let correctedSymbols = 0;
  let erasureSymbols = 0;
  let unknownErrorSymbols = 0;
  let confidenceAssisted = false;

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const decoded = decodeRsAdaptive(
      blocks[blockIndex],
      plan.paritySymbols,
      confidenceBlocks[blockIndex],
      options
    );
    correctedSymbols += decoded.correctedSymbols;
    erasureSymbols += decoded.erasureSymbols ?? 0;
    unknownErrorSymbols += decoded.unknownErrorSymbols ?? decoded.correctedSymbols;
    confidenceAssisted ||= decoded.confidenceAssisted;
    decodedDataSymbols.push(...decoded.data);
  }

  return {
    body: new Uint8Array(decodedDataSymbols.slice(0, plan.bodyByteCount)),
    correctedSymbols,
    erasureSymbols,
    unknownErrorSymbols,
    confidenceAssisted,
    plan
  };
}

function decodeCanonicalWithProfile(matrix, rotation, tolerance = 0, confidenceMatrix = null, options = {}, alignmentProfile = ALIGNMENT_PROFILE_STANDARD_5) {
  const size = matrix.length;
  const version = versionFromSize(size);
  if (!version) throw new Error(`Unsupported matrix size ${size}.`);
  if (!validateStructure(matrix, tolerance, alignmentProfile)) throw new Error("QuadQR finder/alignment structure does not match.");

  const layout = createLayout(version, { alignmentProfile });
  const errors = [];
  const hintedEncoding = options.cellEncodingHint != null
    ? normalizeCellEncoding(options.cellEncodingHint)
    : null;
  const hasExtendedCells = layout.dataPositions.some(([row, col]) => (matrix[row]?.[col] ?? 0) > 3);
  const encodingAttempts = hintedEncoding
    ? [hintedEncoding]
    : hasExtendedCells
      ? [CELL_ENCODINGS.TRIANGLE16, CELL_ENCODINGS.RGBW]
      : [CELL_ENCODINGS.RGBW, CELL_ENCODINGS.TRIANGLE16];

  for (const cellEncoding of encodingAttempts) {
    let visible;
    try {
      visible = extractVisibleCells(matrix, layout, cellEncoding);
    } catch (error) {
      errors.push(`${cellEncoding}: ${error.message}`);
      continue;
    }

    const visibleConfidences = confidenceMatrix
      ? layout.dataPositions.map(([row, col]) => confidenceMatrix[row]?.[col] ?? 1)
      : null;

    // New symbols use spectral-spatial interleaving. Legacy order remains a
    // decode fallback so existing RGBW QuadQR images do not become unreadable.
    for (const spectralInterleaving of [true, false]) {
      for (let maskId = 0; maskId < 4; maskId++) {
        try {
          const raw = unmaskAndRestoreLogicalCells(
            visible,
            layout.dataPositions,
            maskId,
            version,
            spectralInterleaving,
            cellEncoding
          );
          const rawConfidences = visibleConfidences
            ? restoreLogicalOrder(visibleConfidences, version, spectralInterleaving)
            : null;
          const headerDecoded = decodeProtectedHeader(
            raw,
            version,
            rawConfidences,
            options,
            cellEncoding
          );
          const header = headerDecoded.header;
          const flags = headerDecoded.flags;
          const decodedFormatVersion = headerDecoded.formatVersion ?? FORMAT_VERSION;
          if (version >= 7 && alignmentProfileForFormat(decodedFormatVersion) !== alignmentProfile) {
            throw new Error(`Format v${decodedFormatVersion} uses a different alignment profile.`);
          }
          const declaredCellEncoding = cellEncodingFromFlags(flags);
          if (declaredCellEncoding !== cellEncoding) {
            throw new Error(`Header declares ${declaredCellEncoding}, not ${cellEncoding}.`);
          }
          const eccLevel = eccFromFlags(flags);
          const payloadLength = headerDecoded.payloadLength;
          if (streamCellCount(payloadLength, eccLevel, version, cellEncoding) > raw.length) {
            throw new Error("Declared payload exceeds matrix capacity.");
          }

          const bodyDecoded = decodeProtectedBody(
            raw,
            payloadLength,
            eccLevel,
            version,
            rawConfidences,
            options,
            cellEncoding
          );
          const body = bodyDecoded.body;
          const payload = body.slice(0, payloadLength);
          const expectedCrc = readU32be(body, payloadLength);
          const actualCrc = crc32(concatBytes(header, payload));
          if (expectedCrc !== actualCrc) throw new Error("CRC mismatch after ECC.");

          const isText = (flags & TEXT_FLAG) !== 0;
          const secure = (flags & SECURE_FLAG) !== 0;
          const extendedFlag = (flags & EXTENDED_PAYLOAD_FLAG) !== 0;
          const signedFlag = (flags & SIGNED_FLAG) !== 0;
          const security = secure ? inspectSecureEnvelope(payload) : null;
          const envelope = extendedFlag && !secure ? parsePayloadEnvelope(payload) : null;
          const applicationPayload = envelope ? envelope.payload : payload;
          const erasureSymbols = headerDecoded.erasureSymbols + bodyDecoded.erasureSymbols;
          const unknownErrorSymbols = headerDecoded.unknownErrorSymbols + bodyDecoded.unknownErrorSymbols;
          return {
            ok: true,
            format: "QuadQR",
            formatVersion: decodedFormatVersion,
            version,
            size,
            alignmentPatterns: layout.alignments.length,
            alignmentProfile,
            maskId,
            rotation,
            flags,
            highDensity: cellEncoding === CELL_ENCODINGS.TRIANGLE16,
            cellEncoding,
            bitsPerDataCell: cellEncoding === CELL_ENCODINGS.TRIANGLE16 ? 4 : 2,
            statesPerDataCell: cellEncoding === CELL_ENCODINGS.TRIANGLE16 ? 16 : 4,
            eccLevel,
            eccParitySymbols: bodyDecoded.plan.paritySymbols,
            eccBlocks: bodyDecoded.plan.dataBlockLengths.length,
            correctableSymbolsPerBlock: bodyDecoded.plan.correctableSymbolsPerBlock,
            spectralInterleaving,
            confidenceAwareEcc: Boolean(rawConfidences),
            confidenceAssisted: headerDecoded.confidenceAssisted || bodyDecoded.confidenceAssisted,
            erasureSymbols,
            unknownErrorSymbols,
            correctedHeaderSymbols: headerDecoded.correctedSymbols,
            correctedBodySymbols: bodyDecoded.correctedSymbols,
            correctedSymbols: headerDecoded.correctedSymbols + bodyDecoded.correctedSymbols,
            protectedPayload: envelope ? payload : undefined,
            payload: secure ? payload : applicationPayload,
            text: secure ? null : (isText ? getTextDecoder().decode(applicationPayload) : null),
            compressed: envelope?.compressed ?? false,
            compression: envelope?.compression ?? "none",
            signed: envelope?.signed ?? signedFlag,
            signatureVerified: envelope?.signatureVerified,
            signatureTrusted: envelope?.signatureTrusted,
            signingKeyId: envelope?.keyId ?? null,
            hasEmbeddedPublicKey: envelope?.hasEmbeddedPublicKey ?? false,
            signer: envelope?.signer ?? null,
            secure,
            encrypted: secure,
            decrypted: false,
            requiresDecryption: secure,
            security,
            crc32: actualCrc >>> 0
          };
        } catch (error) {
          errors.push(`${cellEncoding} ${spectralInterleaving ? "spectral" : "legacy"} mask ${maskId}: ${error.message}`);
        }
      }
    }
  }

  throw new Error(`QuadQR decode failed. ${errors.join(" | ")}`);
}

function decodeCanonical(matrix, rotation, tolerance = 0, confidenceMatrix = null, options = {}) {
  const hinted = options.alignmentProfileHint;
  const profiles = hinted
    ? [hinted]
    : [ALIGNMENT_PROFILE_STANDARD_5, ALIGNMENT_PROFILE_LEGACY_3];
  const errors = [];
  for (const alignmentProfile of profiles) {
    try {
      return decodeCanonicalWithProfile(matrix, rotation, tolerance, confidenceMatrix, options, alignmentProfile);
    } catch (error) {
      errors.push(`${alignmentProfile}: ${error.message}`);
    }
  }
  throw new Error(`QuadQR decode failed for all alignment profiles. ${errors.join(" | ")}`);
}

function trySoftMatrixDecode(matrix, alternatives, confidenceMatrix, degrees, tolerance, options = {}) {
  if (!alternatives || !confidenceMatrix || options.softDecoding === false) return null;
  const version = versionFromSize(matrix.length);
  if (!version) return null;
  const layout = createLayout(version);
  const legacyLayout = createLayout(version, { alignmentProfile: ALIGNMENT_PROFILE_LEGACY_3 });
  const softPositions = [];
  const seenSoftPositions = new Set();
  for (const [row, col] of [...layout.dataPositions, ...legacyLayout.dataPositions]) {
    const key = `${row},${col}`;
    if (seenSoftPositions.has(key)) continue;
    seenSoftPositions.add(key);
    softPositions.push([row, col]);
  }
  const threshold = clampNumber(options.softDecodeConfidence ?? 0.72, 0.05, 0.95);
  const maxCells = Math.max(2, Math.min(16, Math.round(options.softDecodeMaxCells ?? 10)));
  const pairCells = Math.max(2, Math.min(maxCells, Math.round(options.softDecodePairCells ?? 6)));
  const ranked = [];

  for (const [row, col] of softPositions) {
    const alternative = alternatives[row]?.[col];
    const confidence = confidenceMatrix[row]?.[col] ?? 1;
    if (!Number.isInteger(alternative) || alternative === matrix[row][col] || confidence > threshold) continue;
    ranked.push({ row, col, alternative, confidence });
  }
  ranked.sort((a, b) => (a.confidence - b.confidence) || (a.row - b.row) || (a.col - b.col));
  const candidates = ranked.slice(0, maxCells);
  let attempts = 0;

  const attempt = (changes) => {
    const trial = cloneMatrix(matrix);
    for (const change of changes) trial[change.row][change.col] = change.alternative;
    attempts++;
    try {
      const decoded = decodeCanonical(trial, degrees, tolerance, confidenceMatrix, {
        ...options,
        softDecoding: false
      });
      return {
        ...decoded,
        spectrumEccVersion: 2,
        softDecoded: true,
        softSubstitutions: changes.length,
        softDecodeAttempts: attempts,
        softDecodeCellsConsidered: candidates.length
      };
    } catch {
      return null;
    }
  };

  for (const candidate of candidates) {
    const decoded = attempt([candidate]);
    if (decoded) return decoded;
  }

  const pairCandidates = candidates.slice(0, pairCells);
  for (let i = 0; i < pairCandidates.length; i++) {
    for (let j = i + 1; j < pairCandidates.length; j++) {
      const decoded = attempt([pairCandidates[i], pairCandidates[j]]);
      if (decoded) return decoded;
    }
  }
  return null;
}

export function decodeMatrix(inputMatrix, options = {}) {
  assert(Array.isArray(inputMatrix) && inputMatrix.length > 0, "Matrix is required.");
  let matrix = cloneMatrix(inputMatrix);
  let confidenceMatrix = options.cellConfidence ? cloneMatrix(options.cellConfidence) : null;
  let alternativeMatrix = options.cellAlternatives ? cloneMatrix(options.cellAlternatives) : null;
  const errors = [];
  const tolerance = options.structureTolerance ?? 0;

  if (confidenceMatrix) {
    assert(
      confidenceMatrix.length === matrix.length && confidenceMatrix.every((row) => row.length === matrix.length),
      "cellConfidence must be a square matrix matching the QuadQR matrix."
    );
  }
  if (alternativeMatrix) {
    assert(
      alternativeMatrix.length === matrix.length && alternativeMatrix.every((row) => row.length === matrix.length),
      "cellAlternatives must be a square matrix matching the QuadQR matrix."
    );
  }

  for (let rotationIndex = 0; rotationIndex < 4; rotationIndex++) {
    const degrees = rotationIndex * 90;
    try {
      const decoded = decodeCanonical(matrix, degrees, tolerance, confidenceMatrix, options);
      return {
        spectrumEccVersion: 2,
        softDecoded: false,
        softSubstitutions: 0,
        ...decoded
      };
    } catch (error) {
      errors.push(`${degrees}°: ${error.message}`);
      const softDecoded = trySoftMatrixDecode(
        matrix,
        alternativeMatrix,
        confidenceMatrix,
        degrees,
        tolerance,
        options
      );
      if (softDecoded) return softDecoded;
    }
    matrix = rotate90(matrix);
    if (confidenceMatrix) confidenceMatrix = rotate90(confidenceMatrix);
    if (alternativeMatrix) alternativeMatrix = rotate90(alternativeMatrix);
  }

  throw new Error(`Unable to decode matrix. ${errors.join(" || ")}`);
}


/** Decode a matrix and return only its application payload bytes. */
export function decodeUint8Array(inputMatrix, options = {}) {
  return decodeMatrix(inputMatrix, options).payload;
}

/** Verify a signed decode result and return the result with verification state attached. */
export async function verifyDecodedSignature(result, options = {}) {
  assert(result?.signed, "Decode result is not signed.");
  const source = result.protectedPayload;
  assert(source, "Signed payload metadata is unavailable. Decrypt secure content first if necessary.");
  const verification = await verifyPayloadEnvelopeSignature(source, options);
  return {
    ...result,
    signatureVerified: verification.verified,
    signatureTrusted: verification.trusted,
    signingKeyId: verification.keyId ?? result.signingKeyId ?? null,
    signatureTrustSource: verification.trustSource
  };
}

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  assert(clean.length === 6, `Invalid hex color ${hex}.`);
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16)
  };
}

function resolvePalette(palette = {}) {
  return { ...DEFAULT_PALETTE, ...palette };
}

function normalizeRenderMode(mode = RENDER_MODES.SCREEN) {
  const value = String(mode).toLowerCase();
  assert(value === RENDER_MODES.SCREEN || value === RENDER_MODES.PRINT, "Render mode must be screen or print.");
  return value;
}

function resolveRenderPalette(options = {}) {
  const mode = normalizeRenderMode(options.mode ?? options.renderMode ?? RENDER_MODES.SCREEN);
  const base = mode === RENDER_MODES.PRINT ? PRINT_PALETTE : DEFAULT_PALETTE;
  return { ...base, ...(options.palette ?? {}) };
}

function paletteRgb(palette = {}) {
  const p = resolvePalette(palette);
  return {
    black: hexToRgb(p.black),
    white: hexToRgb(p.white),
    red: hexToRgb(p.red),
    green: hexToRgb(p.green),
    blue: hexToRgb(p.blue)
  };
}

function cellColor(cell, palette) {
  switch (cell) {
    case CELL.BLACK: return palette.black;
    case CELL.RED: return palette.red;
    case CELL.GREEN: return palette.green;
    case CELL.BLUE: return palette.blue;
    case CELL.WHITE: return palette.white;
    default: throw new Error(`Unknown cell value ${cell}.`);
  }
}

function cellRgb(cell, palette) {
  switch (cell) {
    case CELL.BLACK: return palette.black;
    case CELL.RED: return palette.red;
    case CELL.GREEN: return palette.green;
    case CELL.BLUE: return palette.blue;
    case CELL.WHITE: return palette.white;
    default: throw new Error(`Unknown cell value ${cell}.`);
  }
}


function inferCellEncoding(codeOrMatrix, matrix, layout = null) {
  if (!Array.isArray(codeOrMatrix) && codeOrMatrix?.cellEncoding) {
    return normalizeCellEncoding(codeOrMatrix.cellEncoding);
  }
  const activeLayout = layout ?? renderLayoutForMatrix(matrix);
  if (activeLayout) {
    for (const [row, col] of activeLayout.dataPositions) {
      if ((matrix[row]?.[col] ?? 0) > 3) return CELL_ENCODINGS.TRIANGLE16;
    }
  }
  return CELL_ENCODINGS.RGBW;
}

function triangleCellColors(cell) {
  const { first, second } = unpackTriangleCell(cell);
  return { first, second };
}

function drawTriangleCellCanvas(ctx, x, y, width, height, cell, palette) {
  const pair = triangleCellColors(cell);
  if (pair.first === pair.second) {
    ctx.fillStyle = cellColor(pair.first, palette);
    ctx.fillRect(x, y, width, height);
    return;
  }

  // Fixed "/" split. first = upper-left triangle, second = lower-right.
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + width, y);
  ctx.lineTo(x, y + height);
  ctx.closePath();
  ctx.fillStyle = cellColor(pair.first, palette);
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(x + width, y);
  ctx.lineTo(x + width, y + height);
  ctx.lineTo(x, y + height);
  ctx.closePath();
  ctx.fillStyle = cellColor(pair.second, palette);
  ctx.fill();
}

function fillImageTriangleCell(data, imageWidth, x, y, width, height, cell, palette) {
  const pair = triangleCellColors(cell);
  const firstRgb = cellRgb(pair.first, palette);
  const secondRgb = cellRgb(pair.second, palette);
  for (let yy = 0; yy < height; yy++) {
    for (let xx = 0; xx < width; xx++) {
      const normalizedX = (xx + 0.5) / Math.max(1, width);
      const normalizedY = (yy + 0.5) / Math.max(1, height);
      const rgb = normalizedX + normalizedY <= 1 ? firstRgb : secondRgb;
      const p = ((y + yy) * imageWidth + (x + xx)) * 4;
      data[p] = rgb.r;
      data[p + 1] = rgb.g;
      data[p + 2] = rgb.b;
      data[p + 3] = 255;
    }
  }
}

function svgTriangleCell(x, y, size, cell, palette) {
  const pair = triangleCellColors(cell);
  if (pair.first === pair.second) return svgRect(x, y, size, size, cellColor(pair.first, palette));
  const first = cellColor(pair.first, palette);
  const second = cellColor(pair.second, palette);
  return [
    `<polygon points="${x},${y} ${x + size},${y} ${x},${y + size}" fill="${first}"/>`,
    `<polygon points="${x + size},${y} ${x + size},${y + size} ${x},${y + size}" fill="${second}"/>`
  ].join("");
}


function normalizeRenderStyle(style = RENDER_STYLES.CLASSIC) {
  const value = String(style).toLowerCase();
  const allowed = Object.values(RENDER_STYLES);
  assert(allowed.includes(value), `Render style must be one of ${allowed.join(", ")}.`);
  return value;
}

function renderLayoutForMatrix(matrix) {
  const version = versionFromSize(matrix.length);
  if (!version) return null;
  try {
    return createLayout(version);
  } catch {
    return null;
  }
}

function isStructuralRenderCell(layout, row, col, cell) {
  // BLACK never represents payload data in QuadQR. The layout check also keeps
  // structural white and RGB calibration cells untouched by visual styles.
  return Boolean(layout?.reserved?.[row]?.[col]) || cell === CELL.BLACK;
}

function renderNoise(row, col, cell) {
  let value = (
    Math.imul(row + 1, 0x9e3779b1) ^
    Math.imul(col + 1, 0x85ebca6b) ^
    Math.imul((cell + 2) & 0xff, 0xc2b2ae35)
  ) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b) >>> 0;
  value ^= value >>> 16;
  return (value >>> 0) / 0xffffffff;
}

function depthOpacity(row, col, cell) {
  const value = renderNoise(row, col, cell);
  if (value < 0.16) return 0.80;
  if (value < 0.36) return 0.87;
  if (value < 0.56) return 0.94;
  return 1;
}

function mixRgb(a, b, amount) {
  const t = Math.max(0, Math.min(1, amount));
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t)
  };
}

function rgbCss(rgb) {
  return `rgb(${rgb.r} ${rgb.g} ${rgb.b})`;
}

// Scan-safe decorative profiles deliberately alter only a narrow edge band.
// The scanner samples around the center of each module (roughly +/- 0.16 to
// 0.18 module widths), so the central classification area remains the exact
// encoded R/G/B/W color. Structural/calibration cells bypass styling entirely.
function safeStyleEdge(moduleSize) {
  if (moduleSize < 5) return 0;
  return Math.max(1, Math.min(Math.floor(moduleSize * 0.10), Math.floor(moduleSize * 0.16)));
}

function insetStyleColors(rgb, palette) {
  return {
    highlight: mixRgb(rgb, palette.white, 0.12),
    shadow: mixRgb(rgb, palette.black, 0.10)
  };
}

function roundedRectPath(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function setImagePixel(data, width, x, y, rgb) {
  if (x < 0 || y < 0 || x >= width) return;
  const height = data.length / 4 / width;
  if (y >= height) return;
  const p = (y * width + x) * 4;
  data[p] = rgb.r;
  data[p + 1] = rgb.g;
  data[p + 2] = rgb.b;
  data[p + 3] = 255;
}

function fillImageRect(data, width, x, y, rectWidth, rectHeight, rgb) {
  for (let yy = y; yy < y + rectHeight; yy++) {
    for (let xx = x; xx < x + rectWidth; xx++) setImagePixel(data, width, xx, yy, rgb);
  }
}

function fillImageRoundedRect(data, width, x, y, rectWidth, rectHeight, radius, rgb) {
  const r = Math.max(0, Math.min(radius, Math.floor(rectWidth / 2), Math.floor(rectHeight / 2)));
  if (r <= 0) {
    fillImageRect(data, width, x, y, rectWidth, rectHeight, rgb);
    return;
  }
  const leftCenter = x + r;
  const rightCenter = x + rectWidth - r - 1;
  const topCenter = y + r;
  const bottomCenter = y + rectHeight - r - 1;
  const rr = r * r;
  for (let yy = y; yy < y + rectHeight; yy++) {
    for (let xx = x; xx < x + rectWidth; xx++) {
      let dx = 0;
      let dy = 0;
      if (xx < leftCenter) dx = leftCenter - xx;
      else if (xx > rightCenter) dx = xx - rightCenter;
      if (yy < topCenter) dy = topCenter - yy;
      else if (yy > bottomCenter) dy = yy - bottomCenter;
      if (dx * dx + dy * dy <= rr) setImagePixel(data, width, xx, yy, rgb);
    }
  }
}


/** Estimate a conservative center-logo ratio from ECC, utilization and output mode. */
export function estimateSafeLogoSize(codeOrMatrix, options = {}) {
  const code = Array.isArray(codeOrMatrix) ? null : codeOrMatrix;
  const ecc = String(code?.eccLevel ?? options.ecc ?? DEFAULT_ECC_LEVEL).toUpperCase();
  const base = { L: 0.10, M: 0.13, Q: 0.16, H: 0.19 }[ecc] ?? 0.12;
  const utilization = Number.isFinite(code?.utilization) ? code.utilization : Number(options.utilization ?? 0.65);
  const utilizationPenalty = utilization <= 0.55 ? 1 : Math.max(0.72, 1 - (utilization - 0.55) * 0.56);
  const clearBackground = Boolean(options.clearBackground ?? options.logoClearBackground ?? options.logo?.clearBackground);
  const clearPenalty = clearBackground ? 0.90 : 1;
  const mode = normalizeRenderMode(options.mode ?? options.renderMode ?? RENDER_MODES.SCREEN);
  const printPenalty = mode === RENDER_MODES.PRINT ? 0.88 : 1;
  const versionPenalty = code?.version === 1 ? 0.88 : 1;
  return Math.max(0.07, Math.min(0.22, base * utilizationPenalty * clearPenalty * printPenalty * versionPenalty));
}

/**
 * Empirically search for the largest logo ratio that still decodes from the
 * dependency-free ImageData renderer. The logo source must therefore be ImageData-like.
 */
export function findMaxSafeLogoSize(code, options = {}) {
  assert(code?.matrix, "findMaxSafeLogoSize expects an encoded QuadQR object.");
  const logo = options.logo;
  const source = logo?.source ?? logo;
  assert(source?.data && source?.width && source?.height,
    "findMaxSafeLogoSize requires an ImageData-like logo source so it can test pixel output without DOM dependencies.");
  let low = Math.max(0.05, Number(options.minSize ?? 0.05));
  let high = Math.min(0.30, Number(options.maxSize ?? 0.28));
  let best = 0;
  const iterations = Math.max(3, Math.min(10, Math.floor(options.iterations ?? 7)));
  for (let i = 0; i < iterations; i++) {
    const probe = (low + high) / 2;
    try {
      const image = renderToImageData(code, {
        ...options,
        logo: {
          ...(typeof logo === "object" && Object.prototype.hasOwnProperty.call(logo, "source") ? logo : { source }),
          size: probe
        }
      });
      const decoded = scanImageData(image, { minVersion: code.version, maxVersion: code.version });
      if (decoded.crc32 !== code.crc32) throw new Error("Decoded a different payload.");
      best = probe;
      low = probe;
    } catch {
      high = probe;
    }
  }
  return {
    safeSize: best || estimateSafeLogoSize(code, options),
    testedMax: Number(options.maxSize ?? 0.28),
    iterations,
    empirical: best > 0
  };
}

export function getPrintGuidance(codeOrMatrix, options = {}) {
  const matrix = Array.isArray(codeOrMatrix) ? codeOrMatrix : codeOrMatrix?.matrix;
  assert(matrix?.length, "getPrintGuidance expects a QuadQR code or matrix.");
  const quietZone = Math.max(4, Math.floor(options.quietZone ?? 4));
  const physicalSizeMm = Number(options.physicalSizeMm ?? 35);
  const totalModules = matrix.length + quietZone * 2;
  const moduleSizeMm = physicalSizeMm / totalModules;
  const dpi = Number(options.dpi ?? 300);
  const modulePixels = moduleSizeMm / 25.4 * dpi;
  const recommendedMinimumModuleMm = Number(options.minimumModuleMm ?? 0.40);
  return {
    mode: "print",
    physicalSizeMm,
    quietZone,
    moduleSizeMm,
    modulePixelsAtDpi: modulePixels,
    dpi,
    recommendedMinimumModuleMm,
    meetsRecommendedModuleSize: moduleSizeMm >= recommendedMinimumModuleMm,
    recommendedMinimumPhysicalSizeMm: totalModules * recommendedMinimumModuleMm,
    palette: PRINT_PALETTE,
    recommendations: [
      "Use classic rendering for print unless a styled output has been physically validated.",
      "Keep at least a 4-module quiet zone.",
      `Target at least ${recommendedMinimumModuleMm.toFixed(2)} mm per module for general-purpose printing.`,
      "Avoid glossy reflections and low-ink/toner modes when reliable color classification matters."
    ]
  };
}

function resolveLogoRenderOptions(options, matrixSize, moduleSize, quietZone, palette, codeOrMatrix = null) {
  if (!options.logo) return null;

  const nested = (
    options.logo &&
    typeof options.logo === "object" &&
    Object.prototype.hasOwnProperty.call(options.logo, "source")
  ) ? options.logo : null;
  const source = nested ? nested.source : options.logo;
  if (!source) return null;

  const requestedSize = nested?.size ?? options.logoSize ?? 0.18;
  const autoSize = String(requestedSize).toLowerCase() === "auto";
  const rawSize = Number(requestedSize);
  const sizeRatio = autoSize
    ? estimateSafeLogoSize(codeOrMatrix, { ...options, clearBackground: nested?.clearBackground ?? options.logoClearBackground })
    : Math.max(0.05, Math.min(0.30, Number.isFinite(rawSize) ? rawSize : 0.18));
  const rawPadding = Number(nested?.padding ?? options.logoPadding ?? 0.65);
  const rawRadius = Number(nested?.radius ?? options.logoRadius ?? 0.8);
  const paddingModules = Math.max(0, Number.isFinite(rawPadding) ? rawPadding : 0.65);
  const radiusModules = Math.max(0, Number.isFinite(rawRadius) ? rawRadius : 0.8);
  const clearBackground = Boolean(nested?.clearBackground ?? options.logoClearBackground ?? false);
  const backgroundColor = nested?.backgroundColor ?? options.logoBackgroundColor ?? palette.white;

  const codePixels = matrixSize * moduleSize;
  const canvasPixels = (matrixSize + quietZone * 2) * moduleSize;
  const logoPixels = Math.max(1, codePixels * sizeRatio);
  const center = canvasPixels / 2;
  const paddingPixels = paddingModules * moduleSize;
  const backgroundPixels = logoPixels + paddingPixels * 2;

  return {
    source,
    sizeRatio,
    clearBackground,
    backgroundColor,
    logoX: center - logoPixels / 2,
    logoY: center - logoPixels / 2,
    logoSize: logoPixels,
    backgroundX: center - backgroundPixels / 2,
    backgroundY: center - backgroundPixels / 2,
    backgroundSize: backgroundPixels,
    backgroundRadius: radiusModules * moduleSize
  };
}

function canvasLogoSource(source) {
  if (!source || typeof source === "string") return source;
  if (source.data && Number.isInteger(source.width) && Number.isInteger(source.height)) {
    let scratch = null;
    if (typeof OffscreenCanvas !== "undefined") {
      scratch = new OffscreenCanvas(source.width, source.height);
    } else if (typeof document !== "undefined") {
      scratch = document.createElement("canvas");
      scratch.width = source.width;
      scratch.height = source.height;
    }
    if (!scratch) return source;
    const ctx = scratch.getContext("2d");
    if (!ctx) return source;
    const pixels = source.data instanceof Uint8ClampedArray
      ? source.data
      : new Uint8ClampedArray(source.data);
    ctx.putImageData(new ImageData(pixels, source.width, source.height), 0, 0);
    return scratch;
  }
  return source;
}

function logoSourceDimensions(source) {
  const width = source?.naturalWidth ?? source?.videoWidth ?? source?.width;
  const height = source?.naturalHeight ?? source?.videoHeight ?? source?.height;
  if (!(Number(width) > 0 && Number(height) > 0)) return null;
  return { width: Number(width), height: Number(height) };
}

function containRect(x, y, size, dimensions) {
  if (!dimensions) return { x, y, width: size, height: size };
  const scale = Math.min(size / dimensions.width, size / dimensions.height);
  const width = dimensions.width * scale;
  const height = dimensions.height * scale;
  return {
    x: x + (size - width) / 2,
    y: y + (size - height) / 2,
    width,
    height
  };
}

function drawLogoToCanvas(ctx, logo, palette) {
  if (!logo) return;
  if (logo.clearBackground) {
    ctx.fillStyle = logo.backgroundColor || palette.white;
    roundedRectPath(
      ctx,
      logo.backgroundX,
      logo.backgroundY,
      logo.backgroundSize,
      logo.backgroundSize,
      logo.backgroundRadius
    );
    ctx.fill();
  }

  const source = canvasLogoSource(logo.source);
  assert(
    source && typeof source !== "string",
    "renderToCanvas() logo must be a loaded CanvasImageSource or ImageData-like object. Load URL/data-URL logos into an Image first."
  );
  const rect = containRect(logo.logoX, logo.logoY, logo.logoSize, logoSourceDimensions(source));
  const previousSmoothing = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height);
  ctx.imageSmoothingEnabled = previousSmoothing;
}

function blendImagePixel(data, width, x, y, rgb, alpha) {
  if (x < 0 || y < 0 || x >= width) return;
  const height = data.length / 4 / width;
  if (y >= height) return;
  const p = (y * width + x) * 4;
  const a = Math.max(0, Math.min(1, alpha));
  data[p] = Math.round(data[p] * (1 - a) + rgb.r * a);
  data[p + 1] = Math.round(data[p + 1] * (1 - a) + rgb.g * a);
  data[p + 2] = Math.round(data[p + 2] * (1 - a) + rgb.b * a);
  data[p + 3] = 255;
}

function drawLogoToImageData(data, width, logo) {
  if (!logo) return;
  if (logo.clearBackground) {
    const rgb = hexToRgb(logo.backgroundColor);
    fillImageRoundedRect(
      data,
      width,
      Math.round(logo.backgroundX),
      Math.round(logo.backgroundY),
      Math.round(logo.backgroundSize),
      Math.round(logo.backgroundSize),
      Math.round(logo.backgroundRadius),
      rgb
    );
  }

  const source = logo.source;
  assert(
    source?.data && Number.isInteger(source.width) && Number.isInteger(source.height),
    "renderToImageData() logo must be an ImageData-like object with width, height, and RGBA data."
  );
  const dest = containRect(logo.logoX, logo.logoY, logo.logoSize, {
    width: source.width,
    height: source.height
  });
  const x0 = Math.round(dest.x);
  const y0 = Math.round(dest.y);
  const destWidth = Math.max(1, Math.round(dest.width));
  const destHeight = Math.max(1, Math.round(dest.height));
  const src = source.data;

  for (let y = 0; y < destHeight; y++) {
    const sy = Math.min(source.height - 1, Math.floor((y + 0.5) * source.height / destHeight));
    for (let x = 0; x < destWidth; x++) {
      const sx = Math.min(source.width - 1, Math.floor((x + 0.5) * source.width / destWidth));
      const p = (sy * source.width + sx) * 4;
      const alpha = (src[p + 3] ?? 255) / 255;
      if (alpha <= 0) continue;
      blendImagePixel(data, width, x0 + x, y0 + y, {
        r: src[p],
        g: src[p + 1],
        b: src[p + 2]
      }, alpha);
    }
  }
}

function escapeXmlAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function svgRect(x, y, width, height, fill, radius = 0) {
  const rounded = radius > 0 ? ` rx="${radius}" ry="${radius}"` : "";
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${escapeXmlAttribute(fill)}"${rounded}/>`;
}

function svgLogoHref(source) {
  if (typeof source === "string") return source;
  if (typeof source?.src === "string" && source.src) return source.src;
  return null;
}

function resolveRenderSizing(options, matrixSize) {
  const mode = normalizeRenderMode(options.mode ?? options.renderMode ?? RENDER_MODES.SCREEN);
  const quietZone = Math.max(0, Math.floor(options.quietZone ?? 4));
  const totalModules = matrixSize + quietZone * 2;
  const hasImageSize = options.imageSize !== undefined && options.imageSize !== null;
  const hasModuleSize = options.moduleSize !== undefined && options.moduleSize !== null;

  let pixelSize;
  if (hasImageSize) {
    const requested = Number(options.imageSize);
    assert(Number.isFinite(requested) && requested > 0, "imageSize must be a positive number of pixels.");
    pixelSize = Math.max(totalModules, Math.round(requested));
  } else if (hasModuleSize) {
    const requested = Number(options.moduleSize);
    assert(Number.isFinite(requested) && requested > 0, "moduleSize must be a positive number of pixels.");
    const moduleSize = Math.max(1, Math.floor(requested));
    pixelSize = totalModules * moduleSize;
  } else {
    // A practical export default that is large enough for screens/social use
    // while keeping the API independent from the encoded matrix version.
    pixelSize = Math.max(totalModules, 720);
  }

  return {
    quietZone,
    totalModules,
    pixelSize,
    moduleSize: pixelSize / totalModules,
    mode
  };
}

function rasterModuleRect(row, col, quietZone, moduleSize) {
  const x0 = Math.round((col + quietZone) * moduleSize);
  const y0 = Math.round((row + quietZone) * moduleSize);
  const x1 = Math.round((col + quietZone + 1) * moduleSize);
  const y1 = Math.round((row + quietZone + 1) * moduleSize);
  return {
    x: x0,
    y: y0,
    width: Math.max(1, x1 - x0),
    height: Math.max(1, y1 - y0)
  };
}

export function renderToCanvas(codeOrMatrix, canvas, options = {}) {
  assert(canvas && typeof canvas.getContext === "function", "A canvas element is required.");
  const matrix = Array.isArray(codeOrMatrix) ? codeOrMatrix : codeOrMatrix.matrix;
  assert(Array.isArray(matrix) && matrix.length > 0, "A matrix is required.");
  const sizing = resolveRenderSizing(options, matrix.length);
  const { moduleSize, quietZone, pixelSize } = sizing;
  const palette = resolveRenderPalette(options);
  const paletteValues = paletteRgb(palette);
  const mode = normalizeRenderMode(options.mode ?? options.renderMode ?? RENDER_MODES.SCREEN);
  const style = normalizeRenderStyle(mode === RENDER_MODES.PRINT && options.allowStyledPrint !== true ? RENDER_STYLES.CLASSIC : options.style);
  const layout = renderLayoutForMatrix(matrix);
  const cellEncoding = inferCellEncoding(codeOrMatrix, matrix, layout);
  const size = matrix.length;
  const logo = resolveLogoRenderOptions(options, size, moduleSize, quietZone, palette, codeOrMatrix);

  canvas.width = pixelSize;
  canvas.height = pixelSize;
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = palette.white;
  ctx.fillRect(0, 0, pixelSize, pixelSize);

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const cell = matrix[r][c];
      const structural = isStructuralRenderCell(layout, r, c, cell);
      const rect = rasterModuleRect(r, c, quietZone, moduleSize);
      const { x, y, width: cellWidth, height: cellHeight } = rect;
      const cellSize = Math.min(cellWidth, cellHeight);

      if (cellEncoding === CELL_ENCODINGS.TRIANGLE16 && !structural) {
        // Experimental Triangle16 always renders payload cells with exact,
        // hard-edged geometry. Decorative per-cell styles would contaminate the
        // two independent color samples and reduce scan reliability.
        drawTriangleCellCanvas(ctx, x, y, cellWidth, cellHeight, cell, palette);
        continue;
      }

      if (style === RENDER_STYLES.CLASSIC || structural) {
        ctx.fillStyle = cellColor(cell, palette);
        ctx.fillRect(x, y, cellWidth, cellHeight);
        continue;
      }

      const rgb = cellRgb(cell, paletteValues);

      if (style === RENDER_STYLES.DEPTH) {
        const opacity = depthOpacity(r, c, cell);
        const base = mixRgb(paletteValues.white, rgb, opacity);
        ctx.fillStyle = rgbCss(base);
        ctx.fillRect(x, y, cellWidth, cellHeight);

        if (cellSize >= 6) {
          const edge = Math.max(1, Math.floor(cellSize * 0.08));
          const highlight = mixRgb(base, paletteValues.white, 0.17);
          const shadow = mixRgb(base, paletteValues.black, 0.12);
          ctx.fillStyle = rgbCss(highlight);
          ctx.fillRect(x, y, cellWidth, edge);
          ctx.fillRect(x, y, edge, cellHeight);
          ctx.fillStyle = rgbCss(shadow);
          ctx.fillRect(x, y + cellHeight - edge, cellWidth, edge);
          ctx.fillRect(x + cellWidth - edge, y, edge, cellHeight);
        }
        continue;
      }

      if (style === RENDER_STYLES.SOFT) {
        const inset = cellSize >= 6 ? Math.max(1, Math.floor(cellSize * 0.07)) : 0;
        const width = cellWidth - inset * 2;
        const height = cellHeight - inset * 2;
        const radius = Math.max(1, Math.floor(cellSize * 0.20));
        ctx.fillStyle = cellColor(cell, palette);
        roundedRectPath(ctx, x + inset, y + inset, width, height, radius);
        ctx.fill();
        continue;
      }

      if (style === RENDER_STYLES.INSET) {
        // Keep the exact encoded color across the full module, then limit the
        // recessed effect to a narrow edge band so center sampling stays intact.
        ctx.fillStyle = cellColor(cell, palette);
        ctx.fillRect(x, y, cellWidth, cellHeight);
        if (cell === CELL.WHITE) continue;

        const edge = safeStyleEdge(cellSize);
        if (edge > 0) {
          const fx = insetStyleColors(rgb, paletteValues);
          ctx.fillStyle = rgbCss(fx.shadow);
          ctx.fillRect(x, y, cellWidth, edge);
          ctx.fillRect(x, y, edge, cellHeight);
          ctx.fillStyle = rgbCss(fx.highlight);
          ctx.fillRect(x, y + cellHeight - edge, cellWidth, edge);
          ctx.fillRect(x + cellWidth - edge, y, edge, cellHeight);
        }
      }
    }
  }
  drawLogoToCanvas(ctx, logo, palette);
  return canvas;
}

export function renderToImageData(codeOrMatrix, options = {}) {
  const matrix = Array.isArray(codeOrMatrix) ? codeOrMatrix : codeOrMatrix.matrix;
  assert(Array.isArray(matrix) && matrix.length > 0, "A matrix is required.");
  const sizing = resolveRenderSizing(options, matrix.length);
  const { moduleSize, quietZone, pixelSize } = sizing;
  const resolvedPalette = resolveRenderPalette(options);
  const palette = paletteRgb(resolvedPalette);
  const mode = normalizeRenderMode(options.mode ?? options.renderMode ?? RENDER_MODES.SCREEN);
  const style = normalizeRenderStyle(mode === RENDER_MODES.PRINT && options.allowStyledPrint !== true ? RENDER_STYLES.CLASSIC : options.style);
  const layout = renderLayoutForMatrix(matrix);
  const cellEncoding = inferCellEncoding(codeOrMatrix, matrix, layout);
  const size = matrix.length;
  const data = new Uint8ClampedArray(pixelSize * pixelSize * 4);
  const white = palette.white;
  const logo = resolveLogoRenderOptions(options, size, moduleSize, quietZone, resolvedPalette, codeOrMatrix);

  for (let i = 0; i < pixelSize * pixelSize; i++) {
    const p = i * 4;
    data[p] = white.r;
    data[p + 1] = white.g;
    data[p + 2] = white.b;
    data[p + 3] = 255;
  }

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const cell = matrix[r][c];
      const structural = isStructuralRenderCell(layout, r, c, cell);
      const rect = rasterModuleRect(r, c, quietZone, moduleSize);
      const x0 = rect.x;
      const y0 = rect.y;
      const cellWidth = rect.width;
      const cellHeight = rect.height;
      const cellSize = Math.min(cellWidth, cellHeight);

      if (cellEncoding === CELL_ENCODINGS.TRIANGLE16 && !structural) {
        fillImageTriangleCell(data, pixelSize, x0, y0, cellWidth, cellHeight, cell, palette);
        continue;
      }

      const rgb = cellRgb(cell, palette);

      if (style === RENDER_STYLES.CLASSIC || structural) {
        fillImageRect(data, pixelSize, x0, y0, cellWidth, cellHeight, rgb);
        continue;
      }

      if (style === RENDER_STYLES.DEPTH) {
        const opacity = depthOpacity(r, c, cell);
        const base = mixRgb(white, rgb, opacity);
        fillImageRect(data, pixelSize, x0, y0, cellWidth, cellHeight, base);
        if (cellSize >= 6) {
          const edge = Math.max(1, Math.floor(cellSize * 0.08));
          const highlight = mixRgb(base, white, 0.17);
          const shadow = mixRgb(base, palette.black, 0.12);
          fillImageRect(data, pixelSize, x0, y0, cellWidth, edge, highlight);
          fillImageRect(data, pixelSize, x0, y0, edge, cellHeight, highlight);
          fillImageRect(data, pixelSize, x0, y0 + cellHeight - edge, cellWidth, edge, shadow);
          fillImageRect(data, pixelSize, x0 + cellWidth - edge, y0, edge, cellHeight, shadow);
        }
        continue;
      }

      if (style === RENDER_STYLES.SOFT) {
        const inset = cellSize >= 6 ? Math.max(1, Math.floor(cellSize * 0.07)) : 0;
        const width = cellWidth - inset * 2;
        const height = cellHeight - inset * 2;
        const radius = Math.max(1, Math.floor(cellSize * 0.20));
        fillImageRoundedRect(data, pixelSize, x0 + inset, y0 + inset, width, height, radius, rgb);
        continue;
      }

      if (style === RENDER_STYLES.INSET) {
        fillImageRect(data, pixelSize, x0, y0, cellWidth, cellHeight, rgb);
        if (cell === CELL.WHITE) continue;
        const edge = safeStyleEdge(cellSize);
        if (edge > 0) {
          const fx = insetStyleColors(rgb, palette);
          fillImageRect(data, pixelSize, x0, y0, cellWidth, edge, fx.shadow);
          fillImageRect(data, pixelSize, x0, y0, edge, cellHeight, fx.shadow);
          fillImageRect(data, pixelSize, x0, y0 + cellHeight - edge, cellWidth, edge, fx.highlight);
          fillImageRect(data, pixelSize, x0 + cellWidth - edge, y0, edge, cellHeight, fx.highlight);
        }
      }
    }
  }

  drawLogoToImageData(data, pixelSize, logo);

  return { width: pixelSize, height: pixelSize, data };
}

/** Render a QuadQR code/matrix to a standalone SVG string. */
export function renderToSVG(codeOrMatrix, options = {}) {
  const matrix = Array.isArray(codeOrMatrix) ? codeOrMatrix : codeOrMatrix.matrix;
  assert(Array.isArray(matrix) && matrix.length > 0, "A matrix is required.");
  const sizing = resolveRenderSizing(options, matrix.length);
  const { moduleSize, quietZone, pixelSize } = sizing;
  const palette = resolveRenderPalette(options);
  const paletteValues = paletteRgb(palette);
  const mode = normalizeRenderMode(options.mode ?? options.renderMode ?? RENDER_MODES.SCREEN);
  const style = normalizeRenderStyle(mode === RENDER_MODES.PRINT && options.allowStyledPrint !== true ? RENDER_STYLES.CLASSIC : options.style);
  const layout = renderLayoutForMatrix(matrix);
  const cellEncoding = inferCellEncoding(codeOrMatrix, matrix, layout);
  const size = matrix.length;
  const logo = resolveLogoRenderOptions(options, size, moduleSize, quietZone, palette, codeOrMatrix);
  const body = [svgRect(0, 0, pixelSize, pixelSize, palette.white)];

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const cell = matrix[r][c];
      const structural = isStructuralRenderCell(layout, r, c, cell);
      const x = (c + quietZone) * moduleSize;
      const y = (r + quietZone) * moduleSize;
      const fill = cellEncoding === CELL_ENCODINGS.TRIANGLE16 && !structural ? null : cellColor(cell, palette);

      if (cellEncoding === CELL_ENCODINGS.TRIANGLE16 && !structural) {
        body.push(svgTriangleCell(x, y, moduleSize, cell, palette));
        continue;
      }

      if (style === RENDER_STYLES.CLASSIC || structural) {
        body.push(svgRect(x, y, moduleSize, moduleSize, fill));
        continue;
      }

      const rgb = cellRgb(cell, paletteValues);

      if (style === RENDER_STYLES.DEPTH) {
        const opacity = depthOpacity(r, c, cell);
        const base = mixRgb(paletteValues.white, rgb, opacity);
        body.push(svgRect(x, y, moduleSize, moduleSize, rgbCss(base)));
        if (moduleSize >= 6) {
          const edge = Math.max(1, Math.floor(moduleSize * 0.08));
          const highlight = rgbCss(mixRgb(base, paletteValues.white, 0.17));
          const shadow = rgbCss(mixRgb(base, paletteValues.black, 0.12));
          body.push(svgRect(x, y, moduleSize, edge, highlight));
          body.push(svgRect(x, y, edge, moduleSize, highlight));
          body.push(svgRect(x, y + moduleSize - edge, moduleSize, edge, shadow));
          body.push(svgRect(x + moduleSize - edge, y, edge, moduleSize, shadow));
        }
        continue;
      }

      if (style === RENDER_STYLES.SOFT) {
        const inset = moduleSize >= 6 ? Math.max(1, Math.floor(moduleSize * 0.07)) : 0;
        const width = moduleSize - inset * 2;
        const radius = Math.max(1, Math.floor(moduleSize * 0.20));
        body.push(svgRect(x + inset, y + inset, width, width, fill, radius));
        continue;
      }

      if (style === RENDER_STYLES.INSET) {
        body.push(svgRect(x, y, moduleSize, moduleSize, fill));
        if (cell === CELL.WHITE) continue;
        const edge = safeStyleEdge(moduleSize);
        if (edge > 0) {
          const fx = insetStyleColors(rgb, paletteValues);
          const shadow = rgbCss(fx.shadow);
          const highlight = rgbCss(fx.highlight);
          body.push(svgRect(x, y, moduleSize, edge, shadow));
          body.push(svgRect(x, y, edge, moduleSize, shadow));
          body.push(svgRect(x, y + moduleSize - edge, moduleSize, edge, highlight));
          body.push(svgRect(x + moduleSize - edge, y, edge, moduleSize, highlight));
        }
      }
    }
  }

  if (logo) {
    if (logo.clearBackground) {
      body.push(svgRect(
        logo.backgroundX,
        logo.backgroundY,
        logo.backgroundSize,
        logo.backgroundSize,
        logo.backgroundColor,
        logo.backgroundRadius
      ));
    }
    const href = svgLogoHref(logo.source);
    assert(href, "renderToSVG() logo must be a URL/data URL string or an object with a src string.");
    body.push(
      `<image href="${escapeXmlAttribute(href)}" x="${logo.logoX}" y="${logo.logoY}" width="${logo.logoSize}" height="${logo.logoSize}" preserveAspectRatio="xMidYMid meet"/>`
    );
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelSize}" height="${pixelSize}" viewBox="0 0 ${pixelSize} ${pixelSize}" shape-rendering="crispEdges">`,
    ...body,
    "</svg>"
  ].join("\n");
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function identityColorTransform(rgb) {
  return rgb;
}

function makeWhiteBalanceTransform(observed) {
  const black = observed.black;
  const white = observed.white;
  const ranges = {
    r: Math.max(32, white.r - black.r),
    g: Math.max(32, white.g - black.g),
    b: Math.max(32, white.b - black.b)
  };

  return (rgb) => ({
    // Normalize the camera's observed black/white points per channel. This
    // boosts a suppressed blue channel under warm/yellow illumination without
    // changing the QuadQR palette or payload capacity.
    r: clampNumber((rgb.r - black.r) * 255 / ranges.r, -96, 384),
    g: clampNumber((rgb.g - black.g) * 255 / ranges.g, -96, 384),
    b: clampNumber((rgb.b - black.b) * 255 / ranges.b, -96, 384)
  });
}

function solveLinearSystem(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, index) => row.slice().concat(vector[index]));
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-9) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const divisor = a[col][col];
    for (let j = col; j <= n; j++) a[col][j] /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      if (Math.abs(factor) < 1e-12) continue;
      for (let j = col; j <= n; j++) a[row][j] -= factor * a[col][j];
    }
  }
  return a.map((row) => row[n]);
}

function makeAffineCalibrationTransform(observed) {
  const ideal = {
    black: { r: 0, g: 0, b: 0 },
    white: { r: 255, g: 255, b: 255 },
    red: { r: 255, g: 0, b: 0 },
    green: { r: 0, g: 255, b: 0 },
    blue: { r: 0, g: 0, b: 255 }
  };
  const keys = ["black", "white", "red", "green", "blue"];
  const rows = keys.map((key) => {
    const rgb = observed[key];
    return [rgb.r, rgb.g, rgb.b, 1];
  });
  const normal = Array.from({ length: 4 }, () => Array(4).fill(0));
  for (const row of rows) {
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) normal[i][j] += row[i] * row[j];
    }
  }
  // A tiny ridge term keeps the transform stable if the photographed palette
  // becomes nearly singular under severe clipping or monochromatic lighting.
  const ridge = 1e-4;
  for (let i = 0; i < 4; i++) normal[i][i] += ridge;

  const coefficients = {};
  for (const channel of ["r", "g", "b"]) {
    const rhs = Array(4).fill(0);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const x = rows[rowIndex];
      const y = ideal[keys[rowIndex]][channel];
      for (let i = 0; i < 4; i++) rhs[i] += x[i] * y;
    }
    coefficients[channel] = solveLinearSystem(normal, rhs);
    if (!coefficients[channel]) return null;
  }

  const transform = (rgb) => {
    const x = [rgb.r, rgb.g, rgb.b, 1];
    const mapChannel = (channel) => coefficients[channel].reduce((sum, value, index) => sum + value * x[index], 0);
    return {
      r: clampNumber(mapChannel("r"), -96, 384),
      g: clampNumber(mapChannel("g"), -96, 384),
      b: clampNumber(mapChannel("b"), -96, 384)
    };
  };

  let errorSq = 0;
  for (const key of keys) {
    const mapped = transform(observed[key]);
    const target = ideal[key];
    errorSq += colorDistanceSq(mapped, target);
  }
  return { transform, ideal, rmsError: Math.sqrt(errorSq / (keys.length * 3)) };
}

function classifierFromPaletteRgb(observed, mode = "raw") {
  const affine = mode === "affine" ? makeAffineCalibrationTransform(observed) : null;
  const transform = affine?.transform ?? (mode === "balanced" || mode === "hue"
    ? makeWhiteBalanceTransform(observed)
    : identityColorTransform);
  const idealEntries = affine ? [
    { cell: CELL.BLACK, rgb: affine.ideal.black },
    { cell: CELL.WHITE, rgb: affine.ideal.white },
    { cell: CELL.RED, rgb: affine.ideal.red },
    { cell: CELL.GREEN, rgb: affine.ideal.green },
    { cell: CELL.BLUE, rgb: affine.ideal.blue }
  ] : null;
  const entries = idealEntries ?? [
    { cell: CELL.BLACK, rgb: transform(observed.black) },
    { cell: CELL.WHITE, rgb: transform(observed.white) },
    { cell: CELL.RED, rgb: transform(observed.red) },
    { cell: CELL.GREEN, rgb: transform(observed.green) },
    { cell: CELL.BLUE, rgb: transform(observed.blue) }
  ];
  const colored = entries.filter(({ cell }) => cell === CELL.RED || cell === CELL.GREEN || cell === CELL.BLUE);
  const chroma = (rgb) => Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b);
  const minimumColorChroma = Math.min(...colored.map(({ rgb }) => chroma(rgb)));
  return {
    entries,
    transform,
    mode,
    calibrationModel: affine ? "affine-3x4" : (mode === "balanced" || mode === "hue" ? "black-white-balance" : "observed-palette"),
    calibrationError: affine?.rmsError ?? null,
    dataMode: mode === "hue" ? "hue" : "distance",
    whiteChroma: chroma(entries.find(({ cell }) => cell === CELL.WHITE).rgb),
    minimumColorChroma
  };
}

function colorDistanceSq(a, b) {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
}

function rankRgbCandidates(rgb, classifier) {
  const transformed = classifier.transform(rgb);
  return classifier.entries
    .map((candidate) => ({
      cell: candidate.cell,
      rgb: candidate.rgb,
      distance: Math.sqrt(colorDistanceSq(transformed, candidate.rgb))
    }))
    .sort((a, b) => (a.distance - b.distance) || (a.cell - b.cell));
}

function classifyRgb(rgb, classifier) {
  const ranked = rankRgbCandidates(rgb, classifier);
  const best = ranked[0];
  const second = ranked[1] ?? { cell: best.cell, distance: best.distance + 1 };
  const confidence = Math.max(0, Math.min(1, (second.distance - best.distance) / Math.max(second.distance, 1e-6)));
  return {
    cell: best.cell,
    distance: best.distance,
    confidence,
    alternativeCell: second.cell,
    alternativeDistance: second.distance,
    ambiguity: 1 - confidence
  };
}


function classifyDataHue(rgb, classifier) {
  const transformed = classifier.transform(rgb);
  const channels = [
    { cell: CELL.RED, value: transformed.r },
    { cell: CELL.GREEN, value: transformed.g },
    { cell: CELL.BLUE, value: transformed.b }
  ].sort((a, b) => b.value - a.value);
  const maxValue = channels[0].value;
  const secondValue = channels[1].value;
  const minValue = channels[2].value;
  const chroma = maxValue - minValue;
  const whiteThreshold = Math.max(18, Math.min(58, classifier.minimumColorChroma * 0.34));

  if (chroma <= whiteThreshold) {
    const confidence = clampNumber((whiteThreshold - chroma) / Math.max(whiteThreshold, 1), 0, 1);
    return { cell: CELL.WHITE, distance: chroma, confidence: 0.35 + confidence * 0.65 };
  }

  const margin = maxValue - secondValue;
  const hueConfidence = clampNumber(margin / Math.max(chroma, 1), 0, 1);
  const saturationConfidence = clampNumber((chroma - whiteThreshold) / Math.max(classifier.minimumColorChroma - whiteThreshold, 1), 0, 1);
  return {
    cell: channels[0].cell,
    distance: Math.max(0, classifier.minimumColorChroma - chroma),
    confidence: clampNumber(0.18 + hueConfidence * 0.52 + saturationConfidence * 0.30, 0, 1)
  };
}

function classifySampledRgbGrid(rgbGrid, classifier, layout = null) {
  const size = rgbGrid.length;
  const matrix = make2D(size, CELL.WHITE);
  const confidence = make2D(size, 1);
  const alternatives = make2D(size, null);
  const dataClassifier = {
    ...classifier,
    entries: classifier.entries.filter(({ cell }) => cell !== CELL.BLACK)
  };
  let distanceSum = 0;
  let confidenceSum = 0;
  let minimumConfidence = 1;
  let lowConfidenceCells = 0;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      // Black is structural only. Restricting data modules to RGBW keeps a
      // shadowed/blurred data sample representable so confidence-aware ECC can
      // promote it to an erasure instead of aborting before RS gets a chance.
      const isDataCell = layout && !layout.reserved[r][c];
      const candidates = isDataCell ? dataClassifier : classifier;
      const classified = isDataCell && classifier.dataMode === "hue"
        ? classifyDataHue(rgbGrid[r][c], classifier)
        : classifyRgb(rgbGrid[r][c], candidates);
      const ranked = rankRgbCandidates(rgbGrid[r][c], candidates);
      const alternate = ranked.find((candidate) => candidate.cell !== classified.cell);
      matrix[r][c] = classified.cell;
      confidence[r][c] = classified.confidence;
      alternatives[r][c] = alternate?.cell ?? null;
      distanceSum += classified.distance;
      confidenceSum += classified.confidence;
      minimumConfidence = Math.min(minimumConfidence, classified.confidence);
      if (classified.confidence < 0.4) lowConfidenceCells++;
    }
  }
  return {
    matrix,
    confidence,
    alternatives,
    averageColorDistance: distanceSum / (size * size),
    averageCellConfidence: confidenceSum / (size * size),
    minimumCellConfidence: minimumConfidence,
    lowConfidenceCells
  };
}

function classifyTriangleSampledRgbGrid(rgbGrid, triangleGrid, classifier, layout) {
  const size = rgbGrid.length;
  const matrix = make2D(size, CELL.WHITE);
  const confidence = make2D(size, 1);
  const alternatives = make2D(size, null);
  const dataClassifier = {
    ...classifier,
    entries: classifier.entries.filter(({ cell }) => cell !== CELL.BLACK)
  };
  let distanceSum = 0;
  let confidenceSum = 0;
  let minimumConfidence = 1;
  let lowConfidenceCells = 0;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const isDataCell = layout && !layout.reserved[r][c];
      if (!isDataCell) {
        const classified = classifyRgb(rgbGrid[r][c], classifier);
        matrix[r][c] = classified.cell;
        confidence[r][c] = classified.confidence;
        alternatives[r][c] = classified.alternativeCell ?? null;
        distanceSum += classified.distance;
        confidenceSum += classified.confidence;
        minimumConfidence = Math.min(minimumConfidence, classified.confidence);
        if (classified.confidence < 0.4) lowConfidenceCells++;
        continue;
      }

      const samples = triangleGrid?.[r]?.[c];
      if (!samples) throw new Error("Triangle16 sampling grid is incomplete.");
      const classifyData = (rgb) => classifier.dataMode === "hue"
        ? classifyDataHue(rgb, classifier)
        : classifyRgb(rgb, dataClassifier);
      const first = classifyData(samples.first);
      const second = classifyData(samples.second);
      const firstRanked = rankRgbCandidates(samples.first, dataClassifier);
      const secondRanked = rankRgbCandidates(samples.second, dataClassifier);
      const firstAlt = firstRanked.find((candidate) => candidate.cell !== first.cell)?.cell ?? first.cell;
      const secondAlt = secondRanked.find((candidate) => candidate.cell !== second.cell)?.cell ?? second.cell;
      const firstSpread = Number(samples.firstSpread ?? 0);
      const secondSpread = Number(samples.secondSpread ?? 0);
      const stability = clampNumber(1 - Math.max(firstSpread, secondSpread) / 110, 0.35, 1);
      const cellConfidence = Math.min(first.confidence, second.confidence) * (0.68 + stability * 0.32);
      matrix[r][c] = packTriangleCell(first.cell, second.cell);
      // Prefer changing the region with the weaker classification. If both are
      // similarly uncertain, changing the more spatially unstable region first
      // gives Spectrum ECC 2.0 a better second hypothesis.
      const firstRisk = (1 - first.confidence) + firstSpread / 255;
      const secondRisk = (1 - second.confidence) + secondSpread / 255;
      alternatives[r][c] = firstRisk >= secondRisk
        ? packTriangleCell(firstAlt, second.cell)
        : packTriangleCell(first.cell, secondAlt);
      confidence[r][c] = clampNumber(cellConfidence, 0, 1);
      distanceSum += (first.distance + second.distance) / 2;
      confidenceSum += confidence[r][c];
      minimumConfidence = Math.min(minimumConfidence, confidence[r][c]);
      if (confidence[r][c] < 0.4) lowConfidenceCells++;
    }
  }

  return {
    matrix,
    confidence,
    alternatives,
    averageColorDistance: distanceSum / (size * size),
    averageCellConfidence: confidenceSum / (size * size),
    minimumCellConfidence: minimumConfidence,
    lowConfidenceCells
  };
}

function structuralAccuracy(matrix, layout) {
  let matches = 0;
  let total = 0;
  for (let r = 0; r < layout.size; r++) {
    for (let c = 0; c < layout.size; c++) {
      if (!layout.reserved[r][c]) continue;
      total++;
      if (matrix[r][c] === layout.matrix[r][c]) matches++;
    }
  }
  return total ? matches / total : 0;
}

function pushObservation(options, observation) {
  if (!Array.isArray(options._observationCollector)) return;
  options._observationCollector.push(observation);
}

function paletteClassifierAttempts(observedPalette) {
  return [
    { classifier: classifierFromPaletteRgb(observedPalette, "raw"), colorNormalization: "observed-rgb" },
    { classifier: classifierFromPaletteRgb(observedPalette, "balanced"), colorNormalization: "white-balanced" },
    { classifier: classifierFromPaletteRgb(observedPalette, "affine"), colorNormalization: "affine-calibrated" },
    { classifier: classifierFromPaletteRgb(observedPalette, "hue"), colorNormalization: "white-balanced-hue" }
  ];
}

function tryPerspectiveScan(imageData, options) {
  const geometryCandidates = Array.isArray(options._geometryCandidatesOverride) && options._geometryCandidatesOverride.length
    ? options._geometryCandidatesOverride
    : detectCodeGeometry(imageData, {
        minVersion: options.minVersion ?? MIN_VERSION,
        maxVersion: options.maxVersion ?? MAX_VERSION,
        maxCandidates: options.maxGeometryCandidates ?? 8,
        finderRecovery: options.finderRecovery,
        finderAutoColorBlackClip: options.finderAutoColorBlackClip,
        finderAutoColorWhiteClip: options.finderAutoColorWhiteClip,
        finderAutoColorHighlightPercentile: options.finderAutoColorHighlightPercentile,
        finderAutoColorOutputHighlight: options.finderAutoColorOutputHighlight,
        finderAutoColorAnalysisInset: options.finderAutoColorAnalysisInset,
        finderAutoColorMinimumInputRange: options.finderAutoColorMinimumInputRange,
        finderAutoColorTargetSamples: options.finderAutoColorTargetSamples,
        preciseAlignment: options.preciseAlignment,
        diagnostics: options._visionDiagnostics,
        diagnosticLabel: options._diagnosticLabel ?? "normal"
      });
  if (Array.isArray(options._geometryCollector)) options._geometryCollector.push(...geometryCandidates);
  const results = [];

  for (const geometry of geometryCandidates) {
    const layout = createLayout(geometry.version, {
      alignmentProfile: geometry.alignmentProfile ?? ALIGNMENT_PROFILE_STANDARD_5
    });
    const sampleProfiles = [{
      sampleMode: options.sampleMode ?? "cross",
      sampleRadius: options.sampleRadius ?? 0.16,
      robustCalibration: false
    }];
    if (options.adaptiveSampling !== false) {
      sampleProfiles.push({
        sampleMode: "median",
        sampleRadius: options.robustSampleRadius ?? 0.12,
        robustCalibration: true
      });
    }

    let geometryDecoded = false;
    let bestStructureScore = 0;
    for (const profile of sampleProfiles) {
      let sampled;
      let triangleSampled = null;
      let observedPalette;
      try {
        sampled = samplePerspectiveMatrix(imageData, geometry.homography, layout.size, profile);
        if (options.highDensitySampling !== false && options.triangle16 !== false) {
          triangleSampled = samplePerspectiveTriangleMatrix(
            imageData,
            geometry.homography,
            layout.size,
            profile
          );
        }
        observedPalette = sampleObservedPalette(sampled.rgbGrid, layout.calibration, {
          robust: profile.robustCalibration
        });
      } catch {
        continue;
      }

      const tryAttempt = (attempt, rgbGrid, metadata = {}, allowSoftDecoding = options.softDecoding !== false) => {
        const activeObservedPalette = metadata.observedPalette ?? observedPalette;
        const activeSamplingMode = metadata.samplingMode ?? profile.sampleMode;
        const classified = classifySampledRgbGrid(rgbGrid, attempt.classifier, layout);
        const structureScore = structuralAccuracy(classified.matrix, layout);
        bestStructureScore = Math.max(bestStructureScore, structureScore);
        pushObservation(options, {
          version: geometry.version,
          matrix: classified.matrix,
          confidence: classified.confidence,
          alternatives: classified.alternatives,
          geometry,
          observedPalette: activeObservedPalette,
          samplingMode: activeSamplingMode,
          colorNormalization: attempt.colorNormalization,
          structureScore,
          averageCellConfidence: classified.averageCellConfidence,
          lowConfidenceCells: classified.lowConfidenceCells
        });

        try {
          const decoded = decodeMatrix(classified.matrix, {
            structureTolerance: options.structureTolerance ?? 0.18,
            cellConfidence: classified.confidence,
            cellAlternatives: classified.alternatives,
            cellEncodingHint: CELL_ENCODINGS.RGBW,
            alignmentProfileHint: geometry.alignmentProfile ?? ALIGNMENT_PROFILE_STANDARD_5,
            softDecoding: allowSoftDecoding,
            maxErasureConfidence: options.maxErasureConfidence
          });
          if (decoded.version !== geometry.version) return false;

          results.push({
            ...decoded,
            perspectiveCorrected: true,
            colorCalibrated: true,
            colorNormalization: attempt.colorNormalization,
            samplingMode: activeSamplingMode,
            geometry,
            observedPalette: activeObservedPalette,
            autoEnhanced: metadata.autoEnhanced || undefined,
            recoveryMode: metadata.recoveryMode,
            averageColorDistance: classified.averageColorDistance,
            averageCellConfidence: classified.averageCellConfidence,
            minimumCellConfidence: classified.minimumCellConfidence,
            lowConfidenceCells: classified.lowConfidenceCells,
            rectified: options.includeRectified
              ? rectifyImageData(imageData, geometry.homography, layout.size, options.rectifiedModuleSize ?? 8)
              : undefined
          });
          return true;
        } catch {
          return false;
        }
      };

      const tryTriangleAttempt = (attempt, metadata = {}, allowSoftDecoding = options.softDecoding !== false) => {
        if (!triangleSampled?.triangleGrid) return false;
        const activeObservedPalette = metadata.observedPalette ?? observedPalette;
        const activeSamplingMode = metadata.samplingMode ?? `${profile.sampleMode}-triangle16`;
        const classified = classifyTriangleSampledRgbGrid(
          sampled.rgbGrid,
          triangleSampled.triangleGrid,
          attempt.classifier,
          layout
        );
        const structureScore = structuralAccuracy(classified.matrix, layout);
        bestStructureScore = Math.max(bestStructureScore, structureScore);
        pushObservation(options, {
          version: geometry.version,
          matrix: classified.matrix,
          confidence: classified.confidence,
          alternatives: classified.alternatives,
          geometry,
          observedPalette: activeObservedPalette,
          samplingMode: activeSamplingMode,
          colorNormalization: attempt.colorNormalization,
          cellEncoding: CELL_ENCODINGS.TRIANGLE16,
          structureScore,
          averageCellConfidence: classified.averageCellConfidence,
          lowConfidenceCells: classified.lowConfidenceCells
        });

        try {
          const decoded = decodeMatrix(classified.matrix, {
            structureTolerance: options.structureTolerance ?? 0.18,
            cellConfidence: classified.confidence,
            cellAlternatives: classified.alternatives,
            cellEncodingHint: CELL_ENCODINGS.TRIANGLE16,
            alignmentProfileHint: geometry.alignmentProfile ?? ALIGNMENT_PROFILE_STANDARD_5,
            softDecoding: allowSoftDecoding,
            maxErasureConfidence: options.maxErasureConfidence
          });
          if (decoded.version !== geometry.version) return false;
          results.push({
            ...decoded,
            perspectiveCorrected: true,
            colorCalibrated: true,
            colorNormalization: attempt.colorNormalization,
            samplingMode: activeSamplingMode,
            geometry,
            observedPalette: activeObservedPalette,
            averageColorDistance: classified.averageColorDistance,
            averageCellConfidence: classified.averageCellConfidence,
            minimumCellConfidence: classified.minimumCellConfidence,
            lowConfidenceCells: classified.lowConfidenceCells,
            rectified: options.includeRectified
              ? rectifyImageData(imageData, geometry.homography, layout.size, options.rectifiedModuleSize ?? 8)
              : undefined
          });
          return true;
        } catch {
          return false;
        }
      };

      // Fast path: preserve the original observed-RGB classifier first, then
      // try per-channel white balancing. Most clean frames stop here without
      // paying for the more expensive spatial normalization fallback.
      const basePaletteAttempts = paletteClassifierAttempts(observedPalette);
      for (const attempt of basePaletteAttempts) {
        if (tryAttempt(attempt, sampled.rgbGrid, {}, false) || tryTriangleAttempt(attempt, {}, false)) {
          geometryDecoded = true;
          break;
        }
      }
      // Spectrum ECC soft decoding is intentionally deferred until every cheap
      // hard classifier has had a chance. This preserves the exact recovery
      // candidates while avoiding expensive second-hypothesis RS searches when
      // a later normal color model can decode the frame immediately.
      if (!geometryDecoded && options.softDecoding !== false) {
        for (const attempt of basePaletteAttempts) {
          if (tryAttempt(attempt, sampled.rgbGrid, {}, true) || tryTriangleAttempt(attempt, {}, true)) {
            geometryDecoded = true;
            break;
          }
        }
      }

      if (!geometryDecoded && options.spatialColorNormalization !== false) {
        try {
          const normalizedGrid = spatiallyNormalizeRgbGrid(sampled.rgbGrid, layout.calibration);
          const normalizedPalette = sampleObservedPalette(normalizedGrid, layout.calibration, { robust: true });
          const spatialAttempt = {
            classifier: classifierFromPaletteRgb(normalizedPalette, "raw"),
            colorNormalization: "spatial-white-balanced"
          };
          geometryDecoded = tryAttempt(spatialAttempt, normalizedGrid, {}, false);
          if (!geometryDecoded && options.softDecoding !== false) {
            geometryDecoded = tryAttempt(spatialAttempt, normalizedGrid, {}, true);
          }
        } catch {
          // Continue to the recovery profile below.
        }
      }

      // Lightweight QuadQR color recovery on the already-sampled module grid.
      // Normal camera frames never reach this path. The transform combines
      // QuadQR Auto Color + Auto Tone + Auto Contrast and costs only O(moduleCount).
      if (!geometryDecoded && options.autoEnhanceRecovery !== false) {
        try {
          const enhancedGrid = autoToneContrastColorRgbGrid(sampled.rgbGrid, {
            blackClip: options.autoEnhanceBlackClip,
            whiteClip: options.autoEnhanceWhiteClip,
            saturation: options.autoEnhanceSaturation
          });
          const enhancedPalette = sampleObservedPalette(enhancedGrid, layout.calibration, { robust: true });
          const enhancedAttempts = paletteClassifierAttempts(enhancedPalette).map((attempt) => ({
            ...attempt,
            colorNormalization: `auto-tone-contrast-color/${attempt.colorNormalization}`
          }));
          for (const recoveredAttempt of enhancedAttempts) {
            if (tryAttempt(recoveredAttempt, enhancedGrid, {
              observedPalette: enhancedPalette,
              autoEnhanced: true,
              recoveryMode: "module-grid-auto-tone-contrast-color"
            }, false)) {
              geometryDecoded = true;
              break;
            }
          }
          if (!geometryDecoded && options.softDecoding !== false) {
            for (const recoveredAttempt of enhancedAttempts) {
              if (tryAttempt(recoveredAttempt, enhancedGrid, {
                observedPalette: enhancedPalette,
                autoEnhanced: true,
                recoveryMode: "module-grid-auto-tone-contrast-color"
              }, true)) {
                geometryDecoded = true;
                break;
              }
            }
          }
        } catch {
          // Continue to the QR-region pixel recovery below.
        }
      }

      // Camera-specific QuadQR color-recovery fallback. Enhancing the whole camera
      // frame is often ineffective because dark surroundings, browser/UI
      // reflections and unrelated objects skew the histograms. Once finder
      // geometry is known, rectify only the QuadQR region, run Auto Tone /
      // Contrast / Color there at pixel level, then sample modules again. This
      // closely matches what happens when the QR itself is corrected in an
      // editor before photographing it, while staying off the clean fast path.
      if (
        !geometryDecoded &&
        profile === sampleProfiles[sampleProfiles.length - 1] &&
        options.autoEnhanceRecovery !== false &&
        options.rectifiedAutoEnhanceRecovery !== false
      ) {
        try {
          const recoveryModuleSize = Math.max(4, Math.min(10, Math.round(options.rectifiedRecoveryModuleSize ?? 6)));
          const rectifiedRegion = rectifyImageData(
            imageData,
            geometry.homography,
            layout.size,
            recoveryModuleSize
          );
          const enhancedRegion = autoToneContrastColorImageData(rectifiedRegion, {
            blackClip: options.rectifiedAutoEnhanceBlackClip ?? options.autoEnhanceBlackClip ?? 0.008,
            whiteClip: options.rectifiedAutoEnhanceWhiteClip ?? options.autoEnhanceWhiteClip ?? 0.006,
            saturation: options.rectifiedAutoEnhanceSaturation ?? options.autoEnhanceSaturation ?? 1.22,
            highlightFraction: options.rectifiedAutoEnhanceHighlightFraction ?? 0.16,
            targetSamples: Math.min(120000, rectifiedRegion.width * rectifiedRegion.height)
          });
          const enhancedSampled = sampleAxisAlignedGrid(
            enhancedRegion,
            { x: 0, y: 0, width: enhancedRegion.width, height: enhancedRegion.height },
            layout.size,
            options.rectifiedRecoveryRadiusRatio ?? 0.16
          );
          const enhancedPalette = sampleObservedPalette(
            enhancedSampled.rgbGrid,
            layout.calibration,
            { robust: true }
          );
          const rectifiedAttempts = paletteClassifierAttempts(enhancedPalette).map((attempt) => ({
            ...attempt,
            colorNormalization: `rectified-auto-tone-contrast-color/${attempt.colorNormalization}`
          }));
          for (const recoveredAttempt of rectifiedAttempts) {
            if (tryAttempt(recoveredAttempt, enhancedSampled.rgbGrid, {
              observedPalette: enhancedPalette,
              samplingMode: "rectified-auto-enhance",
              autoEnhanced: true,
              recoveryMode: "rectified-auto-tone-contrast-color"
            }, false)) {
              geometryDecoded = true;
              break;
            }
          }
          if (!geometryDecoded && options.softDecoding !== false) {
            for (const recoveredAttempt of rectifiedAttempts) {
              if (tryAttempt(recoveredAttempt, enhancedSampled.rgbGrid, {
                observedPalette: enhancedPalette,
                samplingMode: "rectified-auto-enhance",
                autoEnhanced: true,
                recoveryMode: "rectified-auto-tone-contrast-color"
              }, true)) {
                geometryDecoded = true;
                break;
              }
            }
          }
        } catch {
          // Geometry refinement remains available as the final bounded fallback.
        }
      }

      if (geometryDecoded) break;
    }

    // A decoded QuadQR has already passed structural validation, Spectrum ECC,
    // and the payload CRC. Continuing through every lower-ranked geometry after
    // that point used to spend most of the camera scan time proving the same
    // frame again. Return the first authenticated decode immediately. An opt-in
    // diagnostic mode can still collect every successful geometry if needed.
    if (geometryDecoded && options.collectAllGeometryResults !== true) {
      return results[results.length - 1] ?? null;
    }

    // Slow-path geometry micro-refinement. Finder/alignment detection can be
    // correct while a soft-focus or smeared camera shifts the effective module
    // centres by a small fraction of a cell. Clean scans never reach this code.
    // On a strong-but-undecodable symbol, probe a tiny 3x3 offset neighbourhood
    // using centre-only samples and attempt decoding from the best candidates.
    if (
      !geometryDecoded &&
      options.geometryRefinement !== false &&
      bestStructureScore >= (options.refinementStructureThreshold ?? 0.90)
    ) {
      const step = clampNumber(options.refinementOffset ?? 0.20, 0.05, 0.35);
      const refinementOffsets = [
        [step, 0], [-step, 0], [0, -step], [0, step],
        [step, -step], [step, step], [-step, -step], [-step, step]
      ];
      const refinementCandidates = [];
      const triangleRefinementCandidates = [];

      for (const [offsetX, offsetY] of refinementOffsets) {
        let sampled;
        let triangleSampled = null;
        let observedPalette;
        try {
          const samplingOptions = {
            sampleMode: "cross",
            sampleRadius: 0,
            sampleOffsetX: offsetX,
            sampleOffsetY: offsetY,
            triangleSampleInset: options.highDensitySampleInset ?? options.triangleSampleInset,
            triangleSampleRadius: options.highDensitySampleRadius ?? options.triangleSampleRadius
          };
          sampled = samplePerspectiveMatrix(imageData, geometry.homography, layout.size, samplingOptions);
          if (options.highDensitySampling !== false && options.triangle16 !== false) {
            triangleSampled = samplePerspectiveTriangleMatrix(
              imageData,
              geometry.homography,
              layout.size,
              samplingOptions
            );
          }
          observedPalette = sampleObservedPalette(sampled.rgbGrid, layout.calibration, { robust: true });
        } catch {
          continue;
        }

        // Raw observed-palette classification is deliberately first here too.
        // It is cheap, and it handles the common case where blur biased the
        // geometry slightly but the camera colors themselves remain usable.
        const attempts = paletteClassifierAttempts(observedPalette);
        for (const attempt of attempts) {
          const classified = classifySampledRgbGrid(sampled.rgbGrid, attempt.classifier, layout);
          const structureScore = structuralAccuracy(classified.matrix, layout);
          bestStructureScore = Math.max(bestStructureScore, structureScore);
          pushObservation(options, {
            version: geometry.version,
            matrix: classified.matrix,
            confidence: classified.confidence,
            alternatives: classified.alternatives,
            geometry,
            observedPalette,
            samplingMode: "refined-center",
            samplingOffset: { x: offsetX, y: offsetY },
            colorNormalization: attempt.colorNormalization,
            structureScore,
            averageCellConfidence: classified.averageCellConfidence,
            lowConfidenceCells: classified.lowConfidenceCells
          });

          // Do not spend RS work on a refinement that made the known finder /
          // alignment structure worse. This keeps the recovery path bounded.
          if (structureScore >= (options.refinementDecodeThreshold ?? 0.95)) {
            refinementCandidates.push({
              attempt,
              classified,
              observedPalette,
              offsetX,
              offsetY,
              structureScore,
              cellEncoding: CELL_ENCODINGS.RGBW,
              samplingMode: "refined-center"
            });
          }

          if (triangleSampled?.triangleGrid) {
            const triangleClassified = classifyTriangleSampledRgbGrid(
              sampled.rgbGrid,
              triangleSampled.triangleGrid,
              attempt.classifier,
              layout
            );
            const triangleStructureScore = structuralAccuracy(triangleClassified.matrix, layout);
            bestStructureScore = Math.max(bestStructureScore, triangleStructureScore);
            pushObservation(options, {
              version: geometry.version,
              matrix: triangleClassified.matrix,
              confidence: triangleClassified.confidence,
              alternatives: triangleClassified.alternatives,
              geometry,
              observedPalette,
              samplingMode: "refined-triangle16",
              samplingOffset: { x: offsetX, y: offsetY },
              colorNormalization: attempt.colorNormalization,
              cellEncoding: CELL_ENCODINGS.TRIANGLE16,
              structureScore: triangleStructureScore,
              averageCellConfidence: triangleClassified.averageCellConfidence,
              lowConfidenceCells: triangleClassified.lowConfidenceCells
            });
            if (triangleStructureScore >= (options.refinementDecodeThreshold ?? 0.95)) {
              triangleRefinementCandidates.push({
                attempt,
                classified: triangleClassified,
                observedPalette,
                offsetX,
                offsetY,
                structureScore: triangleStructureScore,
                cellEncoding: CELL_ENCODINGS.TRIANGLE16,
                samplingMode: "refined-triangle16"
              });
            }
          }
        }
      }

      const sortRefinementCandidates = (items) => items.sort((a, b) =>
        (b.structureScore - a.structureScore) ||
        (b.classified.averageCellConfidence - a.classified.averageCellConfidence) ||
        (a.classified.averageColorDistance - b.classified.averageColorDistance)
      );
      sortRefinementCandidates(refinementCandidates);
      sortRefinementCandidates(triangleRefinementCandidates);

      const decodeLimit = Math.max(1, Math.min(8, Math.round(options.refinementDecodeCandidates ?? 4)));
      // Keep separate per-encoding limits. A Triangle16 image can produce very
      // confident but meaningless centre samples, and those must not crowd out
      // the dual-region candidates during the final bounded recovery pass.
      const decodeCandidates = [
        ...refinementCandidates.slice(0, decodeLimit),
        ...triangleRefinementCandidates.slice(0, decodeLimit)
      ];
      for (const candidate of decodeCandidates) {
        try {
          const decoded = decodeMatrix(candidate.classified.matrix, {
            structureTolerance: options.structureTolerance ?? 0.18,
            cellConfidence: candidate.classified.confidence,
            cellAlternatives: candidate.classified.alternatives,
            cellEncodingHint: candidate.cellEncoding,
            alignmentProfileHint: geometry.alignmentProfile ?? ALIGNMENT_PROFILE_STANDARD_5,
            maxErasureConfidence: options.maxErasureConfidence
          });
          if (decoded.version !== geometry.version) continue;
          results.push({
            ...decoded,
            perspectiveCorrected: true,
            geometryRefined: true,
            samplingOffset: { x: candidate.offsetX, y: candidate.offsetY },
            colorCalibrated: true,
            colorNormalization: candidate.attempt.colorNormalization,
            samplingMode: candidate.samplingMode,
            geometry,
            observedPalette: candidate.observedPalette,
            averageColorDistance: candidate.classified.averageColorDistance,
            averageCellConfidence: candidate.classified.averageCellConfidence,
            minimumCellConfidence: candidate.classified.minimumCellConfidence,
            lowConfidenceCells: candidate.classified.lowConfidenceCells,
            rectified: options.includeRectified
              ? rectifyImageData(imageData, geometry.homography, layout.size, options.rectifiedModuleSize ?? 8)
              : undefined
          });
          geometryDecoded = true;
          break;
        } catch {
          // Try the next high-scoring micro-refinement.
        }
      }
    }


    if (geometryDecoded && options.collectAllGeometryResults !== true) {
      return results[results.length - 1] ?? null;
    }
  }

  results.sort((a, b) =>
    (a.correctedSymbols - b.correctedSymbols) ||
    (a.averageColorDistance - b.averageColorDistance) ||
    (b.geometry.score - a.geometry.score)
  );
  return results[0] ?? null;
}

function tryAxisAlignedScan(imageData, options) {
  const bounds = options.bounds ?? findActiveBounds(imageData, options.whiteThreshold ?? 238);
  const fixedPalette = paletteRgb(options.palette);
  const minVersion = options.minVersion ?? MIN_VERSION;
  const maxVersion = options.maxVersion ?? MAX_VERSION;
  const candidates = [];

  for (let version = minVersion; version <= maxVersion; version++) {
    const size = sizeForVersion(version);
    const moduleW = bounds.width / size;
    const moduleH = bounds.height / size;
    if (moduleW < 0.75 || moduleH < 0.75) continue;
    const aspectError = Math.abs(moduleW - moduleH) / Math.max(moduleW, moduleH);
    if (aspectError > (options.maxModuleAspectError ?? 0.16)) continue;

    const radiusProfiles = [options.sampleRadius ?? 0.18];
    if (options.adaptiveSampling !== false) radiusProfiles.push(options.robustSampleRadius ?? 0.10);
    let accepted = false;

    for (let profileIndex = 0; profileIndex < radiusProfiles.length && !accepted; profileIndex++) {
      try {
        const sampled = sampleAxisAlignedGrid(imageData, bounds, size, radiusProfiles[profileIndex]);
        const triangleSampled = options.highDensitySampling === false || options.triangle16 === false
          ? null
          : sampleAxisAlignedTriangleGrid(
              imageData,
              bounds,
              size,
              Math.min(0.10, Math.max(0.04, radiusProfiles[profileIndex] * 0.48)),
              options.highDensitySampleInset ?? options.triangleSampleInset ?? 0.28
            );
        const layout = createLayout(version);
        const classifierAttempts = [];
        try {
          const observedPalette = sampleObservedPalette(sampled.rgbGrid, layout.calibration, {
            robust: profileIndex > 0
          });
          classifierAttempts.push(...paletteClassifierAttempts(observedPalette).map((attempt) => ({
            ...attempt,
            calibrated: true,
            observedPalette,
            rgbGrid: sampled.rgbGrid
          })));
          if (options.spatialColorNormalization !== false) {
            try {
              const normalizedGrid = spatiallyNormalizeRgbGrid(sampled.rgbGrid, layout.calibration);
              const normalizedPalette = sampleObservedPalette(normalizedGrid, layout.calibration, { robust: true });
              classifierAttempts.push({
                classifier: classifierFromPaletteRgb(normalizedPalette, "raw"),
                calibrated: true,
                colorNormalization: "spatial-white-balanced",
                observedPalette,
                rgbGrid: normalizedGrid
              });
            } catch {
              // Continue with global calibration/fixed palette.
            }
          }
        } catch {
          // Fixed palette fallback below.
        }
        classifierAttempts.push({
          classifier: classifierFromPaletteRgb(fixedPalette, "raw"),
          calibrated: false,
          colorNormalization: "fixed-rgb",
          observedPalette: fixedPalette,
          rgbGrid: sampled.rgbGrid
        });

        for (const attempt of classifierAttempts) {
          const centerGrid = attempt.rgbGrid ?? sampled.rgbGrid;
          const samplingMode = profileIndex === 0 ? "axis" : "axis-center";
          const classifiedAttempts = [{
            classified: classifySampledRgbGrid(centerGrid, attempt.classifier, layout),
            cellEncoding: CELL_ENCODINGS.RGBW,
            samplingMode
          }];
          if (triangleSampled?.triangleGrid && attempt.rgbGrid === sampled.rgbGrid) {
            classifiedAttempts.push({
              classified: classifyTriangleSampledRgbGrid(
                centerGrid,
                triangleSampled.triangleGrid,
                attempt.classifier,
                layout
              ),
              cellEncoding: CELL_ENCODINGS.TRIANGLE16,
              samplingMode: `${samplingMode}-triangle16`
            });
          }

          for (const classifiedAttempt of classifiedAttempts) {
            try {
              const classified = classifiedAttempt.classified;
              const structureScore = structuralAccuracy(classified.matrix, layout);
              pushObservation(options, {
                version,
                matrix: classified.matrix,
                confidence: classified.confidence,
                alternatives: classified.alternatives,
                bounds,
                samplingMode: classifiedAttempt.samplingMode,
                colorNormalization: attempt.colorNormalization,
                cellEncoding: classifiedAttempt.cellEncoding,
                structureScore,
                averageCellConfidence: classified.averageCellConfidence,
                lowConfidenceCells: classified.lowConfidenceCells
              });
              const decoded = decodeMatrix(classified.matrix, {
                structureTolerance: options.structureTolerance ?? 0.12,
                cellConfidence: classified.confidence,
                cellAlternatives: classified.alternatives,
                cellEncodingHint: classifiedAttempt.cellEncoding,
                maxErasureConfidence: options.maxErasureConfidence
              });
              candidates.push({
                ...decoded,
                bounds,
                sampledVersion: version,
                moduleWidth: moduleW,
                moduleHeight: moduleH,
                perspectiveCorrected: false,
                colorCalibrated: attempt.calibrated,
                colorNormalization: attempt.colorNormalization,
                samplingMode: classifiedAttempt.samplingMode,
                averageColorDistance: classified.averageColorDistance,
                averageCellConfidence: classified.averageCellConfidence,
                minimumCellConfidence: classified.minimumCellConfidence,
                lowConfidenceCells: classified.lowConfidenceCells
              });
              accepted = true;
              break;
            } catch {
              // Try the next cell encoding/classifier/profile.
            }
          }
          if (accepted) break;
        }
      } catch {
        // Try a narrower centre sample, then next version.
      }
    }
  }

  candidates.sort((a, b) =>
    (a.correctedSymbols - b.correctedSymbols) || (a.averageColorDistance - b.averageColorDistance)
  );
  return candidates[0] ?? null;
}



export const STRESS_PROFILES = Object.freeze([
  Object.freeze({ id: "clean", label: "Clean", type: "clean", severity: 0, weight: 2 }),
  Object.freeze({ id: "blur", label: "Blur", type: "blur", severity: 0.42, weight: 1 }),
  Object.freeze({ id: "dark", label: "Low brightness", type: "brightness-low", severity: 0.48, weight: 1 }),
  Object.freeze({ id: "bright", label: "High exposure", type: "brightness-high", severity: 0.34, weight: 1 }),
  Object.freeze({ id: "shadow", label: "Uneven shadow", type: "shadow", severity: 0.55, weight: 1.2 }),
  Object.freeze({ id: "contrast", label: "Contrast loss", type: "contrast-loss", severity: 0.42, weight: 1 }),
  Object.freeze({ id: "perspective", label: "Perspective", type: "perspective", severity: 0.42, weight: 1.3 }),
  Object.freeze({ id: "jpeg", label: "JPEG-like compression", type: "jpeg", severity: 0.50, weight: 0.8 }),
  Object.freeze({ id: "downscale", label: "Downscale", type: "downscale", severity: 0.52, weight: 0.9 })
]);


export const RELIABILITY_PROFILES = Object.freeze([
  Object.freeze({ id: "clean", label: "Clean reference", category: "Baseline", type: "clean", severity: 0, weight: 2, suite: "quick" }),
  Object.freeze({ id: "blur", label: "Lens blur", category: "Optics", type: "blur", severity: 0.40, weight: 1, suite: "quick" }),
  Object.freeze({ id: "motion", label: "Motion blur", category: "Optics", type: "motion-blur", severity: 0.42, weight: 1, suite: "full" }),
  Object.freeze({ id: "dark", label: "Low light", category: "Exposure", type: "brightness-low", severity: 0.50, weight: 1, suite: "quick" }),
  Object.freeze({ id: "bright", label: "High exposure", category: "Exposure", type: "brightness-high", severity: 0.38, weight: 1, suite: "full" }),
  Object.freeze({ id: "shadow", label: "Gradient shadow", category: "Lighting", type: "shadow", severity: 0.58, weight: 1.2, suite: "quick" }),
  Object.freeze({ id: "glare", label: "Specular glare", category: "Lighting", type: "glare", severity: 0.34, weight: 1.1, suite: "full" }),
  Object.freeze({ id: "warm", label: "Warm color cast", category: "Color", type: "warm", severity: 0.62, weight: 1, suite: "quick" }),
  Object.freeze({ id: "cool", label: "Cool color cast", category: "Color", type: "cool", severity: 0.60, weight: 1, suite: "full" }),
  Object.freeze({ id: "contrast", label: "Contrast loss", category: "Color", type: "contrast-loss", severity: 0.46, weight: 1, suite: "full" }),
  Object.freeze({ id: "noise", label: "Sensor noise", category: "Sensor", type: "noise", severity: 0.42, weight: 0.9, suite: "full" }),
  Object.freeze({ id: "jpeg", label: "JPEG-like damage", category: "Resampling", type: "jpeg", severity: 0.52, weight: 0.8, suite: "full" }),
  Object.freeze({ id: "downscale", label: "Aggressive downscale", category: "Resampling", type: "downscale", severity: 0.55, weight: 1, suite: "quick" }),
  Object.freeze({ id: "perspective-2d", label: "Projective skew", category: "Perspective", type: "perspective", severity: 0.52, weight: 1.3, suite: "quick" }),
  Object.freeze({ id: "yaw-35", label: "3D yaw 35°", category: "Perspective", type: "perspective-3d", severity: 0.55, yawDegrees: 35, pitchDegrees: 0, rollDegrees: 0, weight: 1.4, suite: "quick" }),
  Object.freeze({ id: "pitch-30", label: "3D pitch 30°", category: "Perspective", type: "perspective-3d", severity: 0.50, yawDegrees: 0, pitchDegrees: 30, rollDegrees: 0, weight: 1.3, suite: "full" }),
  Object.freeze({ id: "z-rotation-55", label: "Z rotation 55°", category: "Perspective", type: "perspective-3d", severity: 0.45, yawDegrees: 0, pitchDegrees: 0, rollDegrees: 55, weight: 1.1, suite: "quick" }),
  Object.freeze({ id: "combined-3d", label: "Combined 3D tilt", category: "Perspective", type: "perspective-3d", severity: 0.62, yawDegrees: 30, pitchDegrees: 15, rollDegrees: 18, weight: 1.5, suite: "full" }),
  Object.freeze({ id: "yaw-55", label: "Extreme yaw 55°", category: "Extreme perspective", type: "perspective-3d", severity: 0.82, yawDegrees: 55, pitchDegrees: 0, rollDegrees: 0, weight: 1.5, suite: "extreme" }),
  Object.freeze({ id: "pitch-40", label: "Extreme pitch 40°", category: "Extreme perspective", type: "perspective-3d", severity: 0.78, yawDegrees: 0, pitchDegrees: 40, rollDegrees: 0, weight: 1.4, suite: "extreme" }),
  Object.freeze({ id: "z-rotation-75", label: "Z rotation 75°", category: "Extreme perspective", type: "perspective-3d", severity: 0.72, yawDegrees: 0, pitchDegrees: 0, rollDegrees: 75, weight: 1.1, suite: "extreme" })
]);

function cloneImageDataLike(imageData) {
  return { width: imageData.width, height: imageData.height, data: new Uint8ClampedArray(imageData.data) };
}

function sampleRgbaBilinear(imageData, x, y) {
  const { width, height, data } = imageData;
  const cx = clampNumber(x, 0, width - 1);
  const cy = clampNumber(y, 0, height - 1);
  const x0 = Math.floor(cx), y0 = Math.floor(cy);
  const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const tx = cx - x0, ty = cy - y0;
  const get = (xx, yy, channel) => data[(yy * width + xx) * 4 + channel];
  const out = [0, 0, 0, 255];
  for (let ch = 0; ch < 4; ch++) {
    const a = get(x0, y0, ch) * (1 - tx) + get(x1, y0, ch) * tx;
    const b = get(x0, y1, ch) * (1 - tx) + get(x1, y1, ch) * tx;
    out[ch] = a * (1 - ty) + b * ty;
  }
  return out;
}

function resizeImageDataLike(imageData, width, height) {
  width = Math.max(1, Math.round(width));
  height = Math.max(1, Math.round(height));
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = (x + 0.5) * imageData.width / width - 0.5;
      const sy = (y + 0.5) * imageData.height / height - 0.5;
      const rgba = sampleRgbaBilinear(imageData, sx, sy);
      const p = (y * width + x) * 4;
      out[p] = rgba[0]; out[p + 1] = rgba[1]; out[p + 2] = rgba[2]; out[p + 3] = rgba[3];
    }
  }
  return { width, height, data: out };
}

function boxBlurImage(imageData, radius) {
  radius = Math.max(1, Math.round(radius));
  const { width, height, data } = imageData;
  const horizontal = new Float32Array(data.length);
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let ch = 0; ch < 3; ch++) {
        let sum = 0, count = 0;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          sum += data[(y * width + xx) * 4 + ch]; count++;
        }
        horizontal[(y * width + x) * 4 + ch] = sum / count;
      }
      horizontal[(y * width + x) * 4 + 3] = 255;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        let sum = 0, count = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          sum += horizontal[(yy * width + x) * 4 + ch]; count++;
        }
        out[p + ch] = sum / count;
      }
      out[p + 3] = 255;
    }
  }
  return { width, height, data: out };
}

function perspectiveStress(imageData, severity) {
  const { width, height } = imageData;
  const inset = Math.min(width, height) * (0.025 + 0.11 * severity);
  const source = [{ x: 0, y: 0 }, { x: width - 1, y: 0 }, { x: width - 1, y: height - 1 }, { x: 0, y: height - 1 }];
  const destination = [
    { x: inset * 1.15, y: inset * 0.25 },
    { x: width - 1 - inset * 0.25, y: inset },
    { x: width - 1 - inset * 1.0, y: height - 1 - inset * 0.35 },
    { x: inset * 0.20, y: height - 1 - inset * 0.95 }
  ];
  const inverse = computeHomography(source, destination);
  const out = new Uint8ClampedArray(width * height * 4);
  out.fill(255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = projectPoint(inverse, x, y);
      if (src.x < 0 || src.y < 0 || src.x >= width || src.y >= height) continue;
      const rgba = sampleRgbaBilinear(imageData, src.x, src.y);
      const p = (y * width + x) * 4;
      out[p] = rgba[0]; out[p + 1] = rgba[1]; out[p + 2] = rgba[2]; out[p + 3] = 255;
    }
  }
  return { width, height, data: out };
}


function fillWhiteRgba(data) {
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }
}

function projectPlaneQuad(width, height, options = {}) {
  const pitch = Number(options.pitchDegrees ?? options.pitch ?? 0) * Math.PI / 180;
  const yaw = Number(options.yawDegrees ?? options.yaw ?? 0) * Math.PI / 180;
  const roll = Number(options.rollDegrees ?? options.roll ?? 0) * Math.PI / 180;
  const cameraDistance = Math.max(1.8, Number(options.cameraDistance ?? 3.0));
  const fill = clampNumber(Number(options.fill ?? 0.84), 0.45, 0.94);
  const aspect = width / Math.max(1, height);
  // Point order intentionally follows TL, TR, BL, BR to match the
  // destination->source homography convention used throughout the scanner.
  const corners = [
    { x: -aspect, y: -1, z: 0 },
    { x: aspect, y: -1, z: 0 },
    { x: -aspect, y: 1, z: 0 },
    { x: aspect, y: 1, z: 0 }
  ];
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const projected = corners.map((point) => {
    // Yaw around Y.
    const x1 = point.x * cy + point.z * sy;
    const z1 = -point.x * sy + point.z * cy;
    const y1 = point.y;
    // Pitch around X.
    const y2 = y1 * cp - z1 * sp;
    const z2 = y1 * sp + z1 * cp;
    const x2 = x1;
    // Roll around Z, i.e. in-plane camera/code rotation.
    const x3 = x2 * cr - y2 * sr;
    const y3 = x2 * sr + y2 * cr;
    const depth = Math.max(0.35, cameraDistance + z2);
    const perspective = cameraDistance / depth;
    return { x: x3 * perspective, y: y3 * perspective };
  });
  const minX = Math.min(...projected.map((point) => point.x));
  const maxX = Math.max(...projected.map((point) => point.x));
  const minY = Math.min(...projected.map((point) => point.y));
  const maxY = Math.max(...projected.map((point) => point.y));
  const projectedWidth = Math.max(0.001, maxX - minX);
  const projectedHeight = Math.max(0.001, maxY - minY);
  const scale = Math.min(width * fill / projectedWidth, height * fill / projectedHeight);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return projected.map((point) => ({
    x: width / 2 + (point.x - centerX) * scale,
    y: height / 2 + (point.y - centerY) * scale
  }));
}

function warpToQuad(imageData, destination) {
  const { width, height } = imageData;
  const source = [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: 0, y: height - 1 },
    { x: width - 1, y: height - 1 }
  ];
  const inverse = computeHomography(source, destination);
  const out = new Uint8ClampedArray(width * height * 4);
  fillWhiteRgba(out);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = projectPoint(inverse, x, y);
      if (src.x < 0 || src.y < 0 || src.x >= width || src.y >= height) continue;
      const rgba = sampleRgbaBilinear(imageData, src.x, src.y);
      const p = (y * width + x) * 4;
      out[p] = rgba[0];
      out[p + 1] = rgba[1];
      out[p + 2] = rgba[2];
      out[p + 3] = 255;
    }
  }
  return { width, height, data: out };
}

function perspective3dStress(imageData, severity, options = {}) {
  const s = clampNumber(Number(severity), 0, 1);
  const destination = projectPlaneQuad(imageData.width, imageData.height, {
    pitchDegrees: options.pitchDegrees ?? (8 + s * 28),
    yawDegrees: options.yawDegrees ?? (12 + s * 43),
    rollDegrees: options.rollDegrees ?? (s * 18),
    cameraDistance: options.cameraDistance ?? 3,
    fill: options.fill ?? (0.88 - s * 0.06)
  });
  return warpToQuad(imageData, destination);
}

function motionBlurImage(imageData, severity, options = {}) {
  const radius = Math.max(1, Math.round(Number(options.radius ?? (2 + severity * 5))));
  const slope = Number(options.slope ?? 0.35);
  const { width, height } = imageData;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        let sum = 0;
        let count = 0;
        for (let k = -radius; k <= radius; k++) {
          const sx = x + k;
          const sy = y + Math.round(k * slope);
          if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
          sum += imageData.data[(sy * width + sx) * 4 + ch];
          count++;
        }
        out[p + ch] = count ? sum / count : imageData.data[p + ch];
      }
      out[p + 3] = 255;
    }
  }
  return { width, height, data: out };
}

function deterministicNoise(x, y, channel) {
  let value = Math.imul((x + 1) ^ (channel * 374761393), 668265263) ^ Math.imul(y + 11, 2246822519);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 0xffffffff * 2 - 1;
}

/** Apply one deterministic camera/print-style distortion to ImageData. */
export function applyStressDistortion(imageData, type, severity = 0.5, options = {}) {
  assert(imageData?.data && imageData.width && imageData.height, "applyStressDistortion requires ImageData-like input.");
  const s = clampNumber(Number(severity), 0, 1);
  if (type === "clean") return cloneImageDataLike(imageData);
  if (type === "blur") return boxBlurImage(imageData, 1 + s * 2.2);
  if (type === "motion-blur") return motionBlurImage(imageData, s, options);
  if (type === "perspective") return perspectiveStress(imageData, s);
  if (type === "perspective-3d" || type === "rotate-z") {
    return perspective3dStress(imageData, s, {
      ...options,
      pitchDegrees: type === "rotate-z" ? 0 : options.pitchDegrees,
      yawDegrees: type === "rotate-z" ? 0 : options.yawDegrees,
      rollDegrees: type === "rotate-z" ? (options.rollDegrees ?? 20 + s * 70) : options.rollDegrees
    });
  }
  if (type === "downscale") {
    const scale = Math.max(0.20, 1 - s * 0.72);
    const small = resizeImageDataLike(imageData, imageData.width * scale, imageData.height * scale);
    return resizeImageDataLike(small, imageData.width, imageData.height);
  }

  const out = cloneImageDataLike(imageData);
  const { width, height, data } = out;
  const quantStep = 4 + Math.round(s * 30);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        let value = data[p + ch];
        if (type === "brightness-low") value *= 1 - s * 0.52;
        else if (type === "brightness-high") value = value + (255 - value) * s * 0.48;
        else if (type === "contrast-loss") value = 128 + (value - 128) * (1 - s * 0.48);
        else if (type === "shadow") {
          const nx = x / Math.max(1, width - 1);
          const ny = y / Math.max(1, height - 1);
          const shadow = clampNumber((nx * 0.65 + ny * 0.35 - 0.18) / 0.82, 0, 1);
          value *= 1 - shadow * s * 0.62;
        } else if (type === "jpeg") {
          value = Math.round(value / quantStep) * quantStep;
          const block = ((Math.floor(x / 8) + Math.floor(y / 8)) & 1) ? 1 : -1;
          value += block * s * 3;
        } else if (type === "warm") {
          if (ch === 0) value *= 1 + s * 0.12;
          if (ch === 1) value *= 1 + s * 0.03;
          if (ch === 2) value *= 1 - s * 0.22;
        } else if (type === "cool") {
          if (ch === 0) value *= 1 - s * 0.20;
          if (ch === 1) value *= 1 + s * 0.02;
          if (ch === 2) value *= 1 + s * 0.14;
        } else if (type === "noise") {
          value += deterministicNoise(x, y, ch) * (5 + s * 34);
        } else if (type === "glare") {
          const nx = (x / Math.max(1, width - 1) - 0.68) / 0.28;
          const ny = (y / Math.max(1, height - 1) - 0.30) / 0.20;
          const falloff = Math.exp(-(nx * nx + ny * ny) * 2.2);
          value += (255 - value) * falloff * s * 0.82;
        } else if (type === "gamma") {
          const gamma = 1 + (s - 0.5) * 1.2;
          value = 255 * Math.pow(value / 255, gamma);
        }
        data[p + ch] = clampNumber(Math.round(value), 0, 255);
      }
      data[p + 3] = 255;
    }
  }
  return out;
}

export function runImageStressTest(imageData, expected = {}, options = {}) {
  const profiles = options.profiles ?? STRESS_PROFILES;
  const results = [];
  let passedWeight = 0;
  let totalWeight = 0;
  for (const profile of profiles) {
    const weight = Number(profile.weight ?? 1);
    totalWeight += weight;
    const distorted = applyStressDistortion(imageData, profile.type ?? profile.id, profile.severity ?? 0.5, profile);
    const started = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
    try {
      const decoded = scanImageData(distorted, {
        minVersion: expected.version ?? options.minVersion ?? MIN_VERSION,
        maxVersion: expected.version ?? options.maxVersion ?? MAX_VERSION,
        debug: false
      });
      const matches = expected.crc32 == null || decoded.crc32 === expected.crc32;
      if (matches) passedWeight += weight;
      results.push({
        id: profile.id,
        label: profile.label,
        type: profile.type,
        severity: profile.severity,
        passed: matches,
        confidence: decoded.confidence ?? decoded.diagnostics?.confidence ?? null,
        correctedSymbols: decoded.correctedSymbols ?? 0,
        elapsedMs: (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()) - started,
        image: options.includeImages ? distorted : undefined,
        error: matches ? null : "Decoded payload did not match expected CRC."
      });
    } catch (error) {
      results.push({
        id: profile.id,
        label: profile.label,
        type: profile.type,
        severity: profile.severity,
        passed: false,
        confidence: 0,
        correctedSymbols: null,
        elapsedMs: (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()) - started,
        image: options.includeImages ? distorted : undefined,
        error: error.message
      });
    }
  }
  const passPercent = totalWeight ? passedWeight / totalWeight * 100 : 0;
  const averageConfidence = results.filter((r) => r.passed && Number.isFinite(r.confidence)).reduce((sum, r, _, arr) => sum + r.confidence / arr.length, 0);
  const score = clampNumber(passPercent * 0.86 + averageConfidence * 100 * 0.14, 0, 100);
  const rating = score >= 90 ? "Excellent" : score >= 75 ? "Good" : score >= 50 ? "Risky" : "Likely unscannable";
  return {
    score,
    rating,
    passPercent,
    passed: results.filter((r) => r.passed).length,
    total: results.length,
    averageConfidence,
    results
  };
}


function reliabilityProfilesForSuite(suite = "full") {
  const rank = { quick: 0, full: 1, extreme: 2 };
  const requested = rank[suite] ?? rank.full;
  return RELIABILITY_PROFILES.filter((profile) => (rank[profile.suite] ?? 1) <= requested);
}

/** Run the broader Reliability Lab suite and return category-level scores. */
export function runReliabilityLab(imageData, expected = {}, options = {}) {
  const suite = options.suite ?? "full";
  const profiles = options.profiles ?? reliabilityProfilesForSuite(suite);
  const report = runImageStressTest(imageData, expected, { ...options, profiles });
  const categoryMap = new Map();
  for (const result of report.results) {
    const profile = profiles.find((item) => item.id === result.id) ?? {};
    const category = profile.category ?? "Other";
    const weight = Number(profile.weight ?? 1);
    if (!categoryMap.has(category)) categoryMap.set(category, { category, passedWeight: 0, totalWeight: 0, passed: 0, total: 0 });
    const entry = categoryMap.get(category);
    entry.totalWeight += weight;
    entry.total++;
    if (result.passed) {
      entry.passedWeight += weight;
      entry.passed++;
    }
    result.category = category;
    result.pitchDegrees = profile.pitchDegrees ?? null;
    result.yawDegrees = profile.yawDegrees ?? null;
    result.rollDegrees = profile.rollDegrees ?? null;
  }
  const categories = [...categoryMap.values()].map((entry) => ({
    category: entry.category,
    passed: entry.passed,
    total: entry.total,
    score: entry.totalWeight ? entry.passedWeight / entry.totalWeight * 100 : 0
  })).sort((a, b) => a.score - b.score || a.category.localeCompare(b.category));
  return {
    ...report,
    suite,
    categories,
    weakestCategory: categories[0] ?? null
  };
}

/** Sweep one 3D perspective axis to measure the largest passing angle. */
export function runPerspectiveSweep(imageData, expected = {}, options = {}) {
  const axis = options.axis ?? "yaw";
  const defaultAngles = axis === "roll"
    ? [0, 25, 45, 60, 75]
    : [0, 15, 25, 35, 45, 55];
  const angles = (options.angles ?? defaultAngles).map(Number).filter(Number.isFinite);
  const results = [];
  let maxPassedAngle = null;
  for (const angle of angles) {
    const transform = {
      pitchDegrees: Number(options.pitchDegrees ?? 0),
      yawDegrees: Number(options.yawDegrees ?? 0),
      rollDegrees: Number(options.rollDegrees ?? 0),
      fill: options.fill ?? 0.84,
      cameraDistance: options.cameraDistance ?? 3
    };
    if (axis === "pitch") transform.pitchDegrees = angle;
    else if (axis === "roll" || axis === "z") transform.rollDegrees = angle;
    else transform.yawDegrees = angle;
    const distorted = applyStressDistortion(imageData, "perspective-3d", 0.5, transform);
    const started = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
    try {
      const decoded = scanImageData(distorted, {
        minVersion: expected.version ?? options.minVersion ?? MIN_VERSION,
        maxVersion: expected.version ?? options.maxVersion ?? MAX_VERSION,
        debug: false
      });
      const passed = expected.crc32 == null || decoded.crc32 === expected.crc32;
      if (passed) maxPassedAngle = Math.max(maxPassedAngle ?? angle, angle);
      results.push({
        angle,
        axis,
        passed,
        confidence: decoded.confidence ?? decoded.diagnostics?.confidence ?? null,
        correctedSymbols: decoded.correctedSymbols ?? 0,
        elapsedMs: (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()) - started,
        image: options.includeImages ? distorted : undefined,
        error: passed ? null : "Decoded payload did not match expected CRC."
      });
    } catch (error) {
      results.push({
        angle,
        axis,
        passed: false,
        confidence: 0,
        correctedSymbols: null,
        elapsedMs: (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()) - started,
        image: options.includeImages ? distorted : undefined,
        error: error.message
      });
    }
  }
  return {
    axis,
    maxPassedAngle,
    passed: results.filter((item) => item.passed).length,
    total: results.length,
    results
  };
}

/** Render and run the standard scanability torture suite. */
export function assessScanability(code, renderOptions = {}, options = {}) {
  assert(code?.matrix, "assessScanability expects an encoded QuadQR object.");
  const testImageSize = Math.max(240, Math.min(Number(options.testImageSize ?? 480), Number(renderOptions.imageSize ?? 720)));
  const image = renderToImageData(code, { ...renderOptions, imageSize: testImageSize });
  const report = runImageStressTest(image, { version: code.version, crc32: code.crc32 }, options);
  const autoLogoSize = renderOptions.logo ? estimateSafeLogoSize(code, renderOptions) : null;
  return {
    ...report,
    version: code.version,
    eccLevel: code.eccLevel,
    utilization: code.utilization,
    testImageSize,
    autoLogoSize,
    recommendations: [
      ...(report.score < 75 ? ["Increase ECC, reduce logo size, use Classic style, or increase output/physical size."] : []),
      ...(Number(renderOptions.quietZone ?? 4) < 4 ? ["Use a quiet zone of at least 4 modules for robust camera/print scanning."] : []),
      ...(renderOptions.logo && autoLogoSize != null ? [`Auto-safe logo estimate: ${(autoLogoSize * 100).toFixed(1)}% of the symbol width.`] : []),
      ...(normalizeRenderMode(renderOptions.mode ?? renderOptions.renderMode ?? "screen") === "print" ? getPrintGuidance(code, renderOptions).recommendations : [])
    ]
  };
}

function paletteConfidence(observedPalette) {
  if (!observedPalette) return 0.5;
  const values = ["black", "white", "red", "green", "blue"].map((name) => observedPalette[name]).filter(Boolean);
  if (values.length < 5) return 0.5;
  let minDistance = Infinity;
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      const a = values[i], b = values[j];
      minDistance = Math.min(minDistance, Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b));
    }
  }
  return clampNumber((minDistance - 28) / 120, 0, 1);
}

function scannerDiagnostics(result, context = {}, options = {}) {
  const info = result ? getVersionInfo(result.version, { ecc: result.eccLevel }) : null;
  const correctableTotal = result && info
    ? Number(info.correctableHeaderSymbols ?? 0) + Number(result.eccBlocks ?? 0) * Number(result.correctableSymbolsPerBlock ?? 0)
    : 0;
  const eccUtilization = correctableTotal > 0 ? clampNumber((result.correctedSymbols ?? 0) / correctableTotal, 0, 1) : 0;
  const structureConfidence = clampNumber(
    result?.structureScore ?? context.observations?.at(-1)?.structureScore ?? (result ? 0.92 : 0), 0, 1
  );
  const cellConfidence = clampNumber(result?.averageCellConfidence ?? 0.75, 0, 1);
  const geometryConfidence = result
    ? clampNumber(result.perspectiveCorrected ? Math.max(0.55, structureConfidence) : Math.max(0.65, structureConfidence * 0.9), 0, 1)
    : (context.geometry?.length ? 0.45 : 0);
  const calibrationConfidence = result
    ? clampNumber(result.colorCalibrated ? paletteConfidence(result.observedPalette) : 0.55, 0, 1)
    : 0;
  const confidence = result
    ? clampNumber(cellConfidence * 0.50 + structureConfidence * 0.20 + geometryConfidence * 0.15 + calibrationConfidence * 0.15 - eccUtilization * 0.12, 0, 1)
    : 0;
  const geometryCandidates = (context.geometry ?? []).slice(0, 8).map((geometry) => ({
    version: geometry.version,
    size: geometry.size,
    score: geometry.score,
    estimatedSize: geometry.estimatedSize,
    alignmentScore: geometry.alignmentScore,
    alignmentGridScore: geometry.alignmentGridScore,
    corners: geometry.corners ?? geometry.quad ?? null,
    finders: geometry.finders ?? null
  }));
  const observations = context.observations ?? [];
  const latest = observations.at(-1) ?? null;
  const stages = {
    finderDetection: geometryCandidates.length > 0 || Boolean(result && !result.perspectiveCorrected),
    geometry: geometryCandidates.length > 0 || Boolean(result && !result.perspectiveCorrected),
    sampling: observations.length > 0 || Boolean(result),
    colorClassification: observations.length > 0 || Boolean(result),
    ecc: Boolean(result),
    crc: Boolean(result),
    payload: Boolean(result)
  };
  let failedStage = null;
  if (!result) {
    failedStage = !stages.finderDetection ? "finder-detection"
      : !stages.sampling ? "perspective-geometry"
        : "color-classification-or-ecc";
  }
  return {
    confidence,
    cellConfidence,
    structureConfidence,
    geometryConfidence,
    calibrationConfidence,
    eccUtilization,
    correctedErrors: result?.correctedSymbols ?? 0,
    erasureSymbols: result?.erasureSymbols ?? 0,
    lowConfidenceCells: result?.lowConfidenceCells ?? latest?.lowConfidenceCells ?? null,
    stages,
    failedStage,
    geometryCandidates,
    vision: context.vision ?? null,
    sampled: latest ? {
      version: latest.version,
      samplingMode: latest.samplingMode,
      colorNormalization: latest.colorNormalization,
      structureScore: latest.structureScore,
      averageCellConfidence: latest.averageCellConfidence,
      observedPalette: latest.observedPalette ?? null,
      matrix: options.debugMatrices === false ? undefined : latest.matrix,
      confidenceMatrix: options.debugMatrices === false ? undefined : latest.confidence
    } : null
  };
}

function decorateScanResult(result, context, options) {
  const diagnostics = scannerDiagnostics(result, context, options);
  return {
    ...result,
    confidence: diagnostics.confidence,
    geometryConfidence: diagnostics.geometryConfidence,
    calibrationConfidence: diagnostics.calibrationConfidence,
    structureConfidence: diagnostics.structureConfidence,
    correctedErrors: result.correctedSymbols ?? 0,
    eccUtilization: diagnostics.eccUtilization,
    diagnostics: options.debug ? diagnostics : {
      confidence: diagnostics.confidence,
      geometryConfidence: diagnostics.geometryConfidence,
      calibrationConfidence: diagnostics.calibrationConfidence,
      structureConfidence: diagnostics.structureConfidence,
      eccUtilization: diagnostics.eccUtilization,
      correctedErrors: diagnostics.correctedErrors,
      erasureSymbols: diagnostics.erasureSymbols
    }
  };
}

/** Non-throwing scanner debug API with detailed stage diagnostics. */
export function debugScanImageData(imageData, options = {}) {
  try {
    const result = scanImageData(imageData, { ...options, debug: true });
    return { ok: true, result, debug: result.diagnostics };
  } catch (error) {
    return { ok: false, error: error.message, debug: error.debug ?? null };
  }
}

export function scanImageData(imageData, options = {}) {
  assert(imageData && imageData.data && imageData.width && imageData.height, "Valid ImageData is required.");
  const minVersion = options.minVersion ?? MIN_VERSION;
  const maxVersion = options.maxVersion ?? MAX_VERSION;
  validateVersion(minVersion);
  validateVersion(maxVersion);

  const geometryCollector = [];
  const observationCollector = options.debug ? [] : (Array.isArray(options._observationCollector) ? options._observationCollector : []);
  const visionDiagnostics = options.debug ? { passes: [] } : (options._visionDiagnostics ?? null);
  const debugContext = { geometry: geometryCollector, observations: observationCollector, vision: visionDiagnostics };
  const scanOptions = {
    ...options,
    _geometryCollector: geometryCollector,
    _observationCollector: observationCollector,
    _visionDiagnostics: visionDiagnostics
  };

  if (options.perspective !== false) {
    const geometryHints = Array.isArray(options._geometryHints)
      ? options._geometryHints.filter((item) => item?.homography && Number.isInteger(item.version)).slice(0, 2)
      : [];
    if (geometryHints.length) {
      try {
        const hinted = tryPerspectiveScan(imageData, {
          ...scanOptions,
          _diagnosticLabel: options._diagnosticLabel ? `${options._diagnosticLabel}-geometry-reuse` : "geometry-reuse",
          _geometryCandidatesOverride: geometryHints,
          _geometryCollector: [],
          _observationCollector: [],
          adaptiveSampling: options._geometryReuseAdaptiveSampling ?? false,
          geometryRefinement: false
        });
        if (hinted) {
          geometryCollector.push(hinted.geometry ?? geometryHints[0]);
          return decorateScanResult({
            ...hinted,
            geometryReused: true,
            recoveryMode: hinted.recoveryMode ?? "geometry-reuse"
          }, debugContext, options);
        }
      } catch {
        // A stale geometry hint is expected when the camera/code moves. The
        // camera worker can request a hint-only attempt when it is reusing
        // low-resolution locator geometry on a higher-detail frame.
      }
      if (options._geometryHintOnly === true) {
        throw new Error("Geometry hint did not decode this frame.");
      }
    }

    const perspective = tryPerspectiveScan(imageData, scanOptions);
    if (perspective) return decorateScanResult(perspective, debugContext, options);
  }

  // Triangle16 has half-cell color regions, so geometry that is adequate for
  // solid RGBW cells can still be off by a few tenths of a module and mix the
  // two triangle colors. If normal geometry was found but no payload decoded,
  // retry geometry once with finer alignment localization. This stays off the
  // clean/normal camera fast path.
  if (
    options.perspective !== false &&
    options.preciseAlignmentRecovery !== false &&
    !options._preciseAlignmentRecovery &&
    geometryCollector.length > 0
  ) {
    try {
      const precise = tryPerspectiveScan(imageData, {
        ...scanOptions,
        preciseAlignment: true,
        _preciseAlignmentRecovery: true,
        _diagnosticLabel: "precise-alignment"
      });
      if (precise) {
        return decorateScanResult({
          ...precise,
          geometryRefined: true,
          recoveryMode: precise.recoveryMode ?? "precise-alignment"
        }, debugContext, options);
      }
    } catch {
      // Continue to color recovery and axis-aligned fallback.
    }
  }

  // If the normal scanner could see QuadQR geometry but could not decode the
  // colors, retry the same frame after a single global Auto Tone / Contrast /
  // Color-style pass. This is deliberately after the normal path so clean
  // camera scanning remains unchanged and fast.
  if (
    options.autoEnhanceRecovery !== false &&
    options.fullFrameAutoEnhanceRecovery !== false &&
    !options._autoEnhancedRecovery &&
    geometryCollector.length > 0
  ) {
    try {
      const enhanced = autoToneContrastColorImageData(imageData, {
        blackClip: options.autoEnhanceBlackClip,
        whiteClip: options.autoEnhanceWhiteClip,
        saturation: options.autoEnhanceSaturation,
        targetSamples: options.autoEnhanceTargetSamples
      });
      const recovered = tryPerspectiveScan(enhanced, {
        ...options,
        _autoEnhancedRecovery: true,
        autoEnhanceRecovery: false,
        _geometryCollector: []
      });
      if (recovered) {
        return decorateScanResult({
          ...recovered,
          autoEnhanced: true,
          recoveryMode: "auto-tone-contrast-color",
          originalColorNormalization: recovered.colorNormalization
        }, debugContext, options);
      }
    } catch {
      // Continue to the axis-aligned fallback.
    }
  }

  if (options.axisAlignedFallback !== false) {
    const axis = tryAxisAlignedScan(imageData, scanOptions);
    if (axis) return decorateScanResult(axis, debugContext, options);
  }

  // Static images sometimes have such low contrast that locator detection itself
  // fails. Permit one enhanced full retry in that case. The live camera disables
  // this on its first pass so an empty frame never becomes expensive.
  if (
    options.autoEnhanceRecovery !== false &&
    !options._autoEnhancedRecovery &&
    geometryCollector.length === 0 &&
    options.autoEnhanceWhenNoGeometry !== false
  ) {
    try {
      const enhanced = autoToneContrastColorImageData(imageData, {
        blackClip: options.autoEnhanceBlackClip,
        whiteClip: options.autoEnhanceWhiteClip,
        saturation: options.autoEnhanceSaturation,
        targetSamples: options.autoEnhanceTargetSamples
      });
      const recoveryOptions = {
        ...options,
        _autoEnhancedRecovery: true,
        autoEnhanceRecovery: false,
        _geometryCollector: []
      };
      if (options.perspective !== false) {
        const perspective = tryPerspectiveScan(enhanced, recoveryOptions);
        if (perspective) return decorateScanResult({ ...perspective, autoEnhanced: true, recoveryMode: "auto-tone-contrast-color" }, debugContext, options);
      }
      if (options.axisAlignedFallback !== false) {
        const axis = tryAxisAlignedScan(enhanced, recoveryOptions);
        if (axis) return decorateScanResult({ ...axis, autoEnhanced: true, recoveryMode: "auto-tone-contrast-color" }, debugContext, options);
      }
    } catch {
      // Fall through to the normal scan failure below.
    }
  }

  const error = new Error(
    "No valid QuadQR code found. Try better lighting, fill more of the frame, keep all locator patterns visible, or use a less blurred image."
  );
  if (options.debug) error.debug = scannerDiagnostics(null, debugContext, options);
  throw error;
}

export async function scanFile(file, options = {}) {
  assert(typeof document !== "undefined", "scanFile is a browser API.");
  assert(file, "A file is required.");
  let bitmap;

  if (typeof createImageBitmap === "function") {
    bitmap = await createImageBitmap(file);
  } else {
    bitmap = await new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Unable to load image.")); };
      img.src = url;
    });
  }

  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  if (typeof bitmap.close === "function") bitmap.close();
  return scanImageData(ctx.getImageData(0, 0, canvas.width, canvas.height), options);
}

function parseObjectPositionFraction(value, fallback = 0.5) {
  if (typeof value !== "string") return fallback;
  const token = value.trim().toLowerCase();
  if (token === "left" || token === "top") return 0;
  if (token === "right" || token === "bottom") return 1;
  if (token === "center") return 0.5;
  if (token.endsWith("%")) {
    const parsed = Number.parseFloat(token);
    if (Number.isFinite(parsed)) return clampNumber(parsed / 100, 0, 1);
  }
  return fallback;
}

function visibleVideoSourceRect(video, options = {}) {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  const full = { x: 0, y: 0, width: sourceWidth, height: sourceHeight, cropped: false };
  if (options.videoCropMode === "full") return full;

  let boxWidth = Number(video.clientWidth) || 0;
  let boxHeight = Number(video.clientHeight) || 0;
  if ((!boxWidth || !boxHeight) && typeof video.getBoundingClientRect === "function") {
    const rect = video.getBoundingClientRect();
    boxWidth = boxWidth || rect.width;
    boxHeight = boxHeight || rect.height;
  }
  if (!boxWidth || !boxHeight) return full;

  let objectFit = options.videoObjectFit;
  let objectPosition = options.videoObjectPosition;
  if ((!objectFit || !objectPosition) && typeof getComputedStyle === "function") {
    try {
      const style = getComputedStyle(video);
      objectFit = objectFit || style.objectFit;
      objectPosition = objectPosition || style.objectPosition;
    } catch {
      // Fall back to the demo's normal cover/center behavior.
    }
  }
  objectFit = objectFit || "cover";
  if (objectFit !== "cover") return full;

  const scale = Math.max(boxWidth / sourceWidth, boxHeight / sourceHeight);
  if (!Number.isFinite(scale) || scale <= 0) return full;
  let cropWidth = Math.min(sourceWidth, boxWidth / scale);
  let cropHeight = Math.min(sourceHeight, boxHeight / scale);
  if (cropWidth >= sourceWidth - 1 && cropHeight >= sourceHeight - 1) return full;

  const positionTokens = String(objectPosition || "50% 50%").trim().split(/\s+/);
  const positionX = parseObjectPositionFraction(positionTokens[0], 0.5);
  const positionY = parseObjectPositionFraction(positionTokens[1] ?? positionTokens[0], 0.5);
  let x = (sourceWidth - cropWidth) * positionX;
  let y = (sourceHeight - cropHeight) * positionY;

  // Optional tiny inset removes the soft edge of a camera preview without
  // changing the visible composition. Leave at zero unless explicitly set.
  const inset = clampNumber(options.videoCropInset ?? 0, 0, 0.18);
  if (inset > 0) {
    const dx = cropWidth * inset;
    const dy = cropHeight * inset;
    x += dx;
    y += dy;
    cropWidth -= dx * 2;
    cropHeight -= dy * 2;
  }

  x = clampNumber(x, 0, Math.max(0, sourceWidth - cropWidth));
  y = clampNumber(y, 0, Math.max(0, sourceHeight - cropHeight));
  return { x, y, width: cropWidth, height: cropHeight, cropped: true };
}

function cropImageDataInset(imageData, insetFraction = 0) {
  const inset = clampNumber(Number(insetFraction) || 0, 0, 0.32);
  if (inset <= 0) {
    return {
      imageData,
      rect: { x: 0, y: 0, width: imageData.width, height: imageData.height }
    };
  }

  const x = Math.max(0, Math.floor(imageData.width * inset));
  const y = Math.max(0, Math.floor(imageData.height * inset));
  const width = Math.max(1, imageData.width - x * 2);
  const height = Math.max(1, imageData.height - y * 2);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    const sourceStart = ((y + row) * imageData.width + x) * 4;
    const sourceEnd = sourceStart + width * 4;
    data.set(imageData.data.subarray(sourceStart, sourceEnd), row * width * 4);
  }
  return {
    imageData: { width, height, data },
    rect: { x, y, width, height }
  };
}

function bestVisionDiagnosticPass(visionDiagnostics) {
  const passes = visionDiagnostics?.passes;
  if (!Array.isArray(passes) || !passes.length) return null;
  return passes.slice().sort((a, b) => {
    const aGeometry = a.geometries?.[0];
    const bGeometry = b.geometries?.[0];
    return (Boolean(bGeometry) - Boolean(aGeometry)) ||
      ((b.finderCount ?? 0) - (a.finderCount ?? 0)) ||
      ((bGeometry?.score ?? 0) - (aGeometry?.score ?? 0));
  })[0];
}

function nowMs() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function cameraScannerStopsOnResult(options = {}) {
  // `continuous` is the clearer public spelling. Preserve the older
  // `stopOnResult` option as an explicit override for compatibility.
  return options.stopOnResult ?? (options.continuous === true ? false : true);
}

function cameraResultIdentity(result) {
  if (!result || !Number.isInteger(result.crc32)) return null;
  return `${result.formatVersion ?? "?"}:${result.version ?? "?"}:${result.crc32 >>> 0}`;
}

function makeCameraAbortError() {
  const error = new Error("Camera scanner aborted.");
  error.name = "AbortError";
  return error;
}

function normalizeFrameDiagnostics(frameDiagnostics, source, width, height, visionDiagnostics) {
  if (!frameDiagnostics || typeof frameDiagnostics !== "object") return;
  frameDiagnostics.scanWidth = width;
  frameDiagnostics.scanHeight = height;
  frameDiagnostics.frameWidth = width;
  frameDiagnostics.frameHeight = height;
  frameDiagnostics.scanRect = { x: 0, y: 0, width, height };
  frameDiagnostics.sourceRect = {
    x: source.x,
    y: source.y,
    width: source.width,
    height: source.height,
    cropped: Boolean(source.cropped)
  };
  frameDiagnostics.vision = visionDiagnostics;
  const bestPass = bestVisionDiagnosticPass(visionDiagnostics);
  frameDiagnostics.bestPass = bestPass;
  frameDiagnostics.finderCount = bestPass?.finderCount ?? 0;
  frameDiagnostics.finders = bestPass?.finders ?? [];
  frameDiagnostics.finderMethod = bestPass?.finderMethod ?? null;
  frameDiagnostics.finderPasses = Array.isArray(visionDiagnostics?.passes)
    ? visionDiagnostics.passes.map((pass) => ({
        method: pass.finderMethod ?? pass.label,
        finderCount: pass.finderCount ?? 0,
        threshold: pass.threshold,
        geometryCount: pass.geometries?.length ?? 0
      }))
    : [];
  frameDiagnostics.geometry = bestPass?.geometries?.[0] ?? null;
}

export function scanVideoFrame(video, options = {}) {
  assert(typeof document !== "undefined", "scanVideoFrame is a browser API.");
  assert(video && video.videoWidth && video.videoHeight, "Video frame is not ready.");

  // Scan what the user actually sees. On phones the video element is usually a
  // portrait box with object-fit: cover while the camera sensor stream is 16:9.
  // Previously we scanned the entire hidden sensor frame, so the QR looked big
  // in the guide but became much smaller after canvas downscaling. Cropping to
  // the visible source region both improves module resolution and reduces work.
  const source = visibleVideoSourceRect(video, options);
  const maxDimension = options.maxDimension ?? 960;
  const scale = Math.min(1, maxDimension / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = options.canvas ?? document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  // High-quality downscaling is preferable for finder geometry, but visible-ROI
  // cropping means many mobile frames now need little or no downscaling at all.
  if ("imageSmoothingEnabled" in ctx) ctx.imageSmoothingEnabled = true;
  if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "high";
  ctx.drawImage(video, source.x, source.y, source.width, source.height, 0, 0, width, height);
  const frameImageData = ctx.getImageData(0, 0, width, height);
  if (options._capturedFrame && typeof options._capturedFrame === "object") {
    options._capturedFrame.imageData = frameImageData;
    options._capturedFrame.scanWidth = width;
    options._capturedFrame.scanHeight = height;
    options._capturedFrame.source = { ...source };
  }
  const visionDiagnostics = options._frameDiagnostics ? { passes: [] } : null;
  try {
    const result = scanImageData(frameImageData, {
      ...options,
      _visionDiagnostics: visionDiagnostics
    });
    normalizeFrameDiagnostics(options._frameDiagnostics, source, width, height, visionDiagnostics);
    if (options._frameDiagnostics && result?.geometry && !options._frameDiagnostics.geometry) {
      const geometry = result.geometry;
      options._frameDiagnostics.geometry = geometry;
      options._frameDiagnostics.geometryReused = Boolean(result.geometryReused);
      if (geometry.finders) {
        const reusedFinders = [
          geometry.finders.topLeft,
          geometry.finders.topRight,
          geometry.finders.bottomLeft
        ].filter(Boolean);
        options._frameDiagnostics.finders = reusedFinders;
        options._frameDiagnostics.finderCount = reusedFinders.length;
        if (result.geometryReused) options._frameDiagnostics.finderMethod = "geometry-reuse";
      }
    }
    if (!source.cropped) return result;
    return {
      ...result,
      cameraVisibleCrop: true,
      cameraSourceRect: { x: source.x, y: source.y, width: source.width, height: source.height }
    };
  } catch (error) {
    normalizeFrameDiagnostics(options._frameDiagnostics, source, width, height, visionDiagnostics);
    throw error;
  }
}

function selectBestFrameObservation(observations) {
  if (!observations?.length) return null;
  return observations
    .filter((item) => item?.matrix && item.structureScore >= 0.82)
    .sort((a, b) =>
      (b.structureScore - a.structureScore) ||
      (b.averageCellConfidence - a.averageCellConfidence) ||
      ((b.geometry?.score ?? 0) - (a.geometry?.score ?? 0))
    )[0] ?? null;
}

function observationDataAgreement(a, b) {
  if (!a?.matrix || !b?.matrix || a.version !== b.version || a.matrix.length !== b.matrix.length) return 0;
  if ((a.cellEncoding ?? null) !== (b.cellEncoding ?? null)) return 0;
  const layout = createLayout(a.version);
  let agreed = 0;
  let compared = 0;
  for (const [row, col] of layout.dataPositions) {
    const ca = a.confidence?.[row]?.[col] ?? 0;
    const cb = b.confidence?.[row]?.[col] ?? 0;
    if (Math.min(ca, cb) < 0.48) continue;
    compared++;
    if (a.matrix[row][col] === b.matrix[row][col]) agreed++;
  }
  return compared ? agreed / compared : 0;
}

function combineFrameObservations(observations) {
  if (!observations?.length) return null;
  const version = observations[0].version;
  const cellEncoding = observations[0].cellEncoding ?? null;
  const size = observations[0].matrix.length;
  if (!observations.every((item) =>
    item.version === version &&
    (item.cellEncoding ?? null) === cellEncoding &&
    item.matrix.length === size
  )) return null;

  const matrix = make2D(size, CELL.WHITE);
  const confidence = make2D(size, 0);
  const alternatives = make2D(size, null);
  const frameCount = observations.length;
  const latest = observations[frameCount - 1];
  let agreementSum = 0;
  let agreementCount = 0;
  for (let i = 0; i < frameCount - 1; i++) {
    const agreement = observationDataAgreement(observations[i], latest);
    if (agreement > 0) {
      agreementSum += agreement;
      agreementCount++;
    }
  }

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const votes = new Map();
      const confidenceByCell = new Map();
      for (let index = 0; index < observations.length; index++) {
        const observation = observations[index];
        const cell = observation.matrix[r][c];
        const sourceConfidence = clampNumber(observation.confidence?.[r]?.[c] ?? 0.5, 0, 1);
        const age = observations.length - 1 - index;
        const recency = Math.pow(0.88, age);
        const frameQuality = clampNumber(
          0.45 +
          (observation.structureScore ?? 0.82) * 0.30 +
          (observation.averageCellConfidence ?? 0.5) * 0.25,
          0.45,
          1
        );
        const weight = (0.25 + sourceConfidence * 0.75) * recency * frameQuality;
        votes.set(cell, (votes.get(cell) ?? 0) + weight);
        const stats = confidenceByCell.get(cell) ?? { weighted: 0, weight: 0 };
        stats.weighted += sourceConfidence * weight;
        stats.weight += weight;
        confidenceByCell.set(cell, stats);

        // The per-frame second hypothesis also contributes weak evidence. It
        // never outranks a strong primary vote by itself, but it preserves a
        // plausible alternative for Spectrum ECC 2.0 when several frames are
        // individually ambiguous in the same region.
        const alternative = observation.alternatives?.[r]?.[c];
        if (Number.isInteger(alternative) && alternative !== cell) {
          const altWeight = weight * (1 - sourceConfidence) * 0.42;
          votes.set(alternative, (votes.get(alternative) ?? 0) + altWeight);
        }
      }

      const ranked = Array.from(votes.entries()).sort((a, b) => b[1] - a[1]);
      const [bestCell, bestWeight] = ranked[0];
      const [secondCell, secondWeight] = ranked[1] ?? [null, 0];
      const totalWeight = ranked.reduce((sum, item) => sum + item[1], 0);
      const sourceStats = confidenceByCell.get(bestCell);
      const sourceConfidence = sourceStats?.weight ? sourceStats.weighted / sourceStats.weight : 0.5;
      const support = totalWeight ? bestWeight / totalWeight : 0;
      const margin = totalWeight ? (bestWeight - secondWeight) / totalWeight : 0;
      const temporalBoost = clampNumber((frameCount - 1) / 5, 0, 0.18);
      const fusedConfidence = clampNumber(
        sourceConfidence * 0.50 + support * 0.30 + margin * 0.20 + temporalBoost,
        0,
        1
      );

      matrix[r][c] = bestCell;
      confidence[r][c] = fusedConfidence;
      alternatives[r][c] = Number.isInteger(secondCell) && secondCell !== bestCell ? secondCell : null;
    }
  }
  return {
    version,
    cellEncoding,
    matrix,
    confidence,
    alternatives,
    frameAgreement: agreementCount ? agreementSum / agreementCount : 1
  };
}

async function improveCameraTrack(stream) {
  const track = stream.getVideoTracks?.()[0];
  if (!track?.applyConstraints || !track.getCapabilities) return;
  try {
    const capabilities = track.getCapabilities();
    const advanced = {};
    if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes("continuous")) {
      advanced.focusMode = "continuous";
    }
    if (Array.isArray(capabilities.exposureMode) && capabilities.exposureMode.includes("continuous")) {
      advanced.exposureMode = "continuous";
    }
    if (Array.isArray(capabilities.whiteBalanceMode) && capabilities.whiteBalanceMode.includes("continuous")) {
      advanced.whiteBalanceMode = "continuous";
    }
    if (Object.keys(advanced).length) await track.applyConstraints({ advanced: [advanced] });
  } catch {
    // Browsers expose different subsets of camera controls. Scanner-side
    // calibration remains the primary path when these hints are unsupported.
  }
}

async function startCameraScannerMainThread(video, options = {}) {
  assert(typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia, "Camera API is unavailable.");
  assert(video, "A video element is required.");
  if (options.signal?.aborted) throw makeCameraAbortError();

  const stream = await navigator.mediaDevices.getUserMedia(
    options.constraints ?? {
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 }
      }
    }
  );
  await improveCameraTrack(stream);

  video.srcObject = stream;
  video.setAttribute("playsinline", "");
  video.muted = true;
  await video.play();
  const track = stream.getVideoTracks?.()[0] ?? null;

  // Keep scanning responsive without queueing stale camera frames. The old
  // 180 ms post-scan timeout made effective cadence equal scan time + 180 ms.
  // The scheduler below measures from scan start and uses real video frames
  // when requestVideoFrameCallback() is available.
  const scanInterval = Math.max(24, Number(options.scanInterval ?? 80));
  const scratchCanvas = document.createElement("canvas");
  const highResolutionCanvas = document.createElement("canvas");
  const multiFrameEnabled = options.multiFrame !== false;
  const multiFrameWindow = Math.max(2, Math.min(8, Math.round(options.multiFrameWindow ?? 4)));
  const multiFrameMinFrames = Math.max(2, Math.min(multiFrameWindow, Math.round(options.multiFrameMinFrames ?? 2)));
  const observationHistory = new Map();
  const cameraAutoColorEvery = Math.max(1, Math.round(options.cameraAutoColorEvery ?? 1));
  const cameraAutoEnhanceEvery = Math.max(1, Math.round(options.cameraAutoEnhanceEvery ?? 2));
  const cameraFinderRecoveryEvery = Math.max(1, Math.round(options.cameraFinderRecoveryEvery ?? 2));
  const cameraHighResolutionEvery = Math.max(1, Math.round(options.cameraHighResolutionEvery ?? 2));
  const baseCameraMaxDimension = Math.max(480, Math.round(options.maxDimension ?? 640));
  const cameraHighResolutionMaxDimension = Math.max(
    baseCameraMaxDimension,
    Math.round(options.cameraHighResolutionMaxDimension ?? 960)
  );
  const stopOnResult = cameraScannerStopsOnResult(options);
  const duplicateCooldown = Math.max(0, Number(options.duplicateCooldown ?? (stopOnResult ? 0 : 1200)));
  const pauseWhenHidden = options.pauseWhenHidden !== false;
  const weakFinderFramesRequired = Math.max(2, Math.round(options.cameraRecoveryWeakFinderFrames ?? 2));
  let missStreak = 0;
  let stopped = false;
  let paused = false;
  let busy = false;
  let timer = null;
  let frameCallbackId = null;
  let lastScanStartedAt = -Infinity;
  let frameNumber = 0;
  let cameraGeometryHint = null;
  let cameraGeometryHintMisses = 0;
  let candidateRecoveryArmed = false;
  let weakFinderStreak = 0;
  let lastResultIdentity = null;
  let lastResultAt = -Infinity;
  let visibilityHandler = null;
  let abortHandler = null;
  let trackEndedHandler = null;
  const cameraGeometryReuseMaxMisses = Math.max(1, Math.round(options.cameraGeometryReuseMaxMisses ?? 5));
  const useVideoFrameCallback = options.useVideoFrameCallback !== false &&
    typeof video.requestVideoFrameCallback === "function";

  const diagnosticsEnabled = typeof options.onDiagnostic === "function";
  const emitDiagnostic = (event) => {
    if (!diagnosticsEnabled) return;
    try {
      options.onDiagnostic({
        timestamp: Date.now(),
        frame: frameNumber,
        ...event
      });
    } catch {
      // Diagnostics are UI-only and must never interrupt scanning.
    }
  };


  const emitCameraState = (state, extra = {}) => {
    try { options.onCameraState?.({ state, timestamp: Date.now(), ...extra }); } catch {}
  };

  if (diagnosticsEnabled) {
    const settings = track?.getSettings?.() ?? {};
    emitDiagnostic({
      type: "camera-ready",
      method: "camera",
      message: `Camera ready · ${settings.width ?? video.videoWidth}×${settings.height ?? video.videoHeight}` ,
      camera: {
        width: settings.width ?? video.videoWidth,
        height: settings.height ?? video.videoHeight,
        frameRate: settings.frameRate ?? null,
        facingMode: settings.facingMode ?? null
      }
    });
  }

  const cancelScheduledScan = () => {
    if (timer) clearTimeout(timer);
    if (frameCallbackId != null && typeof video.cancelVideoFrameCallback === "function") {
      try { video.cancelVideoFrameCallback(frameCallbackId); } catch {}
    }
    timer = null;
    frameCallbackId = null;
  };

  const resetFreshness = () => {
    missStreak = 0;
    cameraGeometryHint = null;
    cameraGeometryHintMisses = 0;
    candidateRecoveryArmed = false;
    weakFinderStreak = 0;
    observationHistory.clear();
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    paused = false;
    cancelScheduledScan();
    resetFreshness();
    if (visibilityHandler && typeof document !== "undefined") document.removeEventListener("visibilitychange", visibilityHandler);
    if (abortHandler && options.signal?.removeEventListener) options.signal.removeEventListener("abort", abortHandler);
    if (trackEndedHandler && track?.removeEventListener) track.removeEventListener("ended", trackEndedHandler);
    for (const cameraTrack of stream.getTracks()) cameraTrack.stop();
    if (video.srcObject === stream) video.srcObject = null;
    emitCameraState("stopped");
  };

  const pause = () => {
    if (stopped || paused) return;
    paused = true;
    cancelScheduledScan();
    resetFreshness();
    emitDiagnostic({ type: "camera-paused", state: "paused", method: "camera", message: "Camera scanning paused" });
    emitCameraState("paused");
  };

  const resume = () => {
    if (stopped || !paused) return;
    paused = false;
    resetFreshness();
    lastScanStartedAt = -Infinity;
    emitDiagnostic({ type: "camera-resumed", state: "running", method: "camera", message: "Camera scanning resumed with fresh state" });
    emitCameraState("running", { resumed: true });
    scheduleNextScan();
  };

  const scanNow = () => scanVideoFrame(video, {
    ...options,
    maxDimension: baseCameraMaxDimension,
    canvas: scratchCanvas,
    _geometryHints: options.cameraGeometryReuse === false || !cameraGeometryHint ? undefined : [cameraGeometryHint]
  });

  const updateCameraGeometryHint = (frameDiagnostics, result = null) => {
    if (options.cameraGeometryReuse === false) {
      cameraGeometryHint = null;
      return;
    }
    const geometry = result?.geometry ?? frameDiagnostics?.geometry ?? null;
    if (geometry?.homography && Number.isInteger(geometry.version)) {
      cameraGeometryHint = geometry;
      cameraGeometryHintMisses = 0;
      return;
    }
    if (cameraGeometryHint) {
      cameraGeometryHintMisses++;
      if (cameraGeometryHintMisses >= cameraGeometryReuseMaxMisses) {
        cameraGeometryHint = null;
        cameraGeometryHintMisses = 0;
      }
    }
  };

  const emitResult = (result, capturedFrame = null, diagnostic = null) => {
    if (stopped) return true;
    const frameMeta = capturedFrame?.imageData ? {
      frame: frameNumber,
      imageData: capturedFrame.imageData,
      scanWidth: capturedFrame.scanWidth,
      scanHeight: capturedFrame.scanHeight,
      sourceRect: capturedFrame.source ? { ...capturedFrame.source } : null,
      enhancedImageData: capturedFrame.enhancedImageData ?? null,
      enhancedRect: capturedFrame.enhancedRect ? { ...capturedFrame.enhancedRect } : null,
      enhancement: capturedFrame.enhancement ? { ...capturedFrame.enhancement } : null,
      diagnostic
    } : null;

    if (!stopOnResult) resetFreshness();
    const identity = cameraResultIdentity(result);
    const decodedAt = nowMs();
    if (!stopOnResult && duplicateCooldown > 0 && identity && identity === lastResultIdentity && decodedAt - lastResultAt < duplicateCooldown) {
      emitDiagnostic({
        type: "duplicate-suppressed",
        state: "ignored",
        method: "continuous-scan",
        message: `Duplicate QuadQR result suppressed for ${Math.round(duplicateCooldown)} ms`
      });
      return false;
    }
    if (identity) {
      lastResultIdentity = identity;
      lastResultAt = decodedAt;
    }

    options.onResult?.(result, frameMeta);
    options.onDecode?.(result, frameMeta);
    if (stopOnResult) {
      stop();
      return true;
    }
    return false;
  };

  const tryMultiFrameDecode = (observations) => {
    if (!multiFrameEnabled) return null;
    const best = selectBestFrameObservation(observations);
    if (!best) return null;
    const trackKey = `${best.version}:${best.cellEncoding ?? "auto"}`;
    let history = observationHistory.get(trackKey) ?? [];

    // Only fuse observations that appear to describe the same payload. Finder
    // structure alone is not enough because two different QuadQR symbols of the
    // same version would otherwise contaminate each other's history. High-
    // confidence data-cell agreement gives us a cheap identity check without
    // needing the header to decode first.
    if (history.length) {
      const agreement = observationDataAgreement(history[history.length - 1], best);
      const minimumAgreement = best.cellEncoding === CELL_ENCODINGS.TRIANGLE16
        ? (options.multiFrameMinAgreementHighDensity ?? 0.58)
        : (options.multiFrameMinAgreement ?? 0.62);
      if (agreement > 0 && agreement < minimumAgreement) history = [];
    }

    history.push(best);
    while (history.length > multiFrameWindow) history.shift();
    observationHistory.set(trackKey, history);
    if (history.length < multiFrameMinFrames) return null;

    const combined = combineFrameObservations(history);
    if (!combined) return null;
    try {
      const decoded = decodeMatrix(combined.matrix, {
        structureTolerance: options.structureTolerance ?? 0.20,
        cellConfidence: combined.confidence,
        cellAlternatives: combined.alternatives,
        cellEncodingHint: best.cellEncoding ?? undefined,
        maxErasureConfidence: options.maxErasureConfidence,
        softDecoding: options.softDecoding
      });
      if (decoded.version !== best.version) return null;
      return {
        ...decoded,
        perspectiveCorrected: Boolean(best.geometry),
        colorCalibrated: true,
        colorNormalization: "multi-frame-confidence-fusion",
        samplingMode: "multi-frame-confidence-fusion",
        multiFrameCombined: history.length,
        multiFrameAgreement: combined.frameAgreement,
        multiFrameMode: "confidence-fusion",
        geometry: best.geometry,
        observedPalette: best.observedPalette,
        averageCellConfidence: best.averageCellConfidence,
        lowConfidenceCells: best.lowConfidenceCells
      };
    } catch {
      return null;
    }
  };

  const scheduleNextScan = () => {
    if (stopped || paused || timer || frameCallbackId != null) return;
    const runWhenDue = () => {
      frameCallbackId = null;
      if (stopped || paused) return;
      const remaining = scanInterval - (nowMs() - lastScanStartedAt);
      if (remaining > 1) {
        timer = setTimeout(() => {
          timer = null;
          scheduleNextScan();
        }, remaining);
        return;
      }
      void loop();
    };

    if (useVideoFrameCallback) {
      frameCallbackId = video.requestVideoFrameCallback(runWhenDue);
    } else {
      const remaining = Math.max(0, scanInterval - (nowMs() - lastScanStartedAt));
      timer = setTimeout(() => {
        timer = null;
        runWhenDue();
      }, remaining);
    }
  };

  const loop = async () => {
    if (stopped || paused) return;
    if (!busy && video.readyState >= 2) {
      busy = true;
      frameNumber++;
      const observations = [];
      const frameDiagnostics = {};
      const capturedFrame = {};
      const frameStarted = nowMs();
      lastScanStartedAt = frameStarted;
      let allowAutoEnhance = false;
      let allowFinderRecovery = false;
      try {
        // The first frame stays minimal. The primary finder pass itself is now
        // QuadQR-aware (max RGB/value channel), so it remains cheap while no
        // longer confusing dark blue data with structural black. After a miss,
        // alternate frames may bracket finder thresholds and then use the
        // stronger color recovery path. Empty camera frames therefore do not
        // pay every recovery cost on every scan tick.
        allowFinderRecovery = options.finderRecovery !== false &&
          candidateRecoveryArmed && ((missStreak - 1) % cameraFinderRecoveryEvery === 0);
        allowAutoEnhance = options.autoEnhanceRecovery !== false &&
          candidateRecoveryArmed && ((missStreak - 1) % cameraAutoEnhanceEvery === 0);
        const method = allowAutoEnhance
          ? "progressive-color-recovery"
          : (allowFinderRecovery ? "finder-recovery" : "fast-scan");
        const result = scanVideoFrame(video, {
          ...options,
          _diagnosticLabel: method,
          finderRecovery: allowFinderRecovery,
          autoEnhanceRecovery: allowAutoEnhance,
          autoEnhanceWhenNoGeometry: allowAutoEnhance,
          // If geometry exists, the rectified QR-only pixel enhancer is both
          // stronger and much cheaper than reprocessing the whole live frame.
          fullFrameAutoEnhanceRecovery: options.fullFrameAutoEnhanceRecovery ?? false,
          maxDimension: baseCameraMaxDimension,
          canvas: scratchCanvas,
          _geometryHints: options.cameraGeometryReuse === false || !cameraGeometryHint ? undefined : [cameraGeometryHint],
          _capturedFrame: capturedFrame,
          _observationCollector: observations,
          _frameDiagnostics: frameDiagnostics
        });
        const elapsedMs = nowMs() - frameStarted;
        updateCameraGeometryHint(frameDiagnostics, result);
        emitDiagnostic({
          type: "frame",
          state: "decoded",
          method: result.recoveryMode ?? result.samplingMode ?? method,
          elapsedMs,
          missStreak,
          ...frameDiagnostics
        });
        emitDiagnostic({
          type: "success",
          state: "decoded",
          method: result.recoveryMode ?? result.samplingMode ?? method,
          elapsedMs,
          message: `Decoded v${result.version} · ECC ${result.eccLevel} · ${Math.round(elapsedMs)} ms`,
          ...frameDiagnostics
        });
        missStreak = 0;
        candidateRecoveryArmed = false;
        weakFinderStreak = 0;
        observationHistory.clear();
        if (emitResult(result, capturedFrame, frameDiagnostics)) return;
      } catch (error) {
        missStreak++;
        updateCameraGeometryHint(frameDiagnostics);
        const fastElapsedMs = nowMs() - frameStarted;
        emitDiagnostic({
          type: "frame",
          state: "miss",
          method: allowAutoEnhance
            ? "progressive-color-recovery"
            : (allowFinderRecovery ? "finder-recovery" : "fast-scan"),
          elapsedMs: fastElapsedMs,
          missStreak,
          error: error?.message ?? String(error),
          ...frameDiagnostics
        });

        // The main-thread fallback follows the same candidate-gated principle
        // as the dual-worker scanner. Miss count alone never wakes expensive
        // recovery. Two finders/geometry arm it immediately; a single finder
        // must persist across fresh frames first.
        const fastFinderCount = Math.max(
          Number(frameDiagnostics?.finderCount) || 0,
          Number(frameDiagnostics?.bestPass?.finderCount) || 0
        );
        const hasGeometryEvidence = Boolean(frameDiagnostics?.geometry?.homography);
        const hasStrongObservation = Boolean(selectBestFrameObservation(observations));
        if (hasGeometryEvidence || fastFinderCount >= 2 || hasStrongObservation) {
          candidateRecoveryArmed = true;
          weakFinderStreak = 0;
        } else if (fastFinderCount === 1) {
          weakFinderStreak++;
          candidateRecoveryArmed = weakFinderStreak >= weakFinderFramesRequired;
        } else {
          weakFinderStreak = 0;
          candidateRecoveryArmed = false;
        }

        // Geometry-aware high-resolution retry. A dense QuadQR can look large
        // enough in the preview while each individual module has become too
        // small after the normal 640 px scanner cap. If the fast pass already
        // sees at least two convincing finders, spend one bounded retry on a
        // higher-resolution copy of the visible camera ROI. Empty frames and
        // ordinary small codes never pay this cost.
        const shouldTryHighResolution = options.cameraHighResolutionRecovery !== false &&
          cameraHighResolutionMaxDimension > baseCameraMaxDimension &&
          (frameDiagnostics?.finderCount ?? 0) >= (options.cameraHighResolutionMinFinders ?? 2) &&
          ((missStreak - 1) % cameraHighResolutionEvery === 0);
        if (shouldTryHighResolution) {
          const highResolutionObservations = [];
          const highResolutionDiagnostics = {};
          const highResolutionCapturedFrame = {};
          emitDiagnostic({
            type: "method",
            state: "trying",
            method: "high-resolution-geometry-recovery",
            message: `Dense geometry detected · retrying at up to ${cameraHighResolutionMaxDimension}px`,
            ...frameDiagnostics
          });
          try {
            const recoveryStarted = nowMs();
            const recovered = scanVideoFrame(video, {
              ...options,
              _diagnosticLabel: "high-resolution-geometry-recovery",
              finderRecovery: true,
              autoEnhanceRecovery: false,
              fullFrameAutoEnhanceRecovery: false,
              maxDimension: cameraHighResolutionMaxDimension,
              canvas: highResolutionCanvas,
              _capturedFrame: highResolutionCapturedFrame,
              _observationCollector: highResolutionObservations,
              _frameDiagnostics: highResolutionDiagnostics
            });
            const recoveryElapsedMs = nowMs() - recoveryStarted;
            emitDiagnostic({
              type: "success",
              state: "decoded",
              method: "high-resolution-geometry-recovery",
              elapsedMs: recoveryElapsedMs,
              message: `High-resolution retry decoded v${recovered.version} · ${Math.round(recoveryElapsedMs)} ms`,
              ...(highResolutionDiagnostics ?? frameDiagnostics)
            });
            missStreak = 0;
            observationHistory.clear();
            if (emitResult({
              ...recovered,
              cameraHighResolutionRecovery: true,
              cameraProgressiveRecovery: true,
              recoveryMode: recovered.recoveryMode ?? "high-resolution-geometry-recovery"
            }, highResolutionCapturedFrame, highResolutionDiagnostics ?? frameDiagnostics)) return;
          } catch (highResolutionError) {
            observations.push(...highResolutionObservations);
            emitDiagnostic({
              type: "method",
              state: "failed",
              method: "high-resolution-geometry-recovery",
              message: `High-resolution geometry retry did not decode${highResolutionDiagnostics?.finderCount != null ? ` · ${highResolutionDiagnostics.finderCount} finder(s)` : ""}`,
              error: highResolutionError?.message ?? String(highResolutionError),
              ...(highResolutionDiagnostics ?? frameDiagnostics)
            });
          }
        }

        // Strong color casts can hide finder structure before normal geometry
        // recovery begins. QuadQR Auto Color retries the exact captured frame with a cheap
        // per-channel QuadQR Auto Color levels correction before any geometry-dependent
        // recovery. This runs only after the normal fast scan fails, and by
        // default only on every other missed frame after the first one.
        const shouldTryCameraAutoColor = options.cameraAutoColorRecovery !== false &&
          candidateRecoveryArmed &&
          capturedFrame.imageData &&
          ((missStreak - 1) % cameraAutoColorEvery === 0);
        if (shouldTryCameraAutoColor) {
          const requestedCrops = Array.isArray(options.cameraAutoColorCropInsets)
            ? options.cameraAutoColorCropInsets
            : [0.08, 0.16, 0.22, 0];
          const cropInsets = [];
          for (const value of requestedCrops) {
            const inset = clampNumber(Number(value), 0, 0.30);
            if (!cropInsets.some((item) => Math.abs(item - inset) < 0.001)) cropInsets.push(inset);
          }
          const explicitAnalysisInsets = Array.isArray(options.cameraAutoColorAnalysisInsets)
            ? options.cameraAutoColorAnalysisInsets
            : null;

          emitDiagnostic({
            type: "method",
            state: "trying",
            method: "camera-auto-color",
            message: `Fast scan failed · QuadQR Auto Color recovery inside camera guide (${cropInsets.map((v) => v ? `${Math.round(v * 100)}% crop` : "full frame").join(" → ")})`,
            ...frameDiagnostics
          });

          let autoColorDecoded = false;
          for (let profileIndex = 0; profileIndex < cropInsets.length; profileIndex++) {
            const cropInset = cropInsets[profileIndex];
            const cropped = cropImageDataInset(capturedFrame.imageData, cropInset);
            const defaultAnalysisInsets = [0.10, 0.08, 0.04, 0.10];
            const analysisInset = clampNumber(
              Number(explicitAnalysisInsets?.[profileIndex]
                ?? options.cameraAutoColorAnalysisInset
                ?? defaultAnalysisInsets[Math.min(profileIndex, defaultAnalysisInsets.length - 1)]),
              0,
              0.30
            );
            const autoColorObservations = [];
            const autoColorVisionDiagnostics = diagnosticsEnabled ? { passes: [] } : null;
            const autoColorFrameDiagnostics = diagnosticsEnabled ? {} : null;
            const cropLabel = cropInset ? `${Math.round(cropInset * 100)}pct-crop` : "full";
            const profileName = `camera-auto-color-${cropLabel}`;
            try {
              const recoveryStarted = nowMs();
              const correctedFrame = autoColorImageData(cropped.imageData, {
                // This is intentionally performed on a centered recovery crop.
                // A live preview can contain large dark borders, browser UI, a
                // monitor bezel or room background. Those pixels completely
                // change global QuadQR Auto Color/Otsu statistics even though the QR
                // itself looks identical to a saved crop. QuadQR recovery stays
                // QR-centric so surrounding scene pixels do not dominate the correction.
                blackClip: options.cameraAutoColorBlackClip ?? 0.0001,
                whiteClip: options.cameraAutoColorWhiteClip ?? 0.004,
                highlightPercentile: options.cameraAutoColorHighlightPercentile ?? 0.95,
                outputHighlight: options.cameraAutoColorOutputHighlight ?? 190,
                analysisInset,
                minimumInputRange: options.cameraAutoColorMinimumInputRange ?? 72,
                targetSamples: options.cameraAutoColorTargetSamples ?? 90000
              });
              const recovered = scanImageData(correctedFrame, {
                ...options,
                _diagnosticLabel: profileName,
                _visionDiagnostics: autoColorVisionDiagnostics,
                finderRecovery: true,
                autoEnhanceRecovery: false,
                fullFrameAutoEnhanceRecovery: false,
                _observationCollector: autoColorObservations
              });
              if (autoColorFrameDiagnostics) {
                normalizeFrameDiagnostics(
                  autoColorFrameDiagnostics,
                  capturedFrame.source ?? { x: 0, y: 0, width: capturedFrame.scanWidth, height: capturedFrame.scanHeight, cropped: false },
                  correctedFrame.width,
                  correctedFrame.height,
                  autoColorVisionDiagnostics
                );
                autoColorFrameDiagnostics.frameWidth = capturedFrame.scanWidth;
                autoColorFrameDiagnostics.frameHeight = capturedFrame.scanHeight;
                autoColorFrameDiagnostics.scanRect = { ...cropped.rect };
                autoColorFrameDiagnostics.autoColorCropInset = cropInset;
                autoColorFrameDiagnostics.autoColorAnalysisInset = analysisInset;
              }
              const recoveryElapsedMs = nowMs() - recoveryStarted;
              emitDiagnostic({
                type: "frame",
                state: "decoded",
                method: profileName,
                elapsedMs: recoveryElapsedMs,
                missStreak,
                ...(autoColorFrameDiagnostics ?? frameDiagnostics)
              });
              emitDiagnostic({
                type: "success",
                state: "decoded",
                method: "camera-auto-color",
                elapsedMs: recoveryElapsedMs,
                message: `QuadQR Auto Color ${cropInset ? `${Math.round(cropInset * 100)}% crop` : "full frame"} decoded v${recovered.version} · ECC ${recovered.eccLevel} · ${Math.round(recoveryElapsedMs)} ms`,
                ...(autoColorFrameDiagnostics ?? frameDiagnostics)
              });
              capturedFrame.enhancedImageData = correctedFrame;
              capturedFrame.enhancedRect = { ...cropped.rect };
              capturedFrame.enhancement = {
                method: "camera-auto-color",
                cropInset,
                analysisInset
              };
              missStreak = 0;
              observationHistory.clear();
              autoColorDecoded = true;
              if (emitResult({
                ...recovered,
                autoColorCorrected: true,
                cameraProgressiveRecovery: true,
                recoveryMode: "camera-auto-color",
                cameraAutoColorCropInset: cropInset,
                cameraAutoColorAnalysisInset: analysisInset
              }, capturedFrame, autoColorFrameDiagnostics ?? frameDiagnostics)) return;
              break;
            } catch (recoveryError) {
              observations.push(...autoColorObservations);
              if (autoColorFrameDiagnostics) {
                normalizeFrameDiagnostics(
                  autoColorFrameDiagnostics,
                  capturedFrame.source ?? { x: 0, y: 0, width: capturedFrame.scanWidth, height: capturedFrame.scanHeight, cropped: false },
                  cropped.imageData.width,
                  cropped.imageData.height,
                  autoColorVisionDiagnostics
                );
                autoColorFrameDiagnostics.frameWidth = capturedFrame.scanWidth;
                autoColorFrameDiagnostics.frameHeight = capturedFrame.scanHeight;
                autoColorFrameDiagnostics.scanRect = { ...cropped.rect };
                autoColorFrameDiagnostics.autoColorCropInset = cropInset;
                autoColorFrameDiagnostics.autoColorAnalysisInset = analysisInset;
                emitDiagnostic({
                  type: "frame",
                  state: "miss",
                  method: profileName,
                  elapsedMs: nowMs() - frameStarted,
                  missStreak,
                  error: recoveryError?.message ?? String(recoveryError),
                  ...autoColorFrameDiagnostics
                });
              }
              emitDiagnostic({
                type: "method",
                state: "failed",
                method: profileName,
                message: `QuadQR Auto Color ${cropInset ? `${Math.round(cropInset * 100)}% crop` : "full frame"} did not decode${autoColorFrameDiagnostics?.finderCount != null ? ` · ${autoColorFrameDiagnostics.finderCount} finder(s)` : ""}`,
                ...(autoColorFrameDiagnostics ?? frameDiagnostics)
              });
            }
          }
          if (!autoColorDecoded) {
            emitDiagnostic({
              type: "method",
              state: "failed",
              method: "camera-auto-color",
              message: "All camera QuadQR Auto Color profiles failed · continuing deeper recovery",
              ...frameDiagnostics
            });
          }
        }

        // If the fast pass already saw a convincing QuadQR structure, retry
        // the exact same captured ROI immediately with the stronger QR-region
        // color correction. Empty/non-QR frames do not pay this cost. This is
        // the live equivalent of: normal scan first, then Auto Tone / Contrast
        // / Color only when the normal decode actually needs help.
        if (!allowAutoEnhance && options.autoEnhanceRecovery !== false) {
          const strongObservation = selectBestFrameObservation(observations);
          if (strongObservation && scratchCanvas.width && scratchCanvas.height) {
            emitDiagnostic({
              type: "method",
              state: "trying",
              method: "qr-region-auto-enhance",
              message: "Fast decode failed · trying QR-region Auto Tone / Contrast / Color",
              ...frameDiagnostics
            });
            try {
              const recoveryStarted = nowMs();
              const frameContext = scratchCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
              const capturedImageData = frameContext.getImageData(0, 0, scratchCanvas.width, scratchCanvas.height);
              const recoveryObservations = [];
              const recoveryVisionDiagnostics = diagnosticsEnabled ? { passes: [] } : null;
              const recovered = scanImageData(capturedImageData, {
                ...options,
                _diagnosticLabel: "qr-region-auto-enhance",
                _visionDiagnostics: recoveryVisionDiagnostics,
                autoEnhanceRecovery: true,
                autoEnhanceWhenNoGeometry: false,
                fullFrameAutoEnhanceRecovery: false,
                _observationCollector: recoveryObservations
              });
              const recoveryElapsedMs = nowMs() - recoveryStarted;
              emitDiagnostic({
                type: "success",
                state: "decoded",
                method: recovered.recoveryMode ?? recovered.samplingMode ?? "qr-region-auto-enhance",
                elapsedMs: recoveryElapsedMs,
                message: `Recovery decoded v${recovered.version} · ECC ${recovered.eccLevel} · ${Math.round(recoveryElapsedMs)} ms`,
                ...frameDiagnostics
              });
              missStreak = 0;
              observationHistory.clear();
              if (emitResult({
                ...recovered,
                cameraProgressiveRecovery: true
              }, capturedFrame, frameDiagnostics)) return;
            } catch {
              emitDiagnostic({
                type: "method",
                state: "failed",
                method: "qr-region-auto-enhance",
                message: "QR-region color recovery did not decode · trying multi-frame ECC",
                ...frameDiagnostics
              });
              // Keep the original observations for multi-frame voting below.
            }
          }
        }

        const combined = tryMultiFrameDecode(observations);
        if (combined) {
          emitDiagnostic({
            type: "success",
            state: "decoded",
            method: "multi-frame-confidence-fusion",
            message: `Multi-frame confidence fusion decoded v${combined.version} from ${combined.multiFrameCombined} frames`,
            ...frameDiagnostics
          });
          missStreak = 0;
          if (emitResult(combined, capturedFrame, frameDiagnostics)) return;
        } else {
          options.onScanMiss?.(error);
        }
      } finally {
        busy = false;
      }
    }
    scheduleNextScan();
  };

  if (pauseWhenHidden && typeof document !== "undefined" && document.addEventListener) {
    visibilityHandler = () => {
      if (document.hidden) pause();
      else resume();
    };
    document.addEventListener("visibilitychange", visibilityHandler);
    if (document.hidden) paused = true;
  }
  if (options.signal?.addEventListener) {
    abortHandler = () => stop();
    options.signal.addEventListener("abort", abortHandler, { once: true });
    if (options.signal.aborted) {
      stop();
      throw makeCameraAbortError();
    }
  }
  if (track?.addEventListener) {
    trackEndedHandler = () => {
      if (stopped) return;
      emitDiagnostic({ type: "camera-ended", state: "ended", method: "camera", message: "Camera track ended unexpectedly" });
      emitCameraState("ended");
      stop();
    };
    track.addEventListener("ended", trackEndedHandler);
  }
  emitCameraState(paused ? "paused" : "running", { ready: true });

  if (!paused) scheduleNextScan();
  return {
    stream,
    stop,
    pause,
    resume,
    scanNow,
    video,
    get paused() { return paused; },
    continuous: !stopOnResult
  };
}


function cameraWorkerSupported(options = {}) {
  if (options.cameraWorker === false) return false;
  return typeof Worker === "function" &&
    typeof createImageBitmap === "function" &&
    typeof OffscreenCanvas === "function";
}

function serializableCameraWorkerOptions(options = {}) {
  const skip = new Set([
    "canvas",
    "constraints",
    "onDecode",
    "onDiagnostic",
    "onResult",
    "onScanMiss",
    "onCameraState",
    "signal",
    "cameraWorkerUrl"
  ]);
  const out = {};
  for (const [key, value] of Object.entries(options)) {
    if (skip.has(key) || typeof value === "function" || value == null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) => {
        if (item && typeof item === "object") return { ...item };
        return item;
      });
      continue;
    }
    if (Object.getPrototypeOf(value) === Object.prototype) out[key] = { ...value };
  }
  return out;
}

function resolveCameraWorkerUrl(options = {}) {
  if (options.cameraWorkerUrl) {
    return new URL(
      options.cameraWorkerUrl,
      typeof document !== "undefined" ? document.baseURI : import.meta.url
    );
  }
  return new URL("./camera-scanner-worker.js", import.meta.url);
}

async function initializeCameraWorker(options = {}) {
  const worker = new Worker(resolveCameraWorkerUrl(options), {
    type: "module",
    name: "quadqr-camera-scanner"
  });
  let sequence = 0;
  const pending = new Map();
  let fatalError = null;

  const rejectPending = (error) => {
    fatalError = error instanceof Error ? error : new Error(String(error));
    for (const { reject } of pending.values()) reject(fatalError);
    pending.clear();
  };

  worker.addEventListener("message", (event) => {
    const message = event.data ?? {};
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.result);
    else {
      const error = new Error(message.error?.message ?? "QuadQR camera worker failed.");
      error.name = message.error?.name ?? "Error";
      error.stack = message.error?.stack ?? error.stack;
      error.debug = message.error?.debug ?? null;
      entry.reject(error);
    }
  });
  worker.addEventListener("error", (event) => {
    rejectPending(new Error(event?.message || "QuadQR camera worker crashed."));
  });
  worker.addEventListener("messageerror", () => {
    rejectPending(new Error("QuadQR camera worker returned an unreadable message."));
  });

  const request = (type, payload = {}, transfer = []) => {
    if (fatalError) return Promise.reject(fatalError);
    const id = `qqr-camera-${++sequence}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, type, ...payload }, transfer);
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  };

  try {
    const state = await request("init", { options: serializableCameraWorkerOptions(options) });
    if (!state?.offscreenCanvas) throw new Error("OffscreenCanvas is unavailable in the QuadQR camera worker.");
    return {
      worker,
      state,
      request,
      terminate() {
        rejectPending(new Error("QuadQR camera worker stopped."));
        worker.terminate();
      }
    };
  } catch (error) {
    worker.terminate();
    throw error;
  }
}

async function captureCameraBitmap(video, source, maxDimension) {
  const cap = Math.max(1, Math.round(maxDimension));
  const videoWidth = Math.max(1, Math.round(video.videoWidth || source.width || 1));
  const videoHeight = Math.max(1, Math.round(video.videoHeight || source.height || 1));
  const sx = clampNumber(Math.round(source.x || 0), 0, Math.max(0, videoWidth - 1));
  const sy = clampNumber(Math.round(source.y || 0), 0, Math.max(0, videoHeight - 1));
  const sw = Math.max(1, Math.min(videoWidth - sx, Math.round(source.width || videoWidth)));
  const sh = Math.max(1, Math.min(videoHeight - sy, Math.round(source.height || videoHeight)));
  const scale = Math.min(1, cap / Math.max(sw, sh));
  const width = Math.max(1, Math.round(sw * scale));
  const height = Math.max(1, Math.round(sh * scale));

  // Crop and resize before crossing the worker boundary. Previously every
  // 640px scan transferred a full 1080p camera bitmap and only then shrank it
  // inside OffscreenCanvas. On phones that creates unnecessary GPU/memory
  // pressure and can delay fresh-frame acquisition even though decoding is
  // off-thread. The fallback preserves compatibility with browsers that do not
  // implement the resize overload for video-backed ImageBitmap creation.
  try {
    const bitmap = await createImageBitmap(video, sx, sy, sw, sh, {
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: "medium"
    });
    return {
      bitmap,
      source: { x: 0, y: 0, width: bitmap.width, height: bitmap.height, cropped: Boolean(source.cropped) },
      originalSource: { ...source },
      preScaled: true
    };
  } catch {
    const bitmap = await createImageBitmap(video);
    return {
      bitmap,
      source: { ...source },
      originalSource: { ...source },
      preScaled: false
    };
  }
}

function maximumFinderCount(workerResult) {
  let count = 0;
  for (const diagnostic of workerResult?.diagnostics ?? []) {
    count = Math.max(
      count,
      Number(diagnostic?.finderCount) || 0,
      Number(diagnostic?.bestPass?.finderCount) || 0
    );
    for (const pass of diagnostic?.finderPasses ?? []) {
      count = Math.max(count, Number(pass?.finderCount) || 0);
    }
  }
  return count;
}

async function startCameraScannerWorker(video, options = {}) {
  assert(typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia, "Camera API is unavailable.");
  assert(video, "A video element is required.");
  if (options.signal?.aborted) throw makeCameraAbortError();

  // Keep fresh-frame scanning independent from the expensive damaged/color
  // recovery pipeline. Finder detection itself remains JavaScript; WASM is
  // only an optional grayscale/binary + CRC accelerator beneath both workers.
  // The fast worker can therefore inspect the newest frame even while the
  // recovery worker is spending hundreds of milliseconds on an older difficult
  // frame. No recovery method is removed.
  const stopOnResult = cameraScannerStopsOnResult(options);
  const workerOptions = { ...options, stopOnResult };
  const fastWorkerOptions = {
    ...workerOptions,
    cameraPipelineMode: "fast",
    // The fresh-frame worker is intentionally detection/decode only. Recovery
    // must never become more expensive merely because the camera has been
    // looking at an empty scene for a while. The parallel recovery worker is
    // armed only after finder/geometry evidence says a QuadQR candidate is in
    // view.
    finderRecovery: false,
    cameraHighResolutionRecovery: false,
    cameraAutoColorRecovery: false,
    autoEnhanceRecovery: false,
    fullFrameAutoEnhanceRecovery: false,
    multiFrame: false
  };
  const fastWorkerClient = await initializeCameraWorker(fastWorkerOptions);

  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia(
      options.constraints ?? {
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        }
      }
    );
    await improveCameraTrack(stream);

    video.srcObject = stream;
    video.setAttribute("playsinline", "");
    video.muted = true;
    await video.play();
  } catch (error) {
    fastWorkerClient.terminate();
    for (const track of stream?.getTracks?.() ?? []) track.stop();
    if (video.srcObject === stream) video.srcObject = null;
    throw error;
  }

  const scanInterval = Math.max(24, Number(options.scanInterval ?? 33));
  const fastCaptureMaxDimension = Math.max(480, Math.round(options.maxDimension ?? 640));
  const recoveryCaptureMaxDimension = Math.max(
    fastCaptureMaxDimension,
    Math.round(options.cameraHighResolutionMaxDimension ?? 960)
  );
  const recoveryStrongFinderInterval = Math.max(80, Number(options.cameraRecoveryStrongFinderInterval ?? 120));
  const recoveryWeakFinderInterval = Math.max(recoveryStrongFinderInterval, Number(options.cameraRecoveryWeakFinderInterval ?? 260));
  const recoveryWeakFinderFrames = Math.max(2, Math.round(options.cameraRecoveryWeakFinderFrames ?? 2));
  const useVideoFrameCallback = options.useVideoFrameCallback !== false &&
    typeof video.requestVideoFrameCallback === "function";

  const duplicateCooldown = Math.max(0, Number(options.duplicateCooldown ?? (stopOnResult ? 0 : 1200)));
  const pauseWhenHidden = options.pauseWhenHidden !== false;
  let stopped = false;
  let paused = false;
  let busy = false;
  let recoveryBusy = false;
  let recoveryWorkerClient = null;
  let recoveryWorkerPromise = null;
  let recoveryWorkerFailed = false;
  let timer = null;
  let frameCallbackId = null;
  let lastScanStartedAt = -Infinity;
  let lastRecoveryStartedAt = -Infinity;
  let frameNumber = 0;
  let requestToken = 0;
  let recoveryToken = 0;
  let weakFinderStreak = 0;
  let freshnessGeneration = 0;
  let fastWorkerGeneration = 0;
  let recoveryWorkerGeneration = 0;
  let lastResultIdentity = null;
  let lastResultAt = -Infinity;
  let visibilityHandler = null;
  let abortHandler = null;
  let trackEndedHandler = null;

  const diagnosticsEnabled = typeof options.onDiagnostic === "function";
  const emitDiagnostic = (event) => {
    if (!diagnosticsEnabled) return;
    try {
      options.onDiagnostic({
        timestamp: Date.now(),
        frame: event?.frame ?? frameNumber,
        cameraWorker: true,
        ...event
      });
    } catch {
      // Diagnostics are UI-only and must never interrupt scanning.
    }
  };

  const emitCameraState = (state, extra = {}) => {
    try { options.onCameraState?.({ state, timestamp: Date.now(), ...extra }); } catch {}
  };

  const ensureRecoveryWorker = async () => {
    if (recoveryWorkerClient) return recoveryWorkerClient;
    if (recoveryWorkerFailed) return null;
    if (!recoveryWorkerPromise) {
      recoveryWorkerPromise = initializeCameraWorker({ ...workerOptions, cameraPipelineMode: "full" })
        .then((client) => {
          if (stopped || paused) {
            client.terminate();
            return null;
          }
          recoveryWorkerClient = client;
          return client;
        })
        .catch((error) => {
          recoveryWorkerFailed = true;
          emitDiagnostic({
            type: "recovery-worker-error",
            state: "fallback",
            method: "camera-fast-worker",
            message: `Parallel recovery worker unavailable · fast scanner remains active (${error?.message ?? String(error)})`
          });
          return null;
        })
        .finally(() => {
          recoveryWorkerPromise = null;
        });
    }
    return recoveryWorkerPromise;
  };

  const track = stream.getVideoTracks?.()[0];
  const settings = track?.getSettings?.() ?? {};
  emitDiagnostic({
    type: "camera-ready",
    method: "camera-dual-worker",
    message: `Camera ready · ${settings.width ?? video.videoWidth}×${settings.height ?? video.videoHeight} · fast fresh-frame scanner + candidate-gated parallel recovery`,
    camera: {
      width: settings.width ?? video.videoWidth,
      height: settings.height ?? video.videoHeight,
      frameRate: settings.frameRate ?? null,
      facingMode: settings.facingMode ?? null
    },
    worker: fastWorkerClient.state,
    scanMaxDimension: fastCaptureMaxDimension,
    recoveryMaxDimension: recoveryCaptureMaxDimension
  });

  const cancelScheduledScan = () => {
    if (timer) clearTimeout(timer);
    if (frameCallbackId != null && typeof video.cancelVideoFrameCallback === "function") {
      try { video.cancelVideoFrameCallback(frameCallbackId); } catch {}
    }
    timer = null;
    frameCallbackId = null;
  };

  const invalidateFreshness = () => {
    freshnessGeneration++;
    requestToken++;
    recoveryToken++;
    weakFinderStreak = 0;
    lastRecoveryStartedAt = -Infinity;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    paused = false;
    invalidateFreshness();
    cancelScheduledScan();
    if (visibilityHandler && typeof document !== "undefined") document.removeEventListener("visibilitychange", visibilityHandler);
    if (abortHandler && options.signal?.removeEventListener) options.signal.removeEventListener("abort", abortHandler);
    if (trackEndedHandler && track?.removeEventListener) track.removeEventListener("ended", trackEndedHandler);
    fastWorkerClient.terminate();
    if (recoveryWorkerClient) {
      recoveryWorkerClient.terminate();
      recoveryWorkerClient = null;
    } else if (recoveryWorkerPromise) {
      void recoveryWorkerPromise.then((client) => client?.terminate()).catch(() => {});
    }
    for (const cameraTrack of stream.getTracks()) cameraTrack.stop();
    if (video.srcObject === stream) video.srcObject = null;
    emitCameraState("stopped");
  };

  const pause = () => {
    if (stopped || paused) return;
    paused = true;
    invalidateFreshness();
    cancelScheduledScan();
    if (recoveryWorkerClient) {
      recoveryWorkerClient.terminate();
      recoveryWorkerClient = null;
    }
    emitDiagnostic({ type: "camera-paused", state: "paused", method: "camera-dual-worker", message: "Camera scanning paused" });
    emitCameraState("paused");
  };

  const resume = () => {
    if (stopped || !paused) return;
    paused = false;
    invalidateFreshness();
    lastScanStartedAt = -Infinity;
    emitDiagnostic({ type: "camera-resumed", state: "running", method: "camera-dual-worker", message: "Camera scanning resumed with fresh worker state" });
    emitCameraState("running", { resumed: true });
    scheduleNextScan();
  };

  // Preserve the historical immediate/manual helper as a synchronous scan of
  // the current video element. The continuous scanner itself stays off-thread.
  const scanNow = () => scanVideoFrame(video, {
    ...options,
    maxDimension: fastCaptureMaxDimension
  });

  const emitResult = (result, frameMeta = null) => {
    if (stopped) return true;
    const normalizedMeta = frameMeta
      ? { frame: frameMeta.frame ?? frameNumber, ...frameMeta }
      : null;

    if (!stopOnResult) invalidateFreshness();
    const identity = cameraResultIdentity(result);
    const decodedAt = nowMs();
    if (!stopOnResult && duplicateCooldown > 0 && identity && identity === lastResultIdentity && decodedAt - lastResultAt < duplicateCooldown) {
      emitDiagnostic({
        type: "duplicate-suppressed",
        state: "ignored",
        method: "continuous-scan",
        message: `Duplicate QuadQR result suppressed for ${Math.round(duplicateCooldown)} ms`
      });
      return false;
    }
    if (identity) {
      lastResultIdentity = identity;
      lastResultAt = decodedAt;
    }

    options.onResult?.(result, normalizedMeta);
    options.onDecode?.(result, normalizedMeta);
    if (stopOnResult) {
      stop();
      return true;
    }
    return false;
  };

  const runRecovery = async (triggerFrame, finderCount) => {
    if (stopped || paused || recoveryBusy) return;
    recoveryBusy = true;
    lastRecoveryStartedAt = nowMs();
    const token = ++recoveryToken;
    let bitmap = null;
    try {
      const client = await ensureRecoveryWorker();
      if (stopped || paused || token !== recoveryToken) return;
      const recoveryClient = client ?? fastWorkerClient;
      const singleWorkerFallback = !client;
      if (!stopOnResult) {
        if (singleWorkerFallback) {
          // The fast worker guard already resets itself after a successful
          // continuous decode. Avoid concurrent reset/scan messages when one
          // worker is temporarily serving both lanes.
          fastWorkerGeneration = freshnessGeneration;
        } else if (recoveryWorkerGeneration !== freshnessGeneration) {
          await recoveryClient.request("reset");
          recoveryWorkerGeneration = freshnessGeneration;
        }
      }
      const dispatchGeneration = freshnessGeneration;

      // Capture only after the recovery execution path is ready. This guarantees
      // the expensive path receives a fresh frame rather than a bitmap that sat
      // in memory while a recovery worker was starting.
      const visibleSource = visibleVideoSourceRect(video, options);
      const captured = await captureCameraBitmap(video, visibleSource, recoveryCaptureMaxDimension);
      bitmap = captured.bitmap;
      if (stopped || paused || token !== recoveryToken || dispatchGeneration !== freshnessGeneration) {
        bitmap.close?.();
        return;
      }

      emitDiagnostic({
        type: "recovery-dispatch",
        state: "trying",
        method: "parallel-full-recovery",
        frame: triggerFrame,
        finderCount,
        message: `QuadQR candidate detected (${finderCount} finder${finderCount === 1 ? "" : "s"}) · full recovery running in parallel`
      });

      const recoveryPayload = { bitmap, source: captured.source, frame: triggerFrame };
      if (singleWorkerFallback) recoveryPayload.options = serializableCameraWorkerOptions(workerOptions);
      const workerResult = await recoveryClient.request(
        singleWorkerFallback ? "scan-full" : "scan",
        recoveryPayload,
        [bitmap]
      );
      bitmap = null;
      if (stopped || paused || token !== recoveryToken || dispatchGeneration !== freshnessGeneration) return;

      for (const diagnostic of workerResult?.diagnostics ?? []) {
        emitDiagnostic({
          ...diagnostic,
          recoveryWorker: !singleWorkerFallback,
          singleWorkerRecoveryFallback: singleWorkerFallback,
          frame: triggerFrame
        });
      }
      if (workerResult?.ok) {
        emitResult(workerResult.result, { ...workerResult.frameMeta, frame: triggerFrame });
      }
    } catch (error) {
      try { bitmap?.close?.(); } catch {}
      if (!stopped && !paused) {
        emitDiagnostic({
          type: "recovery-worker-error",
          state: "error",
          method: "parallel-full-recovery",
          frame: triggerFrame,
          message: error?.message ?? String(error)
        });
      }
    } finally {
      recoveryBusy = false;
    }
  };

  const maybeDispatchRecovery = (workerResult, triggerFrame) => {
    if (stopped || paused || recoveryBusy) return;
    const finderCount = maximumFinderCount(workerResult);

    // Do not run Auto Color, high-resolution, multi-frame, or damaged-code
    // recovery just because time has passed. An empty scene stays on the cheap
    // fresh-frame detector forever. Two or more finders are strong evidence and
    // arm recovery immediately. One finder is treated as weak evidence and must
    // persist across consecutive fresh frames before recovery is allowed.
    let minimumInterval = null;
    if (finderCount >= 2) {
      weakFinderStreak = 0;
      minimumInterval = recoveryStrongFinderInterval;
    } else if (finderCount === 1) {
      weakFinderStreak++;
      if (weakFinderStreak < recoveryWeakFinderFrames) return;
      minimumInterval = recoveryWeakFinderInterval;
    } else {
      weakFinderStreak = 0;
      return;
    }

    const elapsed = nowMs() - lastRecoveryStartedAt;
    if (elapsed >= minimumInterval) void runRecovery(triggerFrame, finderCount);
  };

  const scheduleNextScan = () => {
    if (stopped || paused || timer || frameCallbackId != null) return;
    const runWhenDue = () => {
      frameCallbackId = null;
      if (stopped || paused) return;
      const remaining = scanInterval - (nowMs() - lastScanStartedAt);
      if (remaining > 1) {
        timer = setTimeout(() => {
          timer = null;
          scheduleNextScan();
        }, remaining);
        return;
      }
      void loop();
    };

    if (useVideoFrameCallback) {
      frameCallbackId = video.requestVideoFrameCallback(runWhenDue);
    } else {
      const remaining = Math.max(0, scanInterval - (nowMs() - lastScanStartedAt));
      timer = setTimeout(() => {
        timer = null;
        runWhenDue();
      }, remaining);
    }
  };

  const loop = async () => {
    if (stopped || paused) return;
    if (!busy && video.readyState >= 2) {
      busy = true;
      frameNumber++;
      const currentFrame = frameNumber;
      lastScanStartedAt = nowMs();
      const token = ++requestToken;
      let bitmap = null;
      try {
        if (!stopOnResult && fastWorkerGeneration !== freshnessGeneration) {
          await fastWorkerClient.request("reset");
          fastWorkerGeneration = freshnessGeneration;
        }
        const dispatchGeneration = freshnessGeneration;
        const visibleSource = visibleVideoSourceRect(video, options);
        const captured = await captureCameraBitmap(video, visibleSource, fastCaptureMaxDimension);
        bitmap = captured.bitmap;
        if (stopped || paused || token !== requestToken || dispatchGeneration !== freshnessGeneration) {
          bitmap.close?.();
          if (!stopped && !paused) scheduleNextScan();
          return;
        }
        const workerResult = await fastWorkerClient.request(
          "scan",
          { bitmap, source: captured.source, frame: currentFrame },
          [bitmap]
        );
        bitmap = null;
        if (stopped || paused || token !== requestToken || dispatchGeneration !== freshnessGeneration) {
          if (!stopped && !paused) scheduleNextScan();
          return;
        }

        for (const diagnostic of workerResult?.diagnostics ?? []) {
          emitDiagnostic({ ...diagnostic, fastWorker: true, frame: currentFrame });
        }
        if (workerResult?.ok) {
          if (emitResult(workerResult.result, { ...workerResult.frameMeta, frame: currentFrame })) return;
        } else {
          // Full perspective/color/damage recovery runs independently. Do not
          // await it here: the next camera callback must remain free to inspect
          // a newer frame immediately.
          maybeDispatchRecovery(workerResult, currentFrame);
          const error = new Error(workerResult?.error?.message ?? "Unable to decode QuadQR frame.");
          error.name = workerResult?.error?.name ?? "Error";
          error.debug = workerResult?.error?.debug ?? null;
          options.onScanMiss?.(error);
        }
      } catch (error) {
        try { bitmap?.close?.(); } catch {}
        if (!stopped && !paused) {
          emitDiagnostic({
            type: "worker-error",
            state: "error",
            method: "camera-fast-worker",
            frame: currentFrame,
            message: error?.message ?? String(error)
          });
          options.onScanMiss?.(error);
        }
      } finally {
        busy = false;
      }
    }
    scheduleNextScan();
  };

  if (pauseWhenHidden && typeof document !== "undefined" && document.addEventListener) {
    visibilityHandler = () => {
      if (document.hidden) pause();
      else resume();
    };
    document.addEventListener("visibilitychange", visibilityHandler);
    if (document.hidden) paused = true;
  }
  if (options.signal?.addEventListener) {
    abortHandler = () => stop();
    options.signal.addEventListener("abort", abortHandler, { once: true });
    if (options.signal.aborted) {
      stop();
      throw makeCameraAbortError();
    }
  }
  if (track?.addEventListener) {
    trackEndedHandler = () => {
      if (stopped) return;
      emitDiagnostic({ type: "camera-ended", state: "ended", method: "camera-dual-worker", message: "Camera track ended unexpectedly" });
      emitCameraState("ended");
      stop();
    };
    track.addEventListener("ended", trackEndedHandler);
  }
  emitCameraState(paused ? "paused" : "running", { ready: true });

  if (!paused) scheduleNextScan();
  return {
    stream,
    stop,
    pause,
    resume,
    scanNow,
    video,
    worker: true,
    workerMode: "dual-pipeline",
    workerState: fastWorkerClient.state,
    get paused() { return paused; },
    continuous: !stopOnResult
  };
}

/**
 * Start continuous camera scanning. Modern browsers use a dedicated module
 * worker by default so the complete recovery pipeline can remain enabled
 * without blocking rendering/input. Unsupported/CSP-restricted environments
 * automatically fall back to the original main-thread scanner.
 */
export async function startCameraScanner(video, options = {}) {
  if (cameraWorkerSupported(options)) {
    try {
      return await startCameraScannerWorker(video, options);
    } catch (error) {
      if (options.cameraWorkerRequired) throw error;
      try {
        options.onDiagnostic?.({
          timestamp: Date.now(),
          frame: 0,
          type: "worker-fallback",
          state: "fallback",
          method: "camera-main-thread",
          message: `Background scanner unavailable · using main-thread fallback (${error?.message ?? String(error)})`
        });
      } catch {}
    }
  }
  return startCameraScannerMainThread(video, options);
}

export function rectifyDetectedCode(imageData, options = {}) {
  const candidates = detectCodeGeometry(imageData, {
    minVersion: options.minVersion ?? MIN_VERSION,
    maxVersion: options.maxVersion ?? MAX_VERSION,
    maxCandidates: 1
  });
  if (!candidates.length) throw new Error("Unable to locate QuadQR geometry.");
  const geometry = candidates[0];
  return {
    geometry,
    imageData: rectifyImageData(
      imageData,
      geometry.homography,
      sizeForVersion(geometry.version),
      options.moduleSize ?? 8
    )
  };
}

export function rotateMatrix(matrix, quarterTurns = 1) {
  let out = cloneMatrix(matrix);
  const turns = ((quarterTurns % 4) + 4) % 4;
  for (let i = 0; i < turns; i++) out = rotate90(out);
  return out;
}

export const internals = Object.freeze({
  sizeForVersion,
  versionFromSize,
  streamCellCount,
  createLayout,
  alignmentPatternCentersForVersion,
  bytesToCells,
  cellsToBytes,
  getBodyRsPlan,
  getHeaderPlan,
  interleaveBlocks,
  deinterleaveBlocks,
  spectralPermutation,
  applyData,
  unmaskCells,
  restoreLogicalOrder,
  cellsToSymbolConfidences,
  decodeRsAdaptive,
  classifierFromPaletteRgb,
  classifyRgb,
  observationDataAgreement,
  encodeProtectedHeader,
  decodeProtectedHeader,
  selectBestFrameObservation,
  combineFrameObservations,
  visibleVideoSourceRect,
  cropImageDataInset,
  HEADER_CODEWORD_CELLS,
  COMPACT_HEADER_CODEWORD_CELLS,
  CELLS_PER_BYTE,
  RGBW_CELLS_PER_BYTE,
  TRIANGLE16_CELLS_PER_BYTE,
  TRIANGLE16_FLAG,
  TEXT_FLAG,
  SECURE_FLAG
});
