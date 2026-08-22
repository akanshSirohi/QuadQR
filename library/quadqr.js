/**
 * QuadQR
 *
 * Experimental four-state RGBW matrix code written in pure JavaScript.
 *
 * Core format:
 * - Red / Green / Blue / White data cells
 * - exactly 2 bits per data cell
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
  sizeForVersion,
  versionFromSize
} from "./geometry.js";
import {
  detectCodeGeometry,
  samplePerspectiveMatrix,
  rectifyImageData,
  sampleObservedPalette,
  spatiallyNormalizeRgbGrid,
  autoToneContrastColorRgbGrid,
  autoToneContrastColorImageData,
  autoColorImageData,
  findActiveBounds,
  sampleAxisAlignedGrid
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
  bytesToHex
} from "./security.js";

export const FORMAT_VERSION = 5;
export const MIN_VERSION = 1;
export const MAX_VERSION = 40;
export const DEFAULT_ECC_LEVEL = "M";

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
const CELLS_PER_BYTE = 4;
const HEADER_CODEWORD_CELLS = HEADER_CODEWORD_BYTES * CELLS_PER_BYTE;

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
const COMPACT_HEADER_CODEWORD_CELLS = COMPACT_HEADER_CODEWORD_BYTES * CELLS_PER_BYTE;
const COMPACT_ECC_LEVELS = Object.freeze({
  L: Object.freeze({ paritySymbols: 4, correctableSymbolsPerBlock: 2 }),
  M: Object.freeze({ paritySymbols: 8, correctableSymbolsPerBlock: 4 }),
  Q: Object.freeze({ paritySymbols: 12, correctableSymbolsPerBlock: 6 }),
  H: Object.freeze({ paritySymbols: 16, correctableSymbolsPerBlock: 8 })
});

const CRC_BYTES = 4;
const TEXT_FLAG = 1;
const SECURE_FLAG = 1 << 3;
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

function bytesToCells(bytes) {
  const out = new Array(bytes.length * CELLS_PER_BYTE);
  let cursor = 0;
  for (const byte of bytes) {
    out[cursor++] = (byte >>> 6) & 0b11;
    out[cursor++] = (byte >>> 4) & 0b11;
    out[cursor++] = (byte >>> 2) & 0b11;
    out[cursor++] = byte & 0b11;
  }
  return out;
}

function cellsToBytes(cells, byteCount = Math.floor(cells.length / CELLS_PER_BYTE)) {
  assert(cells.length >= byteCount * CELLS_PER_BYTE, "Not enough RGBW cells to rebuild bytes.");
  const out = new Uint8Array(byteCount);
  for (let i = 0; i < byteCount; i++) {
    const offset = i * CELLS_PER_BYTE;
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

function flagsFor(text, eccLevel, secure = false) {
  return (text ? TEXT_FLAG : 0) |
    (secure ? SECURE_FLAG : 0) |
    ((ECC_LEVELS[eccLevel].id << ECC_SHIFT) & ECC_MASK);
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

function makeHeader(payloadLength, flags, version) {
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
  header[4] = FORMAT_VERSION;
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

  if (!magicMatches(header) || header[4] !== FORMAT_VERSION) {
    throw new Error("QuadQR magic/version mismatch.");
  }
  return { flags: header[5], payloadLength: readU32be(header, 6) };
}

function createLayout(version) {
  validateVersion(version);
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

  const alignments = alignmentPatternCentersForVersion(version).map(drawAlignmentPattern);
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

function makePaddingCells(count, seed) {
  let state = (seed >>> 0) || 0x6d2b79f5;
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = state & 3;
  }
  return out;
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

function applyData(layout, rawCells, maskId, spectralInterleaving = true) {
  const matrix = cloneMatrix(layout.matrix);
  const permutation = spectralInterleaving
    ? spectralPermutation(layout.dataPositions.length, layout.version)
    : null;

  for (let logicalIndex = 0; logicalIndex < layout.dataPositions.length; logicalIndex++) {
    const physicalIndex = permutation ? permutation[logicalIndex] : logicalIndex;
    const [row, col] = layout.dataPositions[physicalIndex];
    matrix[row][col] = rawCells[logicalIndex] ^ maskValue(row, col, maskId);
  }
  return matrix;
}

function quaternaryPenalty(matrix, reserved) {
  const size = matrix.length;
  let penalty = 0;
  const counts = [0, 0, 0, 0];
  let dataCount = 0;

  for (let r = 0; r < size; r++) {
    let previous = null;
    let run = 0;
    for (let c = 0; c < size; c++) {
      if (reserved[r][c]) {
        previous = null;
        run = 0;
        continue;
      }
      const value = matrix[r][c];
      counts[value]++;
      dataCount++;
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
      const value = matrix[r][c];
      if (value === previous) {
        run++;
        if (run >= 4) penalty += 2;
      } else {
        previous = value;
        run = 1;
      }
    }
  }

  if (dataCount > 0) {
    const ideal = dataCount / 4;
    penalty += counts.reduce((sum, count) => sum + Math.abs(count - ideal), 0) / 2;
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

function getBodyRsPlan(payloadLength, eccLevel, version = 2) {
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
    encodedCells: encodedSymbols * CELLS_PER_BYTE
  };
}

function streamCellCount(payloadLength, eccLevel, version) {
  return getHeaderPlan(version).codewordCells + getBodyRsPlan(payloadLength, eccLevel, version).encodedCells;
}

function streamFitsLayout(layout, eccLevel, payloadLength, version) {
  return streamCellCount(payloadLength, eccLevel, version) <= layout.dataPositions.length;
}

function getCapacityForLayout(layout, eccLevel, version) {
  if (!streamFitsLayout(layout, eccLevel, 0, version)) return 0;
  let low = 0;
  let high = Math.floor(layout.dataPositions.length / CELLS_PER_BYTE);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (streamFitsLayout(layout, eccLevel, mid, version)) low = mid;
    else high = mid - 1;
  }
  return low;
}

export function getVersionInfo(version, options = {}) {
  validateVersion(version);
  const eccLevel = normalizeEccLevel(options.ecc ?? DEFAULT_ECC_LEVEL);
  const layout = createLayout(version);
  const headerPlan = getHeaderPlan(version);
  const effectiveEcc = getEffectiveEcc(version, eccLevel);
  return {
    version,
    formatVersion: FORMAT_VERSION,
    eccLevel,
    size: layout.size,
    dataCells: layout.dataPositions.length,
    theoreticalBits: layout.dataPositions.length * 2,
    capacityBytes: getCapacityForLayout(layout, eccLevel, version),
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
    bitsPerDataCell: 2,
    colors: 4,
    spectralInterleaving: true,
    confidenceAwareEcc: true
  };
}

function chooseVersion(payloadLength, options = {}) {
  const requested = options.version ?? "auto";
  const minVersion = options.minVersion ?? MIN_VERSION;
  const maxVersion = options.maxVersion ?? MAX_VERSION;
  const ecc = normalizeEccLevel(options.ecc ?? DEFAULT_ECC_LEVEL);

  validateVersion(minVersion);
  validateVersion(maxVersion);
  assert(minVersion <= maxVersion, "minVersion must be <= maxVersion.");

  if (requested !== "auto") {
    validateVersion(requested);
    assert(requested >= minVersion && requested <= maxVersion, "Requested version is outside selected bounds.");
    const info = getVersionInfo(requested, { ecc });
    const layout = createLayout(requested);
    assert(
      payloadLength <= info.capacityBytes && streamFitsLayout(layout, ecc, payloadLength, requested),
      `Payload does not fit version ${requested} with ${ecc} ECC. Maximum is ${info.capacityBytes} bytes.`
    );
    return requested;
  }

  for (let version = minVersion; version <= maxVersion; version++) {
    const layout = createLayout(version);
    if (streamFitsLayout(layout, ecc, payloadLength, version)) return version;
  }
  throw new Error(`Payload is too large for versions ${minVersion}..${maxVersion}.`);
}

function encodeProtectedHeader(header, version) {
  const plan = getHeaderPlan(version);
  const codeword = rsEncode(Array.from(header), plan.paritySymbols);
  assert(codeword.length === plan.codewordBytes, "Header RS symbol calculation mismatch.");
  return bytesToCells(codeword);
}

function encodeProtectedBody(bodyBytes, eccLevel, version) {
  const plan = getBodyRsPlan(bodyBytes.length - CRC_BYTES, eccLevel, version);
  assert(bodyBytes.length === plan.dataSymbols, "Body RS symbol calculation mismatch.");

  const blocks = [];
  let offset = 0;
  for (const length of plan.dataBlockLengths) {
    blocks.push(rsEncode(Array.from(bodyBytes.slice(offset, offset + length)), plan.paritySymbols));
    offset += length;
  }
  return { cells: bytesToCells(interleaveBlocks(blocks)), plan };
}

function finalizeMatrix(layout, rawCells, meta) {
  let bestMaskId = 0;
  let bestMatrix = null;
  let bestPenalty = Infinity;

  for (let maskId = 0; maskId < 4; maskId++) {
    const candidate = applyData(layout, rawCells, maskId, true);
    const penalty = quaternaryPenalty(candidate, layout.reserved);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMaskId = maskId;
      bestMatrix = candidate;
    }
  }

  const info = getVersionInfo(meta.version, { ecc: meta.eccLevel });
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
    requiresDecryption: Boolean(meta.secure),
    security: meta.security ?? null,
    meaningfulCells: meta.meaningfulCells,
    dataCells: layout.dataPositions.length,
    capacityBytes: info.capacityBytes,
    alignmentPatterns: layout.alignments.length,
    utilization: meta.meaningfulCells / layout.dataPositions.length,
    bitsPerDataCell: 2,
    eccLevel: meta.eccLevel,
    eccParitySymbols: meta.eccParitySymbols,
    eccBlocks: meta.eccBlocks,
    correctableSymbolsPerBlock: meta.correctableSymbolsPerBlock,
    spectralInterleaving: true,
    confidenceAwareEcc: true,
    crc32: meta.crc >>> 0
  };
}

export function encodeText(text, options = {}) {
  assert(typeof text === "string", "encodeText expects a string.");
  return encodeBytes(getTextEncoder().encode(text), { ...options, text: true });
}

export function encodeBytes(input, options = {}) {
  if (options.formatVersion != null && options.formatVersion !== FORMAT_VERSION) {
    throw new Error(`Only QuadQR format version ${FORMAT_VERSION} is supported.`);
  }

  const payload = input instanceof Uint8Array ? input : new Uint8Array(input);
  const eccLevel = normalizeEccLevel(options.ecc ?? DEFAULT_ECC_LEVEL);
  const secure = Boolean(options.secure);
  const flags = flagsFor(Boolean(options.text), eccLevel, secure);
  const version = chooseVersion(payload.length, { ...options, ecc: eccLevel });
  const layout = createLayout(version);
  const header = makeHeader(payload.length, flags, version);
  const crc = crc32(concatBytes(header, payload));
  const headerCells = encodeProtectedHeader(header, version);
  const bodyEncoded = encodeProtectedBody(concatBytes(payload, u32be(crc)), eccLevel, version);
  const meaningfulCells = headerCells.concat(bodyEncoded.cells);
  assert(meaningfulCells.length <= layout.dataPositions.length, "Internal QuadQR capacity calculation error.");

  const padding = makePaddingCells(
    layout.dataPositions.length - meaningfulCells.length,
    crc ^ payload.length ^ (version << 24) ^ (ECC_LEVELS[eccLevel].id << 16)
  );

  return finalizeMatrix(layout, meaningfulCells.concat(padding), {
    version,
    payloadBytes: payload.length,
    sourcePayloadBytes: options.sourcePayloadBytes ?? payload.length,
    secure,
    security: options.securityMetadata ?? null,
    meaningfulCells: meaningfulCells.length,
    eccLevel,
    eccParitySymbols: bodyEncoded.plan.paritySymbols,
    eccBlocks: bodyEncoded.plan.dataBlockLengths.length,
    correctableSymbolsPerBlock: bodyEncoded.plan.correctableSymbolsPerBlock,
    crc
  });
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
  const sourcePayload = input instanceof Uint8Array ? input : new Uint8Array(input);
  const security = options.security ?? {};
  const encrypted = await encryptSecurePayload(sourcePayload, security);
  return encodeBytes(encrypted.envelope, {
    ...options,
    text: Boolean(options.text),
    secure: true,
    sourcePayloadBytes: sourcePayload.length,
    securityMetadata: encrypted.metadata
  });
}

/**
 * Decrypt a result returned by decodeMatrix/scanImageData/scanFile.
 * The encrypted envelope remains available as encryptedPayload.
 */
