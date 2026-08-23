/**
 * Benchmark helpers for QuadQR.
 *
 * Standard QR capacities below are ISO QR byte-mode payload capacities for
 * versions 1..40. They are used only for same-matrix-size capacity comparison.
 * The QuadQR ECC profile letters are convenience names and are NOT
 * calibrated to the same recovery percentages as ISO QR L/M/Q/H.
 */

import {
  encodeBytes,
  decodeMatrix,
  getVersionInfo,
  compressPayload,
  MAX_VERSION
} from "./quadqr.js";

export const STANDARD_QR_BYTE_CAPACITY = Object.freeze({
  L: Object.freeze([17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367, 425, 458, 520, 586, 644, 718, 792, 858, 929, 1003, 1091, 1171, 1273, 1367, 1465, 1528, 1628, 1732, 1840, 1952, 2068, 2188, 2303, 2431, 2563, 2699, 2809, 2953]),
  M: Object.freeze([14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624, 666, 711, 779, 857, 911, 997, 1059, 1125, 1190, 1264, 1370, 1452, 1538, 1628, 1722, 1809, 1911, 1989, 2099, 2213, 2331]),
  Q: Object.freeze([11, 20, 32, 46, 60, 74, 86, 108, 130, 151, 177, 203, 241, 258, 292, 322, 364, 394, 442, 482, 509, 565, 611, 661, 715, 751, 805, 868, 908, 982, 1030, 1112, 1168, 1228, 1283, 1351, 1423, 1499, 1579, 1663]),
  H: Object.freeze([7, 14, 24, 34, 44, 58, 64, 84, 98, 119, 137, 155, 177, 194, 220, 250, 280, 310, 338, 382, 403, 439, 461, 511, 535, 593, 625, 658, 698, 742, 790, 842, 898, 958, 983, 1051, 1093, 1139, 1219, 1273])
});

function normalizeEcc(ecc = "M") {
  const value = String(ecc).toUpperCase();
  if (!STANDARD_QR_BYTE_CAPACITY[value]) {
    throw new Error("ECC must be one of L, M, Q, H.");
  }
  return value;
}

function nowMs() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function makePayload(length, seed = 0x51) {
  const out = new Uint8Array(length);
  let state = (seed ^ length) >>> 0;
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[i] = state & 0xff;
  }
  return out;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

function summarize(samples) {
  if (!samples.length) return { meanMs: 0, medianMs: 0, p95Ms: 0, minMs: 0, maxMs: 0 };
  const total = samples.reduce((sum, value) => sum + value, 0);
  const sorted = samples.slice().sort((a, b) => a - b);
  return {
    meanMs: total / samples.length,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1]
  };
}

export function getStandardQrByteCapacity(version, ecc = "M") {
  if (!Number.isInteger(version) || version < 1 || version > MAX_VERSION) {
    throw new Error(`Version must be 1..${MAX_VERSION}.`);
  }
  return STANDARD_QR_BYTE_CAPACITY[normalizeEcc(ecc)][version - 1];
}

export function compareCapacity(version, ecc = "M") {
  const level = normalizeEcc(ecc);
  const quadqr = getVersionInfo(version, { ecc: level });
  const standardQrBytes = getStandardQrByteCapacity(version, level);
  const quadqrBytes = quadqr.capacityBytes;
  const differenceBytes = quadqrBytes - standardQrBytes;
  const ratio = standardQrBytes > 0 ? quadqrBytes / standardQrBytes : null;
  const gainPercent = standardQrBytes > 0 ? (differenceBytes / standardQrBytes) * 100 : null;

  return {
    version,
    size: quadqr.size,
    ecc: level,
    quadqrBytes,
    standardQrBytes,
    differenceBytes,
    ratio,
    gainPercent,
    quadqrBitsPerDataCell: quadqr.bitsPerDataCell,
    quadqrPayloadEfficiencyPercent: quadqr.theoreticalBits > 0
      ? (quadqrBytes * 8 / quadqr.theoreticalBits) * 100
      : 0,
    quadqrPayloadBitsPerMatrixCell: quadqrBytes * 8 / (quadqr.size * quadqr.size),
    standardQrPayloadBitsPerMatrixCell: standardQrBytes * 8 / (quadqr.size * quadqr.size),
    note: "ECC profile letters are nominal only; recovery strength is not equivalent to ISO QR."
  };
}


