import {
  alignmentPatternCentersForVersion,
  alignmentPatternIsBlack,
  alignmentPatternRadius,
  primaryAlignmentPatternForVersion,
  ALIGNMENT_PROFILE_STANDARD_5,
  ALIGNMENT_PROFILE_LEGACY_3,
  sizeForVersion
} from "./geometry.js";

/**
 * Image geometry and sampling helpers for QuadQR.
 * JavaScript fallback with optional WASM hot-loop acceleration. No DOM dependency except callers may pass browser ImageData.
 */

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

let visionAccelerator = null;

// Repeated recovery stages often inspect the exact same captured ImageData.
// Cache immutable grayscale/binary preprocessing by ImageData identity so the
// stronger scanner can reuse work instead of rebuilding millions of pixels.
// WeakMap keeps camera frames collectible as soon as the scan finishes.
const binaryPreprocessCache = new WeakMap();
const autoColorGrayCache = new WeakMap();

/** Install or remove optional scanner hot-loop acceleration. Internal WASM wiring hook. */
export function installVisionAccelerator(accelerator = null) {
  visionAccelerator = accelerator && typeof accelerator.buildBinary === "function" ? accelerator : null;
}

function pixelRgb(imageData, x, y) {
  const ix = clamp(Math.round(x), 0, imageData.width - 1);
  const iy = clamp(Math.round(y), 0, imageData.height - 1);
  const index = (iy * imageData.width + ix) * 4;
  const a = imageData.data[index + 3] / 255;
  return {
    r: imageData.data[index] * a + 255 * (1 - a),
    g: imageData.data[index + 1] * a + 255 * (1 - a),
    b: imageData.data[index + 2] * a + 255 * (1 - a)
  };
}

function bilinearRgb(imageData, x, y) {
  const x0 = clamp(Math.floor(x), 0, imageData.width - 1);
  const y0 = clamp(Math.floor(y), 0, imageData.height - 1);
  const x1 = clamp(x0 + 1, 0, imageData.width - 1);
  const y1 = clamp(y0 + 1, 0, imageData.height - 1);
  const fx = clamp(x - x0, 0, 1);
  const fy = clamp(y - y0, 0, 1);

  const p00 = pixelRgb(imageData, x0, y0);
  const p10 = pixelRgb(imageData, x1, y0);
  const p01 = pixelRgb(imageData, x0, y1);
  const p11 = pixelRgb(imageData, x1, y1);

  const mix = (a, b, t) => a + (b - a) * t;
  return {
    r: mix(mix(p00.r, p10.r, fx), mix(p01.r, p11.r, fx), fy),
    g: mix(mix(p00.g, p10.g, fx), mix(p01.g, p11.g, fx), fy),
    b: mix(mix(p00.b, p10.b, fx), mix(p01.b, p11.b, fx), fy)
  };
}

function luminance(rgb) {
  return 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
}

function buildGray(imageData, mode = "luminance") {
  const gray = new Uint8Array(imageData.width * imageData.height);
  for (let i = 0; i < gray.length; i++) {
    const p = i * 4;
    const a = imageData.data[p + 3] / 255;
    const r = imageData.data[p] * a + 255 * (1 - a);
    const g = imageData.data[p + 1] * a + 255 * (1 - a);
    const b = imageData.data[p + 2] * a + 255 * (1 - a);

    // Finder detection is special for QuadQR. Saturated red/green/blue data
    // cells can look very dark in normal luminance, especially blue under a
    // warm phone camera. The HSV "value" channel keeps any cell with one
    // strong RGB component bright while structural black stays dark in all
    // channels. That makes the black/white finder rings far easier to isolate.
    gray[i] = Math.round(mode === "value"
      ? Math.max(r, g, b)
      : 0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
  return gray;
}

function otsuThreshold(gray) {
  const histogram = new Uint32Array(256);
  for (const value of gray) histogram[value]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];

  let sumBackground = 0;
  let weightBackground = 0;
  let maxVariance = -1;
  let threshold = 127;

  for (let t = 0; t < 256; t++) {
    weightBackground += histogram[t];
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;
    sumBackground += t * histogram[t];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const diff = meanBackground - meanForeground;
    const variance = weightBackground * weightForeground * diff * diff;
    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = t;
    }
  }

  return threshold;
}

function binaryAtThreshold(gray, threshold) {
  const binary = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) binary[i] = gray[i] <= threshold ? 1 : 0;
  return binary;
}

function hybridLocalBinary(gray, width, height) {
  // QR-specific local thresholding inspired by the same block strategy used by
  // ZXing's HybridBinarizer. It is intentionally a locator fallback, not a
  // replacement for QuadQR's color correction. 8x8 blocks + smoothed local
  // black points make finder rings survive shadows and screen gradients that
  // defeat one global threshold.
  const BLOCK = 8;
  const MIN_DIMENSION = 40;
  const MIN_DYNAMIC_RANGE = 24;
  if (width < MIN_DIMENSION || height < MIN_DIMENSION) return null;

  const subWidth = Math.ceil(width / BLOCK);
  const subHeight = Math.ceil(height / BLOCK);
  const blackPoints = new Uint16Array(subWidth * subHeight);
  const maxXOffset = Math.max(0, width - BLOCK);
  const maxYOffset = Math.max(0, height - BLOCK);

  for (let by = 0; by < subHeight; by++) {
    const y0 = Math.min(by * BLOCK, maxYOffset);
    for (let bx = 0; bx < subWidth; bx++) {
      const x0 = Math.min(bx * BLOCK, maxXOffset);
      let sum = 0;
      let min = 255;
      let max = 0;
      for (let yy = 0; yy < BLOCK; yy++) {
        const row = (y0 + yy) * width + x0;
        for (let xx = 0; xx < BLOCK; xx++) {
          const value = gray[row + xx];
          sum += value;
          if (value < min) min = value;
          if (value > max) max = value;
        }
      }
      let average = sum >> 6;
      if (max - min <= MIN_DYNAMIC_RANGE) {
        average = min >> 1;
        if (by > 0 && bx > 0) {
          const above = blackPoints[(by - 1) * subWidth + bx];
          const left = blackPoints[by * subWidth + bx - 1];
          const diag = blackPoints[(by - 1) * subWidth + bx - 1];
          const neighbor = (above + 2 * left + diag) >> 2;
          if (min < neighbor) average = neighbor;
        }
      }
      blackPoints[by * subWidth + bx] = average;
    }
  }

  const binary = new Uint8Array(width * height);
  for (let by = 0; by < subHeight; by++) {
    const y0 = Math.min(by * BLOCK, maxYOffset);
    const centerY = clamp(by, 2, Math.max(2, subHeight - 3));
    for (let bx = 0; bx < subWidth; bx++) {
      const x0 = Math.min(bx * BLOCK, maxXOffset);
      const centerX = clamp(bx, 2, Math.max(2, subWidth - 3));
      let sum = 0;
      let count = 0;
      for (let oy = -2; oy <= 2; oy++) {
        const py = clamp(centerY + oy, 0, subHeight - 1);
        for (let ox = -2; ox <= 2; ox++) {
          const px = clamp(centerX + ox, 0, subWidth - 1);
          sum += blackPoints[py * subWidth + px];
          count++;
        }
      }
      const threshold = Math.round(sum / Math.max(1, count));
      for (let yy = 0; yy < BLOCK; yy++) {
        const y = y0 + yy;
        if (y >= height) break;
        const row = y * width;
        for (let xx = 0; xx < BLOCK; xx++) {
          const x = x0 + xx;
          if (x >= width) break;
          if (gray[row + x] <= threshold) binary[row + x] = 1;
        }
      }
    }
  }
  return binary;
}

export function buildBinary(imageData, options = {}) {
  const grayMode = options.grayMode ?? "luminance";
  const thresholdOffset = Math.round(Number(options.thresholdOffset) || 0);
  const canCache = imageData && typeof imageData === "object" && options.cache !== false;
  const cacheKey = `${grayMode}:${thresholdOffset}`;
  if (canCache) {
    const cached = binaryPreprocessCache.get(imageData)?.get(cacheKey);
    if (cached) return cached;
  }

  let result;
  if (visionAccelerator) {
    try {
      const accelerated = visionAccelerator.buildBinary(imageData, {
        grayMode,
        thresholdOffset
      });
      if (accelerated?.gray && accelerated?.binary) {
        result = accelerated;
        if (canCache) {
          let entries = binaryPreprocessCache.get(imageData);
          if (!entries) binaryPreprocessCache.set(imageData, entries = new Map());
          entries.set(cacheKey, result);
        }
        return result;
      }
    } catch {
      // A WASM/runtime failure must never make scanning unavailable. Fall back
      // to the exact JavaScript implementation for this and future calls.
      visionAccelerator = null;
    }
  }

  const gray = buildGray(imageData, grayMode);
  const baseThreshold = otsuThreshold(gray);
  const threshold = clamp(
    Math.round(baseThreshold + thresholdOffset),
    8,
    247
  );
  result = {
    gray,
    binary: binaryAtThreshold(gray, threshold),
    threshold,
    baseThreshold,
    grayMode
  };
  if (canCache) {
    let entries = binaryPreprocessCache.get(imageData);
    if (!entries) binaryPreprocessCache.set(imageData, entries = new Map());
    entries.set(cacheKey, result);
  }
  return result;
}

function finderRatioScore(lengths, toleranceScale = 1) {
  const total = lengths.reduce((sum, value) => sum + value, 0);
  if (total < 7) return Infinity;
  const module = total / 7;
  const expected = [module, module, 3 * module, module, module];
  let score = 0;
  for (let i = 0; i < 5; i++) {
    const tolerance = (i === 2 ? module * 1.25 : module * 0.8) * toleranceScale;
    const diff = Math.abs(lengths[i] - expected[i]);
    if (diff > tolerance) return Infinity;
    score += diff / Math.max(1, expected[i]);
  }
  return score;
}

function finderCenterFromEnd(stateCount, end) {
  return end - stateCount[4] - stateCount[3] - stateCount[2] / 2;
}

function directCrossCheckVertical(binary, width, height, startY, centerX, maxCount, originalTotal, toleranceScale = 1) {
  const x = clamp(Math.round(centerX), 0, width - 1);
  const state = [0, 0, 0, 0, 0];
  let y = clamp(Math.round(startY), 0, height - 1);

  while (y >= 0 && binary[y * width + x]) { state[2]++; y--; }
  if (y < 0) return null;
  while (y >= 0 && !binary[y * width + x] && state[1] <= maxCount) { state[1]++; y--; }
  if (y < 0 || state[1] > maxCount) return null;
  while (y >= 0 && binary[y * width + x] && state[0] <= maxCount) { state[0]++; y--; }
  if (state[0] > maxCount) return null;

  y = clamp(Math.round(startY), 0, height - 1) + 1;
  while (y < height && binary[y * width + x]) { state[2]++; y++; }
  if (y === height) return null;
  while (y < height && !binary[y * width + x] && state[3] < maxCount) { state[3]++; y++; }
  if (y === height || state[3] >= maxCount) return null;
  while (y < height && binary[y * width + x] && state[4] < maxCount) { state[4]++; y++; }
  if (state[4] >= maxCount) return null;

  const total = state.reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - originalTotal) > originalTotal * 0.40) return null;
  const score = finderRatioScore(state, toleranceScale);
  if (!Number.isFinite(score)) return null;
  return { center: finderCenterFromEnd(state, y), moduleSize: total / 7, score };
}

function directCrossCheckHorizontal(binary, width, height, startX, centerY, maxCount, originalTotal, toleranceScale = 1) {
  const y = clamp(Math.round(centerY), 0, height - 1);
  const row = y * width;
  const state = [0, 0, 0, 0, 0];
  let x = clamp(Math.round(startX), 0, width - 1);

  while (x >= 0 && binary[row + x]) { state[2]++; x--; }
  if (x < 0) return null;
  while (x >= 0 && !binary[row + x] && state[1] <= maxCount) { state[1]++; x--; }
  if (x < 0 || state[1] > maxCount) return null;
  while (x >= 0 && binary[row + x] && state[0] <= maxCount) { state[0]++; x--; }
  if (state[0] > maxCount) return null;

  x = clamp(Math.round(startX), 0, width - 1) + 1;
  while (x < width && binary[row + x]) { state[2]++; x++; }
  if (x === width) return null;
  while (x < width && !binary[row + x] && state[3] < maxCount) { state[3]++; x++; }
  if (x === width || state[3] >= maxCount) return null;
  while (x < width && binary[row + x] && state[4] < maxCount) { state[4]++; x++; }
  if (state[4] >= maxCount) return null;

  const total = state.reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - originalTotal) > originalTotal * 0.25) return null;
  const score = finderRatioScore(state, toleranceScale);
  if (!Number.isFinite(score)) return null;
  return { center: finderCenterFromEnd(state, x), moduleSize: total / 7, score };
}

