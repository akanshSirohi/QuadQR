import {
  CELL_ENCODINGS,
  decodeMatrix,
  scanImageData,
  internals
} from "./esm/quadqr.js";
import { autoColorImageData } from "./esm/vision.js";
import { initWasm } from "./esm/wasm.js";

const {
  combineFrameObservations,
  cropImageDataInset,
  observationDataAgreement,
  selectBestFrameObservation
} = internals;

let scanOptions = {};
let missStreak = 0;
let cameraGeometryHint = null;
let cameraGeometryHintMisses = 0;
let observationHistory = new Map();
let wasmState = null;
const frameCanvasPool = new Map();

function nowMs() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack || "",
    debug: error?.debug ?? null
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

function attachGeometryDiagnostic(frameDiagnostics, result) {
  if (!frameDiagnostics || !result?.geometry || frameDiagnostics.geometry) return;
  const geometry = result.geometry;
  frameDiagnostics.geometry = geometry;
  frameDiagnostics.geometryReused = Boolean(result.geometryReused);
  if (geometry.finders) {
    const reusedFinders = [
      geometry.finders.topLeft,
      geometry.finders.topRight,
      geometry.finders.bottomLeft
    ].filter(Boolean);
    frameDiagnostics.finders = reusedFinders;
    frameDiagnostics.finderCount = reusedFinders.length;
    if (result.geometryReused) frameDiagnostics.finderMethod = "geometry-reuse";
  }
}

function scaleGeometryForFrame(geometry, fromFrame, toFrame) {
  if (!geometry?.homography || !fromFrame?.scanWidth || !toFrame?.scanWidth) return null;
  const sx = toFrame.scanWidth / fromFrame.scanWidth;
  const sy = toFrame.scanHeight / fromFrame.scanHeight;
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) return null;
  const moduleScale = Math.sqrt(sx * sy);
  const scalePoint = (point) => point ? { ...point, x: point.x * sx, y: point.y * sy } : point;
  const scaleFinder = (finder) => finder ? {
    ...finder,
    x: finder.x * sx,
    y: finder.y * sy,
    moduleSize: finder.moduleSize * moduleScale
  } : finder;
  const h = geometry.homography;
  const scaled = {
    ...geometry,
    homography: [
      h[0] * sx, h[1] * sx, h[2] * sx,
      h[3] * sy, h[4] * sy, h[5] * sy,
      h[6], h[7], h[8]
    ],
    sourcePoints: Array.isArray(geometry.sourcePoints)
      ? geometry.sourcePoints.map(scalePoint)
      : geometry.sourcePoints,
    finders: geometry.finders ? {
      topLeft: scaleFinder(geometry.finders.topLeft),
      topRight: scaleFinder(geometry.finders.topRight),
      bottomLeft: scaleFinder(geometry.finders.bottomLeft)
    } : geometry.finders
  };
  if (geometry.alignment) {
    scaled.alignment = {
      ...geometry.alignment,
      center: scalePoint(geometry.alignment.center),
      predicted: scalePoint(geometry.alignment.predicted)
    };
  }
  return scaled;
}

function updateCameraGeometryHint(frameDiagnostics, result = null) {
  if (scanOptions.cameraGeometryReuse === false) {
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
    const maxMisses = Math.max(1, Math.round(scanOptions.cameraGeometryReuseMaxMisses ?? 5));
    if (cameraGeometryHintMisses >= maxMisses) {
      cameraGeometryHint = null;
      cameraGeometryHintMisses = 0;
    }
  }
}

