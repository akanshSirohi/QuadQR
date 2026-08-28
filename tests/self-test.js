import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  CELL,
  DEFAULT_ECC_LEVEL,
  FORMAT_VERSION,
  MAX_VERSION,
  COMPRESSION_LEVELS,
  decodeMatrix,
  decryptDecoded,
  encodeBytes,
  encodeText,
  encodeSignedText,
  encodeSecureText,
  generateRaw256Key,
  generateSigningKeyPair,
  verifyDecodedSignature,
  compressPayload,
  decompressPayload,
  compressDeflatePayload,
  decompressDeflatePayload,
  compressBrotliPayload,
  decompressBrotliPayload,
  bytesToHex,
  getVersionInfo,
  internals,
  renderToImageData,
  renderToSVG,
  rotateMatrix,
  scanImageData,
  debugScanImageData,
  applyStressDistortion,
  runImageStressTest,
  runReliabilityLab,
  runPerspectiveSweep,
  estimateSafeLogoSize,
  findMaxSafeLogoSize,
  getPrintGuidance
} from "../library/quadqr.js";
import {
  gfAdd,
  rsDecode,
  rsEncode,
  rsSyndromes
} from "../library/reed-solomon.js";
import {
  autoColorImageData,
  computeHomography,
  projectPoint
} from "../library/vision.js";
import {
  benchmarkCodec,
  compareCapacity,
  calculateCapacityPlan,
  getStandardQrByteCapacity
} from "../library/benchmark.js";

function bytesEqual(a, b) {
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i], `byte mismatch at ${i}`);
}

function testText(text, options = {}) {
  const encoded = encodeText(text, options);
  const decoded = decodeMatrix(encoded.matrix);
  assert.equal(decoded.text, text);
  assert.equal(decoded.version, encoded.version);
  assert.equal(decoded.formatVersion, FORMAT_VERSION);
  return encoded;
}

function corruptVisibleDataCell(matrix, layout, cellIndex, delta = 1, spectral = true) {
  const physicalIndex = spectral
    ? internals.spectralPermutation(layout.dataPositions.length, layout.version)[cellIndex]
    : cellIndex;
  const [row, col] = layout.dataPositions[physicalIndex];
  const value = matrix[row][col];
  assert.ok(value >= CELL.RED && value <= CELL.WHITE);
  matrix[row][col] = value ^ delta;
}

function cloneMatrix(matrix) {
  return matrix.map((row) => row.slice());
}

function bilinearRgb(image, x, y) {
  const x0 = Math.max(0, Math.min(image.width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(image.height - 1, Math.floor(y)));
  const x1 = Math.max(0, Math.min(image.width - 1, x0 + 1));
  const y1 = Math.max(0, Math.min(image.height - 1, y0 + 1));
  const fx = x - x0;
  const fy = y - y0;

  const pixel = (px, py) => {
    const i = (py * image.width + px) * 4;
    return [image.data[i], image.data[i + 1], image.data[i + 2]];
  };

  const p00 = pixel(x0, y0);
  const p10 = pixel(x1, y0);
  const p01 = pixel(x0, y1);
  const p11 = pixel(x1, y1);
  const out = [];

  for (let channel = 0; channel < 3; channel++) {
    const top = p00[channel] * (1 - fx) + p10[channel] * fx;
    const bottom = p01[channel] * (1 - fx) + p11[channel] * fx;
    out[channel] = top * (1 - fy) + bottom * fy;
  }
  return out;
}

function warpWithColorCast(image, width, height, quad) {
  const homography = computeHomography(
    [
      { x: 0, y: 0 },
      { x: image.width - 1, y: 0 },
      { x: 0, y: image.height - 1 },
      { x: image.width - 1, y: image.height - 1 }
    ],
    quad
  );

  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const p = i * 4;
    data[p] = 242;
    data[p + 1] = 244;
    data[p + 2] = 246;
    data[p + 3] = 255;
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = projectPoint(homography, x, y);
      if (
        source.x < 0 || source.y < 0 ||
        source.x >= image.width - 1 || source.y >= image.height - 1
      ) continue;

      let [r, g, b] = bilinearRgb(image, source.x, source.y);
      r = Math.min(255, r * 1.08 + 5);
      g = Math.min(255, g * 0.94 + 8);
      b = Math.min(255, b * 0.82 + 14);

      const p = (y * width + x) * 4;
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = 255;
    }
  }

  return { width, height, data };
}

function gaussianBlurImage(image, passes = 1) {
  const { width, height } = image;
  const weights = [1, 4, 6, 4, 1];
  const norm = 16;
  let source = new Uint8ClampedArray(image.data);

  for (let pass = 0; pass < passes; pass++) {
    const horizontal = new Uint8ClampedArray(source.length);
    const vertical = new Uint8ClampedArray(source.length);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const out = (y * width + x) * 4;
        for (let channel = 0; channel < 3; channel++) {
          let sum = 0;
          for (let k = -2; k <= 2; k++) {
            const xx = Math.max(0, Math.min(width - 1, x + k));
            sum += source[(y * width + xx) * 4 + channel] * weights[k + 2];
          }
          horizontal[out + channel] = sum / norm;
        }
        horizontal[out + 3] = 255;
      }
    }

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const out = (y * width + x) * 4;
        for (let channel = 0; channel < 3; channel++) {
          let sum = 0;
          for (let k = -2; k <= 2; k++) {
            const yy = Math.max(0, Math.min(height - 1, y + k));
            sum += horizontal[(yy * width + x) * 4 + channel] * weights[k + 2];
          }
          vertical[out + channel] = sum / norm;
        }
        vertical[out + 3] = 255;
      }
    }

    source = vertical;
  }

  return { width, height, data: source };
}

function warpWithDirtyWarmCamera(image, width, height, quad) {
  const homography = computeHomography(
    [
      { x: 0, y: 0 },
      { x: image.width - 1, y: 0 },
      { x: 0, y: image.height - 1 },
      { x: image.width - 1, y: image.height - 1 }
    ],
    quad
  );

  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const p = i * 4;
    data[p] = 230;
    data[p + 1] = 215;
    data[p + 2] = 175;
    data[p + 3] = 255;
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = projectPoint(homography, x, y);
      if (
        source.x < 0 || source.y < 0 ||
        source.x >= image.width - 1 || source.y >= image.height - 1
      ) continue;

      let [r, g, b] = bilinearRgb(image, source.x, source.y);
      const nx = x / width;
      const ny = y / height;
      const haze = 0.10 + 0.18 * Math.max(0, Math.sin((nx * 1.7 + ny * 1.2) * Math.PI));

      // Strong yellow/warm camera cast with a heavily suppressed blue channel,
      // similar to a dirty lens + poor auto white balance on a phone camera.
      r = r * 1.15 + 8;
      g = g * 0.75 + 28;
      b = b * 0.18 + 70;
      r = r * (1 - haze) + 232 * haze;
      g = g * (1 - haze) + 214 * haze;
      b = b * (1 - haze) + 171 * haze;

      const p = (y * width + x) * 4;
      data[p] = Math.max(0, Math.min(255, r));
      data[p + 1] = Math.max(0, Math.min(255, g));
      data[p + 2] = Math.max(0, Math.min(255, b));
      data[p + 3] = 255;
    }
  }

  return gaussianBlurImage({ width, height, data }, 2);
}


function flattenWarmCameraLevels(image) {
  const data = new Uint8ClampedArray(image.data.length);
  for (let i = 0; i < image.width * image.height; i++) {
    const p = i * 4;
    let r = 150 + image.data[p] * 0.28;
    let g = 145 + image.data[p + 1] * 0.22;
    let b = 120 + image.data[p + 2] * 0.14;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    // Camera haze/processing often reduces saturation together with contrast.
    r = y + (r - y) * 0.72;
    g = y + (g - y) * 0.72;
    b = y + (b - y) * 0.72;
    data[p] = r;
    data[p + 1] = g;
    data[p + 2] = b;
    data[p + 3] = 255;
  }
  return gaussianBlurImage({ width: image.width, height: image.height, data }, 2);
}

console.log("Running QuadQR self-tests...");

// 2-bit color mapping is exact: one byte occupies exactly four cells.
{
  const bytes = new Uint8Array([0b00011011, 0b11100100]);
  const cells = internals.bytesToCells(bytes);
  assert.deepEqual(cells, [0, 1, 2, 3, 3, 2, 1, 0]);
  bytesEqual(internals.cellsToBytes(cells), bytes);
}