function directCrossCheckDiagonal(binary, width, height, centerX, centerY, toleranceScale = 1) {
  const cx = clamp(Math.round(centerX), 0, width - 1);
  const cy = clamp(Math.round(centerY), 0, height - 1);
  const state = [0, 0, 0, 0, 0];
  let step = 0;
  while (cx - step >= 0 && cy - step >= 0 && binary[(cy - step) * width + (cx - step)]) { state[2]++; step++; }
  if (!state[2]) return false;
  while (cx - step >= 0 && cy - step >= 0 && !binary[(cy - step) * width + (cx - step)]) { state[1]++; step++; }
  if (!state[1]) return false;
  while (cx - step >= 0 && cy - step >= 0 && binary[(cy - step) * width + (cx - step)]) { state[0]++; step++; }
  if (!state[0]) return false;

  step = 1;
  while (cx + step < width && cy + step < height && binary[(cy + step) * width + (cx + step)]) { state[2]++; step++; }
  while (cx + step < width && cy + step < height && !binary[(cy + step) * width + (cx + step)]) { state[3]++; step++; }
  if (!state[3]) return false;
  while (cx + step < width && cy + step < height && binary[(cy + step) * width + (cx + step)]) { state[4]++; step++; }
  if (!state[4]) return false;

  return Number.isFinite(finderRatioScore(state, toleranceScale * 1.35));
}

function clusterFinderCandidates(raw, minConfirmations = 2) {
  const clusters = [];
  raw.sort((a, b) => a.moduleSize - b.moduleSize);

  for (const candidate of raw) {
    let best = null;
    let bestDistance = Infinity;
    for (const cluster of clusters) {
      const moduleRatio = Math.abs(cluster.moduleSize - candidate.moduleSize) /
        Math.max(cluster.moduleSize, candidate.moduleSize);
      if (moduleRatio > 0.45) continue;
      const dx = cluster.x - candidate.x;
      const dy = cluster.y - candidate.y;
      const distance = Math.hypot(dx, dy);
      if (distance <= Math.max(cluster.moduleSize, candidate.moduleSize) * 2.25 && distance < bestDistance) {
        best = cluster;
        bestDistance = distance;
      }
    }

    if (!best) {
      clusters.push({ ...candidate, confirmations: 1 });
    } else {
      const n = best.confirmations;
      best.x = (best.x * n + candidate.x) / (n + 1);
      best.y = (best.y * n + candidate.y) / (n + 1);
      best.moduleSize = (best.moduleSize * n + candidate.moduleSize) / (n + 1);
      best.score = (best.score * n + candidate.score) / (n + 1);
      best.confirmations++;
    }
  }

  return clusters
    .filter((candidate) => candidate.confirmations >= minConfirmations)
    .sort((a, b) =>
      (b.confirmations - a.confirmations) ||
      (a.score - b.score) ||
      (b.moduleSize - a.moduleSize)
    );
}

export function detectFinderCandidates(binary, width, height, options = {}) {
  // Finder acquisition follows the same broad strategy that makes mature QR
  // readers feel immediate: scan a subset of rows for 1:1:3:1:1, then confirm
  // each hit directly across the orthogonal axes. Unlike the previous scanner,
  // this does not allocate complete run arrays for every row and column.
  const raw = [];
  const toleranceScale = options.toleranceScale ?? 1;
  const moduleSpreadLimit = options.moduleSpreadLimit ?? 0.45;
  const minConfirmations = options.minConfirmations ?? 2;
  const rowStep = Math.max(1, Math.round(options.rowStep ?? (height > 900 ? 2 : 1)));
  const diagonalCheck = options.diagonalCheck === true;
  const maxRawCandidates = Math.max(24, Math.round(options.maxRawCandidates ?? 160));

  const handlePossibleCenter = (stateCount, y, endX) => {
    const ratioScore = finderRatioScore(stateCount, toleranceScale);
    if (!Number.isFinite(ratioScore)) return false;
    const total = stateCount.reduce((sum, value) => sum + value, 0);
    const centerX = finderCenterFromEnd(stateCount, endX);
    const maxCount = Math.max(2, Math.ceil(stateCount[2] * 1.25));
    const vertical = directCrossCheckVertical(binary, width, height, y, centerX, maxCount, total, toleranceScale);
    if (!vertical) return false;
    const horizontal = directCrossCheckHorizontal(binary, width, height, centerX, vertical.center, maxCount, total, toleranceScale);
    if (!horizontal) return false;
    if (diagonalCheck && !directCrossCheckDiagonal(binary, width, height, horizontal.center, vertical.center, toleranceScale)) return false;

    const moduleSize = (total / 7 + vertical.moduleSize + horizontal.moduleSize) / 3;
    const moduleSpread = Math.max(
      Math.abs(moduleSize - total / 7),
      Math.abs(moduleSize - vertical.moduleSize),
      Math.abs(moduleSize - horizontal.moduleSize)
    ) / Math.max(0.01, moduleSize);
    if (moduleSpread > moduleSpreadLimit) return false;

    raw.push({
      x: horizontal.center,
      y: vertical.center,
      moduleSize,
      score: ratioScore + vertical.score + horizontal.score
    });
    return true;
  };

  for (let y = rowStep - 1; y < height; y += rowStep) {
    const state = [0, 0, 0, 0, 0];
    let currentState = 0;
    const row = y * width;

    for (let x = 0; x < width; x++) {
      if (binary[row + x]) {
        if ((currentState & 1) === 1) currentState++;
        state[currentState]++;
      } else {
        if ((currentState & 1) === 0) {
          if (currentState === 4) {
            handlePossibleCenter(state, y, x);
            state[0] = state[2];
            state[1] = state[3];
            state[2] = state[4];
            state[3] = 1;
            state[4] = 0;
            currentState = 3;
          } else {
            currentState++;
            state[currentState]++;
          }
        } else {
          state[currentState]++;
        }
      }
    }
    if (currentState === 4) handlePossibleCenter(state, y, width);
    if (raw.length >= maxRawCandidates) break;
  }

  return clusterFinderCandidates(raw, minConfirmations);
}

function detectFinderCandidatesByComponents(binary, width, height, options = {}) {
  const visited = new Uint8Array(width * height);
  const stack = [];
  const candidates = [];
  const minArea = Math.max(16, Math.round(options.componentMinArea ?? 20));
  const minSpan = Math.max(5, Math.round(options.componentMinSpan ?? 7));
  const maxComponents = Math.max(64, Math.round(options.componentMaxCount ?? 600));
  let componentsSeen = 0;

  const templateScore = (minX, minY, maxX, maxY) => {
    const spanX = maxX - minX + 1;
    const spanY = maxY - minY + 1;
    let matches = 0;
    let total = 0;
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const x = minX + ((c + 0.5) / 7) * spanX;
        const y = minY + ((r + 0.5) / 7) * spanY;
        const actual = sampleBinaryAt(binary, width, height, x, y);
        if (actual == null) continue;
        const expected = r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        total++;
        if (Boolean(actual) === expected) matches++;
      }
    }
    return total ? matches / total : 0;
  };

  for (let index = 0; index < binary.length; index++) {
    if (!binary[index] || visited[index]) continue;
    componentsSeen++;
    if (componentsSeen > maxComponents) break;
    visited[index] = 1;
    stack.length = 0;
    stack.push(index);
    let area = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    while (stack.length) {
      const current = stack.pop();
      const y = Math.floor(current / width);
      const x = current - y * width;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      if (x > 0) {
        const next = current - 1;
        if (binary[next] && !visited[next]) { visited[next] = 1; stack.push(next); }
      }
      if (x + 1 < width) {
        const next = current + 1;
        if (binary[next] && !visited[next]) { visited[next] = 1; stack.push(next); }
      }
      if (y > 0) {
        const next = current - width;
        if (binary[next] && !visited[next]) { visited[next] = 1; stack.push(next); }
      }
      if (y + 1 < height) {
        const next = current + width;
        if (binary[next] && !visited[next]) { visited[next] = 1; stack.push(next); }
      }
    }

    const spanX = maxX - minX + 1;
    const spanY = maxY - minY + 1;
    if (area < minArea || spanX < minSpan || spanY < minSpan) continue;
    const aspect = spanX / spanY;
    if (aspect < 0.18 || aspect > 5.5) continue;
    const density = area / (spanX * spanY);
    if (density < 0.10 || density > 0.78) continue;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    if (sampleBinaryAt(binary, width, height, centerX, centerY) !== 1) continue;
    const score = templateScore(minX, minY, maxX, maxY);
    if (score < (options.componentTemplateThreshold ?? 0.63)) continue;

    candidates.push({
      x: centerX,
      y: centerY,
      moduleSize: Math.max(0.75, Math.sqrt(area / 24)),
      score: (1 - score) * 3,
      componentScore: score,
      componentArea: area
    });
  }

  return candidates.sort((a, b) =>
    (b.componentScore - a.componentScore) ||
    (b.componentArea - a.componentArea)
  ).slice(0, Math.max(3, Math.round(options.componentMaxCandidates ?? 12)));
}

function recoverFinderSetFromTwo(binary, width, height, strongFinders, detector = {}) {
  if (strongFinders.length !== 2) return strongFinders;
  const moduleMean = (strongFinders[0].moduleSize + strongFinders[1].moduleSize) / 2;
  const loose = detectFinderCandidates(binary, width, height, {
    toleranceScale: Math.max(1.45, (detector.toleranceScale ?? 1) * 1.35),
    moduleSpreadLimit: Math.max(0.72, detector.moduleSpreadLimit ?? 0.45),
    minConfirmations: 1
  });

  const extra = loose.filter((candidate) => {
    const moduleRatio = Math.abs(candidate.moduleSize - moduleMean) / Math.max(candidate.moduleSize, moduleMean);
    if (moduleRatio > 0.62) return false;
    return strongFinders.every((known) =>
      Math.hypot(candidate.x - known.x, candidate.y - known.y) > Math.max(moduleMean, known.moduleSize) * 5
    );
  }).slice(0, 12);

  if (!extra.length) return strongFinders;
  return strongFinders.concat(extra).sort((a, b) =>
    (b.confirmations - a.confirmations) ||
    (a.score - b.score) ||
    (b.moduleSize - a.moduleSize)
  );
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

function cross(a, b) {
  return a.x * b.y - a.y * b.x;
}

export function chooseFinderTriples(candidates, maxTriples = 16, options = {}) {
  const perspectiveRecovery = options.perspectiveRecovery === true;
  const topLimit = perspectiveRecovery ? 18 : 14;
  const top = candidates.slice(0, Math.min(candidates.length, topLimit));
  const triples = [];
  const maxCornerCos = options.maxCornerCos ?? (perspectiveRecovery ? 0.84 : 0.55);
  const maxModuleSpread = options.maxFinderModuleSpread ?? (perspectiveRecovery ? 0.78 : 0.5);
  const maxLegRatio = options.maxFinderLegRatio ?? (perspectiveRecovery ? 3.6 : 2.1);
  const minLegModules = options.minFinderLegModules ?? (perspectiveRecovery ? 7.5 : 10);

  for (let a = 0; a < top.length - 2; a++) {
    for (let b = a + 1; b < top.length - 1; b++) {
      for (let c = b + 1; c < top.length; c++) {
        const points = [top[a], top[b], top[c]];
        for (let corner = 0; corner < 3; corner++) {
          const tl = points[corner];
          const other = points.filter((_, index) => index !== corner);
          let tr = other[0];
          let bl = other[1];
          let u = sub(tr, tl);
          let v = sub(bl, tl);
          let d1 = Math.hypot(u.x, u.y);
          let d2 = Math.hypot(v.x, v.y);
          if (d1 < tl.moduleSize * minLegModules || d2 < tl.moduleSize * minLegModules) continue;
          const cos = Math.abs(dot(u, v) / (d1 * d2));
          if (cos > maxCornerCos) continue;
          if (cross(u, v) < 0) {
            [tr, bl] = [bl, tr];
            u = sub(tr, tl);
            v = sub(bl, tl);
            d1 = Math.hypot(u.x, u.y);
            d2 = Math.hypot(v.x, v.y);
          }
          const moduleMean = (tl.moduleSize + tr.moduleSize + bl.moduleSize) / 3;
          const moduleSpread = Math.max(
            Math.abs(tl.moduleSize - moduleMean),
            Math.abs(tr.moduleSize - moduleMean),
            Math.abs(bl.moduleSize - moduleMean)
          ) / moduleMean;
          if (moduleSpread > maxModuleSpread) continue;
          const legRatio = Math.max(d1, d2) / Math.min(d1, d2);
          if (legRatio > maxLegRatio) continue;
          const area = Math.abs(cross(u, v));
          const confirmScore = tl.confirmations + tr.confirmations + bl.confirmations;
          const recoveryPenalty = perspectiveRecovery
            ? 1 + Math.max(0, cos - 0.55) * 7 + Math.max(0, moduleSpread - 0.5) * 5 + Math.max(0, legRatio - 2.1) * 2
            : 1;
          const score = area / ((1 + cos * 8 + moduleSpread * 5 + Math.max(0, legRatio - 1) * 2) * recoveryPenalty) + confirmScore * 100;
          triples.push({
            tl,
            tr,
            bl,
            moduleMean,
            moduleSpread,
            legRatio,
            score,
            orthogonality: 1 - cos,
            perspectiveRecovery
          });
        }
      }
    }
  }

  triples.sort((a, b) => b.score - a.score);
  return triples.slice(0, maxTriples);
}

function rayDistanceToImageBoundary(width, height, x, y, dx, dy) {
  let limit = Infinity;
  if (dx > 1e-9) limit = Math.min(limit, (width - 1 - x) / dx);
  else if (dx < -1e-9) limit = Math.min(limit, (0 - x) / dx);
  if (dy > 1e-9) limit = Math.min(limit, (height - 1 - y) / dy);
  else if (dy < -1e-9) limit = Math.min(limit, (0 - y) / dy);
  return Number.isFinite(limit) ? Math.max(0, limit) : 0;
}

function finderHalfRunDistance(binary, width, height, center, direction) {
  const length = Math.hypot(direction.x, direction.y);
  if (length < 1e-6) return NaN;
  const dx = direction.x / length;
  const dy = direction.y / length;
  const maxDistance = rayDistanceToImageBoundary(width, height, center.x, center.y, dx, dy);
  let previous = sampleBinaryAt(binary, width, height, center.x, center.y);
  if (previous !== 1) return NaN;
  let transitions = 0;
  let lastDistance = 0;
  // Half-pixel stepping keeps the measured boundary stable at small module
  // sizes without becoming expensive. A finder needs only three transitions:
  // center black -> white ring -> black ring -> outside white.
  for (let distance = 0.5; distance <= maxDistance; distance += 0.5) {
    const value = sampleBinaryAt(binary, width, height, center.x + dx * distance, center.y + dy * distance);
    if (value == null) break;
    if (value !== previous) {
      transitions++;
      previous = value;
      if (transitions === 3) return distance;
    }
    lastDistance = distance;
    if (distance > 80 && transitions === 0) break;
  }
  return transitions >= 2 ? lastDistance : NaN;
}

function directionalFinderModuleSize(binary, width, height, pattern, otherPattern) {
  const direction = { x: otherPattern.x - pattern.x, y: otherPattern.y - pattern.y };
  const forward = finderHalfRunDistance(binary, width, height, pattern, direction);
  const backward = finderHalfRunDistance(binary, width, height, pattern, { x: -direction.x, y: -direction.y });
  if (!Number.isFinite(forward) && !Number.isFinite(backward)) return NaN;
  if (!Number.isFinite(forward)) return (backward * 2) / 7;
  if (!Number.isFinite(backward)) return (forward * 2) / 7;
  return (forward + backward) / 7;
}

function moduleSizeBetweenFinders(binary, width, height, a, b) {
  const fromA = directionalFinderModuleSize(binary, width, height, a, b);
  const fromB = directionalFinderModuleSize(binary, width, height, b, a);
  if (Number.isFinite(fromA) && Number.isFinite(fromB)) return (fromA + fromB) / 2;
  if (Number.isFinite(fromA)) return fromA;
  if (Number.isFinite(fromB)) return fromB;
  return (a.moduleSize + b.moduleSize) / 2;
}

function nearestVersionFromEstimate(value, minVersion, maxVersion) {
  const candidates = [];
  for (let version = minVersion; version <= maxVersion; version++) {
    const size = sizeForVersion(version);
    candidates.push({ version, error: Math.abs(size - value) });
  }
  candidates.sort((a, b) => a.error - b.error);
  return candidates;
}

function sampleBinaryAt(binary, width, height, x, y) {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= width || iy >= height) return null;
  return binary[iy * width + ix];
}