/** Calculate the smallest QuadQR and standard QR versions for a payload size. */
export function calculateCapacityPlan(options = {}) {
  const ecc = normalizeEcc(options.ecc ?? "M");
  let sourceBytes;
  const hasConcretePayload = options.payload instanceof Uint8Array || typeof options.payload === "string";
  if (options.payload instanceof Uint8Array) sourceBytes = options.payload;
  else if (typeof options.payload === "string") sourceBytes = new TextEncoder().encode(options.payload);
  else sourceBytes = new Uint8Array(Math.max(0, Math.floor(options.payloadBytes ?? 0)));

  const requestedCompression = options.compression ?? "none";
  const signed = Boolean(options.signed);
  const keyIdBytes = options.keyId ? new TextEncoder().encode(String(options.keyId)).length : 0;
  const envelopeHeaderBytes = 16;
  const signingBytes = signed ? 64 + keyIdBytes + (options.embedPublicKey ? 32 : 0) : 0;
  let compression = requestedCompression;
  let storedBytes = sourceBytes.length;
  let compressed = false;

  if (requestedCompression !== "none" && hasConcretePayload) {
    const candidate = compressPayload(sourceBytes);
    if (requestedCompression === "lz" || candidate.length < sourceBytes.length - 2) {
      storedBytes = candidate.length;
      compressed = true;
      compression = "lz";
    } else {
      compression = "none";
    }
  } else if (requestedCompression !== "none" && !hasConcretePayload) {
    compression = "unknown";
  }

  const needsEnvelope = signed || compressed || requestedCompression === "lz";
  const encodedBytes = storedBytes + (needsEnvelope ? envelopeHeaderBytes + signingBytes : 0);
  const extensionOverheadBytes = encodedBytes - storedBytes;

  let quadqrVersion = null;
  let quadqrInfo = null;
  for (let version = 1; version <= MAX_VERSION; version++) {
    const info = getVersionInfo(version, { ecc });
    if (encodedBytes <= info.capacityBytes) {
      quadqrVersion = version;
      quadqrInfo = info;
      break;
    }
  }

  const standard = STANDARD_QR_BYTE_CAPACITY[ecc];
  let standardQrVersion = null;
  for (let version = 1; version <= MAX_VERSION; version++) {
    if (sourceBytes.length <= standard[version - 1]) {
      standardQrVersion = version;
      break;
    }
  }

  return {
    ecc,
    sourceBytes: sourceBytes.length,
    encodedBytes,
    storedBytes,
    extensionOverheadBytes,
    compression,
    compressed,
    signed,
    quadqrVersion,
    quadqrSize: quadqrInfo?.size ?? null,
    quadqrCapacityBytes: quadqrInfo?.capacityBytes ?? null,
    remainingBytes: quadqrInfo ? quadqrInfo.capacityBytes - encodedBytes : null,
    utilizationPercent: quadqrInfo ? encodedBytes / quadqrInfo.capacityBytes * 100 : null,
    standardQrVersion,
    standardQrSize: standardQrVersion ? 21 + 4 * (standardQrVersion - 1) : null,
    matrixWidthSavingsPercent: quadqrInfo && standardQrVersion
      ? (1 - quadqrInfo.size / (21 + 4 * (standardQrVersion - 1))) * 100
      : null,
    note: "Compression is measured only when concrete payload bytes are provided. Byte-count-only estimates cannot predict compression gain."
  };
}

export function buildCapacityComparison(options = {}) {
  const ecc = normalizeEcc(options.ecc ?? "M");
  const versions = options.versions ?? Array.from({ length: MAX_VERSION }, (_, i) => i + 1);
  return versions.map((version) => compareCapacity(version, ecc));
}

export function benchmarkCodec(options = {}) {
  const ecc = normalizeEcc(options.ecc ?? "M");
  const iterations = Math.max(1, Math.floor(options.iterations ?? 30));
  const warmup = Math.max(0, Math.floor(options.warmup ?? Math.min(5, iterations)));
  const requestedSizes = options.payloadSizes ?? [24, 32, 128, 512, 1024, 2048];
  const results = [];

  for (const requestedSize of requestedSizes) {
    const payloadBytes = Math.max(0, Math.floor(requestedSize));
    const payload = makePayload(payloadBytes);

    let probe;
    try {
      probe = encodeBytes(payload, { ecc });
    } catch (error) {
      results.push({ payloadBytes, skipped: true, reason: error.message });
      continue;
    }

    for (let i = 0; i < warmup; i++) {
      const encoded = encodeBytes(payload, { ecc, version: probe.version });
      decodeMatrix(encoded.matrix);
    }

    const encodeSamples = [];
    const decodeSamples = [];
    let encoded = probe;

    for (let i = 0; i < iterations; i++) {
      let start = nowMs();
      encoded = encodeBytes(payload, { ecc, version: probe.version });
      encodeSamples.push(nowMs() - start);

      start = nowMs();
      const decoded = decodeMatrix(encoded.matrix);
      decodeSamples.push(nowMs() - start);

      if (decoded.payload.length !== payload.length) {
        throw new Error(`Benchmark decode length mismatch at ${payloadBytes} bytes.`);
      }
    }

    const versionInfo = getVersionInfo(encoded.version, { ecc });
    results.push({
      payloadBytes,
      skipped: false,
      version: encoded.version,
      size: encoded.size,
      capacityBytes: versionInfo.capacityBytes,
      utilizationPercent: versionInfo.capacityBytes > 0
        ? (payloadBytes / versionInfo.capacityBytes) * 100
        : 0,
      encode: summarize(encodeSamples),
      decode: summarize(decodeSamples),
      iterations
    });
  }

  return {
    format: "QuadQR",
    ecc,
    iterations,
    warmup,
    generatedAt: new Date().toISOString(),
    results
  };
}

export function benchmarkReport(options = {}) {
  const ecc = normalizeEcc(options.ecc ?? "M");
  const versions = options.versions ?? [1, 2, 5, 10, 20, 30, 40];
  return {
    capacity: buildCapacityComparison({ ecc, versions }),
    performance: benchmarkCodec({
      ecc,
      iterations: options.iterations ?? 30,
      warmup: options.warmup,
      payloadSizes: options.payloadSizes
    }),
    caveat: "QuadQR and standard QR ECC labels are not equivalent recovery targets. Capacity rows compare equal matrix dimensions and same letter only."
  };
}
