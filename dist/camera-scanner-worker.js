/*
 * QuadQR camera worker guard.
 *
 * The scanner engine lives in camera-scanner-worker-core.js. This thin guard
 * keeps the engine untouched while preventing false finder lookalikes from
 * waking the expensive recovery lane, and resets worker-local tracking after
 * continuous decodes so the next symbol starts fresh.
 */

const nativeAddEventListener = self.addEventListener.bind(self);
const nativePostMessage = self.postMessage.bind(self);

let coreMessageHandler = null;
let coreReadyPromise = null;
let activeOptions = {};
let fastFinderTrack = null;
let colorProbeCanvas = null;
let colorProbeContext = null;
let syntheticSequence = 0;

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function resetGuardState() {
  fastFinderTrack = null;
}

function coreModuleUrl() {
  const url = new URL(import.meta.url);
  const path = url.pathname || "";
  // Source and ESM builds keep the worker core beside this guard. The classic
  // dist worker lives one directory above dist/esm, so load the same core from
  // there instead of maintaining a second copy with rewritten imports.
  if (path.includes("/library/") || path.includes("/esm/")) {
    return new URL("./camera-scanner-worker-core.js", url);
  }
  return new URL("./esm/camera-scanner-worker-core.js", url);
}

function ensureCore() {
  if (coreReadyPromise) return coreReadyPromise;
  coreReadyPromise = (async () => {
    const originalAddEventListener = self.addEventListener;
    const capture = (type, listener, options) => {
      if (type === "message" && !coreMessageHandler) {
        coreMessageHandler = listener;
        return;
      }
      return nativeAddEventListener(type, listener, options);
    };

    self.addEventListener = capture;
    try {
      await import(coreModuleUrl());
    } finally {
      self.addEventListener = originalAddEventListener;
    }

    if (typeof coreMessageHandler !== "function") {
      throw new Error("QuadQR camera worker core did not register its message handler.");
    }
  })();
  return coreReadyPromise;
}

function tuneFastWorkerOptions(options = {}) {
  if (options.cameraPipelineMode !== "fast") return options;
  const tuned = { ...options };

  // Connected-component finder recovery is useful for damaged eyes, but the
  // original 600-component default is unnecessarily expensive on keyboards,
  // text-heavy UIs, and other high-contrast scenes. Keep it available while
  // bounding work in the fresh-frame lane. Full recovery keeps its old limits.
  if (tuned.componentMaxCount == null) tuned.componentMaxCount = 360;
  if (tuned.componentMaxCandidates == null) tuned.componentMaxCandidates = 8;
  if (tuned.componentTemplateThreshold == null) tuned.componentTemplateThreshold = 0.68;
  return tuned;
}

function maxFinderEvidence(workerResult) {
  let best = null;
  for (const diagnostic of workerResult?.diagnostics ?? []) {
    const choices = [
      {
        count: Number(diagnostic?.finderCount) || 0,
        finders: Array.isArray(diagnostic?.finders) ? diagnostic.finders : [],
        method: diagnostic?.finderMethod ?? null,
        geometry: diagnostic?.geometry ?? null,
        width: Number(diagnostic?.scanWidth ?? diagnostic?.frameWidth) || 0,
        height: Number(diagnostic?.scanHeight ?? diagnostic?.frameHeight) || 0
      },
      {
        count: Number(diagnostic?.bestPass?.finderCount) || 0,
        finders: Array.isArray(diagnostic?.bestPass?.finders) ? diagnostic.bestPass.finders : [],
        method: diagnostic?.bestPass?.finderMethod ?? diagnostic?.bestPass?.label ?? null,
        geometry: diagnostic?.bestPass?.geometries?.[0] ?? null,
        width: Number(diagnostic?.scanWidth ?? diagnostic?.frameWidth) || 0,
        height: Number(diagnostic?.scanHeight ?? diagnostic?.frameHeight) || 0
      }
    ];
    for (const choice of choices) {
      choice.count = Math.max(choice.count, choice.finders.length);
      if (!best ||
          Boolean(choice.geometry) > Boolean(best.geometry) ||
          (Boolean(choice.geometry) === Boolean(best.geometry) && choice.count > best.count)) {
        best = choice;
      }
    }
  }
  return best ?? { count: 0, finders: [], method: null, geometry: null, width: 0, height: 0 };
}