function alignmentTemplateValue(pattern, r, c) {
  return alignmentPatternIsBlack(pattern, r, c) ? 1 : 0;
}

const ALIGNMENT_SUBCELL_PROBES = Object.freeze([
  Object.freeze([0, 0]),
  Object.freeze([-0.32, 0]),
  Object.freeze([0.32, 0]),
  Object.freeze([0, -0.32]),
  Object.freeze([0, 0.32])
]);

function alignmentScore(binary, width, height, center, basisU, basisV, scale, pattern) {
  let matches = 0;
  let total = 0;
  const radius = alignmentPatternRadius(pattern);
  for (let r = -radius; r <= radius; r++) {
    for (let c = -radius; c <= radius; c++) {
      const x = center.x + basisU.x * c * scale + basisV.x * r * scale;
      const y = center.y + basisU.y * c * scale + basisV.y * r * scale;
      const value = sampleBinaryAt(binary, width, height, x, y);
      if (value === null) continue;
      total++;
      if (value === alignmentTemplateValue(pattern, r, c)) matches++;
    }
  }
  return total ? matches / total : 0;
}

function preciseAlignmentScore(binary, width, height, center, basisU, basisV, scale, pattern) {
  let matches = 0;
  let total = 0;
  const radius = alignmentPatternRadius(pattern);
  for (let r = -radius; r <= radius; r++) {
    for (let c = -radius; c <= radius; c++) {
      const expected = alignmentTemplateValue(pattern, r, c);
      // Centre-only alignment scoring has a broad plateau: a candidate can be
      // wrong by almost half a module while every centre still lands in the
      // correct solid tile. This denser score is reserved for the slow recovery
      // path, where Triangle16 needs sub-module geometry precision.
      for (const [du, dv] of ALIGNMENT_SUBCELL_PROBES) {
        const x = center.x + basisU.x * (c + du) * scale + basisV.x * (r + dv) * scale;
        const y = center.y + basisU.y * (c + du) * scale + basisV.y * (r + dv) * scale;
        const value = sampleBinaryAt(binary, width, height, x, y);
        if (value === null) continue;
        total++;
        if (value === expected) matches++;
      }
    }
  }
  return total ? matches / total : 0;
}

// Fast 5x5 nested-eye probe used before the heavier alignment template search.
// A standard 5x5 alignment pattern has a particularly strong signature along
// its centre axes: black / white / black / white / black. We also probe the
// inner and outer diagonals so random payload modules are much less likely to
// impersonate an alignment eye. This is deliberately tiny: at most 17 binary
// samples per candidate instead of a full 25/125-sample template evaluation.
const FAST_ALIGNMENT_PROBES = Object.freeze([
  Object.freeze([0, 0, 1, 2.2]),
  Object.freeze([-1, 0, 0, 1.4]), Object.freeze([1, 0, 0, 1.4]),
  Object.freeze([0, -1, 0, 1.4]), Object.freeze([0, 1, 0, 1.4]),
  Object.freeze([-2, 0, 1, 1.2]), Object.freeze([2, 0, 1, 1.2]),
  Object.freeze([0, -2, 1, 1.2]), Object.freeze([0, 2, 1, 1.2]),
  Object.freeze([-1, -1, 0, 0.9]), Object.freeze([1, -1, 0, 0.9]),
  Object.freeze([-1, 1, 0, 0.9]), Object.freeze([1, 1, 0, 0.9]),
  Object.freeze([-2, -2, 1, 0.8]), Object.freeze([2, -2, 1, 0.8]),
  Object.freeze([-2, 2, 1, 0.8]), Object.freeze([2, 2, 1, 0.8])
]);

function fastNestedAlignmentScore(binary, width, height, center, basisU, basisV, scale) {
  let matched = 0;
  let total = 0;
  for (const [c, r, expected, weight] of FAST_ALIGNMENT_PROBES) {
    const x = center.x + basisU.x * c * scale + basisV.x * r * scale;
    const y = center.y + basisU.y * c * scale + basisV.y * r * scale;
    const value = sampleBinaryAt(binary, width, height, x, y);
    if (value === null) continue;
    total += weight;
    if (value === expected) matched += weight;
  }
  return total ? matched / total : 0;
}