// Direct GF(256) Reed-Solomon verification.
{
  const parity = 24;
  const data = Array.from({ length: 100 }, (_, i) => (i * 37 + 11) & 0xff);
  const codeword = rsEncode(data, parity);
  assert.ok(rsSyndromes(codeword, parity).every((value) => value === 0));

  const damaged = codeword.slice();
  for (let i = 0; i < parity / 2; i++) {
    const position = (i * 7 + 5) % damaged.length;
    damaged[position] = gfAdd(damaged[position], (i * 19 + 1) & 0xff || 1);
  }

  const repaired = rsDecode(damaged, parity);
  assert.deepEqual(repaired.data, data);
  assert.equal(repaired.correctedSymbols, parity / 2);
}

for (const ecc of ["L", "M", "Q", "H"]) {
  testText("QuadQR", { ecc });
  testText("Unicode: नमस्ते 🌈 QR テスト café", { ecc });
}

// Error/erasure Reed-Solomon path: M-style 24 parity bytes can recover
// 16 damaged symbols when enough low-confidence locations are known.
{
  const parity = 24;
  const data = Array.from({ length: 100 }, (_, i) => (i * 23 + 17) & 0xff);
  const codeword = rsEncode(data, parity);
  const damaged = codeword.slice();
  const erasures = [];
  for (let i = 0; i < 16; i++) {
    const position = (i * 11 + 3) % damaged.length;
    damaged[position] = gfAdd(damaged[position], ((i * 13 + 5) & 0xff) || 1);
    erasures.push(position);
  }
  assert.throws(() => rsDecode(damaged, parity));
  const repaired = rsDecode(damaged, parity, { erasurePositions: erasures });
  assert.deepEqual(repaired.data, data);
  assert.equal(repaired.erasureSymbols, 16);
}

// Legacy physical placement remains readable. This reconstructs the logical
// stream from a newly encoded symbol, writes it back without the spectral
// permutation, and verifies the decoder's compatibility fallback.
{
  const encoded = encodeText("Legacy placement compatibility", { ecc: "M" });
  const layout = internals.createLayout(encoded.version);
  const visible = layout.dataPositions.map(([row, col]) => encoded.matrix[row][col]);
  const physicalRaw = internals.unmaskCells(visible, layout.dataPositions, encoded.maskId);
  const logicalRaw = internals.restoreLogicalOrder(physicalRaw, encoded.version, true);
  const legacyMatrix = internals.applyData(layout, logicalRaw, encoded.maskId, false);
  const decoded = decodeMatrix(legacyMatrix);
  assert.equal(decoded.text, "Legacy placement compatibility");
  assert.equal(decoded.spectralInterleaving, false);
}

// Spectral-spatial interleaving is a zero-overhead permutation: every logical
// data cell maps to exactly one physical data position.
{
  for (const version of [1, 2, 5, 10, 20, 40]) {
    const layout = internals.createLayout(version);
    const permutation = internals.spectralPermutation(layout.dataPositions.length, version);
    assert.equal(permutation.length, layout.dataPositions.length);
    assert.equal(new Set(permutation).size, permutation.length);
    assert.ok(permutation.every((value) => value >= 0 && value < permutation.length));
  }
}

// Confidence-aware ECC should recover a symbol beyond the ordinary hard-error
// limit without adding parity or reducing payload capacity.
{
  const payload = new Uint8Array(Array.from({ length: 100 }, (_, i) => (i * 31 + 7) & 0xff));
  const encoded = encodeBytes(payload, { ecc: "M" });
  const layout = internals.createLayout(encoded.version);
  const damaged = cloneMatrix(encoded.matrix);
  const confidence = Array.from({ length: encoded.size }, () => Array(encoded.size).fill(1));
  const permutation = internals.spectralPermutation(layout.dataPositions.length, layout.version);
  const bodyStart = internals.getHeaderPlan(encoded.version).codewordCells;

  for (let symbolIndex = 0; symbolIndex < 16; symbolIndex++) {
    const logicalCell = bodyStart + symbolIndex * 4;
    const physicalCell = permutation[logicalCell];
    const [row, col] = layout.dataPositions[physicalCell];
    damaged[row][col] ^= (symbolIndex % 3) + 1;
    confidence[row][col] = 0.02;
  }

  assert.throws(() => decodeMatrix(damaged));
  const decoded = decodeMatrix(damaged, { cellConfidence: confidence });
  bytesEqual(decoded.payload, payload);
  assert.equal(decoded.spectralInterleaving, true);
  assert.equal(decoded.confidenceAwareEcc, true);
  assert.equal(decoded.confidenceAssisted, true);
  assert.ok(decoded.erasureSymbols > 0);
  assert.ok(decoded.correctedBodySymbols >= 16);
}


// Spectrum ECC 2.0 soft decoding uses scanner-provided second hypotheses when
// hard decoding and confidence-to-erasure recovery are both just beyond the
// correction budget. One targeted substitution should bring this one-block
// codeword back inside the normal 12-error M-profile limit.
{
  const payload = new Uint8Array(Array.from({ length: 20 }, (_, i) => (i * 17 + 11) & 0xff));
  const encoded = encodeBytes(payload, { version: 3, ecc: "M" });
  const layout = internals.createLayout(encoded.version);
  const permutation = internals.spectralPermutation(layout.dataPositions.length, encoded.version);
  const bodyStart = internals.getHeaderPlan(encoded.version).codewordCells;
  const damaged = cloneMatrix(encoded.matrix);
  const confidence = Array.from({ length: encoded.size }, () => Array(encoded.size).fill(1));
  const alternatives = Array.from({ length: encoded.size }, () => Array(encoded.size).fill(null));

  for (let symbolIndex = 0; symbolIndex < 13; symbolIndex++) {
    const logicalCell = bodyStart + symbolIndex * 4;
    const physicalCell = permutation[logicalCell];
    const [row, col] = layout.dataPositions[physicalCell];
    const original = damaged[row][col];
    damaged[row][col] = (original + 1 + (symbolIndex & 1)) & 3;
    confidence[row][col] = 0.70; // above erasure threshold, inside soft-search threshold
    alternatives[row][col] = original;
  }

  assert.throws(() => decodeMatrix(damaged, { cellConfidence: confidence, maxErasureConfidence: 0.68 }));
  const decoded = decodeMatrix(damaged, {
    cellConfidence: confidence,
    cellAlternatives: alternatives,
    maxErasureConfidence: 0.68,
    softDecodeConfidence: 0.72
  });
  bytesEqual(decoded.payload, payload);
  assert.equal(decoded.spectrumEccVersion, 2);
  assert.equal(decoded.softDecoded, true);
  assert.equal(decoded.softSubstitutions, 1);
  assert.ok(decoded.softDecodeAttempts >= 1);
}

for (const length of [0, 1, 2, 7, 8, 9, 31, 32, 33, 64, 200, 700]) {
  const bytes = new Uint8Array(crypto.randomBytes(length));
  const encoded = encodeBytes(bytes, { ecc: "M" });
  const decoded = decodeMatrix(encoded.matrix);
  bytesEqual(decoded.payload, bytes);
}

// All four RGBW states must appear as data cells in a representative code.
{
  const encoded = encodeBytes(new Uint8Array(Array.from({ length: 64 }, (_, i) => i)), { ecc: "L" });
  const layout = internals.createLayout(encoded.version);
  const seen = new Set(layout.dataPositions.map(([r, c]) => encoded.matrix[r][c]));
  for (const value of [CELL.RED, CELL.GREEN, CELL.BLUE, CELL.WHITE]) assert.ok(seen.has(value));
}

// Larger versions use distributed alignment patterns with a compact profile:
// one 5x5 primary bottom-right alignment reference plus 3x3 secondary markers.
// The three 7x7 corner finder patterns remain the only primary finders.
{
  const expectedCounts = new Map([
    [1, 1],
    [2, 1],
    [6, 1],
    [7, 6],
    [14, 13],
    [21, 22],
    [28, 33],
    [35, 46],
    [40, 46]
  ]);

  for (const [version, expectedCount] of expectedCounts) {
    const info = getVersionInfo(version, { ecc: "M" });
    const layout = internals.createLayout(version);
    assert.equal(info.alignmentPatterns, expectedCount, `v${version} alignment count`);
    assert.equal(layout.alignments.length, expectedCount, `v${version} layout alignment count`);
    assert.equal(layout.calibration.red.length, 4);
    assert.equal(layout.calibration.green.length, 4);
    assert.equal(layout.calibration.blue.length, 4);

    const primaryMarkers = layout.alignments.filter((marker) => marker.primary);
    assert.equal(primaryMarkers.length, 1, `v${version} primary alignment count`);
    assert.equal(primaryMarkers[0].size, 5, `v${version} primary alignment size`);

    for (const marker of layout.alignments) {
      const radius = marker.size === 3 ? 1 : 2;
      assert.equal(marker.size, marker.primary ? 5 : 3, `v${version} marker size`);
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          const black = marker.size === 3
            ? dr !== 0 || dc !== 0
            : Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
          const expected = black ? CELL.BLACK : CELL.WHITE;
          assert.equal(layout.matrix[marker.row + dr][marker.col + dc], expected);
          assert.equal(layout.reserved[marker.row + dr][marker.col + dc], true);
        }
      }
    }
  }

  assert.deepEqual(getVersionInfo(7, { ecc: "M" }).alignmentCenters, [
    [6, 22], [22, 6], [22, 22], [22, 38], [38, 22], [38, 38]
  ]);
}