function tryMultiFrameDecode(observations) {
  if (scanOptions.multiFrame === false) return null;
  const multiFrameWindow = Math.max(2, Math.min(8, Math.round(scanOptions.multiFrameWindow ?? 4)));
  const multiFrameMinFrames = Math.max(2, Math.min(multiFrameWindow, Math.round(scanOptions.multiFrameMinFrames ?? 2)));
  const best = selectBestFrameObservation(observations);
  if (!best) return null;
  const trackKey = `${best.version}:${best.cellEncoding ?? "auto"}`;
  let history = observationHistory.get(trackKey) ?? [];

  if (history.length) {
    const agreement = observationDataAgreement(history[history.length - 1], best);
    const minimumAgreement = best.cellEncoding === CELL_ENCODINGS.TRIANGLE16
      ? (scanOptions.multiFrameMinAgreementHighDensity ?? 0.58)
      : (scanOptions.multiFrameMinAgreement ?? 0.62);
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
      structureTolerance: scanOptions.structureTolerance ?? 0.20,
      cellConfidence: combined.confidence,
      cellAlternatives: combined.alternatives,
      cellEncodingHint: best.cellEncoding ?? undefined,
      maxErasureConfidence: scanOptions.maxErasureConfidence,
      softDecoding: scanOptions.softDecoding
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
}

function pooledFrameCanvas(cap, width, height) {
  let entry = frameCanvasPool.get(cap);
  if (!entry) {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    entry = { canvas, ctx };
    frameCanvasPool.set(cap, entry);
  } else if (entry.canvas.width !== width || entry.canvas.height !== height) {
    entry.canvas.width = width;
    entry.canvas.height = height;
  }
  return entry;
}

function makeCanvasFrameProvider(bitmap, source) {
  // Cache ImageData per resolution for the current camera frame, and reuse the
  // underlying OffscreenCanvas/context across frames. This avoids allocating
  // fresh canvases at camera frame rate without changing any scanner stage.
  const frames = new Map();
  return (maxDimension) => {
    const cap = Math.max(1, Math.round(maxDimension));
    if (frames.has(cap)) return frames.get(cap);
    const scale = Math.min(1, cap / Math.max(source.width, source.height));
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    const { ctx } = pooledFrameCanvas(cap, width, height);
    if ("imageSmoothingEnabled" in ctx) ctx.imageSmoothingEnabled = true;
    if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, source.x, source.y, source.width, source.height, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    const frame = { imageData, scanWidth: width, scanHeight: height, source: { ...source } };
    frames.set(cap, frame);
    return frame;
  };
}

function scanCapturedFrame(frame, options, observations, frameDiagnostics) {
  const visionDiagnostics = frameDiagnostics ? { passes: [] } : null;
  try {
    let result = scanImageData(frame.imageData, {
      ...options,
      _visionDiagnostics: visionDiagnostics,
      _observationCollector: observations
    });
    normalizeFrameDiagnostics(frameDiagnostics, frame.source, frame.scanWidth, frame.scanHeight, visionDiagnostics);
    attachGeometryDiagnostic(frameDiagnostics, result);
    if (frame.source.cropped) {
      result = {
        ...result,
        cameraVisibleCrop: true,
        cameraSourceRect: {
          x: frame.source.x,
          y: frame.source.y,
          width: frame.source.width,
          height: frame.source.height
        }
      };
    }
    return result;
  } catch (error) {
    normalizeFrameDiagnostics(frameDiagnostics, frame.source, frame.scanWidth, frame.scanHeight, visionDiagnostics);
    throw error;
  }
}

function makeFrameMeta(frame, diagnostic, enhancement = null) {
  return {
    imageData: frame.imageData,
    scanWidth: frame.scanWidth,
    scanHeight: frame.scanHeight,
    sourceRect: frame.source ? { ...frame.source } : null,
    enhancedImageData: enhancement?.imageData ?? null,
    enhancedRect: enhancement?.rect ? { ...enhancement.rect } : null,
    enhancement: enhancement?.meta ? { ...enhancement.meta } : null,
    diagnostic
  };
}

function transferableBuffers(frameMeta) {
  const buffers = [];
  const base = frameMeta?.imageData?.data?.buffer;
  const enhanced = frameMeta?.enhancedImageData?.data?.buffer;
  if (base instanceof ArrayBuffer) buffers.push(base);
  if (enhanced instanceof ArrayBuffer && enhanced !== base) buffers.push(enhanced);
  return buffers;
}

function pushDiagnostic(events, event) {
  events.push(event);
}

function processFrame(bitmap, source, frameNumber) {
  const events = [];
  const observations = [];
  const frameDiagnostics = {};
  const frameStarted = nowMs();
  const baseCameraMaxDimension = Math.max(480, Math.round(scanOptions.maxDimension ?? 640));
  const cameraHighResolutionMaxDimension = Math.max(
    baseCameraMaxDimension,
    Math.round(scanOptions.cameraHighResolutionMaxDimension ?? 960)
  );
  const cameraAutoColorEvery = Math.max(1, Math.round(scanOptions.cameraAutoColorEvery ?? 1));
  const cameraAutoEnhanceEvery = Math.max(1, Math.round(scanOptions.cameraAutoEnhanceEvery ?? 2));
  const cameraFinderRecoveryEvery = Math.max(1, Math.round(scanOptions.cameraFinderRecoveryEvery ?? 2));
  const cameraHighResolutionEvery = Math.max(1, Math.round(scanOptions.cameraHighResolutionEvery ?? 2));
  const getFrame = makeCanvasFrameProvider(bitmap, source);
  const baseFrame = getFrame(baseCameraMaxDimension);

  let allowFinderRecovery = false;
  let allowAutoEnhance = false;
  try {
    const fastPipeline = scanOptions.cameraPipelineMode === "fast";
    allowFinderRecovery = !fastPipeline && scanOptions.finderRecovery !== false &&
      missStreak > 0 && ((missStreak - 1) % cameraFinderRecoveryEvery === 0);
    allowAutoEnhance = !fastPipeline && scanOptions.autoEnhanceRecovery !== false &&
      missStreak > 0 && ((missStreak - 1) % cameraAutoEnhanceEvery === 0);
    const method = allowAutoEnhance
      ? "progressive-color-recovery"
      : (allowFinderRecovery ? "finder-recovery" : "fast-scan");

    const result = scanCapturedFrame(baseFrame, {
      ...scanOptions,
      _diagnosticLabel: method,
      finderRecovery: allowFinderRecovery,
      autoEnhanceRecovery: allowAutoEnhance,
      autoEnhanceWhenNoGeometry: allowAutoEnhance,
      fullFrameAutoEnhanceRecovery: scanOptions.fullFrameAutoEnhanceRecovery ?? false,
      _geometryHints: scanOptions.cameraGeometryReuse === false || !cameraGeometryHint ? undefined : [cameraGeometryHint]
    }, observations, frameDiagnostics);

    const elapsedMs = nowMs() - frameStarted;
    updateCameraGeometryHint(frameDiagnostics, result);
    pushDiagnostic(events, {
      type: "frame",
      state: "decoded",
      method: result.recoveryMode ?? result.samplingMode ?? method,
      elapsedMs,
      missStreak,
      ...frameDiagnostics
    });
    pushDiagnostic(events, {
      type: "success",
      state: "decoded",
      method: result.recoveryMode ?? result.samplingMode ?? method,
      elapsedMs,
      message: `Decoded v${result.version} · ECC ${result.eccLevel} · ${Math.round(elapsedMs)} ms`,
      ...frameDiagnostics
    });
    missStreak = 0;
    observationHistory.clear();
    return {
      ok: true,
      result,
      frameMeta: makeFrameMeta(baseFrame, frameDiagnostics),
      diagnostics: events,
      elapsedMs,
      missStreak
    };
  } catch (error) {
    missStreak++;
    updateCameraGeometryHint(frameDiagnostics);
    const fastElapsedMs = nowMs() - frameStarted;
    pushDiagnostic(events, {
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

    // The continuous camera engine can dedicate one worker to fresh-frame
    // acquisition. In fast mode we intentionally stop here after the normal
    // detector/decode attempt. A second worker runs the complete recovery
    // stack in parallel, so Auto Color, high-resolution perspective recovery,
    // multi-frame fusion, and damaged-code recovery can never block the next
    // fresh camera frame. This changes scheduling only, not scanner capability.
    if (scanOptions.cameraPipelineMode === "fast") {
      return {
        ok: false,
        error: serializeError(error),
        diagnostics: events,
        elapsedMs: nowMs() - frameStarted,
        missStreak,
        fastPipeline: true
      };
    }

    const shouldTryHighResolution = scanOptions.cameraHighResolutionRecovery !== false &&
      cameraHighResolutionMaxDimension > baseCameraMaxDimension &&
      (frameDiagnostics?.finderCount ?? 0) >= (scanOptions.cameraHighResolutionMinFinders ?? 2) &&
      ((missStreak - 1) % cameraHighResolutionEvery === 0);
    if (shouldTryHighResolution) {
      const highResolutionObservations = [];
      const highResolutionDiagnostics = {};
      pushDiagnostic(events, {
        type: "method",
        state: "trying",
        method: "high-resolution-geometry-recovery",
        message: `Finder geometry detected · refining detail at up to ${cameraHighResolutionMaxDimension}px`,
        ...frameDiagnostics
      });
      try {
        const recoveryStarted = nowMs();
        const highResolutionFrame = getFrame(cameraHighResolutionMaxDimension);
        const scaledGeometry = scaleGeometryForFrame(frameDiagnostics?.geometry, baseFrame, highResolutionFrame);
        let recovered = null;

        // If the low-resolution locator already established projective geometry,
        // do not make the detailed frame rediscover the eyes. Scale the
        // homography and sample/decode immediately. If that fast reuse misses,
        // fall through to the complete high-detail detector/recovery path.
        if (scaledGeometry) {
          try {
            recovered = scanCapturedFrame(highResolutionFrame, {
              ...scanOptions,
              _diagnosticLabel: "high-resolution-geometry-reuse",
              _geometryHints: [scaledGeometry],
              _geometryHintOnly: true,
              finderRecovery: false,
              autoEnhanceRecovery: false,
              fullFrameAutoEnhanceRecovery: false
            }, highResolutionObservations, highResolutionDiagnostics);
          } catch {
            recovered = null;
          }
        }

        if (!recovered) {
          recovered = scanCapturedFrame(highResolutionFrame, {
            ...scanOptions,
            _diagnosticLabel: "high-resolution-geometry-recovery",
            finderRecovery: true,
            autoEnhanceRecovery: false,
            fullFrameAutoEnhanceRecovery: false
          }, highResolutionObservations, highResolutionDiagnostics);
        }
        const recoveryElapsedMs = nowMs() - recoveryStarted;
        pushDiagnostic(events, {
          type: "success",
          state: "decoded",
          method: recovered.geometryReused ? "high-resolution-geometry-reuse" : "high-resolution-geometry-recovery",
          elapsedMs: recoveryElapsedMs,
          message: `Detail retry decoded v${recovered.version} · ${Math.round(recoveryElapsedMs)} ms`,
          ...highResolutionDiagnostics
        });
        missStreak = 0;
        observationHistory.clear();
        return {
          ok: true,
          result: {
            ...recovered,
            cameraHighResolutionRecovery: true,
            cameraProgressiveRecovery: true,
            recoveryMode: recovered.recoveryMode ?? (recovered.geometryReused ? "high-resolution-geometry-reuse" : "high-resolution-geometry-recovery")
          },
          frameMeta: makeFrameMeta(highResolutionFrame, highResolutionDiagnostics),
          diagnostics: events,
          elapsedMs: nowMs() - frameStarted,
          missStreak
        };
      } catch (highResolutionError) {
        observations.push(...highResolutionObservations);
        pushDiagnostic(events, {
          type: "method",
          state: "failed",
          method: "high-resolution-geometry-recovery",
          message: `High-detail geometry retry did not decode${highResolutionDiagnostics?.finderCount != null ? ` · ${highResolutionDiagnostics.finderCount} finder(s)` : ""}`,
          error: highResolutionError?.message ?? String(highResolutionError),
          ...(highResolutionDiagnostics ?? frameDiagnostics)
        });
      }
    }

    const shouldTryCameraAutoColor = scanOptions.cameraAutoColorRecovery !== false &&
      baseFrame.imageData &&
      ((missStreak - 1) % cameraAutoColorEvery === 0);
    if (shouldTryCameraAutoColor) {
      const requestedCrops = Array.isArray(scanOptions.cameraAutoColorCropInsets)
        ? scanOptions.cameraAutoColorCropInsets
        : [0.08, 0.16, 0.22, 0];
      const cropInsets = [];
      for (const value of requestedCrops) {
        const inset = clampNumber(Number(value), 0, 0.30);
        if (!cropInsets.some((item) => Math.abs(item - inset) < 0.001)) cropInsets.push(inset);
      }
      const explicitAnalysisInsets = Array.isArray(scanOptions.cameraAutoColorAnalysisInsets)
        ? scanOptions.cameraAutoColorAnalysisInsets
        : null;

      pushDiagnostic(events, {
        type: "method",
        state: "trying",
        method: "camera-auto-color",
        message: `Fast scan failed · QuadQR Auto Color recovery inside camera guide (${cropInsets.map((v) => v ? `${Math.round(v * 100)}% crop` : "full frame").join(" → ")})`,
        ...frameDiagnostics
      });

      for (let profileIndex = 0; profileIndex < cropInsets.length; profileIndex++) {
        const cropInset = cropInsets[profileIndex];
        const cropped = cropImageDataInset(baseFrame.imageData, cropInset);
        const defaultAnalysisInsets = [0.10, 0.08, 0.04, 0.10];
        const analysisInset = clampNumber(
          Number(explicitAnalysisInsets?.[profileIndex]
            ?? scanOptions.cameraAutoColorAnalysisInset
            ?? defaultAnalysisInsets[Math.min(profileIndex, defaultAnalysisInsets.length - 1)]),
          0,
          0.30
        );
        const autoColorObservations = [];
        const autoColorVisionDiagnostics = { passes: [] };
        const autoColorFrameDiagnostics = {};
        const cropLabel = cropInset ? `${Math.round(cropInset * 100)}pct-crop` : "full";
        const profileName = `camera-auto-color-${cropLabel}`;
        try {
          const recoveryStarted = nowMs();
          const correctedFrame = autoColorImageData(cropped.imageData, {
            blackClip: scanOptions.cameraAutoColorBlackClip ?? 0.0001,
            whiteClip: scanOptions.cameraAutoColorWhiteClip ?? 0.004,
            highlightPercentile: scanOptions.cameraAutoColorHighlightPercentile ?? 0.95,
            outputHighlight: scanOptions.cameraAutoColorOutputHighlight ?? 190,
            analysisInset,
            minimumInputRange: scanOptions.cameraAutoColorMinimumInputRange ?? 72,
            targetSamples: scanOptions.cameraAutoColorTargetSamples ?? 90000
          });
          const recovered = scanImageData(correctedFrame, {
            ...scanOptions,
            _diagnosticLabel: profileName,
            _visionDiagnostics: autoColorVisionDiagnostics,
            finderRecovery: true,
            autoEnhanceRecovery: false,
            fullFrameAutoEnhanceRecovery: false,
            _observationCollector: autoColorObservations
          });
          normalizeFrameDiagnostics(
            autoColorFrameDiagnostics,
            baseFrame.source,
            correctedFrame.width,
            correctedFrame.height,
            autoColorVisionDiagnostics
          );
          autoColorFrameDiagnostics.frameWidth = baseFrame.scanWidth;
          autoColorFrameDiagnostics.frameHeight = baseFrame.scanHeight;
          autoColorFrameDiagnostics.scanRect = { ...cropped.rect };
          autoColorFrameDiagnostics.autoColorCropInset = cropInset;
          autoColorFrameDiagnostics.autoColorAnalysisInset = analysisInset;
          attachGeometryDiagnostic(autoColorFrameDiagnostics, recovered);
          const recoveryElapsedMs = nowMs() - recoveryStarted;
          pushDiagnostic(events, {
            type: "frame",
            state: "decoded",
            method: profileName,
            elapsedMs: recoveryElapsedMs,
            missStreak,
            ...autoColorFrameDiagnostics
          });
          pushDiagnostic(events, {
            type: "success",
            state: "decoded",
            method: "camera-auto-color",
            elapsedMs: recoveryElapsedMs,
            message: `QuadQR Auto Color ${cropInset ? `${Math.round(cropInset * 100)}% crop` : "full frame"} decoded v${recovered.version} · ECC ${recovered.eccLevel} · ${Math.round(recoveryElapsedMs)} ms`,
            ...autoColorFrameDiagnostics
          });
          missStreak = 0;
          observationHistory.clear();
          return {
            ok: true,
            result: {
              ...recovered,
              autoColorCorrected: true,
              cameraProgressiveRecovery: true,
              recoveryMode: "camera-auto-color",
              cameraAutoColorCropInset: cropInset,
              cameraAutoColorAnalysisInset: analysisInset
            },
            frameMeta: makeFrameMeta(baseFrame, autoColorFrameDiagnostics, {
              imageData: correctedFrame,
              rect: cropped.rect,
              meta: { method: "camera-auto-color", cropInset, analysisInset }
            }),
            diagnostics: events,
            elapsedMs: nowMs() - frameStarted,
            missStreak
          };
        } catch (recoveryError) {
          observations.push(...autoColorObservations);
          normalizeFrameDiagnostics(
            autoColorFrameDiagnostics,
            baseFrame.source,
            cropped.imageData.width,
            cropped.imageData.height,
            autoColorVisionDiagnostics
          );
          autoColorFrameDiagnostics.frameWidth = baseFrame.scanWidth;
          autoColorFrameDiagnostics.frameHeight = baseFrame.scanHeight;
          autoColorFrameDiagnostics.scanRect = { ...cropped.rect };
          autoColorFrameDiagnostics.autoColorCropInset = cropInset;
          autoColorFrameDiagnostics.autoColorAnalysisInset = analysisInset;
          pushDiagnostic(events, {
            type: "frame",
            state: "miss",
            method: profileName,
            elapsedMs: nowMs() - frameStarted,
            missStreak,
            error: recoveryError?.message ?? String(recoveryError),
            ...autoColorFrameDiagnostics
          });
          pushDiagnostic(events, {
            type: "method",
            state: "failed",
            method: profileName,
            message: `QuadQR Auto Color ${cropInset ? `${Math.round(cropInset * 100)}% crop` : "full frame"} did not decode${autoColorFrameDiagnostics?.finderCount != null ? ` · ${autoColorFrameDiagnostics.finderCount} finder(s)` : ""}`,
            ...autoColorFrameDiagnostics
          });
        }
      }
      pushDiagnostic(events, {
        type: "method",
        state: "failed",
        method: "camera-auto-color",
        message: "All camera QuadQR Auto Color profiles failed · continuing deeper recovery",
        ...frameDiagnostics
      });
    }

    if (!allowAutoEnhance && scanOptions.autoEnhanceRecovery !== false) {
      const strongObservation = selectBestFrameObservation(observations);
      if (strongObservation) {
        pushDiagnostic(events, {
          type: "method",
          state: "trying",
          method: "qr-region-auto-enhance",
          message: "Fast decode failed · trying QR-region Auto Tone / Contrast / Color",
          ...frameDiagnostics
        });
        try {
          const recoveryStarted = nowMs();
          const recoveryObservations = [];
          const recoveryVisionDiagnostics = { passes: [] };
          const recovered = scanImageData(baseFrame.imageData, {
            ...scanOptions,
            _diagnosticLabel: "qr-region-auto-enhance",
            _visionDiagnostics: recoveryVisionDiagnostics,
            autoEnhanceRecovery: true,
            autoEnhanceWhenNoGeometry: false,
            fullFrameAutoEnhanceRecovery: false,
            _observationCollector: recoveryObservations
          });
          const recoveryElapsedMs = nowMs() - recoveryStarted;
          pushDiagnostic(events, {
            type: "success",
            state: "decoded",
            method: recovered.recoveryMode ?? recovered.samplingMode ?? "qr-region-auto-enhance",
            elapsedMs: recoveryElapsedMs,
            message: `Recovery decoded v${recovered.version} · ECC ${recovered.eccLevel} · ${Math.round(recoveryElapsedMs)} ms`,
            ...frameDiagnostics
          });
          missStreak = 0;
          observationHistory.clear();
          return {
            ok: true,
            result: { ...recovered, cameraProgressiveRecovery: true },
            frameMeta: makeFrameMeta(baseFrame, frameDiagnostics),
            diagnostics: events,
            elapsedMs: nowMs() - frameStarted,
            missStreak
          };
        } catch {
          pushDiagnostic(events, {
            type: "method",
            state: "failed",
            method: "qr-region-auto-enhance",
            message: "QR-region color recovery did not decode · trying multi-frame ECC",
            ...frameDiagnostics
          });
        }
      }
    }

    const combined = tryMultiFrameDecode(observations);
    if (combined) {
      pushDiagnostic(events, {
        type: "success",
        state: "decoded",
        method: "multi-frame-confidence-fusion",
        message: `Multi-frame confidence fusion decoded v${combined.version} from ${combined.multiFrameCombined} frames`,
        ...frameDiagnostics
      });
      missStreak = 0;
      return {
        ok: true,
        result: combined,
        frameMeta: makeFrameMeta(baseFrame, frameDiagnostics),
        diagnostics: events,
        elapsedMs: nowMs() - frameStarted,
        missStreak
      };
    }

    return {
      ok: false,
      error: serializeError(error),
      diagnostics: events,
      elapsedMs: nowMs() - frameStarted,
      missStreak
    };
  } finally {
    try { bitmap.close(); } catch {}
  }
}

async function initialize(options) {
  scanOptions = options ?? {};
  missStreak = 0;
  cameraGeometryHint = null;
  cameraGeometryHintMisses = 0;
  observationHistory = new Map();
  try {
    wasmState = await initWasm();
  } catch {
    wasmState = null;
  }
  return {
    worker: true,
    wasm: wasmState,
    offscreenCanvas: typeof OffscreenCanvas === "function"
  };
}

self.addEventListener("message", async (event) => {
  const message = event.data ?? {};
  const id = message.id;
  if (!id) return;
  try {
    if (message.type === "init") {
      const result = await initialize(message.options ?? {});
      self.postMessage({ id, ok: true, type: "init", result });
      return;
    }
    if (message.type === "reset") {
      missStreak = 0;
      cameraGeometryHint = null;
      cameraGeometryHintMisses = 0;
      observationHistory.clear();
      self.postMessage({ id, ok: true, type: "reset" });
      return;
    }
    if (message.type === "scan" || message.type === "scan-full") {
      if (!(message.bitmap instanceof ImageBitmap)) throw new Error("Camera worker expected an ImageBitmap frame.");
      if (typeof OffscreenCanvas !== "function") throw new Error("OffscreenCanvas is unavailable in the camera worker.");
      const previousOptions = scanOptions;
      if (message.type === "scan-full") {
        // Safety fallback for browsers that allow one module worker but reject
        // creation of the second recovery worker. Run the exact full pipeline
        // in the existing worker rather than silently losing recovery power.
        scanOptions = { ...previousOptions, ...(message.options ?? {}), cameraPipelineMode: "full" };
      }
      let result;
      try {
        result = processFrame(message.bitmap, message.source, message.frame ?? 0);
      } finally {
        scanOptions = previousOptions;
      }
      const transfers = result.ok ? transferableBuffers(result.frameMeta) : [];
      self.postMessage({ id, ok: true, type: message.type, result }, transfers);
      return;
    }
    throw new Error(`Unknown camera worker message: ${message.type}`);
  } catch (error) {
    try { message.bitmap?.close?.(); } catch {}
    self.postMessage({ id, ok: false, type: message.type, error: serializeError(error) });
  }
});