function searchNestedAlignmentFast(binary, width, height, predicted, basisU, basisV, target, options = {}) {
  if (target?.size !== 5 || options.fastAlignmentLocator === false) return null;

  const inferredScale = clamp(Number(options.inferredTargetScale ?? 1), 0.5, 2.1);
  const radius = clamp(Number(options.radius ?? 5), 2.5, 18);
  const coarseStep = radius >= 14 ? 2 : radius >= 9 ? 1.5 : 1;
  const scales = [...new Set([
    Number((inferredScale * 0.78).toFixed(3)),
    Number((inferredScale * 0.90).toFixed(3)),
    Number(inferredScale.toFixed(3)),
    Number((inferredScale * 1.12).toFixed(3)),
    Number((inferredScale * 1.28).toFixed(3)),
    0.75, 1, 1.25
  ])].filter((value) => value >= 0.48 && value <= 2.1);

  const candidates = [];
  for (let offsetV = -radius; offsetV <= radius + 0.001; offsetV += coarseStep) {
    for (let offsetU = -radius; offsetU <= radius + 0.001; offsetU += coarseStep) {
      const center = {
        x: predicted.x + basisU.x * offsetU + basisV.x * offsetV,
        y: predicted.y + basisU.y * offsetU + basisV.y * offsetV
      };
      let bestScore = 0;
      let bestScale = 1;
      for (const scale of scales) {
        const score = fastNestedAlignmentScore(binary, width, height, center, basisU, basisV, scale);
        if (score > bestScore) {
          bestScore = score;
          bestScale = scale;
        }
      }
      // Keeping only plausible nested eyes makes the fine phase effectively
      // constant-time even on very dense symbols.
      if (bestScore >= (options.fastAlignmentSeedThreshold ?? 0.73)) {
        candidates.push({ score: bestScore, center, scale: bestScale, offsetU, offsetV });
      }
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  const fineSeeds = candidates.slice(0, Math.max(1, Math.round(options.fastAlignmentFineSeeds ?? 5)));
  const fineOffsets = [-0.75, -0.35, 0, 0.35, 0.75];
  let best = null;

  for (const seed of fineSeeds) {
    const fineScales = [...new Set([
      Number((seed.scale * 0.90).toFixed(3)),
      Number((seed.scale * 0.96).toFixed(3)),
      Number(seed.scale.toFixed(3)),
      Number((seed.scale * 1.05).toFixed(3)),
      Number((seed.scale * 1.12).toFixed(3))
    ])].filter((value) => value >= 0.46 && value <= 2.15);
    for (const du of fineOffsets) {
      for (const dv of fineOffsets) {
        const offsetU = seed.offsetU + du;
        const offsetV = seed.offsetV + dv;
        const center = {
          x: predicted.x + basisU.x * offsetU + basisV.x * offsetV,
          y: predicted.y + basisU.y * offsetU + basisV.y * offsetV
        };
        for (const scale of fineScales) {
          const score = alignmentScore(binary, width, height, center, basisU, basisV, scale, target);
          if (!best || score > best.score) {
            best = { score, center, scale, offsetU, offsetV, broadSearch: radius > 4, fastNested: true };
          }
        }
      }
    }
  }

  return best;
}

export function searchAlignment(binary, width, height, triple, version, options = {}) {
  const size = sizeForVersion(version);
  const separation = size - 7;
  const basisU = {
    x: (triple.tr.x - triple.tl.x) / separation,
    y: (triple.tr.y - triple.tl.y) / separation
  };
  const basisV = {
    x: (triple.bl.x - triple.tl.x) / separation,
    y: (triple.bl.y - triple.tl.y) / separation
  };
  const target = primaryAlignmentPatternForVersion(version, { profile: options.alignmentProfile ?? ALIGNMENT_PROFILE_STANDARD_5 });
  const targetX = target.col + 0.5;
  const targetY = target.row + 0.5;
  const predicted = {
    x: triple.tl.x + basisU.x * (targetX - 3.5) + basisV.x * (targetY - 3.5),
    y: triple.tl.y + basisU.y * (targetX - 3.5) + basisV.y * (targetY - 3.5)
  };

  const finderSizes = [triple.tl.moduleSize, triple.tr.moduleSize, triple.bl.moduleSize];
  const finderMin = Math.max(0.01, Math.min(...finderSizes));
  const finderMax = Math.max(...finderSizes);
  const finderScaleRatio = finderMax / finderMin;
  const inferredTargetScale = clamp(
    Math.sqrt(
      Math.max(0.2, triple.tr.moduleSize / Math.max(0.01, triple.tl.moduleSize)) *
      Math.max(0.2, triple.bl.moduleSize / Math.max(0.01, triple.tl.moduleSize))
    ),
    0.58,
    1.75
  );
  const localScales = [...new Set([
    0.72, 0.85, 1, 1.15, 1.3,
    Number(inferredTargetScale.toFixed(3)),
    Number((inferredTargetScale * 0.88).toFixed(3)),
    Number((inferredTargetScale * 1.12).toFixed(3))
  ])].filter((scale) => scale >= 0.52 && scale <= 1.9);

  const cornerSkew = Math.max(0, 1 - (triple.orthogonality ?? 1));
  const projectiveSignal = Math.max(
    Math.max(0, finderScaleRatio - 1),
    Math.max(0, (triple.moduleSpread ?? 0) * 1.25),
    cornerSkew * 0.75
  );

  // Try the nested-eye locator first. It searches a projective-sized region
  // using only a handful of binary samples per location and therefore remains
  // cheap even when the affine prediction is several modules off.
  const fastRadius = clamp(
    Number(options.fastAlignmentRadius ?? (3 + projectiveSignal * 13)),
    3,
    options.fastAlignmentMaxRadius ?? 16
  );
  const fastNested = searchNestedAlignmentFast(
    binary,
    width,
    height,
    predicted,
    basisU,
    basisV,
    target,
    {
      ...options,
      inferredTargetScale,
      radius: fastRadius
    }
  );

  const fastAccept = options.fastAlignmentAccept ?? (options.preciseAlignment ? 0.88 : 0.80);
  if (fastNested && fastNested.score >= fastAccept) {
    return {
      ...fastNested,
      basisU,
      basisV,
      predicted,
      target,
      finderScaleRatio,
      projectiveSignal
    };
  }

  const precise = options.preciseAlignment === true;
  const localScoreFn = precise ? preciseAlignmentScore : alignmentScore;
  const localOffsets = precise
    ? [-2.5, -1.5, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1.5, 2.5]
    : [-2.5, -1.5, -0.75, 0, 0.75, 1.5, 2.5];

  const centerAt = (offsetU, offsetV) => ({
    x: predicted.x + basisU.x * offsetU + basisV.x * offsetV,
    y: predicted.y + basisU.y * offsetU + basisV.y * offsetV
  });
  let best = fastNested && fastNested.score > 0
    ? fastNested
    : { score: 0, center: predicted, scale: 1, offsetU: 0, offsetV: 0, broadSearch: false };

  const evaluateIntoBest = (offsetU, offsetV, scales, scoreFn, broadSearch = false) => {
    const center = centerAt(offsetU, offsetV);
    for (const scale of scales) {
      const score = scoreFn(binary, width, height, center, basisU, basisV, scale, target);
      if (score > best.score) best = { score, center, scale, offsetU, offsetV, broadSearch };
    }
  };

  for (const ou of localOffsets) {
    for (const ov of localOffsets) evaluateIntoBest(ou, ov, localScales, localScoreFn, false);
  }

  // A three-finder affine extrapolation becomes increasingly wrong as the
  // symbol tilts away from the camera. Under strong yaw/pitch the primary
  // bottom-right alignment marker can move 8-15 modules away from the affine
  // prediction even though all three finder patterns remain strong. Use a
  // bounded coarse-to-fine search only when the locator geometry signals that
  // projective foreshortening is present.
  const broadEnabled = options.perspectiveAlignmentRecovery !== false && (
    options.perspectiveRecovery === true ||
    projectiveSignal >= (options.perspectiveAlignmentSignalThreshold ?? 0.32)
  );

  if (broadEnabled && best.score < (options.perspectiveAlignmentEarlyAccept ?? 0.78)) {
    const radius = clamp(
      Number(options.perspectiveAlignmentRadius ?? (3.5 + projectiveSignal * 17)),
      4,
      options.perspectiveAlignmentMaxRadius ?? 17
    );
    const coarseStep = radius > 12 ? 3 : radius > 8 ? 2.5 : 2;
    const coarseScales = [...new Set([
      Number((inferredTargetScale * 0.78).toFixed(3)),
      Number((inferredTargetScale * 0.92).toFixed(3)),
      Number(inferredTargetScale.toFixed(3)),
      Number((inferredTargetScale * 1.10).toFixed(3)),
      Number((inferredTargetScale * 1.28).toFixed(3)),
      0.68, 0.82, 1, 1.18, 1.38, 1.58
    ])].filter((scale) => scale >= 0.48 && scale <= 2.05);
    const coarseOffsets = [0];
    for (let offset = coarseStep; offset <= radius + 0.001; offset += coarseStep) {
      coarseOffsets.push(offset, -offset);
    }
    if (!coarseOffsets.some((value) => Math.abs(Math.abs(value) - radius) < 0.35)) {
      coarseOffsets.push(radius, -radius);
    }

    const seeds = [];
    for (const ou of coarseOffsets) {
      for (const ov of coarseOffsets) {
        if (Math.abs(ou) <= 2.75 && Math.abs(ov) <= 2.75) continue;
        const center = centerAt(ou, ov);
        let seedScore = 0;
        let seedScale = 1;
        // Keep the coarse pass cheap. Fine refinement below uses the denser
        // sub-cell alignment score to reject data-cell lookalikes.
        for (const scale of coarseScales) {
          const score = alignmentScore(binary, width, height, center, basisU, basisV, scale, target);
          if (score > seedScore) {
            seedScore = score;
            seedScale = scale;
          }
        }
        seeds.push({ score: seedScore, scale: seedScale, offsetU: ou, offsetV: ov });
      }
    }
    seeds.sort((a, b) => b.score - a.score);

    let broadBest = null;
    const fineSeeds = seeds.slice(0, options.perspectiveAlignmentFineSeeds ?? 6);
    const fineOffsets = [-1.25, -0.75, -0.4, 0, 0.4, 0.75, 1.25];
    for (const seed of fineSeeds) {
      const fineScales = [...new Set([
        Number((seed.scale * 0.86).toFixed(3)),
        Number((seed.scale * 0.94).toFixed(3)),
        Number(seed.scale.toFixed(3)),
        Number((seed.scale * 1.06).toFixed(3)),
        Number((seed.scale * 1.16).toFixed(3)),
        Number(inferredTargetScale.toFixed(3)),
        1.0, 1.15, 1.3
      ])].filter((scale) => scale >= 0.46 && scale <= 2.1);
      for (const du of fineOffsets) {
        for (const dv of fineOffsets) {
          const offsetU = seed.offsetU + du;
          const offsetV = seed.offsetV + dv;
          const center = centerAt(offsetU, offsetV);
          for (const scale of fineScales) {
            const score = preciseAlignmentScore(binary, width, height, center, basisU, basisV, scale, target);
            if (!broadBest || score > broadBest.score) {
              broadBest = { score, center, scale, offsetU, offsetV, broadSearch: true };
            }
          }
        }
      }
    }

    // The precise score probes each alignment module at several sub-cell
    // positions, making it substantially harder for random payload cells to
    // impersonate the primary reference. Prefer a strong projective candidate
    // even if the cheap centre-only local score happened to be slightly higher.
    if (broadBest && (
      broadBest.score >= (options.perspectiveAlignmentPreciseThreshold ?? 0.80) ||
      broadBest.score > best.score + 0.08
    )) {
      best = broadBest;
    }
  }

  return {
    ...best,
    basisU,
    basisV,
    predicted,
    target,
    finderScaleRatio,
    projectiveSignal
  };
}

function projectedAlignmentScore(binary, width, height, homography, pattern) {
  let matches = 0;
  let total = 0;
  const radius = alignmentPatternRadius(pattern);
  for (let r = -radius; r <= radius; r++) {
    for (let c = -radius; c <= radius; c++) {
      const point = projectPoint(homography, pattern.col + c + 0.5, pattern.row + r + 0.5);
      const value = sampleBinaryAt(binary, width, height, point.x, point.y);
      if (value === null) continue;
      total++;
      if (value === alignmentTemplateValue(pattern, r, c)) matches++;
    }
  }
  return total ? matches / total : 0;
}

function scoreAlignmentGrid(binary, width, height, homography, version, options = {}) {
  const patterns = alignmentPatternCentersForVersion(version, { profile: options.alignmentProfile ?? ALIGNMENT_PROFILE_STANDARD_5 });
  if (!patterns.length) return { score: 1, patternScores: [] };
  const patternScores = patterns.map((pattern) => ({
    row: pattern.row,
    col: pattern.col,
    size: pattern.size,
    primary: Boolean(pattern.primary),
    score: projectedAlignmentScore(binary, width, height, homography, pattern)
  }));
  const totalWeight = patternScores.reduce((sum, item) => sum + (item.primary ? 2 : 1), 0);
  const score = patternScores.reduce(
    (sum, item) => sum + item.score * (item.primary ? 2 : 1),
    0
  ) / totalWeight;
  return { score, patternScores };
}

function localProjectiveBasis(homography, moduleX, moduleY) {
  const center = projectPoint(homography, moduleX, moduleY);
  const alongU = projectPoint(homography, moduleX + 1, moduleY);
  const alongV = projectPoint(homography, moduleX, moduleY + 1);
  return {
    center,
    basisU: { x: alongU.x - center.x, y: alongU.y - center.y },
    basisV: { x: alongV.x - center.x, y: alongV.y - center.y }
  };
}

function searchProjectedAlignment(binary, width, height, homography, pattern) {
  const moduleX = pattern.col + 0.5;
  const moduleY = pattern.row + 0.5;
  const local = localProjectiveBasis(homography, moduleX, moduleY);
  const moduleScale = Math.max(
    0.5,
    (Math.hypot(local.basisU.x, local.basisU.y) + Math.hypot(local.basisV.x, local.basisV.y)) / 2
  );
  const offsets = [-1, -0.5, 0, 0.5, 1];
  const scales = [0.88, 1, 1.12];
  let best = {
    score: projectedAlignmentScore(binary, width, height, homography, pattern),
    center: local.center,
    scale: 1,
    offsetU: 0,
    offsetV: 0,
    displacementModules: 0
  };

  for (const offsetU of offsets) {
    for (const offsetV of offsets) {
      const center = {
        x: local.center.x + local.basisU.x * offsetU + local.basisV.x * offsetV,
        y: local.center.y + local.basisU.y * offsetU + local.basisV.y * offsetV
      };
      for (const scale of scales) {
        const score = alignmentScore(
          binary,
          width,
          height,
          center,
          local.basisU,
          local.basisV,
          scale,
          pattern
        );
        if (score > best.score) {
          best = {
            score,
            center,
            scale,
            offsetU,
            offsetV,
            displacementModules: Math.hypot(offsetU, offsetV),
            displacementPixels: Math.hypot(offsetU, offsetV) * moduleScale
          };
        }
      }
    }
  }

  return best;
}

function refineHomographyWithAlignmentGrid(
  binary,
  width,
  height,
  initialHomography,
  version,
  sourcePoints,
  destinationPoints,
  initialGrid,
  options = {}
) {
  const patterns = alignmentPatternCentersForVersion(version, { profile: options.alignmentProfile ?? ALIGNMENT_PROFILE_STANDARD_5 });
  if (patterns.length <= 1 || options.alignmentRefinement === false) {
    return {
      homography: initialHomography,
      grid: initialGrid,
      refined: false,
      points: []
    };
  }

  const primary = patterns.find((pattern) => pattern.primary);
  const secondaries = patterns.filter((pattern) => !pattern.primary);
  const minimumScore = options.alignmentRefinePatternThreshold ?? 0.84;
  const maxPoints = Math.max(1, Math.min(18, Math.round(options.alignmentRefineMaxPoints ?? 12)));
  const candidates = [];

  for (const pattern of secondaries) {
    const found = searchProjectedAlignment(binary, width, height, initialHomography, pattern);
    if (found.score < minimumScore) continue;
    if (found.displacementModules > (options.alignmentRefineMaxDisplacement ?? 1.45)) continue;
    candidates.push({ pattern, ...found });
  }

  if (!candidates.length) {
    return { homography: initialHomography, grid: initialGrid, refined: false, points: [] };
  }

  // Prefer confident references, but retain spatial distribution so dense
  // versions use alignment information across the entire matrix rather than
  // allowing a cluster of nearby markers to dominate the fit.
  candidates.sort((a, b) =>
    (b.score - a.score) ||
    ((b.pattern.row + b.pattern.col) - (a.pattern.row + a.pattern.col))
  );
  const selected = [];
  for (const candidate of candidates) {
    if (selected.length >= maxPoints) break;
    const tooClose = selected.some((item) =>
      Math.hypot(item.pattern.col - candidate.pattern.col, item.pattern.row - candidate.pattern.row) < 6
    );
    if (!tooClose || selected.length < 3) selected.push(candidate);
  }
  if (!selected.length) return { homography: initialHomography, grid: initialGrid, refined: false, points: [] };

  const refinedSource = sourcePoints.slice();
  const refinedDestination = destinationPoints.slice();
  const weights = [4, 4, 4, 5];
  const pointInfo = [];

  for (const candidate of selected) {
    refinedSource.push(candidate.center);
    refinedDestination.push({
      x: candidate.pattern.col + 0.5,
      y: candidate.pattern.row + 0.5
    });
    // Distributed 5x5 alignment eyes now carry stronger evidence while remaining
    // below the three primary finder patterns in the projective fit.
    weights.push(1.15 + candidate.score * 1.95);
    pointInfo.push({
      row: candidate.pattern.row,
      col: candidate.pattern.col,
      score: candidate.score,
      x: candidate.center.x,
      y: candidate.center.y,
      displacementModules: candidate.displacementModules
    });
  }

  let refinedHomography;
  try {
    refinedHomography = computeHomographyLeastSquares(refinedSource, refinedDestination, weights);
  } catch {
    return { homography: initialHomography, grid: initialGrid, refined: false, points: [] };
  }

  const refinedGrid = scoreAlignmentGrid(binary, width, height, refinedHomography, version, options);
  const primaryBefore = primary
    ? projectedAlignmentScore(binary, width, height, initialHomography, primary)
    : 1;
  const primaryAfter = primary
    ? projectedAlignmentScore(binary, width, height, refinedHomography, primary)
    : 1;
  const allowedGridDrop = options.alignmentRefineAllowedGridDrop ?? 0.006;
  const allowedPrimaryDrop = options.alignmentRefineAllowedPrimaryDrop ?? 0.04;

  if (
    refinedGrid.score + allowedGridDrop < initialGrid.score ||
    primaryAfter + allowedPrimaryDrop < primaryBefore
  ) {
    return { homography: initialHomography, grid: initialGrid, refined: false, points: [] };
  }

  return {
    homography: refinedHomography,
    grid: refinedGrid,
    refined: true,
    points: pointInfo,
    initialGridScore: initialGrid.score
  };
}

function solveLinearSystemFloat(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, index) => row.slice().concat([vector[index]]));
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-10) throw new Error("Singular homography system.");
    if (pivot !== col) [a[col], a[pivot]] = [a[pivot], a[col]];
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