function plausibleFinderSet(evidence) {
  const finders = evidence?.finders ?? [];
  if (!finders.length) return false;
  if (finders.length === 1) return true;

  for (let i = 0; i < finders.length; i++) {
    for (let j = i + 1; j < finders.length; j++) {
      const a = finders[i];
      const b = finders[j];
      const ma = Math.max(0.1, Number(a?.moduleSize) || 0.1);
      const mb = Math.max(0.1, Number(b?.moduleSize) || 0.1);
      const ratio = Math.max(ma, mb) / Math.min(ma, mb);
      if (ratio > 2.25) continue;
      const modulesApart = Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0)) /
        Math.max(0.1, (ma + mb) / 2);
      if (modulesApart >= 7 && modulesApart <= 150) return true;
    }
  }
  return false;
}

function normalizeFinders(evidence) {
  const width = Math.max(1, evidence?.width || 1);
  const height = Math.max(1, evidence?.height || 1);
  const minDimension = Math.max(1, Math.min(width, height));
  return (evidence?.finders ?? []).slice(0, 6).map((finder) => ({
    x: clampNumber((Number(finder?.x) || 0) / width, 0, 1),
    y: clampNumber((Number(finder?.y) || 0) / height, 0, 1),
    module: Math.max(0.0001, (Number(finder?.moduleSize) || 0.1) / minDimension)
  }));
}

function sameFinderTrack(previous, current) {
  if (!previous?.finders?.length || !current?.length) return false;
  const used = new Set();
  let matches = 0;

  for (const finder of current) {
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let index = 0; index < previous.finders.length; index++) {
      if (used.has(index)) continue;
      const old = previous.finders[index];
      const moduleRatio = Math.max(old.module, finder.module) / Math.max(0.0001, Math.min(old.module, finder.module));
      if (moduleRatio > 2.5) continue;
      const distance = Math.hypot(old.x - finder.x, old.y - finder.y);
      const tolerance = Math.max(0.055, Math.max(old.module, finder.module) * 6);
      if (distance <= tolerance && distance < bestDistance) {
        bestIndex = index;
        bestDistance = distance;
      }
    }
    if (bestIndex >= 0) {
      used.add(bestIndex);
      matches++;
    }
  }

  const required = previous.finders.length >= 2 && current.length >= 2 ? 2 : 1;
  return matches >= required;
}

function colorProbeRect(bitmap, track) {
  if (!track?.finders?.length) return { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
  const points = track.finders.map((finder) => ({
    x: finder.x * bitmap.width,
    y: finder.y * bitmap.height,
    module: finder.module * Math.min(bitmap.width, bitmap.height)
  }));
  const centerX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const centerY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  let span = Math.max(...points.map((point) => point.module * 18), Math.min(bitmap.width, bitmap.height) * 0.16);
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      span = Math.max(span, Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y));
    }
  }
  const half = span * (points.length >= 2 ? 0.78 : 0.62);
  const x0 = clampNumber(Math.floor(centerX - half), 0, Math.max(0, bitmap.width - 1));
  const y0 = clampNumber(Math.floor(centerY - half), 0, Math.max(0, bitmap.height - 1));
  const x1 = clampNumber(Math.ceil(centerX + half), x0 + 1, bitmap.width);
  const y1 = clampNumber(Math.ceil(centerY + half), y0 + 1, bitmap.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function sampleQuadColorEvidence(bitmap) {
  try {
    const sampleSize = Math.max(32, Math.min(96, Math.round(activeOptions.cameraCandidateColorSampleSize ?? 56)));
    if (!colorProbeCanvas) {
      colorProbeCanvas = new OffscreenCanvas(sampleSize, sampleSize);
      colorProbeContext = colorProbeCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
    } else if (colorProbeCanvas.width !== sampleSize || colorProbeCanvas.height !== sampleSize) {
      colorProbeCanvas.width = sampleSize;
      colorProbeCanvas.height = sampleSize;
    }
    if (!colorProbeContext) return null;

    const rect = colorProbeRect(bitmap, fastFinderTrack);
    if ("imageSmoothingEnabled" in colorProbeContext) colorProbeContext.imageSmoothingEnabled = true;
    if ("imageSmoothingQuality" in colorProbeContext) colorProbeContext.imageSmoothingQuality = "medium";
    colorProbeContext.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, sampleSize, sampleSize);
    const data = colorProbeContext.getImageData(0, 0, sampleSize, sampleSize).data;

    const minimumValue = Math.max(40, Number(activeOptions.cameraCandidateColorMinValue ?? 64));
    const minimumChroma = Math.max(14, Number(activeOptions.cameraCandidateColorMinChroma ?? 26));
    const minimumDominance = Math.max(4, Number(activeOptions.cameraCandidateColorMinDominance ?? 9));
    const families = [0, 0, 0];
    let chromatic = 0;
    let dominant = 0;
    const pixels = sampleSize * sampleSize;

    for (let index = 0; index < data.length; index += 4) {
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max < minimumValue || max - min < minimumChroma) continue;
      chromatic++;
      if (r - Math.max(g, b) >= minimumDominance) { families[0]++; dominant++; }
      else if (g - Math.max(r, b) >= minimumDominance) { families[1]++; dominant++; }
      else if (b - Math.max(r, g) >= minimumDominance) { families[2]++; dominant++; }
    }

    const minimumDominant = Math.max(10, Math.round(pixels * Number(activeOptions.cameraCandidateColorFraction ?? 0.008)));
    const minimumFamily = Math.max(3, Math.round(pixels * Number(activeOptions.cameraCandidateColorFamilyFraction ?? 0.001)));
    const strongFamilies = families.filter((count) => count >= minimumFamily).length;
    const sortedFamilies = families.slice().sort((a, b) => b - a);
    const balancedEnough = sortedFamilies[1] >= Math.max(minimumFamily, sortedFamilies[0] * 0.055);

    return {
      present: dominant >= minimumDominant && strongFamilies >= 2 && balancedEnough,
      dominant,
      chromatic,
      families: { red: families[0], green: families[1], blue: families[2] },
      sampled: pixels,
      rect
    };
  } catch {
    return null;
  }
}