// Rotation handling.
{
  const source = encodeText("Rotation check with RGBW ECC", { ecc: "M" });
  for (let turns = 0; turns < 4; turns++) {
    const decoded = decodeMatrix(rotateMatrix(source.matrix, turns));
    assert.equal(decoded.text, "Rotation check with RGBW ECC");
  }
}

// Capacity boundary checks.
for (const version of [1, 2, 5, 10, 16, 28, MAX_VERSION]) {
  const info = getVersionInfo(version, { ecc: DEFAULT_ECC_LEVEL });
  assert.equal(info.bitsPerDataCell, 2);
  assert.equal(info.theoreticalBits, info.dataCells * 2);
  if (info.capacityBytes <= 0) continue;

  const exact = new Uint8Array(info.capacityBytes);
  exact.fill(version & 0xff);
  const encoded = encodeBytes(exact, { version, ecc: DEFAULT_ECC_LEVEL });
  bytesEqual(decodeMatrix(encoded.matrix).payload, exact);

  assert.throws(
    () => encodeBytes(new Uint8Array(info.capacityBytes + 1), { version, ecc: DEFAULT_ECC_LEVEL }),
    /does not fit/
  );
}

// Compact v1 framing keeps the smallest symbol useful at every ECC profile.
{
  const expected = { L: 28, M: 24, Q: 20, H: 16 };
  for (const [ecc, capacity] of Object.entries(expected)) {
    const info = getVersionInfo(1, { ecc });
    assert.equal(info.capacityBytes, capacity);
    assert.equal(info.compactSmallSymbol, true);
    assert.equal(info.headerCells, 32);
    assert.equal(info.headerParitySymbols, 4);

    const payload = new Uint8Array(capacity);
    payload.fill(capacity);
    const encoded = encodeBytes(payload, { version: 1, ecc });
    assert.equal(encoded.version, 1);
    bytesEqual(decodeMatrix(encoded.matrix).payload, payload);
  }
}

// v1-M corrects two compact-header byte symbols and four body byte symbols.
{
  const payload = new Uint8Array(20);
  payload.forEach((_, i) => { payload[i] = (i * 29 + 7) & 0xff; });
  const encoded = encodeBytes(payload, { version: 1, ecc: "M" });
  const layout = internals.createLayout(1);
  const damaged = cloneMatrix(encoded.matrix);
  const headerCells = internals.getHeaderPlan(1).codewordCells;

  for (const symbolIndex of [1, 5]) {
    corruptVisibleDataCell(damaged, layout, symbolIndex * 4, 1);
  }
  for (let symbolIndex = 0; symbolIndex < 4; symbolIndex++) {
    corruptVisibleDataCell(damaged, layout, headerCells + symbolIndex * 4, (symbolIndex % 3) + 1);
  }

  const decoded = decodeMatrix(damaged);
  bytesEqual(decoded.payload, payload);
  assert.ok(decoded.correctedHeaderSymbols >= 2);
  assert.ok(decoded.correctedBodySymbols >= 4);
}

// Header and body RS correction. Four cells form one GF(256) byte symbol.
{
  const text = "RGBW ECC correction test: " + "0123456789abcdef".repeat(7);
  const encoded = encodeText(text, { ecc: "M" });
  const layout = internals.createLayout(encoded.version);
  const damaged = cloneMatrix(encoded.matrix);

  // Three different header byte symbols. Header can correct four.
  for (const symbolIndex of [1, 6, 12]) {
    corruptVisibleDataCell(damaged, layout, symbolIndex * 4, 1);
  }

  // Ten body byte symbols. M can correct twelve per block.
  for (let symbolIndex = 0; symbolIndex < 10; symbolIndex++) {
    corruptVisibleDataCell(
      damaged,
      layout,
      internals.getHeaderPlan(encoded.version).codewordCells + symbolIndex * 4,
      (symbolIndex % 3) + 1
    );
  }

  const decoded = decodeMatrix(damaged);
  assert.equal(decoded.text, text);
  assert.ok(decoded.correctedHeaderSymbols >= 3);
  assert.ok(decoded.correctedBodySymbols >= 10);
}

// Beyond one-block M correction limit must fail safely.
{
  const text = "Beyond correction limit " + "A".repeat(120);
  const encoded = encodeText(text, { ecc: "M" });
  const plan = internals.getBodyRsPlan(new TextEncoder().encode(text).length, "M", encoded.version);
  assert.equal(plan.dataBlockLengths.length, 1, "Test expects a single RS body block.");
  const layout = internals.createLayout(encoded.version);
  const damaged = cloneMatrix(encoded.matrix);

  for (let symbolIndex = 0; symbolIndex < 13; symbolIndex++) {
    corruptVisibleDataCell(damaged, layout, internals.getHeaderPlan(encoded.version).codewordCells + symbolIndex * 4, 1);
  }

  assert.throws(() => decodeMatrix(damaged));
}

// Scanner-level Spectrum ECC test: make sixteen body symbols visually
// ambiguous and slightly closer to the wrong RGBW state. Hard matrix decoding
// of equivalent corruption is beyond M's 12-error limit, but calibrated color
// confidence lets the image scanner recover through erasures.
{
  const payload = new Uint8Array(Array.from({ length: 100 }, (_, i) => (i * 31 + 7) & 0xff));
  const encoded = encodeBytes(payload, { ecc: "M" });
  const moduleSize = 14;
  const quietZone = 4;
  const image = renderToImageData(encoded, { moduleSize, quietZone, style: "classic" });
  const layout = internals.createLayout(encoded.version);
  const permutation = internals.spectralPermutation(layout.dataPositions.length, layout.version);
  const bodyStart = internals.getHeaderPlan(encoded.version).codewordCells;
  const palette = {
    [CELL.RED]: [0xef, 0x23, 0x3c],
    [CELL.GREEN]: [0x16, 0xa3, 0x4a],
    [CELL.BLUE]: [0x25, 0x63, 0xeb],
    [CELL.WHITE]: [0xff, 0xff, 0xff]
  };
  const states = [CELL.RED, CELL.GREEN, CELL.BLUE, CELL.WHITE];

  function paintModule(row, col, rgb) {
    const x0 = (quietZone + col) * moduleSize;
    const y0 = (quietZone + row) * moduleSize;
    for (let y = y0; y < y0 + moduleSize; y++) {
      for (let x = x0; x < x0 + moduleSize; x++) {
        const offset = (y * image.width + x) * 4;
        image.data[offset] = rgb[0];
        image.data[offset + 1] = rgb[1];
        image.data[offset + 2] = rgb[2];
        image.data[offset + 3] = 255;
      }
    }
  }

  for (let symbolIndex = 0; symbolIndex < 16; symbolIndex++) {
    const logicalCell = bodyStart + symbolIndex * 4;
    const [row, col] = layout.dataPositions[permutation[logicalCell]];
    const current = encoded.matrix[row][col];
    const wrong = states[(states.indexOf(current) + 1) % states.length];
    const source = palette[current];
    const target = palette[wrong];
    paintModule(row, col, source.map((value, channel) =>
      Math.round(value * 0.46 + target[channel] * 0.54)
    ));
  }

  const decoded = scanImageData(image, {
    minVersion: encoded.version,
    maxVersion: encoded.version,
    perspective: false
  });
  bytesEqual(decoded.payload, payload);
  assert.equal(decoded.confidenceAssisted, true);
  assert.ok(decoded.erasureSymbols > 0);
  assert.ok(decoded.correctedBodySymbols >= 16);
  assert.ok(decoded.lowConfidenceCells >= 16);
}