export function computeHomography(sourcePoints, destinationPoints) {
  // Returns transform mapping destination -> source.
  assert(sourcePoints.length === 4 && destinationPoints.length === 4, "Four point pairs are required.");
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const u = destinationPoints[i].x;
    const v = destinationPoints[i].y;
    const x = sourcePoints[i].x;
    const y = sourcePoints[i].y;
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    b.push(y);
  }
  const h = solveLinearSystemFloat(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function computeHomographyLeastSquares(sourcePoints, destinationPoints, weights = null) {
  // Same destination -> source convention as computeHomography(), but accepts
  // more than four correspondences and averages locator/alignment measurement
  // noise. This is used only as a refinement after a valid four-point projective
  // solution already exists.
  assert(
    sourcePoints.length === destinationPoints.length && sourcePoints.length >= 4,
    "At least four matching point pairs are required."
  );

  const normal = Array.from({ length: 8 }, () => Array(8).fill(0));
  const rhs = Array(8).fill(0);

  const addEquation = (row, value, weight) => {
    for (let i = 0; i < 8; i++) {
      rhs[i] += row[i] * value * weight;
      for (let j = 0; j < 8; j++) normal[i][j] += row[i] * row[j] * weight;
    }
  };

  for (let i = 0; i < sourcePoints.length; i++) {
    const u = destinationPoints[i].x;
    const v = destinationPoints[i].y;
    const x = sourcePoints[i].x;
    const y = sourcePoints[i].y;
    const weight = Math.max(0.05, Number(weights?.[i] ?? 1));
    addEquation([u, v, 1, 0, 0, 0, -u * x, -v * x], x, weight);
    addEquation([0, 0, 0, u, v, 1, -u * y, -v * y], y, weight);
  }

  // Tiny Tikhonov regularisation keeps near-degenerate noisy fits numerically
  // stable without moving a normal QR-sized solution in any meaningful way.
  for (let i = 0; i < 8; i++) normal[i][i] += 1e-9;
  const h = solveLinearSystemFloat(normal, rhs);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

export function projectPoint(h, u, v) {
  const denominator = h[6] * u + h[7] * v + h[8];
  return {
    x: (h[0] * u + h[1] * v + h[2]) / denominator,
    y: (h[3] * u + h[4] * v + h[5]) / denominator
  };
}

function geometryCandidatesFromBinary(binary, width, height, finders, threshold, options = {}) {
  if (finders.length < 3) return [];
  const minVersion = options.minVersion ?? 1;
  const maxVersion = options.maxVersion ?? 40;
  const maxCandidates = options.maxCandidates ?? 8;
  const triples = chooseFinderTriples(finders, options.perspectiveRecovery ? 30 : 20, options);
  const geometries = [];

  for (const triple of triples) {
    const legH = Math.hypot(triple.tr.x - triple.tl.x, triple.tr.y - triple.tl.y);
    const legV = Math.hypot(triple.bl.x - triple.tl.x, triple.bl.y - triple.tl.y);
    const moduleH = moduleSizeBetweenFinders(binary, width, height, triple.tl, triple.tr);
    const moduleV = moduleSizeBetweenFinders(binary, width, height, triple.tl, triple.bl);
    const estimatedSizeH = legH / Math.max(0.5, moduleH) + 7;
    const estimatedSizeV = legV / Math.max(0.5, moduleV) + 7;
    const estimateSpread = Math.abs(estimatedSizeH - estimatedSizeV);
    const fallbackEstimate = ((legH + legV) / 2) / triple.moduleMean + 7;
    const estimatedSize = Number.isFinite(estimatedSizeH) && Number.isFinite(estimatedSizeV)
      ? (estimatedSizeH + estimatedSizeV) / 2
      : fallbackEstimate;
    // Wrong finder triples often produce wildly different horizontal/vertical
    // module counts. Reject only the most implausible sets here; full projective
    // recovery remains intentionally permissive for real extreme camera angles.
    const maxEstimateSpread = options.maxDimensionEstimateSpread ?? (options.perspectiveRecovery ? 18 : 10);
    if (estimateSpread > maxEstimateSpread) continue;
    const versions = nearestVersionFromEstimate(estimatedSize, minVersion, maxVersion).slice(0, Math.max(1, Math.round(options.versionSearchLimit ?? 9)));

    for (const item of versions) {
      const version = item.version;
      const size = sizeForVersion(version);

      // Near-front-facing symbols do not need to wait for a fourth locator.
      // With three reliable finder centres we already have an affine mapping.
      // Validate that cheap mapping against the distributed 5x5 alignment grid;
      // when it agrees strongly, return it immediately and let payload decoding
      // provide the final integrity check. Strongly projective symbols skip this
      // shortcut and continue into the full alignment/homography path below.
      const affineProjectiveSignal = Math.max(
        Math.max(0, triple.moduleSpread ?? 0),
        Math.max(0, 1 - (triple.orthogonality ?? 1)) * 0.85,
        Math.max(0, (triple.legRatio ?? 1) - 1) * 0.12
      );
      const allowAffineFastPath = options.finderAffineFastPath !== false &&
        options.preciseAlignment !== true &&
        options.perspectiveRecovery !== true &&
        item.error <= (options.finderAffineVersionError ?? 2.6) &&
        affineProjectiveSignal <= (options.finderAffineMaxProjectiveSignal ?? 0.24);

      if (allowAffineFastPath) {
        const separation = size - 7;
        const basisU = {
          x: (triple.tr.x - triple.tl.x) / separation,
          y: (triple.tr.y - triple.tl.y) / separation
        };
        const basisV = {
          x: (triple.bl.x - triple.tl.x) / separation,
          y: (triple.bl.y - triple.tl.y) / separation
        };
        const target = primaryAlignmentPatternForVersion(version, {
          profile: options.alignmentProfile ?? ALIGNMENT_PROFILE_STANDARD_5
        });
        const targetX = target.col + 0.5;
        const targetY = target.row + 0.5;
        const predictedAlignment = {
          x: triple.tl.x + basisU.x * (targetX - 3.5) + basisV.x * (targetY - 3.5),
          y: triple.tl.y + basisU.y * (targetX - 3.5) + basisV.y * (targetY - 3.5)
        };
        const affineDest = [
          { x: 3.5, y: 3.5 },
          { x: size - 3.5, y: 3.5 },
          { x: 3.5, y: size - 3.5 },
          { x: targetX, y: targetY }
        ];
        const affineSrc = [
          { x: triple.tl.x, y: triple.tl.y },
          { x: triple.tr.x, y: triple.tr.y },
          { x: triple.bl.x, y: triple.bl.y },
          predictedAlignment
        ];
        try {
          const affineHomography = computeHomography(affineSrc, affineDest);
          const affineGrid = scoreAlignmentGrid(binary, width, height, affineHomography, version, options);
          if (affineGrid.score >= (options.finderAffineGridThreshold ?? 0.84)) {
            const versionPenalty = item.error / 4;
            geometries.push({
              version,
              size,
              sourcePoints: affineSrc,
              destinationPoints: affineDest,
              homography: affineHomography,
              finders: { topLeft: triple.tl, topRight: triple.tr, bottomLeft: triple.bl },
              alignment: {
                center: predictedAlignment,
                predicted: predictedAlignment,
                score: affineGrid.score,
                scale: 1,
                target: { row: target.row, col: target.col },
                patterns: affineGrid.patternScores.length,
                gridScore: affineGrid.score,
                initialGridScore: affineGrid.score,
                refined: false,
                refinementPoints: [],
                patternScores: affineGrid.patternScores,
                method: "finder-affine"
              },
              threshold,
              finderMethod: `${options.finderMethod ?? "finder"}-affine`,
              alignmentProfile: options.alignmentProfile ?? ALIGNMENT_PROFILE_STANDARD_5,
              estimatedSize,
              estimatedSizeH,
              estimatedSizeV,
              directionalModuleSizeH: moduleH,
              directionalModuleSizeV: moduleV,
              score: triple.score * (0.58 + 0.42 * affineGrid.score) / (1 + versionPenalty * 0.08),
              finderAffineFastPath: true
            });
            continue;
          }
        } catch {
          // Full alignment search below remains the authoritative path.
        }
      }

      const alignment = searchAlignment(binary, width, height, triple, version, options);
      if (alignment.score < (options.alignmentThreshold ?? 0.72)) continue;

      const alignmentTarget = alignment.target;
      const dest = [
        { x: 3.5, y: 3.5 },
        { x: size - 3.5, y: 3.5 },
        { x: 3.5, y: size - 3.5 },
        { x: alignmentTarget.col + 0.5, y: alignmentTarget.row + 0.5 }
      ];
      const src = [
        { x: triple.tl.x, y: triple.tl.y },
        { x: triple.tr.x, y: triple.tr.y },
        { x: triple.bl.x, y: triple.bl.y },
        alignment.center
      ];

      let homography;
      try {
        homography = computeHomography(src, dest);
      } catch {
        continue;
      }

      const initialAlignmentGrid = scoreAlignmentGrid(binary, width, height, homography, version, options);
      const alignmentGridThreshold = options.alignmentGridThreshold ?? 0.68;
      const refinementFloor = Math.max(0, alignmentGridThreshold - (options.alignmentRefineCandidateMargin ?? 0.10));
      const skipRefinementScore = options.alignmentRefineSkipScore ?? 0.985;
      const refinement = (
        initialAlignmentGrid.score >= refinementFloor &&
        initialAlignmentGrid.score < skipRefinementScore
      )
        ? refineHomographyWithAlignmentGrid(
            binary,
            width,
            height,
            homography,
            version,
            src,
            dest,
            initialAlignmentGrid,
            options
          )
        : {
            homography,
            grid: initialAlignmentGrid,
            refined: false,
            points: []
          };
      homography = refinement.homography;
      const alignmentGrid = refinement.grid;
      if (alignmentGrid.score < alignmentGridThreshold) continue;

      const versionPenalty = item.error / 4;
      const alignmentConfidence = 0.55 * alignment.score + 0.45 * alignmentGrid.score;
      const score = triple.score * (0.5 + 0.5 * alignmentConfidence) / (1 + versionPenalty * 0.08);
      geometries.push({
        version,
        size,
        sourcePoints: src,
        destinationPoints: dest,
        homography,
        finders: { topLeft: triple.tl, topRight: triple.tr, bottomLeft: triple.bl },
        alignment: {
          center: alignment.center,
          score: alignment.score,
          scale: alignment.scale,
          target: { row: alignmentTarget.row, col: alignmentTarget.col },
          patterns: alignmentGrid.patternScores.length,
          gridScore: alignmentGrid.score,
          initialGridScore: refinement.initialGridScore ?? initialAlignmentGrid.score,
          refined: refinement.refined,
          refinementPoints: refinement.points,
          patternScores: alignmentGrid.patternScores
        },
        threshold,
        finderMethod: options.finderMethod,
        alignmentProfile: options.alignmentProfile ?? ALIGNMENT_PROFILE_STANDARD_5,
        estimatedSize,
        estimatedSizeH,
        estimatedSizeV,
        directionalModuleSizeH: moduleH,
        directionalModuleSizeV: moduleV,
        score
      });
    }
  }

  const deduped = [];
  geometries.sort((a, b) => b.score - a.score);
  for (const geometry of geometries) {
    const duplicate = deduped.some((other) =>
      other.version === geometry.version &&
      Math.hypot(
        other.sourcePoints[0].x - geometry.sourcePoints[0].x,
        other.sourcePoints[0].y - geometry.sourcePoints[0].y
      ) < Math.max(3, geometry.finders.topLeft.moduleSize * 2)
    );
    if (!duplicate) deduped.push(geometry);
    if (deduped.length >= maxCandidates) break;
  }
  return deduped;
}

function pushFinderDiagnostic(options, finderMethod, threshold, finders, geometries) {
  if (!options.diagnostics || typeof options.diagnostics !== "object") return;
  const passes = Array.isArray(options.diagnostics.passes)
    ? options.diagnostics.passes
    : (options.diagnostics.passes = []);
  passes.push({
    label: options.diagnosticLabel ?? "perspective",
    finderMethod,
    width: options.width,
    height: options.height,
    threshold,
    finderCount: finders.length,
    finders: finders.map((finder) => ({
      x: finder.x,
      y: finder.y,
      moduleSize: finder.moduleSize,
      confirmations: finder.confirmations,
      score: finder.score
    })),
    geometries: geometries.map((geometry) => ({
      version: geometry.version,
      size: geometry.size,
      score: geometry.score,
      estimatedSize: geometry.estimatedSize,
      alignmentScore: geometry.alignment.score,
      alignmentGridScore: geometry.alignment.gridScore,
      finderMethod: geometry.finderMethod,
      alignmentProfile: geometry.alignmentProfile,
      finders: {
        topLeft: { ...geometry.finders.topLeft },
        topRight: { ...geometry.finders.topRight },
        bottomLeft: { ...geometry.finders.bottomLeft }
      },
      alignmentCenter: { ...geometry.alignment.center },
      sourcePoints: geometry.sourcePoints.map((point) => ({ ...point }))
    }))
  });
}

export function detectCodeGeometry(imageData, options = {}) {
  assert(imageData?.data && imageData.width && imageData.height, "Valid image data is required.");
  const width = imageData.width;
  const height = imageData.height;
  const maxCandidates = options.maxCandidates ?? 8;

  const evaluatePass = (pass, recovery = false) => {
    const detector = pass.detector ?? {};
    const finders = detectFinderCandidates(pass.binary, width, height, detector);
    const geometryOptions = {
      ...options,
      finderMethod: pass.finderMethod,
      perspectiveRecovery: recovery || options.perspectiveRecovery === true,
      alignmentThreshold: recovery ? 0.68 : 0.72,
      alignmentGridThreshold: recovery ? 0.64 : 0.68,
      versionSearchLimit: recovery
        ? (options.recoveryVersionSearchLimit ?? 9)
        : (options.fastVersionSearchLimit ?? 4)
    };
    let geometries = geometryCandidatesFromBinary(
      pass.binary,
      width,
      height,
      finders,
      pass.threshold,
      { ...geometryOptions, alignmentProfile: ALIGNMENT_PROFILE_STANDARD_5 }
    );

    // New format-v6 symbols use 5x5 alignment eyes. Only if that geometry does
    // not validate do we spend a compatibility attempt on format-v5's compact
    // 3x3 secondary markers. This keeps the modern path fast.
    if (!geometries.length && options.legacyAlignmentRecovery !== false && finders.length >= 3) {
      const legacyMethod = `${pass.finderMethod}-legacy-align`;
      const legacyOptions = {
        ...geometryOptions,
        finderMethod: legacyMethod,
        alignmentProfile: ALIGNMENT_PROFILE_LEGACY_3
      };
      geometries = geometryCandidatesFromBinary(
        pass.binary,
        width,
        height,
        finders,
        pass.threshold,
        legacyOptions
      );
      if (geometries.length) {
        pushFinderDiagnostic(
          { ...options, width, height, diagnosticLabel: `${options.diagnosticLabel ?? "normal"}-legacy-align` },
          legacyMethod,
          pass.threshold,
          finders,
          geometries
        );
      }
    }

    pushFinderDiagnostic(
      { ...options, width, height },
      pass.finderMethod,
      pass.threshold,
      finders,
      geometries
    );

    // Dense codes under projective distortion can leave two finder patterns
    // perfectly strong while the third is stretched enough to miss the normal
    // 1:1:3:1:1 tolerance. Only in that very specific recovery state, run one
    // bounded looser detector and let the normal three-finder geometry checks
    // reject false data-cell lookalikes. The clean fast path is unchanged.
    if (!geometries.length && recovery && finders.length === 2) {
      const recoveredFinders = recoverFinderSetFromTwo(pass.binary, width, height, finders, detector);
      if (recoveredFinders.length > 2) {
        const finderMethod = `${pass.finderMethod}-two-finder-recovery`;
        geometries = geometryCandidatesFromBinary(
          pass.binary,
          width,
          height,
          recoveredFinders,
          pass.threshold,
          { ...geometryOptions, finderMethod }
        );
        pushFinderDiagnostic(
          { ...options, width, height, diagnosticLabel: `${options.diagnosticLabel ?? "perspective"}-two-finder` },
          finderMethod,
          pass.threshold,
          recoveredFinders,
          geometries
        );
        if (geometries.length) return { finders: recoveredFinders, geometries };
      }
    }

    return { finders, geometries };
  };

  // Fast path stays exactly one grayscale + finder pass. No QuadQR Auto Color, extra
  // thresholding, or luminance image is computed when a normal frame works.
  const valueInfo = buildBinary(imageData, { grayMode: "value" });
  const fast = evaluatePass({
    finderMethod: "rgb-value-otsu",
    binary: valueInfo.binary,
    threshold: valueInfo.threshold,
    detector: {
      toleranceScale: options.finderToleranceScale ?? 1.0,
      moduleSpreadLimit: options.finderModuleSpreadLimit ?? 0.45,
      minConfirmations: options.finderMinConfirmations ?? 2,
      diagonalCheck: false
    }
  }, false);
  const fastEstimateMatched = fast.geometries.some((geometry) =>
    Math.abs(sizeForVersion(geometry.version) - geometry.estimatedSize) <= (options.fastDimensionAcceptance ?? 2.0)
  );
  if (fast.geometries.length && fastEstimateMatched) {
    return fast.geometries.slice(0, maxCandidates);
  }

  // Seeing three finder patterns should immediately unlock perspective-aware
  // geometry. The previous first pass used stricter near-front-facing triple
  // limits, so a code could visibly have all three eyes yet still fall through
  // into color recovery. Reuse the exact same binary/finders with broader
  // projective geometry before doing any additional pixel processing.
  if (fast.finders.length >= 3) {
    const finderMethod = "rgb-value-otsu-projective";
    const projectiveGeometries = geometryCandidatesFromBinary(
      valueInfo.binary,
      width,
      height,
      fast.finders,
      valueInfo.threshold,
      {
        ...options,
        finderMethod,
        perspectiveRecovery: true,
        alignmentThreshold: 0.60,
        alignmentGridThreshold: 0.58,
        versionSearchLimit: options.fastPerspectiveVersionSearchLimit ?? 4,
        perspectiveAlignmentFineSeeds: options.fastPerspectiveAlignmentFineSeeds ?? 3,
        perspectiveAlignmentMaxRadius: options.fastPerspectiveAlignmentMaxRadius ?? 12
      }
    );
    pushFinderDiagnostic(
      { ...options, width, height, diagnosticLabel: `${options.diagnosticLabel ?? "normal"}-projective` },
      finderMethod,
      valueInfo.threshold,
      fast.finders,
      projectiveGeometries
    );
    if (projectiveGeometries.length) return projectiveGeometries.slice(0, maxCandidates);
  }

  // Keep the original strict geometry as a fallback if the projective pass did
  // not produce anything better. This preserves historical behavior while
  // avoiding an early wrong-version lock-in when the directional size estimate
  // clearly points at another version.
  if (fast.geometries.length) return fast.geometries.slice(0, maxCandidates);

  // A local block threshold is part of the normal locator path, not the heavy
  // color/damage recovery stack. It is especially effective when one finder is
  // under a shadow or a phone-screen gradient while the other two are bright.
  // At camera locator resolution this costs far less than escalating to a
  // high-resolution scan or running full-frame Auto Color.
  let localBinary = null;
  if (options.localFinderThreshold !== false && fast.finders.length < 3) {
    localBinary = hybridLocalBinary(valueInfo.gray, width, height);
    if (localBinary) {
      const local = evaluatePass({
        finderMethod: "rgb-value-hybrid-local",
        binary: localBinary,
        threshold: null,
        detector: {
          toleranceScale: 1.10,
          moduleSpreadLimit: 0.58,
          diagonalCheck: false
        }
      }, true);
      if (local.geometries.length) return local.geometries.slice(0, maxCandidates);
    }
  }

  if (options.componentFinderFallback !== false && fast.finders.length < 3) {
    for (const [binary, method] of [
      [valueInfo.binary, "rgb-value-component"],
      [localBinary, "rgb-value-hybrid-component"]
    ]) {
      if (!binary) continue;
      const componentFinders = detectFinderCandidatesByComponents(binary, width, height, options);
      const merged = clusterFinderCandidates([
        ...fast.finders.map((finder) => ({ ...finder })),
        ...componentFinders
      ], 1);
      if (merged.length < 3) continue;
      const componentGeometries = geometryCandidatesFromBinary(
        binary,
        width,
        height,
        merged,
        method.includes("hybrid") ? null : valueInfo.threshold,
        {
          ...options,
          finderMethod: method,
          perspectiveRecovery: true,
          alignmentThreshold: 0.60,
          alignmentGridThreshold: 0.58,
          versionSearchLimit: options.fastPerspectiveVersionSearchLimit ?? 4,
          perspectiveAlignmentFineSeeds: options.fastPerspectiveAlignmentFineSeeds ?? 3,
          perspectiveAlignmentMaxRadius: options.fastPerspectiveAlignmentMaxRadius ?? 12
        }
      );
      pushFinderDiagnostic(
        { ...options, width, height, diagnosticLabel: `${options.diagnosticLabel ?? "normal"}-component` },
        method,
        method.includes("hybrid") ? null : valueInfo.threshold,
        merged,
        componentGeometries
      );
      if (componentGeometries.length) return componentGeometries.slice(0, maxCandidates);
    }
  }

  if (options.finderRecovery === false) return [];

  // If the clean threshold already found exactly two strong locators, try the
  // bounded perspective-tolerant third-finder pass before any color processing.
  // This is substantially cheaper than QuadQR Auto Color and targets the dense-code
  // projective failure mode directly.
  if (fast.finders.length === 2) {
    const recoveredFinders = recoverFinderSetFromTwo(valueInfo.binary, width, height, fast.finders, {});
    if (recoveredFinders.length > 2) {
      const finderMethod = "rgb-value-otsu-two-finder-recovery";
      const recoveredGeometries = geometryCandidatesFromBinary(
        valueInfo.binary,
        width,
        height,
        recoveredFinders,
        valueInfo.threshold,
        {
          ...options,
          finderMethod,
          alignmentThreshold: 0.68,
          alignmentGridThreshold: 0.64
        }
      );
      pushFinderDiagnostic(
        { ...options, width, height, diagnosticLabel: `${options.diagnosticLabel ?? "perspective"}-two-finder` },
        finderMethod,
        valueInfo.threshold,
        recoveredFinders,
        recoveredGeometries
      );
      if (recoveredGeometries.length) return recoveredGeometries.slice(0, maxCandidates);
    }
  }

  // Camera recovery #1: QuadQR Auto Color per-channel levels before
  // finder thresholding. Live camera frames are usually much larger than the
  // QR itself, so a single global histogram can be dominated by dark room/UI
  // pixels around the guide. QuadQR keeps recovery deliberately code-centric
  // by using center-weighted analysis windows so surrounding scene pixels do not
  // dominate the correction, while still applying
  // each correction to the full frame so finder coordinates never move.
  const requestedInsets = Array.isArray(options.finderAutoColorAnalysisInsets)
    ? options.finderAutoColorAnalysisInsets
    : (Number.isFinite(options.finderAutoColorAnalysisInset)
      ? [options.finderAutoColorAnalysisInset]
      : [0.10, 0.20, 0.04]);
  const autoColorInsets = [];
  for (const value of requestedInsets) {
    const inset = clamp(Number(value), 0, 0.30);
    if (!autoColorInsets.some((item) => Math.abs(item - inset) < 0.001)) autoColorInsets.push(inset);
  }

  for (const analysisInset of autoColorInsets) {
    try {
      const autoColorGray = buildAutoColorValueGray(imageData, {
        blackClip: options.finderAutoColorBlackClip ?? 0.0001,
        whiteClip: options.finderAutoColorWhiteClip,
        highlightPercentile: options.finderAutoColorHighlightPercentile ?? 0.95,
        outputHighlight: options.finderAutoColorOutputHighlight ?? 190,
        analysisInset,
        minimumInputRange: options.finderAutoColorMinimumInputRange ?? 72,
        targetSamples: options.finderAutoColorTargetSamples
      });
      const base = otsuThreshold(autoColorGray);
      const insetLabel = String(Math.round(analysisInset * 100)).padStart(2, "0");
      const thresholds = [
        { suffix: "otsu", value: base },
        { suffix: "high", value: clamp(base + 12, 8, 247) }
      ];
      for (const thresholdInfo of thresholds) {
        const autoColor = evaluatePass({
          finderMethod: `auto-color-center${insetLabel}-${thresholdInfo.suffix}`,
          binary: binaryAtThreshold(autoColorGray, thresholdInfo.value),
          threshold: thresholdInfo.value,
          detector: { toleranceScale: 1.22, moduleSpreadLimit: 0.60 }
        }, true);
        if (autoColor.geometries.length) return autoColor.geometries.slice(0, maxCandidates);
      }
    } catch {
      // Try the next center weighting, then continue with raw threshold bracketing.
    }
  }

  // Camera recovery #2: bracket the raw value-channel threshold, then retain
  // the legacy luminance pass for unusual captures. These are only built after
  // both the normal and QuadQR Auto Color finder passes fail.
  const highThreshold = clamp(valueInfo.baseThreshold + 18, 8, 247);
  const lowThreshold = clamp(valueInfo.baseThreshold - 14, 8, 247);
  const recoveryPasses = [];
  if (highThreshold !== valueInfo.threshold) {
    recoveryPasses.push({
      finderMethod: "rgb-value-high-threshold",
      binary: binaryAtThreshold(valueInfo.gray, highThreshold),
      threshold: highThreshold,
      detector: { toleranceScale: 1.18, moduleSpreadLimit: 0.56 }
    });
  }
  if (lowThreshold !== valueInfo.threshold) {
    recoveryPasses.push({
      finderMethod: "rgb-value-low-threshold",
      binary: binaryAtThreshold(valueInfo.gray, lowThreshold),
      threshold: lowThreshold,
      detector: { toleranceScale: 1.14, moduleSpreadLimit: 0.54 }
    });
  }
  const lumaInfo = buildBinary(imageData, { grayMode: "luminance" });
  recoveryPasses.push({
    finderMethod: "luminance-otsu",
    binary: lumaInfo.binary,
    threshold: lumaInfo.threshold,
    detector: { toleranceScale: 1.10, moduleSpreadLimit: 0.52 }
  });

  for (const pass of recoveryPasses) {
    const recovery = evaluatePass(pass, true);
    if (recovery.geometries.length) return recovery.geometries.slice(0, maxCandidates);
  }

  return [];
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function robustRgb(values) {
  if (!values.length) throw new Error("No RGB samples available.");
  return {
    r: median(values.map((rgb) => rgb.r)),
    g: median(values.map((rgb) => rgb.g)),
    b: median(values.map((rgb) => rgb.b))
  };
}

function averageProjectedSample(imageData, homography, moduleX, moduleY, radius = 0.16) {
  const offsets = radius > 0
    ? [[0, 0], [-radius, 0], [radius, 0], [0, -radius], [0, radius]]
    : [[0, 0]];
  const values = [];
  for (const [dx, dy] of offsets) {
    const point = projectPoint(homography, moduleX + dx, moduleY + dy);
    if (point.x < 0 || point.y < 0 || point.x >= imageData.width || point.y >= imageData.height) continue;
    values.push(bilinearRgb(imageData, point.x, point.y));
  }
  if (!values.length) return { r: 255, g: 255, b: 255 };
  return averageRgb(values);
}

function robustProjectedSample(imageData, homography, moduleX, moduleY, radius = 0.12) {
  // Fallback for dirty/soft-focus camera frames. A compact 3x3 patch stays
  // away from module edges and median aggregation rejects glare/speckles.
  const offsets = radius > 0 ? [-radius, 0, radius] : [0];
  const values = [];
  for (const dy of offsets) {
    for (const dx of offsets) {
      const point = projectPoint(homography, moduleX + dx, moduleY + dy);
      if (point.x < 0 || point.y < 0 || point.x >= imageData.width || point.y >= imageData.height) continue;
      values.push(bilinearRgb(imageData, point.x, point.y));
    }
  }
  return values.length ? robustRgb(values) : { r: 255, g: 255, b: 255 };
}



function histogramPercentile(histogram, total, fraction) {
  if (!total) return 0;
  const target = Math.max(1, Math.ceil(total * clamp(fraction, 0, 1)));
  let seen = 0;
  for (let i = 0; i < histogram.length; i++) {
    seen += histogram[i];
    if (seen >= target) return i;
  }
  return histogram.length - 1;
}


function buildAutoColorLevels(imageData, options = {}) {
  const analysisInset = clamp(options.analysisInset ?? 0, 0, 0.30);
  const x0 = Math.floor(imageData.width * analysisInset);
  const y0 = Math.floor(imageData.height * analysisInset);
  const x1 = Math.max(x0 + 1, Math.ceil(imageData.width * (1 - analysisInset)));
  const y1 = Math.max(y0 + 1, Math.ceil(imageData.height * (1 - analysisInset)));
  const analysisWidth = Math.max(1, x1 - x0);
  const analysisHeight = Math.max(1, y1 - y0);
  const pixelCount = analysisWidth * analysisHeight;
  const targetSamples = Math.max(4000, Math.round(options.targetSamples ?? 90000));
  const step = Math.max(1, Math.floor(pixelCount / targetSamples));
  const histograms = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let samples = 0;

  // Camera recovery deliberately supports analysing only the central part of
  // the visible frame. A phone preview often contains very dark UI/screen
  // edges outside the code; letting those pixels define the black point makes
  // an otherwise useful QuadQR Auto Color pass far too weak.
  for (let index = 0; index < pixelCount; index += step) {
    const x = x0 + (index % analysisWidth);
    const y = y0 + Math.floor(index / analysisWidth);
    const p = (y * imageData.width + x) * 4;
    const a = imageData.data[p + 3] / 255;
    const rgb = [
      imageData.data[p] * a + 255 * (1 - a),
      imageData.data[p + 1] * a + 255 * (1 - a),
      imageData.data[p + 2] * a + 255 * (1 - a)
    ];
    for (let channel = 0; channel < 3; channel++) {
      histograms[channel][clamp(Math.round(rgb[channel]), 0, 255)]++;
    }
    samples++;
  }

  const blackClip = clamp(options.blackClip ?? 0.004, 0, 0.06);
  const whiteClip = clamp(options.whiteClip ?? 0.004, 0, 0.06);
  const lows = histograms.map((histogram) => histogramPercentile(histogram, samples, blackClip));

  let references;
  let highs;
  const outputHighlight = Number(options.outputHighlight);
  if (Number.isFinite(outputHighlight)) {
    // Strong QuadQR camera color-recovery mode. QuadQR Auto Color does not
    // stretch the brightest observed paper/white
    // cells all the way to 255. Instead it anchors the per-channel shadow
    // points close to black while keeping the observed highlight around a
    // neutral mid-high value. That produces much darker structural black and
    // much stronger RGB separation without washing the whole code out.
    const highlightPercentile = clamp(options.highlightPercentile ?? 0.95, 0.70, 0.9999);
    const target = clamp(outputHighlight, 96, 250);
    references = histograms.map((histogram) => histogramPercentile(histogram, samples, highlightPercentile));
    const minimumInputRange = Math.max(32, Math.round(options.minimumInputRange ?? 72));
    highs = references.map((reference, channel) => {
      const observedRange = Math.max(minimumInputRange, reference - lows[channel]);
      return lows[channel] + observedRange * 255 / target;
    });
  } else {
    references = histograms.map((histogram) => histogramPercentile(histogram, samples, 1 - whiteClip));
    highs = references.slice();
    for (let channel = 0; channel < 3; channel++) {
      highs[channel] = Math.max(lows[channel] + 24, highs[channel]);
    }
  }

  const mapChannel = (value, channel) => clamp(
    (value - lows[channel]) * 255 / Math.max(1, highs[channel] - lows[channel]),
    0,
    255
  );

  return { lows, highs, references, mapChannel };
}

export function autoColorImageData(imageData, options = {}) {
  const levels = buildAutoColorLevels(imageData, options);
  const pixelCount = imageData.width * imageData.height;
  const data = new Uint8ClampedArray(imageData.data.length);
  for (let index = 0; index < pixelCount; index++) {
    const p = index * 4;
    const a = imageData.data[p + 3] / 255;
    const r = imageData.data[p] * a + 255 * (1 - a);
    const g = imageData.data[p + 1] * a + 255 * (1 - a);
    const b = imageData.data[p + 2] * a + 255 * (1 - a);
    data[p] = levels.mapChannel(r, 0);
    data[p + 1] = levels.mapChannel(g, 1);
    data[p + 2] = levels.mapChannel(b, 2);
    data[p + 3] = 255;
  }
  return { width: imageData.width, height: imageData.height, data };
}

function buildAutoColorValueGray(imageData, options = {}) {
  const canCache = imageData && typeof imageData === "object" && options.cache !== false;
  const cacheKey = [
    options.blackClip ?? 0.0001,
    options.whiteClip ?? "default",
    options.highlightPercentile ?? 0.95,
    options.outputHighlight ?? 190,
    options.analysisInset ?? 0,
    options.minimumInputRange ?? 72,
    options.targetSamples ?? "default"
  ].join(":");
  if (canCache) {
    const cached = autoColorGrayCache.get(imageData)?.get(cacheKey);
    if (cached) return cached;
  }

  const levels = buildAutoColorLevels(imageData, options);
  const gray = new Uint8Array(imageData.width * imageData.height);
  for (let i = 0; i < gray.length; i++) {
    const p = i * 4;
    const a = imageData.data[p + 3] / 255;
    const r = imageData.data[p] * a + 255 * (1 - a);
    const g = imageData.data[p + 1] * a + 255 * (1 - a);
    const b = imageData.data[p + 2] * a + 255 * (1 - a);
    gray[i] = Math.round(Math.max(
      levels.mapChannel(r, 0),
      levels.mapChannel(g, 1),
      levels.mapChannel(b, 2)
    ));
  }
  if (canCache) {
    let entries = autoColorGrayCache.get(imageData);
    if (!entries) autoColorGrayCache.set(imageData, entries = new Map());
    entries.set(cacheKey, gray);
  }
  return gray;
}

function buildAutoToneContrastColorTransform(samples, options = {}) {
  if (!samples?.length) return (rgb) => rgb;
  const blackClip = clamp(options.blackClip ?? 0.006, 0, 0.08);
  const whiteClip = clamp(options.whiteClip ?? 0.004, 0, 0.08);
  const highlightFraction = clamp(options.highlightFraction ?? 0.14, 0.04, 0.35);
  const saturation = clamp(options.saturation ?? 1.12, 1, 1.5);

  // QuadQR Auto Color-style neutralization: use the brightest portion of the frame as
  // a likely white reference. This is especially effective on warm/yellow
  // phone-camera frames where the blue channel is suppressed.
  const luminanceHistogram = new Uint32Array(256);
  for (const rgb of samples) {
    const y = clamp(Math.round(luminance(rgb)), 0, 255);
    luminanceHistogram[y]++;
  }
  const highlightThreshold = histogramPercentile(
    luminanceHistogram,
    samples.length,
    1 - highlightFraction
  );
  let highlightR = 0;
  let highlightG = 0;
  let highlightB = 0;
  let highlightCount = 0;
  for (const rgb of samples) {
    if (luminance(rgb) < highlightThreshold) continue;
    highlightR += rgb.r;
    highlightG += rgb.g;
    highlightB += rgb.b;
    highlightCount++;
  }
  const highlightMean = highlightCount
    ? { r: highlightR / highlightCount, g: highlightG / highlightCount, b: highlightB / highlightCount }
    : { r: 255, g: 255, b: 255 };
  const neutralTarget = (highlightMean.r + highlightMean.g + highlightMean.b) / 3;
  const gains = {
    r: clamp(neutralTarget / Math.max(24, highlightMean.r), 0.72, 1.42),
    g: clamp(neutralTarget / Math.max(24, highlightMean.g), 0.72, 1.42),
    b: clamp(neutralTarget / Math.max(24, highlightMean.b), 0.72, 1.42)
  };

  // Auto Tone-style per-channel levels after the neutralization above.
  const histograms = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (const rgb of samples) {
    const corrected = [rgb.r * gains.r, rgb.g * gains.g, rgb.b * gains.b];
    for (let channel = 0; channel < 3; channel++) {
      histograms[channel][clamp(Math.round(corrected[channel]), 0, 255)]++;
    }
  }
  const lows = histograms.map((histogram) => histogramPercentile(histogram, samples.length, blackClip));
  const highs = histograms.map((histogram) => histogramPercentile(histogram, samples.length, 1 - whiteClip));
  for (let channel = 0; channel < 3; channel++) {
    highs[channel] = Math.max(lows[channel] + 20, highs[channel]);
  }

  const tone = (value, channel) => clamp(
    (value * [gains.r, gains.g, gains.b][channel] - lows[channel]) * 255 / (highs[channel] - lows[channel]),
    0,
    255
  );

  // Auto Contrast-style common tonal expansion is calculated after the
  // per-channel levels so it does not undo white-balance correction.
  const toneLuminanceHistogram = new Uint32Array(256);
  for (const rgb of samples) {
    const corrected = { r: tone(rgb.r, 0), g: tone(rgb.g, 1), b: tone(rgb.b, 2) };
    toneLuminanceHistogram[clamp(Math.round(luminance(corrected)), 0, 255)]++;
  }
  const contrastLow = histogramPercentile(toneLuminanceHistogram, samples.length, blackClip);
  const contrastHigh = Math.max(
    contrastLow + 28,
    histogramPercentile(toneLuminanceHistogram, samples.length, 1 - whiteClip)
  );
  const contrast = (value) => clamp((value - contrastLow) * 255 / (contrastHigh - contrastLow), 0, 255);

  return (rgb) => {
    let r = contrast(tone(rgb.r, 0));
    let g = contrast(tone(rgb.g, 1));
    let b = contrast(tone(rgb.b, 2));

    // A small saturation recovery restores separation lost to lens haze and
    // bilinear camera scaling. It is intentionally conservative because this
    // path runs only after the normal scanner has failed.
    const y = luminance({ r, g, b });
    r = clamp(y + (r - y) * saturation, 0, 255);
    g = clamp(y + (g - y) * saturation, 0, 255);
    b = clamp(y + (b - y) * saturation, 0, 255);
    return { r, g, b };
  };
}

export function autoToneContrastColorRgbGrid(rgbGrid, options = {}) {
  const samples = [];
  for (const row of rgbGrid) for (const rgb of row) samples.push(rgb);
  const transform = buildAutoToneContrastColorTransform(samples, options);
  return rgbGrid.map((row) => row.map((rgb) => transform(rgb)));
}

export function autoToneContrastColorImageData(imageData, options = {}) {
  const pixelCount = imageData.width * imageData.height;
  const targetSamples = Math.max(8000, Math.round(options.targetSamples ?? 160000));
  const step = Math.max(1, Math.floor(pixelCount / targetSamples));
  const samples = [];
  for (let index = 0; index < pixelCount; index += step) {
    const p = index * 4;
    const a = imageData.data[p + 3] / 255;
    samples.push({
      r: imageData.data[p] * a + 255 * (1 - a),
      g: imageData.data[p + 1] * a + 255 * (1 - a),
      b: imageData.data[p + 2] * a + 255 * (1 - a)
    });
  }

  const transform = buildAutoToneContrastColorTransform(samples, options);
  const data = new Uint8ClampedArray(imageData.data.length);
  for (let index = 0; index < pixelCount; index++) {
    const p = index * 4;
    const a = imageData.data[p + 3] / 255;
    const corrected = transform({
      r: imageData.data[p] * a + 255 * (1 - a),
      g: imageData.data[p + 1] * a + 255 * (1 - a),
      b: imageData.data[p + 2] * a + 255 * (1 - a)
    });
    data[p] = corrected.r;
    data[p + 1] = corrected.g;
    data[p + 2] = corrected.b;
    data[p + 3] = 255;
  }
  return { width: imageData.width, height: imageData.height, data };
}

export function samplePerspectiveMatrix(imageData, homography, size, options = {}) {
  const rgbGrid = Array.from({ length: size }, () => new Array(size));
  const mode = options.sampleMode ?? "cross";
  const radius = options.sampleRadius ?? (mode === "median" ? 0.12 : 0.16);
  const offsetX = Number.isFinite(options.sampleOffsetX) ? options.sampleOffsetX : 0;
  const offsetY = Number.isFinite(options.sampleOffsetY) ? options.sampleOffsetY : 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const moduleX = c + 0.5 + offsetX;
      const moduleY = r + 0.5 + offsetY;
      rgbGrid[r][c] = mode === "median"
        ? robustProjectedSample(imageData, homography, moduleX, moduleY, radius)
        : averageProjectedSample(imageData, homography, moduleX, moduleY, radius);
    }
  }
  return { rgbGrid };
}

/**
 * Sample the two protected regions of every Triangle16 module.
 *
 * Triangle16 uses a fixed "/" diagonal. Samples are intentionally placed well
 * inside the upper-left and lower-right triangles, away from the diagonal and
 * module borders. This makes the decoder much less sensitive to antialiasing,
 * blur, resampling and small homography errors than center sampling.
 */
function rgbSampleSpread(values, center) {
  if (!values.length) return 0;
  return values.reduce((sum, rgb) => sum + Math.hypot(
    rgb.r - center.r,
    rgb.g - center.g,
    rgb.b - center.b
  ), 0) / values.length;
}

export function samplePerspectiveTriangleMatrix(imageData, homography, size, options = {}) {
  const triangleGrid = Array.from({ length: size }, () => new Array(size));
  const mode = options.sampleMode ?? "cross";
  const radius = options.highDensitySampleRadius ?? options.triangleSampleRadius ??
    (mode === "median" ? 0.055 : 0.065);
  const inset = Math.max(0.18, Math.min(0.34, Number(options.highDensitySampleInset ?? options.triangleSampleInset ?? 0.27)));
  const offsetX = Number.isFinite(options.sampleOffsetX) ? options.sampleOffsetX : 0;
  const offsetY = Number.isFinite(options.sampleOffsetY) ? options.sampleOffsetY : 0;
  const sampler = mode === "median" ? robustProjectedSample : averageProjectedSample;
  const side = Math.max(0.18, inset - 0.06);
  const middle = Math.min(0.52, 0.50 - inset * 0.04);
  const firstAnchors = [
    [inset, inset],
    [side, middle],
    [middle, side]
  ];
  const secondAnchors = firstAnchors.map(([x, y]) => [1 - x, 1 - y]);

  const sampleRegion = (c, r, anchors) => {
    const values = anchors.map(([x, y]) => sampler(
      imageData,
      homography,
      c + x + offsetX,
      r + y + offsetY,
      radius
    ));
    const rgb = robustRgb(values);
    return { rgb, spread: rgbSampleSpread(values, rgb) };
  };

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const first = sampleRegion(c, r, firstAnchors);
      const second = sampleRegion(c, r, secondAnchors);
      triangleGrid[r][c] = {
        first: first.rgb,
        second: second.rgb,
        firstSpread: first.spread,
        secondSpread: second.spread
      };
    }
  }
  return { triangleGrid };
}