function sanitizeDiagnostic(diagnostic, gate) {
  if (!diagnostic || typeof diagnostic !== "object") return diagnostic;
  const rawBestPass = diagnostic.bestPass;
  return {
    ...diagnostic,
    rawFinderCount: diagnostic.finderCount ?? rawBestPass?.finderCount ?? 0,
    rawFinders: diagnostic.finders ?? rawBestPass?.finders ?? [],
    rawFinderMethod: diagnostic.finderMethod ?? rawBestPass?.finderMethod ?? null,
    rawGeometry: diagnostic.geometry ?? rawBestPass?.geometries?.[0] ?? null,
    finderCount: 0,
    finders: [],
    geometry: null,
    bestPass: rawBestPass ? { ...rawBestPass, finderCount: 0, finders: [], geometries: [] } : rawBestPass,
    finderPasses: Array.isArray(diagnostic.finderPasses)
      ? diagnostic.finderPasses.map((pass) => ({ ...pass, finderCount: 0, geometryCount: 0 }))
      : diagnostic.finderPasses,
    candidateGate: gate
  };
}

function gateFastFinderDiagnostics(workerResult, colorEvidence, frameNumber) {
  if (!workerResult || workerResult.ok) {
    resetGuardState();
    return workerResult;
  }

  const evidence = maxFinderEvidence(workerResult);
  if (evidence.count <= 0 || !evidence.finders.length) {
    resetGuardState();
    return workerResult;
  }
  if (!plausibleFinderSet(evidence)) {
    resetGuardState();
    const gate = {
      state: "rejected-implausible-finders",
      stableFrames: 0,
      requiredFrames: 2,
      rawFinderCount: evidence.count,
      finderMethod: evidence.method,
      color: null
    };
    return {
      ...workerResult,
      candidateGate: gate,
      diagnostics: (workerResult.diagnostics ?? []).map((diagnostic) => sanitizeDiagnostic(diagnostic, gate))
    };
  }

  const normalized = normalizeFinders(evidence);
  const continued = sameFinderTrack(fastFinderTrack, normalized);
  const streak = continued ? (fastFinderTrack.streak + 1) : 1;
  fastFinderTrack = {
    finders: normalized,
    streak,
    frame: frameNumber,
    rawCount: evidence.count,
    method: evidence.method
  };

  const geometryConfirmed = Boolean(
    evidence.geometry?.homography && Number.isInteger(evidence.geometry?.version)
  );
  const requiredFrames = geometryConfirmed
    ? 1
    : evidence.count >= 2
      ? Math.max(2, Math.round(activeOptions.cameraCandidateStableFrames ?? 2))
      : Math.max(3, Math.round(activeOptions.cameraCandidateWeakStableFrames ?? 3));
  const colorRequired = activeOptions.cameraCandidateColorGate !== false;
  const colorConfirmed = colorEvidence?.present === true;
  const colorUnavailableFallback = colorEvidence == null && streak >= Math.max(requiredFrames + 1, 3);
  const accepted = geometryConfirmed ||
    (streak >= requiredFrames && (!colorRequired || colorConfirmed || colorUnavailableFallback));

  const gate = {
    state: geometryConfirmed
      ? "confirmed-geometry"
      : accepted
        ? "confirmed"
        : (colorEvidence && !colorConfirmed ? "rejected-non-quad-color" : "confirming"),
    stableFrames: streak,
    requiredFrames,
    rawFinderCount: evidence.count,
    finderMethod: evidence.method,
    color: colorEvidence ? {
      present: colorEvidence.present,
      dominant: colorEvidence.dominant,
      sampled: colorEvidence.sampled,
      families: colorEvidence.families
    } : null
  };

  if (accepted) {
    for (const diagnostic of workerResult.diagnostics ?? []) diagnostic.candidateGate = gate;
    return workerResult;
  }

  return {
    ...workerResult,
    candidateGate: gate,
    diagnostics: (workerResult.diagnostics ?? []).map((diagnostic) => sanitizeDiagnostic(diagnostic, gate))
  };
}

