import {
  alignmentPatternCentersForVersion,
  alignmentPatternIsBlack,
  alignmentPatternRadius,
  primaryAlignmentPatternForVersion,
  sizeForVersion
} from "./geometry.js";

/**
 * Image geometry and sampling helpers for QuadQR.
 * Pure JavaScript. No DOM dependency except callers may pass browser ImageData.
 */

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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

function buildGray(imageData) {
  const gray = new Uint8Array(imageData.width * imageData.height);
  for (let i = 0; i < gray.length; i++) {
    const p = i * 4;
    const a = imageData.data[p + 3] / 255;
    const r = imageData.data[p] * a + 255 * (1 - a);
    const g = imageData.data[p + 1] * a + 255 * (1 - a);
    const b = imageData.data[p + 2] * a + 255 * (1 - a);
    gray[i] = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
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

function buildBinary(imageData) {
  const gray = buildGray(imageData);
  const threshold = otsuThreshold(gray);
  const binary = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) binary[i] = gray[i] <= threshold ? 1 : 0;
  return { gray, binary, threshold };
}

function runsForRow(binary, width, row) {
  const runs = [];
  let color = binary[row * width];
  let start = 0;
  for (let x = 1; x < width; x++) {
    const next = binary[row * width + x];
    if (next !== color) {
      runs.push({ color, start, length: x - start });
      color = next;
      start = x;
    }
  }
  runs.push({ color, start, length: width - start });
  return runs;
}

function runsForColumn(binary, width, height, col) {
  const runs = [];
  let color = binary[col];
  let start = 0;
  for (let y = 1; y < height; y++) {
    const next = binary[y * width + col];
    if (next !== color) {
      runs.push({ color, start, length: y - start });
      color = next;
      start = y;
    }
  }
  runs.push({ color, start, length: height - start });
  return runs;
}

function finderRatioScore(lengths) {
  const total = lengths.reduce((sum, value) => sum + value, 0);
  if (total < 7) return Infinity;
  const module = total / 7;
  const expected = [module, module, 3 * module, module, module];
  let score = 0;
  for (let i = 0; i < 5; i++) {
    const tolerance = i === 2 ? module * 1.25 : module * 0.8;
    const diff = Math.abs(lengths[i] - expected[i]);
    if (diff > tolerance) return Infinity;
    score += diff / Math.max(1, expected[i]);
  }
  return score;
}

function findWindowContainingCoordinate(runs, coordinate) {
  for (let i = 2; i < runs.length - 2; i++) {
    const centerRun = runs[i];
    if (centerRun.color !== 1) continue;
    if (coordinate < centerRun.start || coordinate >= centerRun.start + centerRun.length) continue;
    const window = runs.slice(i - 2, i + 3);
    if (window.map((run) => run.color).join("") !== "10101") continue;
    const score = finderRatioScore(window.map((run) => run.length));
    if (!Number.isFinite(score)) continue;
    const first = window[0].start;
    const total = window.reduce((sum, run) => sum + run.length, 0);
    return {
      center: first + total / 2,
      moduleSize: total / 7,
      score
    };
  }
  return null;
}

function crossCheckVertical(binary, width, height, x, y) {
  const col = clamp(Math.round(x), 0, width - 1);
  return findWindowContainingCoordinate(runsForColumn(binary, width, height, col), y);
}

function crossCheckHorizontal(binary, width, height, x, y) {
  const row = clamp(Math.round(y), 0, height - 1);
  return findWindowContainingCoordinate(runsForRow(binary, width, row), x);
}

function clusterFinderCandidates(raw) {
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
    .filter((candidate) => candidate.confirmations >= 2)
    .sort((a, b) =>
      (b.confirmations - a.confirmations) ||
      (a.score - b.score) ||
      (b.moduleSize - a.moduleSize)
    );
}

function detectFinderCandidates(binary, width, height) {
  const raw = [];
  const rowStep = height > 1200 ? 2 : 1;

  for (let y = 0; y < height; y += rowStep) {
    const runs = runsForRow(binary, width, y);
    for (let i = 0; i <= runs.length - 5; i++) {
      const window = runs.slice(i, i + 5);
      if (window.map((run) => run.color).join("") !== "10101") continue;
      const lengths = window.map((run) => run.length);
      const ratioScore = finderRatioScore(lengths);
      if (!Number.isFinite(ratioScore)) continue;
      const total = lengths.reduce((sum, value) => sum + value, 0);
      const centerX = window[0].start + total / 2;
      const vertical = crossCheckVertical(binary, width, height, centerX, y);
      if (!vertical) continue;
      const horizontal = crossCheckHorizontal(binary, width, height, centerX, vertical.center);
      if (!horizontal) continue;

      const moduleSize = (total / 7 + vertical.moduleSize + horizontal.moduleSize) / 3;
      const moduleSpread = Math.max(
        Math.abs(moduleSize - total / 7),
        Math.abs(moduleSize - vertical.moduleSize),
        Math.abs(moduleSize - horizontal.moduleSize)
      ) / moduleSize;
      if (moduleSpread > 0.45) continue;

      raw.push({
        x: horizontal.center,
        y: vertical.center,
        moduleSize,
        score: ratioScore + vertical.score + horizontal.score
      });
    }
  }

  return clusterFinderCandidates(raw);
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

function chooseFinderTriples(candidates, maxTriples = 16) {
  const top = candidates.slice(0, Math.min(candidates.length, 14));
  const triples = [];

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
          if (d1 < tl.moduleSize * 10 || d2 < tl.moduleSize * 10) continue;
          const cos = Math.abs(dot(u, v) / (d1 * d2));
          if (cos > 0.55) continue;
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
          if (moduleSpread > 0.5) continue;
          const legRatio = Math.max(d1, d2) / Math.min(d1, d2);
          if (legRatio > 2.1) continue;
          const area = Math.abs(cross(u, v));
          const confirmScore = tl.confirmations + tr.confirmations + bl.confirmations;
          const score = area / (1 + cos * 8 + moduleSpread * 5 + Math.max(0, legRatio - 1) * 2) + confirmScore * 100;
          triples.push({ tl, tr, bl, moduleMean, score, orthogonality: 1 - cos });
        }
      }
    }
  }

  triples.sort((a, b) => b.score - a.score);
  return triples.slice(0, maxTriples);
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