function meanRgb(values) {
  if (!values.length) throw new Error("No calibration samples available.");
  return values.reduce(
    (sum, rgb) => ({ r: sum.r + rgb.r, g: sum.g + rgb.g, b: sum.b + rgb.b }),
    { r: 0, g: 0, b: 0 }
  );
}

function averageRgb(values) {
  const sum = meanRgb(values);
  return { r: sum.r / values.length, g: sum.g / values.length, b: sum.b / values.length };
}

function pickCalibrationSamples(rgbGrid, positions, limit = 24) {
  if (!positions?.length) return [];
  const step = Math.max(1, Math.floor(positions.length / limit));
  const out = [];
  for (let i = 0; i < positions.length; i += step) {
    const [row, col] = positions[i];
    out.push(rgbGrid[row][col]);
    if (out.length >= limit) break;
  }
  return out;
}

export function sampleObservedPalette(rgbGrid, calibration, options = {}) {
  const aggregate = options.robust ? robustRgb : averageRgb;
  const palette = {
    black: aggregate(pickCalibrationSamples(rgbGrid, calibration.black, 36)),
    white: aggregate(pickCalibrationSamples(rgbGrid, calibration.white, 36)),
    red: aggregate(pickCalibrationSamples(rgbGrid, calibration.red, 12)),
    green: aggregate(pickCalibrationSamples(rgbGrid, calibration.green, 12)),
    blue: aggregate(pickCalibrationSamples(rgbGrid, calibration.blue, 12))
  };

  // All five observed classes must remain separated enough for reliable RGBW
  // classification: structural black plus the four visible data states.
  const colors = [palette.black, palette.red, palette.green, palette.blue, palette.white];
  const distances = [];
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      distances.push(Math.hypot(
        colors[i].r - colors[j].r,
        colors[i].g - colors[j].g,
        colors[i].b - colors[j].b
      ));
    }
  }
  if (Math.min(...distances) < 28) throw new Error("RGBW calibration references are not separable in this image.");
  return palette;
}