async function invokeCore(data) {
  await ensureCore();
  const emitted = [];
  const originalPostMessage = self.postMessage;
  self.postMessage = (message, transfer = []) => {
    emitted.push({ message, transfer: Array.isArray(transfer) ? transfer : [] });
  };
  try {
    await coreMessageHandler({ data });
  } finally {
    self.postMessage = originalPostMessage;
  }
  return emitted;
}

async function resetCoreAfterContinuousDecode() {
  const id = `qqr-camera-guard-reset-${++syntheticSequence}`;
  try {
    await invokeCore({ id, type: "reset" });
  } catch {
    // A failed freshness reset must not discard a successful decode.
  }
  resetGuardState();
}

nativeAddEventListener("message", async (event) => {
  const incoming = event.data ?? {};
  try {
    await ensureCore();

    let forwarded = incoming;
    if (incoming.type === "init") {
      activeOptions = { ...(incoming.options ?? {}) };
      resetGuardState();
      forwarded = {
        ...incoming,
        options: tuneFastWorkerOptions(activeOptions)
      };
      activeOptions = { ...forwarded.options };
    } else if (incoming.type === "reset") {
      resetGuardState();
    }

    const fastPipeline = activeOptions.cameraPipelineMode === "fast";
    const shouldProbeColor = fastPipeline &&
      incoming.type === "scan" &&
      incoming.bitmap instanceof ImageBitmap &&
      fastFinderTrack?.finders?.length;
    const colorEvidence = shouldProbeColor ? sampleQuadColorEvidence(incoming.bitmap) : null;

    const emitted = await invokeCore(forwarded);
    const processed = emitted.map(({ message, transfer }) => {
      if (!fastPipeline || incoming.type !== "scan" || !message?.ok || message?.type !== "scan") {
        return { message, transfer };
      }
      return {
        message: {
          ...message,
          result: gateFastFinderDiagnostics(message.result, colorEvidence, incoming.frame ?? 0)
        },
        transfer
      };
    });

    const successfulScan = processed.some(({ message }) =>
      message?.ok &&
      (message.type === "scan" || message.type === "scan-full") &&
      message?.result?.ok
    );
    if (successfulScan && activeOptions.stopOnResult === false) {
      await resetCoreAfterContinuousDecode();
    }

    for (const item of processed) nativePostMessage(item.message, item.transfer);
  } catch (error) {
    try { incoming.bitmap?.close?.(); } catch {}
    nativePostMessage({
      id: incoming.id,
      ok: false,
      type: incoming.type,
      error: {
        name: error?.name || "Error",
        message: error?.message || String(error),
        stack: error?.stack || "",
        debug: error?.debug ?? null
      }
    });
  }
});
