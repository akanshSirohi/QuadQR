import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  CELL,
  DEFAULT_ECC_LEVEL,
  FORMAT_VERSION,
  MAX_VERSION,
  decodeMatrix,
  decryptDecoded,
  encodeBytes,
  encodeText,
  encodeSecureText,
  generateRaw256Key,
  bytesToHex,
  getVersionInfo,
  internals,
  renderToImageData,
  rotateMatrix,
  scanImageData
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