function calibrationReferencePoints(rgbGrid, positions, limit = 64) {
  if (!positions?.length) return [];
  const step = Math.max(1, Math.floor(positions.length / limit));
  const refs = [];
  for (let i = 0; i < positions.length; i += step) {
    const [row, col] = positions[i];
    refs.push({ row, col, rgb: rgbGrid[row][col] });
    if (refs.length >= limit) break;
  }
  return refs;
}

function estimateLocalReference(refs, row, col) {
  if (!refs.length) return { r: 0, g: 0, b: 0 };
  let wr = 0;
  let wg = 0;
  let wb = 0;
  let total = 0;
  for (const ref of refs) {
    const dr = row - ref.row;
    const dc = col - ref.col;
    const distanceSq = dr * dr + dc * dc;
    if (distanceSq < 1e-9) return ref.rgb;
    // Smooth inverse-distance weighting. The +4 prevents one slightly blurred
    // structural cell from dominating the local estimate.
    const weight = 1 / (distanceSq + 4);
    wr += ref.rgb.r * weight;
    wg += ref.rgb.g * weight;
    wb += ref.rgb.b * weight;
    total += weight;
  }
  return {
    r: wr / total,
    g: wg / total,
    b: wb / total
  };
}

export function spatiallyNormalizeRgbGrid(rgbGrid, calibration, options = {}) {
  const size = rgbGrid.length;
  const limit = options.referenceLimit ?? 64;
  const blackRefs = calibrationReferencePoints(rgbGrid, calibration.black, limit);
  const whiteRefs = calibrationReferencePoints(rgbGrid, calibration.white, limit);
  if (!blackRefs.length || !whiteRefs.length) throw new Error("Black/white references are required for spatial color normalization.");

  const normalized = Array.from({ length: size }, () => new Array(size));
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const rgb = rgbGrid[row][col];
      const black = estimateLocalReference(blackRefs, row, col);
      const white = estimateLocalReference(whiteRefs, row, col);
      const normalizeChannel = (value, low, high) => {
        const range = Math.max(28, high - low);
        return clamp((value - low) * 255 / range, -96, 384);
      };
      normalized[row][col] = {
        r: normalizeChannel(rgb.r, black.r, white.r),
        g: normalizeChannel(rgb.g, black.g, white.g),
        b: normalizeChannel(rgb.b, black.b, white.b)
      };
    }
  }
  return normalized;
}