// Progressive Auto Tone / Auto Contrast / Auto Color-style recovery. The
// ordinary scanner is intentionally unable to decode this low-contrast warm
// frame, while the fallback should restore enough dynamic range/color
// separation to decode it without changing the encoded symbol or capacity.
{
  const text = "Auto tone contrast color camera recovery validation payload 1234567890";
  const encoded = encodeText(text, { ecc: "M", version: 4 });
  const clean = renderToImageData(encoded, { moduleSize: 9, quietZone: 4 });
  const flattened = flattenWarmCameraLevels(clean);

  assert.throws(() => scanImageData(flattened, { autoEnhanceRecovery: false }));
  const recovered = scanImageData(flattened);
  assert.equal(recovered.text, text);
  assert.equal(recovered.version, 4);
  assert.equal(recovered.autoEnhanced, true);
  assert.equal(recovered.recoveryMode, "auto-tone-contrast-color");
}

// Camera Auto Color-only regression. This mirrors the real phone observation:
// the normal frame cannot decode under the warm/compressed channel cast, while
// a per-channel Auto Color levels correction alone makes the exact same pixels
// immediately scannable. Keep this separate from the stronger Tone/Contrast
// recovery so camera finder recovery does not accidentally depend on it.
{
  const text = "Camera Auto Color only recovery regression payload 123456";
  const encoded = encodeText(text, { ecc: "M", version: 4 });
  const clean = renderToImageData(encoded, { moduleSize: 9, quietZone: 4 });
  const flattened = flattenWarmCameraLevels(clean);

  assert.throws(() => scanImageData(flattened, { autoEnhanceRecovery: false }));
  const corrected = autoColorImageData(flattened, {
    blackClip: 0.0001,
    highlightPercentile: 0.95,
    outputHighlight: 190,
    analysisInset: 0.04,
    minimumInputRange: 72
  });
  const recovered = scanImageData(corrected, { autoEnhanceRecovery: false });
  assert.equal(recovered.text, text);
  assert.equal(recovered.version, 4);
}

// Live-camera guide recovery regression. A QR crop can be perfectly usable
// while the same pixels embedded in a much larger dark camera frame produce no
// finder geometry because global thresholding is dominated by the surroundings.
// Camera recovery therefore crops toward the guide before applying Auto Color.
{
  const text = "Camera guide crop Auto Color recovery regression";
  const encoded = encodeText(text, { ecc: "M", version: 4 });
  const clean = renderToImageData(encoded, { moduleSize: 7, quietZone: 4 });
  const qr = flattenWarmCameraLevels(clean);
  const frameWidth = qr.width * 2;
  const frameHeight = qr.height * 2;
  const data = new Uint8ClampedArray(frameWidth * frameHeight * 4);
  for (let i = 0; i < frameWidth * frameHeight; i++) {
    const p = i * 4;
    data[p] = 38;
    data[p + 1] = 32;
    data[p + 2] = 26;
    data[p + 3] = 255;
  }
  const offsetX = Math.floor((frameWidth - qr.width) / 2);
  const offsetY = Math.floor((frameHeight - qr.height) / 2);
  for (let y = 0; y < qr.height; y++) {
    for (let x = 0; x < qr.width; x++) {
      const source = (y * qr.width + x) * 4;
      const target = ((offsetY + y) * frameWidth + offsetX + x) * 4;
      data[target] = qr.data[source];
      data[target + 1] = qr.data[source + 1];
      data[target + 2] = qr.data[source + 2];
      data[target + 3] = 255;
    }
  }
  const cameraFrame = { width: frameWidth, height: frameHeight, data };
  assert.throws(() => scanImageData(cameraFrame, {
    finderRecovery: false,
    autoEnhanceRecovery: false,
    axisAlignedFallback: false
  }));

  const cropped = internals.cropImageDataInset(cameraFrame, 0.22);
  const corrected = autoColorImageData(cropped.imageData, {
    blackClip: 0.0001,
    whiteClip: 0.004,
    highlightPercentile: 0.95,
    outputHighlight: 190,
    analysisInset: 0.08,
    minimumInputRange: 72
  });
  const recovered = scanImageData(corrected, {
    finderRecovery: true,
    autoEnhanceRecovery: false
  });
  assert.equal(recovered.text, text);
  assert.equal(recovered.version, 4);
}

// Dirty camera stress test: perspective + warm/yellow cast + blue-channel
// suppression + lens haze + blur. The scanner should fall back to per-channel
// white balancing and still recover the payload without changing the format.
{
  const text = "Dirty yellow camera blur robustness test for QuadQR";
  const encoded = encodeText(text, { ecc: "M" });
  const clean = renderToImageData(encoded, { moduleSize: 6, quietZone: 4 });
  const scaledWidth = Math.round(clean.width * 1.25);
  const scaledHeight = Math.round(clean.height * 1.25);
  const dirty = warpWithDirtyWarmCamera(
    clean,
    scaledWidth + 60,
    scaledHeight + 50,
    [
      { x: 30, y: 18 },
      { x: scaledWidth + 18, y: 27 },
      { x: 22, y: scaledHeight + 20 },
      { x: scaledWidth + 28, y: scaledHeight + 28 }
    ]
  );

  const decoded = scanImageData(dirty, {
    minVersion: encoded.version,
    maxVersion: encoded.version
  });
  assert.equal(decoded.text, text);
  assert.equal(decoded.colorNormalization, "white-balanced");
  assert.ok(decoded.correctedSymbols > 0);
}

// Directional lens/chromatic-shift regression. Keep the structural black/white
// locator geometry fixed while shifting colored data energy to the right by a
// little over half a module. The ordinary detected centres are then wrong, but
// the bounded sub-module geometry refinement should recover the payload.
{
  const text = "Submodule lens shift recovery regression";
  const encoded = encodeText(text, { version: 4, ecc: "M" });
  const moduleSize = 8;
  const quietZone = 4;
  const clean = renderToImageData(encoded, { moduleSize, quietZone, style: "classic" });
  const damaged = {
    width: clean.width,
    height: clean.height,
    data: new Uint8ClampedArray(clean.data)
  };
  const layout = internals.createLayout(encoded.version);
  const palette = {
    [CELL.RED]: [0xef, 0x23, 0x3c],
    [CELL.GREEN]: [0x16, 0xa3, 0x4a],
    [CELL.BLUE]: [0x25, 0x63, 0xeb]
  };
  const shift = 5;

  function fillRect(x0, y0, width, height, rgb) {
    const minX = Math.max(0, x0);
    const minY = Math.max(0, y0);
    const maxX = Math.min(damaged.width, x0 + width);
    const maxY = Math.min(damaged.height, y0 + height);
    for (let y = minY; y < maxY; y++) {
      for (let x = minX; x < maxX; x++) {
        const offset = (y * damaged.width + x) * 4;
        damaged.data[offset] = rgb[0];
        damaged.data[offset + 1] = rgb[1];
        damaged.data[offset + 2] = rgb[2];
        damaged.data[offset + 3] = 255;
      }
    }
  }

  for (const [row, col] of layout.dataPositions) {
    const cell = encoded.matrix[row][col];
    if (cell === CELL.WHITE) continue;
    const x = (quietZone + col) * moduleSize;
    const y = (quietZone + row) * moduleSize;
    fillRect(x, y, moduleSize, moduleSize, [255, 255, 255]);
    fillRect(x + shift, y, moduleSize, moduleSize, palette[cell]);
  }

  assert.throws(() => scanImageData(damaged, {
    minVersion: 4,
    maxVersion: 4,
    geometryRefinement: false,
    autoEnhanceRecovery: false
  }));

  const decoded = scanImageData(damaged, {
    minVersion: 4,
    maxVersion: 4,
    autoEnhanceRecovery: false
  });
  assert.equal(decoded.text, text);
  assert.equal(decoded.geometryRefined, true);
  assert.equal(decoded.samplingMode, "refined-center");
  assert.ok(Math.abs(decoded.samplingOffset.x) >= 0.19);
}

// Mobile camera preview crop regression. The demo uses a portrait video box
// with object-fit: cover while many phone camera streams are landscape. The
// scanner must analyze the same central source region the user sees, instead
// of the much wider hidden sensor frame.
{
  const source = internals.visibleVideoSourceRect({
    videoWidth: 1920,
    videoHeight: 1080,
    clientWidth: 360,
    clientHeight: 480
  }, {
    videoObjectFit: "cover",
    videoObjectPosition: "50% 50%"
  });
  assert.equal(source.cropped, true);
  assert.ok(Math.abs(source.x - 555) < 1e-6);
  assert.ok(Math.abs(source.y) < 1e-6);
  assert.ok(Math.abs(source.width - 810) < 1e-6);
  assert.ok(Math.abs(source.height - 1080) < 1e-6);
}