export async function decryptDecoded(result, security = {}) {
  assert(result?.secure && result?.payload, "decryptDecoded expects an encrypted QuadQR decode result.");
  const plaintext = await decryptSecurePayload(result.payload, security);
  const isText = (result.flags & TEXT_FLAG) !== 0;
  return {
    ...result,
    encryptedPayload: result.payload,
    encryptedPayloadBytes: result.payload.length,
    payload: plaintext,
    text: isText ? getTextDecoder().decode(plaintext) : null,
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

function alignmentGridMismatchRatio(matrix, version) {
  const patterns = alignmentPatternCentersForVersion(version);
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

function validateStructure(matrix, tolerance = 0) {
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
  const primary = alignmentPatternCentersForVersion(version).at(-1);
  if (primary && alignmentPatternMismatchRatio(matrix, primary) > alignmentTolerance) {
    return false;
  }
  if (alignmentGridMismatchRatio(matrix, version) > alignmentTolerance) return false;
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

function extractVisibleCells(matrix, layout) {
  const out = [];
  for (const [row, col] of layout.dataPositions) {
    const value = matrix[row][col];
    if (!Number.isInteger(value) || value < 0 || value > 3) {
      throw new Error("Data region contains an invalid QuadQR data cell.");
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

function restoreLogicalOrder(physicalValues, version, spectralInterleaving) {
  if (!spectralInterleaving) return physicalValues.slice();
  const permutation = spectralPermutation(physicalValues.length, version);
  const logical = new Array(physicalValues.length);
  for (let logicalIndex = 0; logicalIndex < permutation.length; logicalIndex++) {
    logical[logicalIndex] = physicalValues[permutation[logicalIndex]];
  }
  return logical;
}

function cellsToSymbolConfidences(confidences, byteCount) {
  if (!confidences) return null;
  if (confidences.length < byteCount * CELLS_PER_BYTE) return null;
  const out = new Array(byteCount);
  for (let symbolIndex = 0; symbolIndex < byteCount; symbolIndex++) {
    const offset = symbolIndex * CELLS_PER_BYTE;
    // A single wrong 2-bit cell changes the GF(256) symbol, so the weakest
    // constituent cell is the useful confidence bound for that symbol.
    out[symbolIndex] = Math.min(
      confidences[offset] ?? 1,
      confidences[offset + 1] ?? 1,
      confidences[offset + 2] ?? 1,
      confidences[offset + 3] ?? 1
    );
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

function decodeProtectedHeader(rawCells, version, rawConfidences = null, options = {}) {
  const plan = getHeaderPlan(version);
  const headerCells = rawCells.slice(0, plan.codewordCells);
  const codeword = Array.from(cellsToBytes(headerCells, plan.codewordBytes));
  const confidences = cellsToSymbolConfidences(rawConfidences?.slice(0, plan.codewordCells), plan.codewordBytes);
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

function decodeProtectedBody(rawCells, payloadLength, eccLevel, version, rawConfidences = null, options = {}) {
  const plan = getBodyRsPlan(payloadLength, eccLevel, version);
  const bodyStart = getHeaderPlan(version).codewordCells;
  const encodedCells = rawCells.slice(bodyStart, bodyStart + plan.encodedCells);
  if (encodedCells.length !== plan.encodedCells) throw new Error("Protected body is incomplete.");

  const encodedSymbols = Array.from(cellsToBytes(encodedCells, plan.encodedSymbols));
  const symbolConfidences = cellsToSymbolConfidences(
    rawConfidences?.slice(bodyStart, bodyStart + plan.encodedCells),
    plan.encodedSymbols
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

function decodeCanonical(matrix, rotation, tolerance = 0, confidenceMatrix = null, options = {}) {
  const size = matrix.length;
  const version = versionFromSize(size);
  if (!version) throw new Error(`Unsupported matrix size ${size}.`);
  if (!validateStructure(matrix, tolerance)) throw new Error("QuadQR finder/alignment structure does not match.");

  const layout = createLayout(version);
  const visible = extractVisibleCells(matrix, layout);
  const visibleConfidences = confidenceMatrix
    ? layout.dataPositions.map(([row, col]) => confidenceMatrix[row]?.[col] ?? 1)
    : null;
  const errors = [];

  // New symbols use spectral-spatial interleaving. Legacy order remains a
  // decode fallback so existing QuadQR images do not become unreadable.
  for (const spectralInterleaving of [true, false]) {
    for (let maskId = 0; maskId < 4; maskId++) {
      try {
        const physicalRaw = unmaskCells(visible, layout.dataPositions, maskId);
        const raw = restoreLogicalOrder(physicalRaw, version, spectralInterleaving);
        const rawConfidences = visibleConfidences
          ? restoreLogicalOrder(visibleConfidences, version, spectralInterleaving)
          : null;
        const headerDecoded = decodeProtectedHeader(raw, version, rawConfidences, options);
        const header = headerDecoded.header;
        const flags = headerDecoded.flags;
        const eccLevel = eccFromFlags(flags);
        const payloadLength = headerDecoded.payloadLength;
        if (streamCellCount(payloadLength, eccLevel, version) > raw.length) {
          throw new Error("Declared payload exceeds matrix capacity.");
        }

        const bodyDecoded = decodeProtectedBody(
          raw,
          payloadLength,
          eccLevel,
          version,
          rawConfidences,
          options
        );
        const body = bodyDecoded.body;
        const payload = body.slice(0, payloadLength);
        const expectedCrc = readU32be(body, payloadLength);
        const actualCrc = crc32(concatBytes(header, payload));
        if (expectedCrc !== actualCrc) throw new Error("CRC mismatch after ECC.");

        const isText = (flags & TEXT_FLAG) !== 0;
        const secure = (flags & SECURE_FLAG) !== 0;
        const security = secure ? inspectSecureEnvelope(payload) : null;
        const erasureSymbols = headerDecoded.erasureSymbols + bodyDecoded.erasureSymbols;
        const unknownErrorSymbols = headerDecoded.unknownErrorSymbols + bodyDecoded.unknownErrorSymbols;
        return {
          ok: true,
          format: "QuadQR",
          formatVersion: FORMAT_VERSION,
          version,
          size,
          alignmentPatterns: layout.alignments.length,
          maskId,
          rotation,
          flags,
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
          payload,
          text: isText && !secure ? getTextDecoder().decode(payload) : null,
          secure,
          encrypted: secure,
          decrypted: false,
          requiresDecryption: secure,
          security,
          crc32: actualCrc >>> 0
        };
      } catch (error) {
        errors.push(`${spectralInterleaving ? "spectral" : "legacy"} mask ${maskId}: ${error.message}`);
      }
    }
  }

  throw new Error(`QuadQR decode failed. ${errors.join(" | ")}`);
}

export function decodeMatrix(inputMatrix, options = {}) {
  assert(Array.isArray(inputMatrix) && inputMatrix.length > 0, "Matrix is required.");
  let matrix = cloneMatrix(inputMatrix);
  let confidenceMatrix = options.cellConfidence ? cloneMatrix(options.cellConfidence) : null;
  const errors = [];
  const tolerance = options.structureTolerance ?? 0;

  if (confidenceMatrix) {
    assert(
      confidenceMatrix.length === matrix.length && confidenceMatrix.every((row) => row.length === matrix.length),
      "cellConfidence must be a square matrix matching the QuadQR matrix."
    );
  }

  for (let rotationIndex = 0; rotationIndex < 4; rotationIndex++) {
    const degrees = rotationIndex * 90;
    try {
      return decodeCanonical(matrix, degrees, tolerance, confidenceMatrix, options);
    } catch (error) {
      errors.push(`${degrees}°: ${error.message}`);
    }
    matrix = rotate90(matrix);
    if (confidenceMatrix) confidenceMatrix = rotate90(confidenceMatrix);
  }

  throw new Error(`Unable to decode matrix. ${errors.join(" || ")}`);
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

export function renderToCanvas(codeOrMatrix, canvas, options = {}) {
  assert(canvas && typeof canvas.getContext === "function", "A canvas element is required.");
  const matrix = Array.isArray(codeOrMatrix) ? codeOrMatrix : codeOrMatrix.matrix;
  assert(Array.isArray(matrix) && matrix.length > 0, "A matrix is required.");
  const moduleSize = Math.max(1, Math.floor(options.moduleSize ?? 12));
  const quietZone = Math.max(0, Math.floor(options.quietZone ?? 4));
  const palette = resolvePalette(options.palette);
  const paletteValues = paletteRgb(options.palette);
  const style = normalizeRenderStyle(options.style);
  const layout = renderLayoutForMatrix(matrix);
  const size = matrix.length;
  const pixelSize = (size + quietZone * 2) * moduleSize;

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
      const x = (c + quietZone) * moduleSize;
      const y = (r + quietZone) * moduleSize;

      if (style === RENDER_STYLES.CLASSIC || structural) {
        ctx.fillStyle = cellColor(cell, palette);
        ctx.fillRect(x, y, moduleSize, moduleSize);
        continue;
      }

      const rgb = cellRgb(cell, paletteValues);

      if (style === RENDER_STYLES.DEPTH) {
        const opacity = depthOpacity(r, c, cell);
        const base = mixRgb(paletteValues.white, rgb, opacity);
        ctx.fillStyle = rgbCss(base);
        ctx.fillRect(x, y, moduleSize, moduleSize);

        if (moduleSize >= 6) {
          const edge = Math.max(1, Math.floor(moduleSize * 0.08));
          const highlight = mixRgb(base, paletteValues.white, 0.17);
          const shadow = mixRgb(base, paletteValues.black, 0.12);
          ctx.fillStyle = rgbCss(highlight);
          ctx.fillRect(x, y, moduleSize, edge);
          ctx.fillRect(x, y, edge, moduleSize);
          ctx.fillStyle = rgbCss(shadow);
          ctx.fillRect(x, y + moduleSize - edge, moduleSize, edge);
          ctx.fillRect(x + moduleSize - edge, y, edge, moduleSize);
        }
        continue;
      }

      if (style === RENDER_STYLES.SOFT) {
        const inset = moduleSize >= 6 ? Math.max(1, Math.floor(moduleSize * 0.07)) : 0;
        const width = moduleSize - inset * 2;
        const radius = Math.max(1, Math.floor(moduleSize * 0.20));
        ctx.fillStyle = cellColor(cell, palette);
        roundedRectPath(ctx, x + inset, y + inset, width, width, radius);
        ctx.fill();
        continue;
      }

      if (style === RENDER_STYLES.INSET) {
        // Keep the exact encoded color across the full module, then limit the
        // recessed effect to a narrow edge band so center sampling stays intact.
        ctx.fillStyle = cellColor(cell, palette);
        ctx.fillRect(x, y, moduleSize, moduleSize);
        if (cell === CELL.WHITE) continue;

        const edge = safeStyleEdge(moduleSize);
        if (edge > 0) {
          const fx = insetStyleColors(rgb, paletteValues);
          ctx.fillStyle = rgbCss(fx.shadow);
          ctx.fillRect(x, y, moduleSize, edge);
          ctx.fillRect(x, y, edge, moduleSize);
          ctx.fillStyle = rgbCss(fx.highlight);
          ctx.fillRect(x, y + moduleSize - edge, moduleSize, edge);
          ctx.fillRect(x + moduleSize - edge, y, edge, moduleSize);
        }
      }
    }
  }
  return canvas;
}

export function renderToImageData(codeOrMatrix, options = {}) {
  const matrix = Array.isArray(codeOrMatrix) ? codeOrMatrix : codeOrMatrix.matrix;
  assert(Array.isArray(matrix) && matrix.length > 0, "A matrix is required.");
  const moduleSize = Math.max(1, Math.floor(options.moduleSize ?? 8));
  const quietZone = Math.max(0, Math.floor(options.quietZone ?? 4));
  const palette = paletteRgb(options.palette);
  const style = normalizeRenderStyle(options.style);
  const layout = renderLayoutForMatrix(matrix);
  const size = matrix.length;
  const pixelSize = (size + quietZone * 2) * moduleSize;
  const data = new Uint8ClampedArray(pixelSize * pixelSize * 4);
  const white = palette.white;

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
      const rgb = cellRgb(cell, palette);
      const structural = isStructuralRenderCell(layout, r, c, cell);
      const y0 = (r + quietZone) * moduleSize;
      const x0 = (c + quietZone) * moduleSize;

      if (style === RENDER_STYLES.CLASSIC || structural) {
        fillImageRect(data, pixelSize, x0, y0, moduleSize, moduleSize, rgb);
        continue;
      }

      if (style === RENDER_STYLES.DEPTH) {
        const opacity = depthOpacity(r, c, cell);
        const base = mixRgb(white, rgb, opacity);
        fillImageRect(data, pixelSize, x0, y0, moduleSize, moduleSize, base);
        if (moduleSize >= 6) {
          const edge = Math.max(1, Math.floor(moduleSize * 0.08));
          const highlight = mixRgb(base, white, 0.17);
          const shadow = mixRgb(base, palette.black, 0.12);
          fillImageRect(data, pixelSize, x0, y0, moduleSize, edge, highlight);
          fillImageRect(data, pixelSize, x0, y0, edge, moduleSize, highlight);
          fillImageRect(data, pixelSize, x0, y0 + moduleSize - edge, moduleSize, edge, shadow);
          fillImageRect(data, pixelSize, x0 + moduleSize - edge, y0, edge, moduleSize, shadow);
        }
        continue;
      }

      if (style === RENDER_STYLES.SOFT) {
        const inset = moduleSize >= 6 ? Math.max(1, Math.floor(moduleSize * 0.07)) : 0;
        const width = moduleSize - inset * 2;
        const radius = Math.max(1, Math.floor(moduleSize * 0.20));
        fillImageRoundedRect(data, pixelSize, x0 + inset, y0 + inset, width, width, radius, rgb);
        continue;
      }

      if (style === RENDER_STYLES.INSET) {
        fillImageRect(data, pixelSize, x0, y0, moduleSize, moduleSize, rgb);
        if (cell === CELL.WHITE) continue;
        const edge = safeStyleEdge(moduleSize);
        if (edge > 0) {
          const fx = insetStyleColors(rgb, palette);
          fillImageRect(data, pixelSize, x0, y0, moduleSize, edge, fx.shadow);
          fillImageRect(data, pixelSize, x0, y0, edge, moduleSize, fx.shadow);
          fillImageRect(data, pixelSize, x0, y0 + moduleSize - edge, moduleSize, edge, fx.highlight);
          fillImageRect(data, pixelSize, x0 + moduleSize - edge, y0, edge, moduleSize, fx.highlight);
        }
      }
    }
  }

  return { width: pixelSize, height: pixelSize, data };
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

function classifierFromPaletteRgb(observed, mode = "raw") {
  const transform = mode === "balanced" || mode === "hue"
    ? makeWhiteBalanceTransform(observed)
    : identityColorTransform;
  const entries = [
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

function classifyRgb(rgb, classifier) {
  const transformed = classifier.transform(rgb);
  let best = null;
  let bestDistanceSq = Infinity;
  let secondDistanceSq = Infinity;

  for (const candidate of classifier.entries) {
    const distanceSq = colorDistanceSq(transformed, candidate.rgb);
    if (distanceSq < bestDistanceSq) {
      secondDistanceSq = bestDistanceSq;
      bestDistanceSq = distanceSq;
      best = candidate;
    } else if (distanceSq < secondDistanceSq) {
      secondDistanceSq = distanceSq;
    }
  }

  const distance = Math.sqrt(bestDistanceSq);
  const secondDistance = Number.isFinite(secondDistanceSq) ? Math.sqrt(secondDistanceSq) : distance + 1;
  const confidence = Math.max(0, Math.min(1, (secondDistance - distance) / Math.max(secondDistance, 1e-6)));
  return { cell: best.cell, distance, confidence };
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
      matrix[r][c] = classified.cell;
      confidence[r][c] = classified.confidence;
      distanceSum += classified.distance;
      confidenceSum += classified.confidence;
      minimumConfidence = Math.min(minimumConfidence, classified.confidence);
      if (classified.confidence < 0.4) lowConfidenceCells++;
    }
  }
  return {
    matrix,
    confidence,
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
    { classifier: classifierFromPaletteRgb(observedPalette, "hue"), colorNormalization: "white-balanced-hue" }
  ];
}

function tryPerspectiveScan(imageData, options) {
  const geometryCandidates = detectCodeGeometry(imageData, {
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
    diagnostics: options._visionDiagnostics,
    diagnosticLabel: options._diagnosticLabel ?? "normal"
  });
  if (Array.isArray(options._geometryCollector)) options._geometryCollector.push(...geometryCandidates);
  const results = [];

  for (const geometry of geometryCandidates) {
    const layout = createLayout(geometry.version);
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
      let observedPalette;
      try {
        sampled = samplePerspectiveMatrix(imageData, geometry.homography, layout.size, profile);
        observedPalette = sampleObservedPalette(sampled.rgbGrid, layout.calibration, {
          robust: profile.robustCalibration
        });
      } catch {
        continue;
      }

      const tryAttempt = (attempt, rgbGrid, metadata = {}) => {
        const activeObservedPalette = metadata.observedPalette ?? observedPalette;
        const activeSamplingMode = metadata.samplingMode ?? profile.sampleMode;
        const classified = classifySampledRgbGrid(rgbGrid, attempt.classifier, layout);
        const structureScore = structuralAccuracy(classified.matrix, layout);
        bestStructureScore = Math.max(bestStructureScore, structureScore);
        pushObservation(options, {
          version: geometry.version,
          matrix: classified.matrix,
          confidence: classified.confidence,
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

      // Fast path: preserve the original observed-RGB classifier first, then
      // try per-channel white balancing. Most clean frames stop here without
      // paying for the more expensive spatial normalization fallback.
      for (const attempt of paletteClassifierAttempts(observedPalette)) {
        if (tryAttempt(attempt, sampled.rgbGrid)) {
          geometryDecoded = true;
          break;
        }
      }

      if (!geometryDecoded && options.spatialColorNormalization !== false) {
        try {
          const normalizedGrid = spatiallyNormalizeRgbGrid(sampled.rgbGrid, layout.calibration);
          const normalizedPalette = sampleObservedPalette(normalizedGrid, layout.calibration, { robust: true });
          geometryDecoded = tryAttempt({
            classifier: classifierFromPaletteRgb(normalizedPalette, "raw"),
            colorNormalization: "spatial-white-balanced"
          }, normalizedGrid);
        } catch {
          // Continue to the recovery profile below.
        }
      }

      // Very cheap Photoshop-like recovery on the already-sampled module grid.
      // Normal camera frames never reach this path. The transform approximates
      // Auto Color + Auto Tone + Auto Contrast and costs only O(moduleCount).
      if (!geometryDecoded && options.autoEnhanceRecovery !== false) {
        try {
          const enhancedGrid = autoToneContrastColorRgbGrid(sampled.rgbGrid, {
            blackClip: options.autoEnhanceBlackClip,
            whiteClip: options.autoEnhanceWhiteClip,
            saturation: options.autoEnhanceSaturation
          });
          const enhancedPalette = sampleObservedPalette(enhancedGrid, layout.calibration, { robust: true });
          for (const attempt of paletteClassifierAttempts(enhancedPalette)) {
            const recoveredAttempt = {
              ...attempt,
              colorNormalization: `auto-tone-contrast-color/${attempt.colorNormalization}`
            };
            if (tryAttempt(recoveredAttempt, enhancedGrid, {
              observedPalette: enhancedPalette,
              autoEnhanced: true,
              recoveryMode: "module-grid-auto-tone-contrast-color"
            })) {
              geometryDecoded = true;
              break;
            }
          }
        } catch {
          // Continue to the QR-region pixel recovery below.
        }
      }

      // Camera-specific Photoshop-style fallback. Enhancing the whole camera
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
          for (const attempt of paletteClassifierAttempts(enhancedPalette)) {
            const recoveredAttempt = {
              ...attempt,
              colorNormalization: `rectified-auto-tone-contrast-color/${attempt.colorNormalization}`
            };
            if (tryAttempt(recoveredAttempt, enhancedSampled.rgbGrid, {
              observedPalette: enhancedPalette,
              samplingMode: "rectified-auto-enhance",
              autoEnhanced: true,
              recoveryMode: "rectified-auto-tone-contrast-color"
            })) {
              geometryDecoded = true;
              break;
            }
          }
        } catch {
          // Geometry refinement remains available as the final bounded fallback.
        }
      }

      if (geometryDecoded) break;
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

      for (const [offsetX, offsetY] of refinementOffsets) {
        let sampled;
        let observedPalette;
        try {
          sampled = samplePerspectiveMatrix(imageData, geometry.homography, layout.size, {
            sampleMode: "cross",
            sampleRadius: 0,
            sampleOffsetX: offsetX,
            sampleOffsetY: offsetY
          });
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
          if (structureScore < (options.refinementDecodeThreshold ?? 0.95)) continue;
          refinementCandidates.push({
            attempt,
            classified,
            observedPalette,
            offsetX,
            offsetY,
            structureScore
          });
        }
      }

      refinementCandidates.sort((a, b) =>
        (b.structureScore - a.structureScore) ||
        (b.classified.averageCellConfidence - a.classified.averageCellConfidence) ||
        (a.classified.averageColorDistance - b.classified.averageColorDistance)
      );

      const decodeLimit = Math.max(1, Math.min(8, Math.round(options.refinementDecodeCandidates ?? 4)));
      for (const candidate of refinementCandidates.slice(0, decodeLimit)) {
        try {
          const decoded = decodeMatrix(candidate.classified.matrix, {
            structureTolerance: options.structureTolerance ?? 0.18,
            cellConfidence: candidate.classified.confidence,
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
            samplingMode: "refined-center",
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
          try {
            const classified = classifySampledRgbGrid(attempt.rgbGrid ?? sampled.rgbGrid, attempt.classifier, layout);
            const structureScore = structuralAccuracy(classified.matrix, layout);
            pushObservation(options, {
              version,
              matrix: classified.matrix,
              confidence: classified.confidence,
              bounds,
              samplingMode: profileIndex === 0 ? "axis" : "axis-center",
              colorNormalization: attempt.colorNormalization,
              structureScore,
              averageCellConfidence: classified.averageCellConfidence,
              lowConfidenceCells: classified.lowConfidenceCells
            });
            const decoded = decodeMatrix(classified.matrix, {
              structureTolerance: options.structureTolerance ?? 0.12,
              cellConfidence: classified.confidence,
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
              samplingMode: profileIndex === 0 ? "axis" : "axis-center",
              averageColorDistance: classified.averageColorDistance,
              averageCellConfidence: classified.averageCellConfidence,
              minimumCellConfidence: classified.minimumCellConfidence,
              lowConfidenceCells: classified.lowConfidenceCells
            });
            accepted = true;
            break;
          } catch {
            // Try next classifier/profile.
          }
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

export function scanImageData(imageData, options = {}) {
  assert(imageData && imageData.data && imageData.width && imageData.height, "Valid ImageData is required.");
  const minVersion = options.minVersion ?? MIN_VERSION;
  const maxVersion = options.maxVersion ?? MAX_VERSION;
  validateVersion(minVersion);
  validateVersion(maxVersion);

  const geometryCollector = [];
  const scanOptions = { ...options, _geometryCollector: geometryCollector };

  if (options.perspective !== false) {
    const perspective = tryPerspectiveScan(imageData, scanOptions);
    if (perspective) return perspective;
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
        return {
          ...recovered,
          autoEnhanced: true,
          recoveryMode: "auto-tone-contrast-color",
          originalColorNormalization: recovered.colorNormalization
        };
      }
    } catch {
      // Continue to the axis-aligned fallback.
    }
  }

  if (options.axisAlignedFallback !== false) {
    const axis = tryAxisAlignedScan(imageData, scanOptions);
    if (axis) return axis;
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
        if (perspective) return { ...perspective, autoEnhanced: true, recoveryMode: "auto-tone-contrast-color" };
      }
      if (options.axisAlignedFallback !== false) {
        const axis = tryAxisAlignedScan(enhanced, recoveryOptions);
        if (axis) return { ...axis, autoEnhanced: true, recoveryMode: "auto-tone-contrast-color" };
      }
    } catch {
      // Fall through to the normal scan failure below.
    }
  }

  throw new Error(
    "No valid QuadQR code found. Try better lighting, fill more of the frame, keep all locator patterns visible, or use a less blurred image."
  );
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

function normalizeFrameDiagnostics(frameDiagnostics, source, width, height, visionDiagnostics) {
  if (!frameDiagnostics || typeof frameDiagnostics !== "object") return;
  frameDiagnostics.scanWidth = width;
  frameDiagnostics.scanHeight = height;
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

function combineFrameObservations(observations) {
  if (!observations?.length) return null;
  const version = observations[0].version;
  const size = observations[0].matrix.length;
  if (!observations.every((item) => item.version === version && item.matrix.length === size)) return null;

  const matrix = make2D(size, CELL.WHITE);
  const confidence = make2D(size, 0);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const votes = new Map();
      const confidenceByCell = new Map();
      for (const observation of observations) {
        const cell = observation.matrix[r][c];
        const sourceConfidence = clampNumber(observation.confidence?.[r]?.[c] ?? 0.5, 0, 1);
        const weight = 0.35 + sourceConfidence * 0.65;
        votes.set(cell, (votes.get(cell) ?? 0) + weight);
        const stats = confidenceByCell.get(cell) ?? { weighted: 0, weight: 0 };
        stats.weighted += sourceConfidence * weight;
        stats.weight += weight;
        confidenceByCell.set(cell, stats);
      }

      const ranked = Array.from(votes.entries()).sort((a, b) => b[1] - a[1]);
      const [bestCell, bestWeight] = ranked[0];
      const secondWeight = ranked[1]?.[1] ?? 0;
      const totalWeight = ranked.reduce((sum, item) => sum + item[1], 0);
      const sourceStats = confidenceByCell.get(bestCell);
      const sourceConfidence = sourceStats?.weight ? sourceStats.weighted / sourceStats.weight : 0.5;
      const support = totalWeight ? bestWeight / totalWeight : 0;
      const margin = totalWeight ? (bestWeight - secondWeight) / totalWeight : 0;
      const agreement = 0.5 * support + 0.5 * margin;

      matrix[r][c] = bestCell;
      // Do not become overconfident just because several blurry frames agree.
      // Retaining source uncertainty lets Reed-Solomon treat repeated ambiguous
      // cells as erasures instead of hard, supposedly-certain errors.
      confidence[r][c] = clampNumber(sourceConfidence * 0.58 + agreement * 0.42, 0, 1);
    }
  }
  return { version, matrix, confidence };
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

export async function startCameraScanner(video, options = {}) {
  assert(typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia, "Camera API is unavailable.");
  assert(video, "A video element is required.");

  const stream = await navigator.mediaDevices.getUserMedia(
    options.constraints ?? {
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 }
      }
    }
  );
  await improveCameraTrack(stream);

  video.srcObject = stream;
  video.setAttribute("playsinline", "");
  video.muted = true;
  await video.play();

  const scanInterval = Math.max(80, options.scanInterval ?? 180);
  const scratchCanvas = document.createElement("canvas");
  const multiFrameEnabled = options.multiFrame !== false;
  const multiFrameWindow = Math.max(2, Math.min(8, Math.round(options.multiFrameWindow ?? 4)));
  const multiFrameMinFrames = Math.max(2, Math.min(multiFrameWindow, Math.round(options.multiFrameMinFrames ?? 2)));
  const observationHistory = new Map();
  const cameraAutoColorEvery = Math.max(1, Math.round(options.cameraAutoColorEvery ?? 2));
  const cameraAutoEnhanceEvery = Math.max(1, Math.round(options.cameraAutoEnhanceEvery ?? 2));
  const cameraFinderRecoveryEvery = Math.max(1, Math.round(options.cameraFinderRecoveryEvery ?? 2));
  let missStreak = 0;
  let stopped = false;
  let busy = false;
  let timer = null;
  let frameNumber = 0;

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


  if (diagnosticsEnabled) {
    const track = stream.getVideoTracks?.()[0];
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

  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    observationHistory.clear();
    for (const track of stream.getTracks()) track.stop();
    if (video.srcObject === stream) video.srcObject = null;
  };

  const scanNow = () => scanVideoFrame(video, {
    ...options,
    maxDimension: options.maxDimension ?? 1080,
    canvas: scratchCanvas
  });

  const emitResult = (result, capturedFrame = null, diagnostic = null) => {
    const frameMeta = capturedFrame?.imageData ? {
      frame: frameNumber,
      imageData: capturedFrame.imageData,
      scanWidth: capturedFrame.scanWidth,
      scanHeight: capturedFrame.scanHeight,
      sourceRect: capturedFrame.source ? { ...capturedFrame.source } : null,
      diagnostic
    } : null;
    options.onResult?.(result, frameMeta);
    options.onDecode?.(result, frameMeta);
    if (options.stopOnResult ?? true) {
      stop();
      return true;
    }
    return false;
  };

  const tryMultiFrameDecode = (observations) => {
    if (!multiFrameEnabled) return null;
    const best = selectBestFrameObservation(observations);
    if (!best) return null;
    const history = observationHistory.get(best.version) ?? [];
    history.push(best);
    while (history.length > multiFrameWindow) history.shift();
    observationHistory.set(best.version, history);
    if (history.length < multiFrameMinFrames) return null;

    const combined = combineFrameObservations(history);
    if (!combined) return null;
    try {
      const decoded = decodeMatrix(combined.matrix, {
        structureTolerance: options.structureTolerance ?? 0.20,
        cellConfidence: combined.confidence,
        maxErasureConfidence: options.maxErasureConfidence
      });
      if (decoded.version !== best.version) return null;
      return {
        ...decoded,
        perspectiveCorrected: Boolean(best.geometry),
        colorCalibrated: true,
        colorNormalization: "multi-frame-vote",
        samplingMode: "multi-frame-vote",
        multiFrameCombined: history.length,
        geometry: best.geometry,
        observedPalette: best.observedPalette,
        averageCellConfidence: best.averageCellConfidence,
        lowConfidenceCells: best.lowConfidenceCells
      };
    } catch {
      return null;
    }
  };

  const loop = async () => {
    if (stopped) return;
    if (!busy && video.readyState >= 2) {
      busy = true;
      frameNumber++;
      const observations = [];
      const frameDiagnostics = diagnosticsEnabled ? {} : null;
      const capturedFrame = {};
      const frameStarted = nowMs();
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
          missStreak > 0 && ((missStreak - 1) % cameraFinderRecoveryEvery === 0);
        allowAutoEnhance = options.autoEnhanceRecovery !== false &&
          missStreak > 0 && ((missStreak - 1) % cameraAutoEnhanceEvery === 0);
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
          maxDimension: options.maxDimension ?? 1080,
          canvas: scratchCanvas,
          _capturedFrame: capturedFrame,
          _observationCollector: observations,
          _frameDiagnostics: frameDiagnostics
        });
        const elapsedMs = nowMs() - frameStarted;
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
        observationHistory.clear();
        if (emitResult(result, capturedFrame, frameDiagnostics)) return;
      } catch (error) {
        missStreak++;
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

        // The user's real phone-camera case is dominated by color cast before
        // finder detection: Photoshop Auto Color alone makes the same live QR
        // immediately detectable. Retry the exact captured frame with a cheap
        // per-channel Auto Color levels correction before any geometry-dependent
        // recovery. This runs only after the normal fast scan fails, and by
        // default only on every other missed frame after the first one.
        const shouldTryCameraAutoColor = options.cameraAutoColorRecovery !== false &&
          capturedFrame.imageData &&
          ((missStreak - 1) % cameraAutoColorEvery === 0);
        if (shouldTryCameraAutoColor) {
          emitDiagnostic({
            type: "method",
            state: "trying",
            method: "camera-auto-color",
            message: "Fast scan failed · applying camera Auto Color before finder detection",
            ...frameDiagnostics
          });
          const autoColorObservations = [];
          const autoColorVisionDiagnostics = diagnosticsEnabled ? { passes: [] } : null;
          const autoColorFrameDiagnostics = diagnosticsEnabled ? {} : null;
          try {
            const recoveryStarted = nowMs();
            const correctedFrame = autoColorImageData(capturedFrame.imageData, {
              // Strong camera-only Auto Color derived from the supplied
              // before/after Photoshop sample. It anchors near-black per
              // channel, neutralizes the observed highlight around ~190
              // instead of forcing it to 255, and ignores a small outer band
              // so dark preview/UI edges cannot weaken the correction.
              blackClip: options.cameraAutoColorBlackClip ?? 0.0001,
              whiteClip: options.cameraAutoColorWhiteClip ?? 0.004,
              highlightPercentile: options.cameraAutoColorHighlightPercentile ?? 0.95,
              outputHighlight: options.cameraAutoColorOutputHighlight ?? 190,
              analysisInset: options.cameraAutoColorAnalysisInset ?? 0.04,
              minimumInputRange: options.cameraAutoColorMinimumInputRange ?? 72,
              targetSamples: options.cameraAutoColorTargetSamples ?? 90000
            });
            const recovered = scanImageData(correctedFrame, {
              ...options,
              _diagnosticLabel: "camera-auto-color",
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
                capturedFrame.scanWidth,
                capturedFrame.scanHeight,
                autoColorVisionDiagnostics
              );
            }
            const recoveryElapsedMs = nowMs() - recoveryStarted;
            emitDiagnostic({
              type: "frame",
              state: "decoded",
              method: "camera-auto-color",
              elapsedMs: recoveryElapsedMs,
              missStreak,
              ...(autoColorFrameDiagnostics ?? frameDiagnostics)
            });
            emitDiagnostic({
              type: "success",
              state: "decoded",
              method: "camera-auto-color",
              elapsedMs: recoveryElapsedMs,
              message: `Auto Color decoded v${recovered.version} · ECC ${recovered.eccLevel} · ${Math.round(recoveryElapsedMs)} ms`,
              ...(autoColorFrameDiagnostics ?? frameDiagnostics)
            });
            missStreak = 0;
            observationHistory.clear();
            if (emitResult({
              ...recovered,
              autoColorCorrected: true,
              cameraProgressiveRecovery: true,
              recoveryMode: "camera-auto-color"
            }, capturedFrame, autoColorFrameDiagnostics ?? frameDiagnostics)) return;
          } catch {
            observations.push(...autoColorObservations);
            if (autoColorFrameDiagnostics) {
              normalizeFrameDiagnostics(
                autoColorFrameDiagnostics,
                capturedFrame.source ?? { x: 0, y: 0, width: capturedFrame.scanWidth, height: capturedFrame.scanHeight, cropped: false },
                capturedFrame.scanWidth,
                capturedFrame.scanHeight,
                autoColorVisionDiagnostics
              );
              emitDiagnostic({
                type: "frame",
                state: "miss",
                method: "camera-auto-color",
                elapsedMs: nowMs() - frameStarted,
                missStreak,
                ...autoColorFrameDiagnostics
              });
            }
            emitDiagnostic({
              type: "method",
              state: "failed",
              method: "camera-auto-color",
              message: "Camera Auto Color did not decode · continuing recovery",
              ...(autoColorFrameDiagnostics ?? frameDiagnostics)
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
            method: "multi-frame-vote",
            message: `Multi-frame recovery decoded v${combined.version} from ${combined.multiFrameCombined} frames`,
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
    timer = setTimeout(loop, scanInterval);
  };

  timer = setTimeout(loop, 0);
  return { stream, stop, scanNow, video };
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
  encodeProtectedHeader,
  decodeProtectedHeader,
  selectBestFrameObservation,
  combineFrameObservations,
  visibleVideoSourceRect,
  HEADER_CODEWORD_CELLS,
  COMPACT_HEADER_CODEWORD_CELLS,
  CELLS_PER_BYTE,
  TEXT_FLAG,
  SECURE_FLAG
});