export function rectifyImageData(imageData, homography, size, moduleSize = 8) {
  const outputSize = Math.max(1, Math.round(size * moduleSize));
  const data = new Uint8ClampedArray(outputSize * outputSize * 4);
  for (let y = 0; y < outputSize; y++) {
    for (let x = 0; x < outputSize; x++) {
      const moduleX = (x + 0.5) / moduleSize;
      const moduleY = (y + 0.5) / moduleSize;
      const source = projectPoint(homography, moduleX, moduleY);
      const rgb = bilinearRgb(imageData, source.x, source.y);
      const p = (y * outputSize + x) * 4;
      data[p] = clamp(Math.round(rgb.r), 0, 255);
      data[p + 1] = clamp(Math.round(rgb.g), 0, 255);
      data[p + 2] = clamp(Math.round(rgb.b), 0, 255);
      data[p + 3] = 255;
    }
  }
  return { width: outputSize, height: outputSize, data };
}

export function findActiveBounds(imageData, whiteThreshold = 238) {
  const { width, height, data } = imageData;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = data[i + 3];
      const active = a > 16 && (data[i] < whiteThreshold || data[i + 1] < whiteThreshold || data[i + 2] < whiteThreshold);
      if (!active) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) throw new Error("No code-like non-white area found.");
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function sampleAverageAxis(imageData, centerX, centerY, radius) {
  const { width, height, data } = imageData;
  const minX = Math.max(0, Math.floor(centerX - radius));
  const maxX = Math.min(width - 1, Math.ceil(centerX + radius));
  const minY = Math.max(0, Math.floor(centerY - radius));
  const maxY = Math.min(height - 1, Math.ceil(centerY + radius));
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const i = (y * width + x) * 4;
      const a = data[i + 3] / 255;
      r += data[i] * a + 255 * (1 - a);
      g += data[i + 1] * a + 255 * (1 - a);
      b += data[i + 2] * a + 255 * (1 - a);
      count++;
    }
  }
  return count ? { r: r / count, g: g / count, b: b / count } : { r: 255, g: 255, b: 255 };
}

export function sampleAxisAlignedGrid(imageData, bounds, size, radiusRatio = 0.18) {
  const moduleW = bounds.width / size;
  const moduleH = bounds.height / size;
  const radius = Math.max(0, Math.min(moduleW, moduleH) * radiusRatio);
  const rgbGrid = Array.from({ length: size }, () => new Array(size));
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const x = bounds.x + (c + 0.5) * moduleW;
      const y = bounds.y + (r + 0.5) * moduleH;
      rgbGrid[r][c] = sampleAverageAxis(imageData, x, y, radius);
    }
  }
  return { rgbGrid, moduleWidth: moduleW, moduleHeight: moduleH };
}

export function sampleAxisAlignedTriangleGrid(imageData, bounds, size, radiusRatio = 0.065, insetRatio = 0.27) {
  const moduleW = bounds.width / size;
  const moduleH = bounds.height / size;
  const inset = Math.max(0.18, Math.min(0.34, insetRatio));
  const radius = Math.max(0, Math.min(moduleW, moduleH) * radiusRatio);
  const triangleGrid = Array.from({ length: size }, () => new Array(size));
  const side = Math.max(0.18, inset - 0.06);
  const middle = Math.min(0.52, 0.50 - inset * 0.04);
  const firstAnchors = [[inset, inset], [side, middle], [middle, side]];
  const secondAnchors = firstAnchors.map(([x, y]) => [1 - x, 1 - y]);

  const sampleRegion = (r, c, anchors) => {
    const values = anchors.map(([x, y]) => sampleAverageAxis(
      imageData,
      bounds.x + (c + x) * moduleW,
      bounds.y + (r + y) * moduleH,
      radius
    ));
    const rgb = robustRgb(values);
    return { rgb, spread: rgbSampleSpread(values, rgb) };
  };

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const first = sampleRegion(r, c, firstAnchors);
      const second = sampleRegion(r, c, secondAnchors);
      triangleGrid[r][c] = {
        first: first.rgb,
        second: second.rgb,
        firstSpread: first.spread,
        secondSpread: second.spread
      };
    }
  }
  return { triangleGrid, moduleWidth: moduleW, moduleHeight: moduleH };
}

export const visionInternals = Object.freeze({
  buildGray,
  otsuThreshold,
  buildBinary,
  finderRatioScore,
  detectFinderCandidates,
  chooseFinderTriples,
  searchAlignment,
  bilinearRgb,
  luminance
});