// Multi-frame voting: each observation has a different set of badly classified
// data cells. No one damaged location has a majority, so the combined matrix
// should reconstruct the original symbol and decode cleanly.
{
  const payload = new Uint8Array(Array.from({ length: 100 }, (_, i) => (i * 29 + 3) & 0xff));
  const encoded = encodeBytes(payload, { ecc: "M" });
  const layout = internals.createLayout(encoded.version);
  const bodyStart = internals.getHeaderPlan(encoded.version).codewordCells;
  const observations = [];

  for (let frame = 0; frame < 3; frame++) {
    const matrix = cloneMatrix(encoded.matrix);
    const confidence = Array.from({ length: matrix.length }, () => Array(matrix.length).fill(0.92));
    for (let i = 0; i < 16; i++) {
      const logicalCell = bodyStart + (frame * 16 + i) * 4;
      const physicalIndex = internals.spectralPermutation(layout.dataPositions.length, layout.version)[logicalCell];
      const [row, col] = layout.dataPositions[physicalIndex];
      const current = matrix[row][col];
      matrix[row][col] = (current + 1) & 3;
      confidence[row][col] = 0.20;
    }
    observations.push({
      version: encoded.version,
      matrix,
      confidence,
      structureScore: 1,
      averageCellConfidence: 0.9
    });
  }

  const combined = internals.combineFrameObservations(observations);
  assert.ok(combined);
  const decoded = decodeMatrix(combined.matrix, { cellConfidence: combined.confidence });
  bytesEqual(decoded.payload, payload);
}


// Advanced affine color calibration compensates for cross-channel camera/print
// mixing, not only per-channel white balance. This synthetic palette is a
// deliberately anisotropic transform where raw Euclidean matching confuses a
// noisy red sample with blue, while the fitted 3x4 affine calibration restores
// the correct logical class.
{
  const observed = {
    black: { r: 30, g: 25, b: 35 },
    white: { r: 157.5, g: 190.75, b: 131.9 },
    red: { r: 93.75, g: 37.75, b: 47.75 },
    green: { r: 81, g: 152.5, b: 73.25 },
    blue: { r: 42.75, g: 50.5, b: 80.9 }
  };
  const sample = { r: 61.6744, g: 51.9523, b: 56.0861 };
  const rawClassifier = internals.classifierFromPaletteRgb(observed, "raw");
  rawClassifier.entries = rawClassifier.entries.filter(({ cell }) => cell !== CELL.BLACK);
  const affineClassifier = internals.classifierFromPaletteRgb(observed, "affine");
  affineClassifier.entries = affineClassifier.entries.filter(({ cell }) => cell !== CELL.BLACK);
  const raw = internals.classifyRgb(sample, rawClassifier);
  const affine = internals.classifyRgb(sample, affineClassifier);
  assert.equal(raw.cell, CELL.BLUE);
  assert.equal(affine.cell, CELL.RED);
  assert.equal(affineClassifier.calibrationModel, "affine-3x4");
  assert.ok(affineClassifier.calibrationError < 25);
}

// Clean image scan uses perspective geometry and observed color calibration.
{
  const text = "Clean RGBW image scanner";
  const encoded = encodeText(text, { ecc: "M" });
  assert.equal(new TextEncoder().encode(text).length, 24);
  assert.equal(encoded.version, 1, "24-byte v1-M capacity should be used by auto selection.");
  const image = renderToImageData(encoded, { moduleSize: 10, quietZone: 4 });
  const diagnostics = { passes: [] };
  const decoded = scanImageData(image, {
    minVersion: encoded.version,
    maxVersion: encoded.version,
    _visionDiagnostics: diagnostics
  });
  assert.equal(decoded.text, text);
  assert.equal(decoded.perspectiveCorrected, true);
  assert.equal(decoded.colorCalibrated, true);
  assert.ok(diagnostics.passes.length >= 1, "Scanner diagnostics should expose the finder pass.");
  assert.equal(diagnostics.passes[0].finderMethod, "rgb-value-otsu");
  assert.ok(diagnostics.passes[0].finderCount >= 3, "Scanner diagnostics should expose finder candidates.");
  assert.equal(diagnostics.passes[0].geometries[0].version, encoded.version);
}

// Rendering styles are presentation-only and must remain scanner-safe.
{
  const text = "Styled QuadQR scan";
  const encoded = encodeText(text, { ecc: "M" });
  for (const style of ["depth", "soft", "inset"]) {
    const image = renderToImageData(encoded, { moduleSize: 12, quietZone: 4, style });
    const decoded = scanImageData(image, {
      minVersion: encoded.version,
      maxVersion: encoded.version
    });
    assert.equal(decoded.text, text, `${style} renderer must remain decodable`);
  }
}

// Exact output sizing defaults to 720px and imageSize takes precedence over
// the legacy pixels-per-module moduleSize option.
{
  const text = "QuadQR exact image size";
  const encoded = encodeText(text, { ecc: "M" });

  const defaultImage = renderToImageData(encoded, { quietZone: 4 });
  assert.equal(defaultImage.width, 720);
  assert.equal(defaultImage.height, 720);
  assert.equal(scanImageData(defaultImage, { minVersion: encoded.version, maxVersion: encoded.version }).text, text);

  const exact = renderToImageData(encoded, { imageSize: 721, moduleSize: 5, quietZone: 4 });
  assert.equal(exact.width, 721);
  assert.equal(exact.height, 721);
  assert.equal(scanImageData(exact, { minVersion: encoded.version, maxVersion: encoded.version }).text, text);

  const svg = renderToSVG(encoded, { imageSize: 1024, quietZone: 4 });
  assert.ok(svg.includes('width="1024" height="1024"'));
}

// Logo overlays, cleared logo backgrounds, quiet-zone control, and SVG export
// are rendering features only. A conservative logo size must stay decodable.
{
  const text = "QuadQR logo + SVG";
  const encoded = encodeText(text, { version: 5, ecc: "M" });
  const logo = {
    width: 8,
    height: 8,
    data: new Uint8ClampedArray(8 * 8 * 4)
  };
  for (let i = 0; i < 8 * 8; i++) {
    const p = i * 4;
    logo.data[p] = 24;
    logo.data[p + 1] = 24;
    logo.data[p + 2] = 24;
    logo.data[p + 3] = 255;
  }

  const image = renderToImageData(encoded, {
    moduleSize: 8,
    quietZone: 6,
    logo: {
      source: logo,
      size: 0.10,
      clearBackground: true
    }
  });
  assert.equal(image.width, (encoded.size + 12) * 8);
  const decoded = scanImageData(image, {
    minVersion: encoded.version,
    maxVersion: encoded.version
  });
  assert.equal(decoded.text, text);

  const svg = renderToSVG(encoded, {
    moduleSize: 8,
    quietZone: 6,
    logo: {
      source: "data:image/png;base64,AA==",
      size: 0.10,
      clearBackground: true
    }
  });
  assert.ok(svg.startsWith('<?xml version="1.0"'));
  assert.ok(svg.includes("<image "));
  assert.ok(svg.includes(`width="${(encoded.size + 12) * 8}"`));
}

// The inset edge-only style must also survive perspective correction and
// camera-style color cast, not just clean axis-aligned rendering.
{
  const text = "Perspective + RGBW calibration + GF256 Reed-Solomon";
  for (const style of ["inset"]) {
    const encoded = encodeText(text, { ecc: "M" });
    const clean = renderToImageData(encoded, { moduleSize: 12, quietZone: 4, style });
    const warped = warpWithColorCast(clean, 760, 560, [
      { x: 110, y: 70 },
      { x: 625, y: 105 },
      { x: 75, y: 475 },
      { x: 665, y: 505 }
    ]);
    const decoded = scanImageData(warped, {
      minVersion: encoded.version,
      maxVersion: encoded.version
    });
    assert.equal(decoded.text, text, `${style} must survive perspective/color-cast scanning`);
  }
}