function searchAlignment(binary, width, height, triple, version) {
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
  const target = primaryAlignmentPatternForVersion(version);
  const targetX = target.col + 0.5;
  const targetY = target.row + 0.5;
  const predicted = {
    x: triple.tl.x + basisU.x * (targetX - 3.5) + basisV.x * (targetY - 3.5),
    y: triple.tl.y + basisU.y * (targetX - 3.5) + basisV.y * (targetY - 3.5)
  };

  let best = { score: 0, center: predicted, scale: 1 };
  const offsets = [-2.5, -1.5, -0.75, 0, 0.75, 1.5, 2.5];
  const scales = [0.72, 0.85, 1, 1.15, 1.3];

  for (const ou of offsets) {
    for (const ov of offsets) {
      const center = {
        x: predicted.x + basisU.x * ou + basisV.x * ov,
        y: predicted.y + basisU.y * ou + basisV.y * ov
      };
      for (const scale of scales) {
        const score = alignmentScore(binary, width, height, center, basisU, basisV, scale, target);
        if (score > best.score) best = { score, center, scale };
      }
    }
  }

  return { ...best, basisU, basisV, predicted, target };
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

function scoreAlignmentGrid(binary, width, height, homography, version) {
  const patterns = alignmentPatternCentersForVersion(version);
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

export function projectPoint(h, u, v) {
  const denominator = h[6] * u + h[7] * v + h[8];
  return {
    x: (h[0] * u + h[1] * v + h[2]) / denominator,
    y: (h[3] * u + h[4] * v + h[5]) / denominator
  };
}

export function detectCodeGeometry(imageData, options = {}) {
  assert(imageData?.data && imageData.width && imageData.height, "Valid image data is required.");
  const minVersion = options.minVersion ?? 1;
  const maxVersion = options.maxVersion ?? 40;
  const maxCandidates = options.maxCandidates ?? 8;
  const { binary, threshold } = buildBinary(imageData);
  const finders = detectFinderCandidates(binary, imageData.width, imageData.height);
  if (finders.length < 3) return [];

  const triples = chooseFinderTriples(finders, 20);
  const geometries = [];

  for (const triple of triples) {
    const legH = Math.hypot(triple.tr.x - triple.tl.x, triple.tr.y - triple.tl.y);
    const legV = Math.hypot(triple.bl.x - triple.tl.x, triple.bl.y - triple.tl.y);
    const estimatedSize = ((legH + legV) / 2) / triple.moduleMean + 7;
    const versions = nearestVersionFromEstimate(estimatedSize, minVersion, maxVersion).slice(0, 9);

    for (const item of versions) {
      const version = item.version;
      const size = sizeForVersion(version);
      const alignment = searchAlignment(binary, imageData.width, imageData.height, triple, version);
      if (alignment.score < 0.72) continue;

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

      const alignmentGrid = scoreAlignmentGrid(binary, imageData.width, imageData.height, homography, version);
      if (alignmentGrid.score < 0.68) continue;

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
          patternScores: alignmentGrid.patternScores
        },
        threshold,
        estimatedSize,
        score
      });
    }
  }

  // Deduplicate roughly identical geometry/version hypotheses.
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