// Perspective + camera-style color cast.
{
  const text = "Perspective + RGBW calibration + GF256 Reed-Solomon";
  const encoded = encodeText(text, { ecc: "M" });
  const clean = renderToImageData(encoded, { moduleSize: 12, quietZone: 4 });
  const warped = warpWithColorCast(clean, 760, 560, [
    { x: 110, y: 70 },
    { x: 625, y: 105 },
    { x: 75, y: 475 },
    { x: 665, y: 505 }
  ]);

  const decoded = scanImageData(warped, {
    minVersion: Math.max(1, encoded.version - 2),
    maxVersion: Math.min(MAX_VERSION, encoded.version + 2)
  });

  assert.equal(decoded.text, text);
  assert.equal(decoded.perspectiveCorrected, true);
  assert.equal(decoded.colorCalibrated, true);
  assert.ok(decoded.geometry.alignment.score >= 0.72);
}

// Dense symbols must survive the built-in perspective stress transform at
// roughly the same module density used by the demo scanability test. This also
// guards the destination->source homography direction used by the raster warp.
{
  const text = ("QuadQR dense perspective regression with Spectrum ECC. ").repeat(8).slice(0, 350);
  const encoded = encodeText(text, { version: 8, ecc: "M", compression: "none" });
  const clean = renderToImageData(encoded, { imageSize: 570, quietZone: 4 });
  const distorted = applyStressDistortion(clean, "perspective", 0.55);
  const decoded = scanImageData(distorted, { minVersion: 8, maxVersion: 8 });
  assert.equal(decoded.text, text);
  assert.equal(decoded.crc32, encoded.crc32);
  assert.ok(decoded.geometry.alignment.gridScore >= 0.68);
}

// A multi-alignment symbol must survive image scanning and perspective/color cast.
{
  const text = "QuadQR v10 distributed alignment geometry";
  const encoded = encodeText(text, { version: 10, ecc: "M" });
  assert.equal(encoded.version, 10);
  assert.equal(getVersionInfo(10, { ecc: "M" }).alignmentPatterns, 6);

  const clean = renderToImageData(encoded, { moduleSize: 12, quietZone: 4 });
  const warped = warpWithColorCast(clean, 900, 720, [
    { x: 90, y: 55 },
    { x: 790, y: 80 },
    { x: 80, y: 640 },
    { x: 810, y: 650 }
  ]);
  const decoded = scanImageData(warped, { minVersion: 10, maxVersion: 10 });
  assert.equal(decoded.text, text);
  assert.equal(decoded.version, 10);
  assert.equal(decoded.geometry.alignment.patterns, 6);
  assert.ok(decoded.geometry.alignment.gridScore >= 0.68);
}

// Secure Payload v1: password mode must round-trip, remain opaque before
// decryption, reject a wrong password, and preserve normal ECC/image scanning.
{
  const text = "Private QuadQR payload 🔐";
  const encoded = await encodeSecureText(text, {
    ecc: "M",
    security: {
      mode: "password",
      password: "correct horse battery staple",
      iterations: 100_000
    }
  });
  assert.equal(encoded.secure, true);
  assert.ok(encoded.payloadBytes > encoded.sourcePayloadBytes);
  assert.equal(encoded.security.mode, "password");
  assert.equal(encoded.security.algorithm, "AES-256-GCM");

  const decoded = decodeMatrix(encoded.matrix);
  assert.equal(decoded.secure, true);
  assert.equal(decoded.requiresDecryption, true);
  assert.equal(decoded.text, null);
  assert.equal(decoded.security.mode, "password");

  const decrypted = await decryptDecoded(decoded, { password: "correct horse battery staple" });
  assert.equal(decrypted.text, text);
  assert.equal(decrypted.requiresDecryption, false);
  await assert.rejects(
    () => decryptDecoded(decoded, { password: "definitely-wrong" }),
    /decryption failed/i
  );

  const image = renderToImageData(encoded, { moduleSize: 12, quietZone: 4 });
  const scanned = scanImageData(image, { minVersion: encoded.version, maxVersion: encoded.version });
  assert.equal(scanned.secure, true);
  const scannedPlain = await decryptDecoded(scanned, { password: "correct horse battery staple" });
  assert.equal(scannedPlain.text, text);
}

// Secure Payload v1: raw 256-bit keys should decrypt without password KDF work,
// automatically expose a non-secret key fingerprint ID, and reject another key.
{
  const key = generateRaw256Key();
  assert.equal(key.length, 32);
  assert.equal(bytesToHex(key).length, 64);

  const encoded = await encodeSecureText("Raw key secure payload", {
    ecc: "M",
    security: { mode: "raw-key", key }
  });
  const decoded = decodeMatrix(encoded.matrix);
  assert.equal(decoded.secure, true);
  assert.equal(decoded.security.mode, "raw-key");
  assert.equal(decoded.security.kdf, null);
  assert.equal(decoded.security.keyIdHex.length, 16);

  const decrypted = await decryptDecoded(decoded, { key });
  assert.equal(decrypted.text, "Raw key secure payload");

  const wrongKey = generateRaw256Key();
  await assert.rejects(
    () => decryptDecoded(decoded, { key: wrongKey }),
    /key ID|decryption failed/i
  );
}


// Compression 3.0 stays an internal detail around a normal payload.
{
  const text = "Payload compression compression compression ".repeat(8);
  const raw = new TextEncoder().encode(text);

  // Legacy portable LZ remains available and decodable for compatibility.
  const lzCompressed = compressPayload(raw);
  const lzRestored = decompressPayload(lzCompressed, raw.length);
  bytesEqual(lzRestored, raw);
  assert.ok(lzCompressed.length < raw.length);
  assert.deepEqual(COMPRESSION_LEVELS.lz, { min: 1, max: 9, default: 6 });
  bytesEqual(compressPayload(raw), compressPayload(raw, { level: 6 }));
  for (const level of [1, 6, 9]) {
    const compressed = compressPayload(raw, { level });
    bytesEqual(decompressPayload(compressed, raw.length), raw);
  }
  assert.throws(() => compressPayload(raw, { level: 0 }), /LZ level must be 1\.\.9/i);
  assert.throws(() => compressPayload(raw, { level: 10 }), /LZ level must be 1\.\.9/i);

  const explicitLzLevelCode = encodeText(text, { compression: "lz", compressionLevel: 9 });
  assert.equal(explicitLzLevelCode.compression, "lz");
  assert.equal(explicitLzLevelCode.compressionLevel, 9);
  assert.equal(decodeMatrix(explicitLzLevelCode.matrix).text, text);
  const explicitLzAlias = encodeText(text, { compression: "lz", lzLevel: 1 });
  assert.equal(explicitLzAlias.compressionLevel, 1);
  assert.throws(() => encodeText(text, { compression: "lz", compressionLevel: 10 }), /LZ compressionLevel must be 1\.\.9/i);

  // Forced legacy LZ must remain a valid stream even for 0..3 byte inputs.
  for (const tinyText of ["", "a", "ab", "abc"]) {
    const tinyRaw = new TextEncoder().encode(tinyText);
    bytesEqual(decompressPayload(compressPayload(tinyRaw), tinyRaw.length), tinyRaw);
    const tinyLz = decodeMatrix(encodeText(tinyText, { compression: "lz" }).matrix);
    assert.equal(tinyLz.text, tinyText);
    assert.equal(tinyLz.compression, "lz");
  }

  // The synchronous raw-DEFLATE path is pure JS and runtime-neutral.
  const deflated = compressDeflatePayload(raw);
  const inflated = decompressDeflatePayload(deflated, raw.length);
  bytesEqual(inflated, raw);
  assert.ok(deflated.length < lzCompressed.length);
  assert.deepEqual(COMPRESSION_LEVELS.deflate, { min: 1, max: 9, default: 6 });
  for (const level of [1, 6, 9]) {
    const compressed = compressDeflatePayload(raw, { level });
    bytesEqual(decompressDeflatePayload(compressed, raw.length), raw);
  }
  assert.throws(() => compressDeflatePayload(raw, { level: 0 }), /DEFLATE level must be 1\.\.9/i);

  // Brotli is also bundled, synchronous, and round-trips standard byte payloads.
  const brotlied = compressBrotliPayload(raw);
  const unbrotlied = decompressBrotliPayload(brotlied, raw.length);
  bytesEqual(unbrotlied, raw);
  assert.ok(brotlied.length <= deflated.length);
  assert.deepEqual(COMPRESSION_LEVELS.brotli, { min: 0, max: 11, default: 11 });
  for (const quality of [0, 6, 11]) {
    const compressed = compressBrotliPayload(raw, { quality });
    bytesEqual(decompressBrotliPayload(compressed, raw.length), raw);
  }
  assert.throws(() => compressBrotliPayload(raw, { quality: 12 }), /Brotli quality must be an integer 0\.\.11/i);

  const encoded = encodeText(text, { ecc: "M", compression: "auto" });
  const decoded = decodeMatrix(encoded.matrix);
  assert.equal(decoded.text, text);
  assert.equal(decoded.compression, "brotli");
  assert.equal(decoded.compressed, true);
  assert.equal("contentType" in decoded, false);
  assert.ok(encoded.payloadBytes < raw.length);

  // Highly repetitive text should collapse dramatically compared with legacy LZ.
  const repetitive = "hello ".repeat(1000).trimEnd();
  const repetitiveRaw = new TextEncoder().encode(repetitive);
  const repetitiveLz = compressPayload(repetitiveRaw);
  const repetitiveDeflate = compressDeflatePayload(repetitiveRaw);
  const repetitiveBrotli = compressBrotliPayload(repetitiveRaw);
  assert.ok(repetitiveDeflate.length * 5 < repetitiveLz.length);
  assert.ok(repetitiveBrotli.length < repetitiveDeflate.length);
  const repetitiveEncoded = encodeText(repetitive, { ecc: "M", compression: "auto" });
  const repetitiveDecoded = decodeMatrix(repetitiveEncoded.matrix);
  assert.equal(repetitiveDecoded.text, repetitive);
  assert.equal(repetitiveDecoded.compression, "brotli");

  // Explicit modes remain deterministic.
  const explicitLz = decodeMatrix(encodeText(text, { compression: "lz" }).matrix);
  assert.equal(explicitLz.compression, "lz");
  const explicitDeflate = decodeMatrix(encodeText(text, { compression: "deflate" }).matrix);
  assert.equal(explicitDeflate.compression, "deflate");
  const explicitBrotliCode = encodeText(text, { compression: "brotli", compressionLevel: 9 });
  const explicitBrotli = decodeMatrix(explicitBrotliCode.matrix);
  assert.equal(explicitBrotli.compression, "brotli");
  assert.equal(explicitBrotliCode.compressionLevel, 9);
  const explicitDeflateCode = encodeText(text, { compression: "deflate", compressionLevel: 1 });
  assert.equal(explicitDeflateCode.compressionLevel, 1);
  assert.throws(() => encodeText(text, { compression: "deflate", compressionLevel: 10 }), /1\.\.9/);
  assert.throws(() => encodeText(text, { compression: "brotli", compressionLevel: -1 }), /0\.\.11/);

  // Smart mode starts balanced, then escalates only when stronger levels can
  // plausibly cross a physical QuadQR version boundary.
  const smartRows = [];
  for (let i = 0; i < 20; i++) {
    smartRows.push(JSON.stringify({
      id: i,
      name: `product-${i % 17}`,
      category: `cat-${i % 7}`,
      description: `This is a repeated product description for item ${i % 23} with common words and values`,
      price: (i % 13) * 17.25,
      tags: [`tag${i % 5}`, `tag${i % 9}`]
    }));
  }
  const smartText = smartRows.join("\n");
  const autoSmartBaseline = encodeText(smartText, { compression: "auto", ecc: "M" });
  const smartCode = encodeText(smartText, { compression: "smart", ecc: "M" });
  assert.equal(smartCode.compressionStrategy, "smart");
  assert.equal(smartCode.smartCompression.cpuHeavy, true);
  assert.ok(smartCode.smartCompression.levelsTried.length >= 4);
  assert.ok(smartCode.version < autoSmartBaseline.version, `Expected Smart v${smartCode.version} to beat Auto v${autoSmartBaseline.version}.`);
  assert.equal(decodeMatrix(smartCode.matrix).text, smartText);

  // Auto mode is genuinely zero-overhead when an envelope would make the
  // stored representation larger than the original payload. Brotli must also
  // safely handle tiny inputs when it is explicitly requested.
  const tiny = encodeText("abc", { compression: "auto" });
  const tinyDecoded = decodeMatrix(tiny.matrix);
  assert.equal(tinyDecoded.text, "abc");
  assert.equal(tinyDecoded.compressed, false);
  assert.equal(tiny.payloadBytes, 3);
  const tinyBrotli = decodeMatrix(encodeText("abc", { compression: "brotli" }).matrix);
  assert.equal(tinyBrotli.text, "abc");
  assert.equal(tinyBrotli.compression, "brotli");
}

// Signed QuadQR: the private key signs, while a trusted external public key verifies.
{
  const pair = await generateSigningKeyPair();
  assert.ok(pair.keyId);
  const encoded = await encodeSignedText("Signed QuadQR payload", {
    ecc: "Q",
    compression: "auto",
    privateKey: pair.privateKey,
    keyId: pair.keyId
  });
  const decoded = decodeMatrix(encoded.matrix);
  assert.equal(decoded.signed, true);
  assert.equal(decoded.signingKeyId, pair.keyId);
  assert.equal(decoded.hasEmbeddedPublicKey, false);
  await assert.rejects(() => verifyDecodedSignature(decoded), /trusted Ed25519 public key/i);
  const verified = await verifyDecodedSignature(decoded, { publicKey: pair.publicKey });
  assert.equal(verified.signatureVerified, true);
  assert.equal(verified.signatureTrusted, true);
  assert.equal(verified.text, "Signed QuadQR payload");

  const embedded = await encodeSignedText("Embedded key compatibility", {
    ecc: "Q",
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    embedPublicKey: true,
    keyId: pair.keyId
  });
  const embeddedDecoded = decodeMatrix(embedded.matrix);
  assert.equal(embeddedDecoded.hasEmbeddedPublicKey, true);
  const selfChecked = await verifyDecodedSignature(embeddedDecoded, { allowEmbeddedKey: true });
  assert.equal(selfChecked.signatureVerified, true);
  assert.equal(selfChecked.signatureTrusted, false);

  const secured = await encodeSecureText("Signed + encrypted", {
    ecc: "Q",
    compression: "auto",
    security: { mode: "password", password: "signed-secret", iterations: 100_000 },
    signing: {
      privateKey: pair.privateKey,
      keyId: pair.keyId
    }
  });
  let secureDecoded = decodeMatrix(secured.matrix);
  secureDecoded = await decryptDecoded(secureDecoded, { password: "signed-secret" });
  assert.equal(secureDecoded.signingKeyId, pair.keyId);
  secureDecoded = await verifyDecodedSignature(secureDecoded, { publicKey: pair.publicKey });
  assert.equal(secureDecoded.text, "Signed + encrypted");
  assert.equal(secureDecoded.signatureVerified, true);
  assert.equal(secureDecoded.signatureTrusted, true);
}

// Print mode, scanner diagnostics, automatic logo sizing and deterministic stress tests.
{
  const encoded = encodeText("Diagnostics and stress test", { ecc: "M", version: 5 });
  const image = renderToImageData(encoded, { imageSize: 360, mode: "print", quietZone: 1 });
  assert.equal(image.width, 360);
  const decoded = scanImageData(image, { minVersion: 5, maxVersion: 5, debug: true });
  assert.equal(decoded.text, "Diagnostics and stress test");
  assert.ok(decoded.confidence >= 0 && decoded.confidence <= 1);
  assert.ok(decoded.diagnostics.stages.payload);
  assert.equal(debugScanImageData(image, { minVersion: 5, maxVersion: 5 }).ok, true);

  const dark = applyStressDistortion(image, "brightness-low", 0.25);
  assert.equal(dark.width, image.width);
  const report = runImageStressTest(image, { version: 5, crc32: encoded.crc32 }, {
    profiles: [
      { id: "clean", label: "Clean", type: "clean", severity: 0, weight: 1 },
      { id: "jpeg", label: "JPEG", type: "jpeg", severity: 0.25, weight: 1 }
    ]
  });
  assert.equal(report.total, 2);
  assert.ok(report.score >= 0 && report.score <= 100);

  const autoLogo = estimateSafeLogoSize(encoded, { clearBackground: true });
  assert.ok(autoLogo >= 0.07 && autoLogo <= 0.22);
  const logo = { width: 6, height: 6, data: new Uint8ClampedArray(6 * 6 * 4) };
  for (let i = 0; i < logo.width * logo.height; i++) {
    logo.data[i * 4] = 20;
    logo.data[i * 4 + 1] = 20;
    logo.data[i * 4 + 2] = 20;
    logo.data[i * 4 + 3] = 255;
  }
  const withAutoLogo = renderToImageData(encoded, {
    imageSize: 360,
    logo: { source: logo, size: "auto", clearBackground: true }
  });
  assert.equal(scanImageData(withAutoLogo, { minVersion: 5, maxVersion: 5 }).text, "Diagnostics and stress test");
  const empiricalLogo = findMaxSafeLogoSize(encoded, {
    imageSize: 360,
    logo: { source: logo, clearBackground: true },
    minSize: 0.07,
    maxSize: 0.18,
    iterations: 3
  });
  assert.ok(empiricalLogo.safeSize >= 0.07 && empiricalLogo.safeSize <= 0.18);
  const print = getPrintGuidance(encoded, { physicalSizeMm: 40, dpi: 300 });
  assert.ok(print.moduleSizeMm > 0);
  assert.ok(print.quietZone >= 4);
}

// Experimental Triangle16: two RGBW triangles per data module = 16 states / 4 bits.
{
  const text = "Triangle16 integration test: higher density with protected solid-color header.";
  const rgbwInfo = getVersionInfo(5, { ecc: "M", highDensity: false });
  const triangleInfo = getVersionInfo(5, { ecc: "M", highDensity: true });
  assert.equal(triangleInfo.bitsPerDataCell, 4);
  assert.equal(triangleInfo.statesPerDataCell, 16);
  assert.ok(triangleInfo.capacityBytes > rgbwInfo.capacityBytes * 1.8);

  const encoded = encodeText(text, {
    ecc: "M",
    highDensity: true
  });
  assert.equal(encoded.highDensity, true);
  assert.equal(encoded.bitsPerDataCell, 4);
  assert.equal(decodeMatrix(encoded.matrix).text, text);

  const image = renderToImageData(encoded, { imageSize: 720, quietZone: 4 });
  const scanned = scanImageData(image, {
    minVersion: encoded.version,
    maxVersion: encoded.version
  });
  assert.equal(scanned.text, text);
  assert.equal(scanned.highDensity, true);
  assert.match(scanned.samplingMode ?? "", /triangle16/);

  const stress = runImageStressTest(image, {
    version: encoded.version,
    crc32: encoded.crc32
  }, {
    profiles: [
      { id: "clean-tri", label: "Clean", type: "clean", severity: 0, weight: 1 },
      { id: "blur-tri", label: "Blur", type: "blur", severity: 0.25, weight: 1 },
      { id: "perspective-tri", label: "Perspective", type: "perspective", severity: 0.25, weight: 1 }
    ]
  });
  assert.equal(stress.passed, stress.total);

  const svg = renderToSVG(encoded, { imageSize: 360, quietZone: 4 });
  assert.match(svg, /<polygon/);
}

// Dense Triangle16 perspective regression. Solid RGBW cells can tolerate a
// finder/alignment solution that is a fraction of a module off; split cells
// cannot. The precise-alignment recovery pass must keep a high-utilization v10
// symbol decodable under the same deterministic projective distortion.
{
  const payload = Uint8Array.from({ length: 1000 }, (_, index) => (index * 73 + 19) & 0xff);
  const encoded = encodeBytes(payload, {
    version: 10,
    ecc: "M",
    highDensity: true
  });
  const image = renderToImageData(encoded, { imageSize: 900, quietZone: 4 });
  const distorted = applyStressDistortion(image, "perspective", 0.22);
  const decoded = scanImageData(distorted, { minVersion: 10, maxVersion: 10 });
  bytesEqual(decoded.payload, payload);
  assert.equal(decoded.highDensity, true);
}

// Reliability Lab 3D perspective regressions. Strong camera yaw now uses a
// bounded projective alignment search rather than assuming the primary
// alignment marker stays close to the three-finder affine extrapolation.
{
  const text = "QuadQR Reliability Lab projective geometry";
  const normal = encodeText(text, { version: 8, ecc: "M", compression: "none" });
  const normalImage = renderToImageData(normal, { imageSize: 720, quietZone: 4 });
  const yaw55 = applyStressDistortion(normalImage, "perspective-3d", 0.5, {
    pitchDegrees: 0,
    yawDegrees: 55,
    rollDegrees: 0
  });
  const normalDecoded = scanImageData(yaw55, { minVersion: 8, maxVersion: 8 });
  assert.equal(normalDecoded.text, text);
  assert.equal(normalDecoded.crc32, normal.crc32);

  const dense = encodeText(text.repeat(4), {
    version: 8,
    ecc: "M",
    compression: "none",
    highDensity: true
  });
  const denseImage = renderToImageData(dense, { imageSize: 720, quietZone: 4 });
  const denseYaw = applyStressDistortion(denseImage, "perspective-3d", 0.5, {
    pitchDegrees: 0,
    yawDegrees: 45,
    rollDegrees: 0
  });
  const denseDecoded = scanImageData(denseYaw, { minVersion: 8, maxVersion: 8 });
  assert.equal(denseDecoded.crc32, dense.crc32);
  assert.equal(denseDecoded.highDensity, true);

  const z75 = applyStressDistortion(denseImage, "perspective-3d", 0.5, {
    pitchDegrees: 0,
    yawDegrees: 0,
    rollDegrees: 75
  });
  assert.equal(scanImageData(z75, { minVersion: 8, maxVersion: 8 }).crc32, dense.crc32);
}

// Reliability Lab reports category scores and perspective sweeps using final
// payload CRC verification rather than finder detection alone.
{
  const encoded = encodeText("Reliability API smoke", { version: 4, ecc: "M" });
  const image = renderToImageData(encoded, { imageSize: 480, quietZone: 4 });
  const report = runReliabilityLab(image, { version: 4, crc32: encoded.crc32 }, {
    profiles: [
      { id: "clean-api", label: "Clean", category: "Baseline", type: "clean", severity: 0, weight: 1 },
      { id: "roll-api", label: "Z rotation", category: "Perspective", type: "perspective-3d", severity: 0.5, pitchDegrees: 0, yawDegrees: 0, rollDegrees: 55, weight: 1 }
    ]
  });
  assert.equal(report.passed, 2);
  assert.equal(report.total, 2);
  assert.ok(report.categories.some((item) => item.category === "Perspective" && item.score === 100));

  const sweep = runPerspectiveSweep(image, { version: 4, crc32: encoded.crc32 }, {
    axis: "yaw",
    angles: [0, 20, 35]
  });
  assert.equal(sweep.total, 3);
  assert.equal(sweep.maxPassedAngle, 35);
}

// Benchmark helpers and stable standard QR byte-mode reference capacities.
{
  assert.equal(getStandardQrByteCapacity(1, "L"), 17);
  assert.equal(getStandardQrByteCapacity(1, "M"), 14);
  assert.equal(getStandardQrByteCapacity(10, "M"), 213);
  assert.equal(getStandardQrByteCapacity(40, "H"), 1273);

  const v1Comparison = compareCapacity(1, "M");
  assert.equal(v1Comparison.quadqrBytes, 24);
  assert.equal(v1Comparison.standardQrBytes, 14);
  assert.equal(v1Comparison.differenceBytes, 10);
  assert.ok(v1Comparison.ratio > 1.7);

  const comparison = compareCapacity(10, "M");
  assert.equal(comparison.quadqrBytes, getVersionInfo(10, { ecc: "M" }).capacityBytes);
  assert.equal(comparison.standardQrBytes, 213);
  assert.ok(comparison.ratio > 1);

  const triangleComparison = compareCapacity(10, "M", { highDensity: true });
  assert.equal(triangleComparison.highDensity, true);
  assert.equal(triangleComparison.quadqrBitsPerDataCell, 4);
  assert.ok(triangleComparison.quadqrBytes > comparison.quadqrBytes * 1.8);

  const trianglePlan = calculateCapacityPlan({
    payloadBytes: 256,
    ecc: "M",
    highDensity: true
  });
  assert.equal(trianglePlan.highDensity, true);
  assert.ok(trianglePlan.quadqrVersion >= 1);

  const plan = calculateCapacityPlan({ payloadBytes: 256, ecc: "M", compression: "auto" });
  assert.ok(plan.quadqrVersion >= 1);
  assert.equal(plan.compression, "unknown");

  const quick = benchmarkCodec({ ecc: "M", iterations: 1, warmup: 0, payloadSizes: [32] });
  assert.equal(quick.results.length, 1);
  assert.equal(quick.results[0].skipped, false);
  assert.ok(quick.results[0].encode.meanMs >= 0);
  assert.ok(quick.results[0].decode.meanMs >= 0);
}

console.log("Representative QuadQR M capacities:");
for (const version of [1, 2, 5, 10]) {
  const info = getVersionInfo(version, { ecc: "M" });
  console.log(`  v${version}: ${info.size}x${info.size}, ${info.capacityBytes} payload bytes, ${info.bitsPerDataCell} bits/data-cell`);
}

console.log("All tests passed.");
