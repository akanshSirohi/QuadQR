import {
  encodeText,
  encodeSecureText,
  decryptDecoded,
  generateRaw256Key,
  bytesToHex,
  renderToCanvas,
  scanImageData,
  scanFile,
  startCameraScanner,
  getVersionInfo,
  MAX_VERSION
} from "../library/quadqr.js";
import { buildCapacityComparison, benchmarkCodec } from "../library/benchmark.js";

const payloadEl = document.querySelector("#payload");
const versionEl = document.querySelector("#version");
const eccLevelEl = document.querySelector("#eccLevel");
const moduleSizeEl = document.querySelector("#moduleSize");
const renderStyleEl = document.querySelector("#renderStyle");
const styleHintEl = document.querySelector("#styleHint");
const securityModeEl = document.querySelector("#securityMode");
const passwordSecurityFieldsEl = document.querySelector("#passwordSecurityFields");
const rawKeySecurityFieldsEl = document.querySelector("#rawKeySecurityFields");
const securityPasswordEl = document.querySelector("#securityPassword");
const securityRawKeyEl = document.querySelector("#securityRawKey");
const generateRawKeyBtn = document.querySelector("#generateRawKeyBtn");
const securityHintEl = document.querySelector("#securityHint");
const generateBtn = document.querySelector("#generateBtn");
const downloadBtn = document.querySelector("#downloadBtn");
const canvas = document.querySelector("#qrCanvas");
const verificationPill = document.querySelector("#verificationPill");
const statsEl = document.querySelector("#stats");
const errorBox = document.querySelector("#errorBox");
const scanFileEl = document.querySelector("#scanFile");
const scanResultEl = document.querySelector("#scanResult");
const cameraVideo = document.querySelector("#cameraVideo");
const cameraFreezeFrame = document.querySelector("#cameraFreezeFrame");
const cameraOverlay = document.querySelector("#cameraOverlay");
const cameraHudText = document.querySelector("#cameraHudText");
const cameraFinderHud = document.querySelector("#cameraFinderHud");
const cameraLiveHud = document.querySelector(".camera-live-hud");
const cameraMethodStat = document.querySelector("#cameraMethodStat");
const cameraFinderStat = document.querySelector("#cameraFinderStat");
const cameraGeometryStat = document.querySelector("#cameraGeometryStat");
const cameraFrameStat = document.querySelector("#cameraFrameStat");
const cameraLog = document.querySelector("#cameraLog");
const copyCameraLogBtn = document.querySelector("#copyCameraLogBtn");
const startCameraBtn = document.querySelector("#startCameraBtn");
const stopCameraBtn = document.querySelector("#stopCameraBtn");
const cameraPill = document.querySelector("#cameraPill");
const cameraResultEl = document.querySelector("#cameraResult");
const tabButtons = [...document.querySelectorAll("[data-tab]")];
const tabViews = [...document.querySelectorAll("[data-view]")];
const benchmarkEccEl = document.querySelector("#benchmarkEcc");
const benchmarkIterationsEl = document.querySelector("#benchmarkIterations");
const runBenchmarkBtn = document.querySelector("#runBenchmarkBtn");
const benchmarkPill = document.querySelector("#benchmarkPill");
const capacityBenchmarkBody = document.querySelector("#capacityBenchmarkBody");
const speedBenchmarkBody = document.querySelector("#speedBenchmarkBody");

let currentCode = null;
let cameraController = null;
let cameraLogLines = [];
let lastCameraLogSignature = "";
let lastCameraFrameDiagnostic = null;
let lastCameraUiUpdate = 0;

function rebuildVersions() {
  const selected = versionEl.value || "auto";
  const ecc = eccLevelEl.value;
  versionEl.innerHTML = '<option value="auto">Auto smallest</option>';

  for (let version = 1; version <= MAX_VERSION; version++) {
    const info = getVersionInfo(version, { ecc });
    const option = document.createElement("option");
    option.value = String(version);
    option.textContent = `v${version} · ${info.size}×${info.size} · ${info.capacityBytes} B`;
    option.disabled = info.capacityBytes <= 0;
    versionEl.appendChild(option);
  }

  if ([...versionEl.options].some((option) => option.value === selected && !option.disabled)) {
    versionEl.value = selected;
  }
}

function setPill(element, state, text) {
  element.className = `pill ${state}`;
  element.textContent = text;
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove("hidden");
}

function clearError() {
  errorBox.textContent = "";
  errorBox.classList.add("hidden");
}

function updateStats(code) {
  const values = [
    `${code.size}×${code.size} (v${code.version})`,
    `${code.payloadBytes} B`,
    `${code.capacityBytes} B`,
    `${code.bitsPerDataCell} bits/cell`,
    `${code.eccLevel} · ${code.eccParitySymbols} parity bytes`,
    `${code.alignmentPatterns} pattern${code.alignmentPatterns === 1 ? "" : "s"}`,
    `${code.eccBlocks} · correct ${code.correctableSymbolsPerBlock}/block`,
    String(code.maskId),
    `${(code.utilization * 100).toFixed(1)}%`,
    code.secure
      ? `${code.security?.mode === "raw-key" ? "Raw key" : "Password"} · ${code.security?.overheadBytes ?? 0} B overhead`
      : "None",
    code.crc32.toString(16).padStart(8, "0").toUpperCase()
  ];

  [...statsEl.querySelectorAll("dd")].forEach((dd, index) => {
    dd.textContent = values[index];
  });
}

function securityOptionsFromGenerator() {
  const mode = securityModeEl.value;
  if (mode === "none") return null;
  if (mode === "password") {
    if (!securityPasswordEl.value) throw new Error("Enter a password for Secure Payload mode.");
    return { mode: "password", password: securityPasswordEl.value };
  }
  if (!securityRawKeyEl.value.trim()) throw new Error("Enter or generate a raw 256-bit key.");
  return { mode: "raw-key", key: securityRawKeyEl.value.trim() };
}

function updateSecurityUi() {
  const mode = securityModeEl.value;
  passwordSecurityFieldsEl.classList.toggle("hidden", mode !== "password");
  rawKeySecurityFieldsEl.classList.toggle("hidden", mode !== "raw-key");

  const hints = {
    none: "Standard mode stores the payload normally. Security is opt-in and does not alter QuadQR scanning or Spectrum ECC.",
    password: "Password mode derives a 256-bit AES key with PBKDF2-HMAC-SHA-256 and encrypts with AES-256-GCM. The salt, nonce, and KDF settings travel inside the protected payload.",
    "raw-key": "Raw-key mode uses an exact random 256-bit key directly with AES-256-GCM. QuadQR stores only a short SHA-256 key fingerprint so an app can identify the required key without exposing it."
  };
  securityHintEl.textContent = hints[mode] || hints.none;
}

function formatResult(container, result, titleText, options = {}) {
  const locked = result.secure && result.requiresDecryption;
  const payload = locked
    ? `[Encrypted secure payload · ${result.payload.length} bytes]`
    : (result.text ?? `[${result.payload.length} raw bytes]`);
  container.className = `scan-result good${locked ? " secure-locked" : ""}`;
  options.onSecurityState?.(locked ? "locked" : (result.decrypted ? "decrypted" : "decoded"), result);
  container.innerHTML = "";

  const title = document.createElement("strong");
  title.textContent = locked ? `${titleText} · encrypted` : titleText;

  const meta = document.createElement("div");
  const geometry = result.perspectiveCorrected ? "perspective corrected" : "axis aligned";
  const calibration = result.colorCalibrated ? "color calibrated" : "fixed palette";
  const spectrum = result.spectralInterleaving ? "spectral interleaving" : "legacy placement";
  const recovery = result.confidenceAssisted
    ? `${result.erasureSymbols ?? 0} confidence erasure(s) used`
    : "hard-decision ECC sufficient";
  meta.textContent =
    `v${result.version}, ECC ${result.eccLevel}, mask ${result.maskId}, ` +
    `${result.alignmentPatterns ?? result.geometry?.alignment?.patterns ?? 1} alignment pattern(s), ` +
    `${result.correctedSymbols ?? 0} RS byte symbols corrected, ${recovery}, ${spectrum}, ` +
    `${geometry}, ${calibration}, CRC ${result.crc32.toString(16).padStart(8, "0").toUpperCase()}`;

  container.append(title, meta);

  if (result.secure) {
    const secureMeta = document.createElement("div");
    secureMeta.className = "security-meta";
    const mode = result.security?.mode === "raw-key" ? "raw 256-bit key" : "password";
    const keyId = result.security?.keyId ?? result.security?.keyIdHex;
    secureMeta.textContent =
      `Secure Payload v${result.security?.securePayloadVersion ?? 1} · AES-256-GCM · ${mode}` +
      (keyId ? ` · key ID ${keyId}` : "") +
      (result.decrypted ? " · decrypted" : "");
    container.appendChild(secureMeta);
  }

  const data = document.createElement("pre");
  data.textContent = payload;
  data.style.whiteSpace = "pre-wrap";
  data.style.marginBottom = "0";
  container.appendChild(data);

  if (locked) {
    const label = document.createElement("div");
    label.className = "decrypt-label";
    label.textContent = result.security?.mode === "raw-key"
      ? "Enter the 64-character raw key to decrypt this payload."
      : "Enter the password to decrypt this payload.";

    const controls = document.createElement("div");
    controls.className = "decrypt-controls";
    const input = document.createElement("input");
    input.type = result.security?.mode === "raw-key" ? "text" : "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = result.security?.mode === "raw-key" ? "64 hex characters" : "Password";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = "Decrypt";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const credentials = result.security?.mode === "raw-key"
          ? { key: input.value.trim() }
          : { password: input.value };
        const decrypted = await decryptDecoded(result, credentials);
        formatResult(container, decrypted, `${titleText} · secure`, options);
      } catch (error) {
        const errorLine = document.createElement("div");
        errorLine.className = "error";
        errorLine.textContent = error.message;
        container.querySelector(".error")?.remove();
        container.appendChild(errorLine);
      } finally {
        button.disabled = false;
      }
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") button.click();
    });

    controls.append(input, button);
    container.append(label, controls);
  }
}

async function generate() {
  clearError();
  generateBtn.disabled = true;

  try {
    const requestedVersion = versionEl.value === "auto" ? "auto" : Number(versionEl.value);
    const security = securityOptionsFromGenerator();
    const commonOptions = {
      version: requestedVersion,
      ecc: eccLevelEl.value
    };
    const code = security
      ? await encodeSecureText(payloadEl.value, { ...commonOptions, security })
      : encodeText(payloadEl.value, commonOptions);

    renderToCanvas(code, canvas, {
      moduleSize: Number(moduleSizeEl.value),
      quietZone: 4,
      style: renderStyleEl.value
    });

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const scanned = scanImageData(imageData, {
      minVersion: code.version,
      maxVersion: code.version
    });
    const verified = scanned.secure ? await decryptDecoded(scanned, security) : scanned;

    if (verified.text !== payloadEl.value) {
      throw new Error("Generated image decoded, but payload did not match.");
    }

    currentCode = code;
    downloadBtn.disabled = false;
    updateStats(code);
    setPill(
      verificationPill,
      "good",
      code.secure ? "Secure + Spectrum ECC verified" : "Spectrum ECC verified"
    );
  } catch (error) {
    currentCode = null;
    downloadBtn.disabled = true;
    setPill(verificationPill, "bad", "Verification failed");
    showError(error.message);
  } finally {
    generateBtn.disabled = false;
  }
}


function formatMs(value) {
  return `${value.toFixed(3)} ms`;
}

function renderCapacityBenchmark() {
  const rows = buildCapacityComparison({
    ecc: benchmarkEccEl.value,
    versions: [1, 2, 5, 10, 20, 30, 40]
  });

  capacityBenchmarkBody.innerHTML = "";
  for (const row of rows) {
    const tr = document.createElement("tr");
    const ratio = row.ratio == null ? "n/a" : `${row.ratio.toFixed(2)}×`;
    const values = [
      `v${row.version}`,
      `${row.size}×${row.size}`,
      `${row.quadqrBytes} B`,
      `${row.standardQrBytes} B`,
      `${row.differenceBytes >= 0 ? "+" : ""}${row.differenceBytes} B`,
      ratio
    ];
    const labels = ["Version", "Matrix", "QuadQR", "Standard QR", "Difference", "Ratio"];
    values.forEach((value, index) => {
      const td = document.createElement("td");
      td.textContent = value;
      td.dataset.label = labels[index];
      tr.appendChild(td);
    });
    capacityBenchmarkBody.appendChild(tr);
  }
}

async function runBenchmark() {
  runBenchmarkBtn.disabled = true;
  setPill(benchmarkPill, "neutral", "Running");
  speedBenchmarkBody.innerHTML = '<tr><td colspan="6" class="muted-cell">Running benchmark...</td></tr>';

  // Let the UI paint before the synchronous benchmark loop starts.
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));

  try {
    renderCapacityBenchmark();
    const report = benchmarkCodec({
      ecc: benchmarkEccEl.value,
      iterations: Number(benchmarkIterationsEl.value),
      payloadSizes: [32, 128, 512, 1024, 2048]
    });

    speedBenchmarkBody.innerHTML = "";
    for (const row of report.results) {
      const tr = document.createElement("tr");
      if (row.skipped) {
        const payload = document.createElement("td");
        payload.textContent = `${row.payloadBytes} B`;
        payload.dataset.label = "Payload";
        const reason = document.createElement("td");
        reason.colSpan = 5;
        reason.textContent = row.reason;
        reason.className = "muted-cell";
        tr.append(payload, reason);
      } else {
        const values = [
          `${row.payloadBytes} B`,
          `${row.size}×${row.size} (v${row.version})`,
          formatMs(row.encode.meanMs),
          formatMs(row.encode.p95Ms),
          formatMs(row.decode.meanMs),
          formatMs(row.decode.p95Ms)
        ];
        const labels = ["Payload", "Matrix", "Encode mean", "Encode p95", "Decode mean", "Decode p95"];
        values.forEach((value, index) => {
          const td = document.createElement("td");
          td.textContent = value;
          td.dataset.label = labels[index];
          tr.appendChild(td);
        });
      }
      speedBenchmarkBody.appendChild(tr);
    }
    setPill(benchmarkPill, "good", "Complete");
  } catch (error) {
    speedBenchmarkBody.innerHTML = "";
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6;
    td.className = "muted-cell";
    td.textContent = error.message;
    tr.appendChild(td);
    speedBenchmarkBody.appendChild(tr);
    setPill(benchmarkPill, "bad", "Failed");
  } finally {
    runBenchmarkBtn.disabled = false;
  }
}

function friendlyScanMethod(method) {
  const names = {
    "camera": "Camera",
    "fast-scan": "Fast scan",
    "finder-recovery": "Finder recovery",
    "camera-auto-color": "Camera Auto Color",
    "progressive-color-recovery": "Color recovery",
    "qr-region-auto-enhance": "QR color enhance",
    "module-grid-auto-tone-contrast-color": "Module auto enhance",
    "rectified-auto-tone-contrast-color": "Rectified auto enhance",
    "multi-frame-vote": "Multi-frame ECC",
    "refined-center": "Geometry refine",
    "cross": "Fast scan",
    "median": "Robust sample"
  };
  if (!method) return "Searching";
  if (names[method]) return names[method];
  if (String(method).startsWith("camera-auto-color-")) return "Camera Auto Color";
  if (String(method).includes("auto-tone-contrast-color")) return "Auto Tone / Contrast / Color";
  return String(method).replaceAll("-", " ");
}

function friendlyFinderMethod(method) {
  const names = {
    "rgb-value-otsu": "RGB value/Otsu",
    "auto-color-value-otsu": "Auto Color value/Otsu",
    "rgb-value-high-threshold": "RGB value/high threshold",
    "rgb-value-low-threshold": "RGB value/low threshold",
    "luminance-otsu": "Luminance/Otsu"
  };
  if (!method) return "";
  if (names[method]) return names[method];
  const match = String(method).match(/^auto-color-center(\d+)-(otsu|high)$/);
  if (match) return `Auto Color center ${Number(match[1])}%/${match[2] === "otsu" ? "Otsu" : "high"}`;
  return String(method).replaceAll("-", " ");
}

function bestDiagnosticPass(diagnostic) {
  const passes = diagnostic?.vision?.passes;
  if (!Array.isArray(passes) || !passes.length) return diagnostic?.bestPass ?? null;
  return passes.slice().sort((a, b) => {
    const ag = a.geometries?.[0];
    const bg = b.geometries?.[0];
    return (Boolean(bg) - Boolean(ag)) ||
      ((b.finderCount ?? 0) - (a.finderCount ?? 0)) ||
      ((bg?.score ?? 0) - (ag?.score ?? 0));
  })[0];
}

function resetCameraDiagnosticsUi() {
  lastCameraFrameDiagnostic = null;
  lastCameraUiUpdate = 0;
  cameraMethodStat.textContent = "Idle";
  cameraFinderStat.textContent = "0 / 3";
  cameraGeometryStat.textContent = "Not found";
  cameraFrameStat.textContent = "--";
  cameraHudText.textContent = "Idle";
  cameraFinderHud.textContent = "Finders 0/3";
  cameraFinderHud.classList.remove("found");
  cameraLiveHud.classList.remove("scanning", "found", "locked");
  clearCameraOverlay();
}

function resetCameraLog() {
  cameraLogLines = [];
  lastCameraLogSignature = "";
  cameraLog.innerHTML = '<div class="scanner-log-line muted">Camera diagnostics ready.</div>';
}

function formatLogTime(timestamp) {
  return new Date(timestamp ?? Date.now()).toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function appendCameraLog(message, level = "", signature = message) {
  if (!message || signature === lastCameraLogSignature) return;
  lastCameraLogSignature = signature;
  const line = `${formatLogTime(Date.now())}  ${message}`;
  cameraLogLines.push(line);
  if (cameraLogLines.length > 40) cameraLogLines.shift();

  const element = document.createElement("div");
  element.className = `scanner-log-line${level ? ` ${level}` : ""}`;
  element.textContent = line;
  cameraLog.appendChild(element);
  while (cameraLog.children.length > 40) cameraLog.firstElementChild?.remove();
  cameraLog.scrollTop = cameraLog.scrollHeight;
}

function clearCameraOverlay() {
  if (!cameraOverlay) return;
  const ctx = cameraOverlay.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, cameraOverlay.width, cameraOverlay.height);
}

function clearFrozenCameraFrame() {
  if (!cameraFreezeFrame) return;
  cameraFreezeFrame.classList.remove("visible");
  const ctx = cameraFreezeFrame.getContext("2d");
  if (ctx && cameraFreezeFrame.width && cameraFreezeFrame.height) {
    ctx.clearRect(0, 0, cameraFreezeFrame.width, cameraFreezeFrame.height);
  }
}

function freezeCapturedCameraFrame(frameMeta) {
  const imageData = frameMeta?.imageData;
  if (!cameraFreezeFrame || !imageData?.data || !imageData.width || !imageData.height) {
    return freezeCurrentCameraFrame();
  }

  // Keep the exact pixel buffer that was decoded. Do not grab the live <video>
  // again here: by the time onResult runs the camera may already be presenting
  // the next sensor frame, which made the frozen image and finder overlay drift
  // apart even though both were individually correct. The scanner's captured
  // ROI and its diagnostics share the same coordinate system, so rendering this
  // buffer 1:1 guarantees the locked overlay matches the successful frame.
  cameraFreezeFrame.width = imageData.width;
  cameraFreezeFrame.height = imageData.height;
  const ctx = cameraFreezeFrame.getContext("2d", { alpha: false });
  if (!ctx) return false;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.putImageData(imageData, 0, 0);
  cameraFreezeFrame.classList.add("visible");
  return true;
}

function freezeCurrentCameraFrame() {
  if (!cameraFreezeFrame || !cameraVideo.videoWidth || !cameraVideo.videoHeight) return false;
  const rect = cameraVideo.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cameraFreezeFrame.width = Math.max(1, Math.round(rect.width * dpr));
  cameraFreezeFrame.height = Math.max(1, Math.round(rect.height * dpr));
  const ctx = cameraFreezeFrame.getContext("2d", { alpha: false });
  if (!ctx) return false;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Reproduce the demo video's object-fit: cover crop exactly so the frozen
  // success frame stays aligned with the finder overlay after camera tracks
  // are stopped and the live video element loses its source.
  const sourceWidth = cameraVideo.videoWidth;
  const sourceHeight = cameraVideo.videoHeight;
  const scale = Math.max(rect.width / sourceWidth, rect.height / sourceHeight);
  let cropWidth = Math.min(sourceWidth, rect.width / scale);
  let cropHeight = Math.min(sourceHeight, rect.height / scale);
  const sourceX = Math.max(0, (sourceWidth - cropWidth) / 2);
  const sourceY = Math.max(0, (sourceHeight - cropHeight) / 2);
  cropWidth = Math.min(cropWidth, sourceWidth - sourceX);
  cropHeight = Math.min(cropHeight, sourceHeight - sourceY);

  ctx.drawImage(
    cameraVideo,
    sourceX, sourceY, cropWidth, cropHeight,
    0, 0, rect.width, rect.height
  );
  cameraFreezeFrame.classList.add("visible");
  return true;
}

function prepareOverlayCanvas() {
  const rect = cameraVideo.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (cameraOverlay.width !== width || cameraOverlay.height !== height) {
    cameraOverlay.width = width;
    cameraOverlay.height = height;
  }
  const ctx = cameraOverlay.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  return { ctx, width: rect.width, height: rect.height };
}

function drawFinderBox(ctx, finder, sx, sy, label, confirmed, offsetX = 0, offsetY = 0) {
  const x = (finder.x + offsetX) * sx;
  const y = (finder.y + offsetY) * sy;
  const moduleX = finder.moduleSize * sx;
  const moduleY = finder.moduleSize * sy;
  const size = Math.max(22, Math.min(140, ((moduleX + moduleY) / 2) * 7.35));
  const left = x - size / 2;
  const top = y - size / 2;
  const corner = Math.max(8, Math.min(18, size * 0.24));
  const color = confirmed ? "rgba(77, 238, 137, 0.98)" : "rgba(250, 204, 92, 0.95)";

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = confirmed ? 2.4 : 1.8;
  ctx.lineCap = "round";
  ctx.shadowColor = confirmed ? "rgba(77, 238, 137, 0.42)" : "rgba(250, 204, 92, 0.28)";
  ctx.shadowBlur = 8;

  ctx.beginPath();
  ctx.moveTo(left + corner, top); ctx.lineTo(left, top); ctx.lineTo(left, top + corner);
  ctx.moveTo(left + size - corner, top); ctx.lineTo(left + size, top); ctx.lineTo(left + size, top + corner);
  ctx.moveTo(left, top + size - corner); ctx.lineTo(left, top + size); ctx.lineTo(left + corner, top + size);
  ctx.moveTo(left + size - corner, top + size); ctx.lineTo(left + size, top + size); ctx.lineTo(left + size, top + size - corner);
  ctx.stroke();

  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(x, y, 2.5, 0, Math.PI * 2);
  ctx.fill();

  if (label) {
    ctx.font = "700 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    const textWidth = ctx.measureText(label).width;
    const tx = Math.max(4, Math.min(left, cameraVideo.clientWidth - textWidth - 12));
    const ty = Math.max(15, top - 7);
    ctx.fillStyle = "rgba(3, 8, 11, 0.82)";
    ctx.fillRect(tx - 4, ty - 11, textWidth + 8, 15);
    ctx.fillStyle = color;
    ctx.fillText(label, tx, ty);
  }
  ctx.restore();
}

function drawCameraFinderOverlay(diagnostic) {
  const prepared = prepareOverlayCanvas();
  if (!prepared) return;
  const { ctx, width, height } = prepared;
  const scanWidth = diagnostic?.scanWidth;
  const scanHeight = diagnostic?.scanHeight;
  if (!scanWidth || !scanHeight) return;
  const frameWidth = diagnostic?.frameWidth ?? scanWidth;
  const frameHeight = diagnostic?.frameHeight ?? scanHeight;
  const scanRect = diagnostic?.scanRect ?? { x: 0, y: 0, width: scanWidth, height: scanHeight };
  const sx = width / frameWidth;
  const sy = height / frameHeight;
  const offsetX = scanRect.x ?? 0;
  const offsetY = scanRect.y ?? 0;
  const pass = bestDiagnosticPass(diagnostic);
  if (!pass) return;

  const geometry = pass.geometries?.[0] ?? diagnostic.geometry;
  if (geometry?.finders) {
    const points = [
      [geometry.finders.topLeft, "TL"],
      [geometry.finders.topRight, "TR"],
      [geometry.finders.bottomLeft, "BL"]
    ];

    ctx.save();
    ctx.strokeStyle = "rgba(77, 238, 137, 0.35)";
    ctx.lineWidth = 1.25;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo((points[0][0].x + offsetX) * sx, (points[0][0].y + offsetY) * sy);
    ctx.lineTo((points[1][0].x + offsetX) * sx, (points[1][0].y + offsetY) * sy);
    ctx.moveTo((points[0][0].x + offsetX) * sx, (points[0][0].y + offsetY) * sy);
    ctx.lineTo((points[2][0].x + offsetX) * sx, (points[2][0].y + offsetY) * sy);
    ctx.stroke();
    ctx.restore();

    for (const [finder, label] of points) drawFinderBox(ctx, finder, sx, sy, label, true, offsetX, offsetY);
    return;
  }

  const candidates = (pass.finders ?? []).slice(0, 6);
  for (let i = 0; i < candidates.length; i++) {
    drawFinderBox(ctx, candidates[i], sx, sy, `F${i + 1}`, false, offsetX, offsetY);
  }
}

function updateCameraDiagnosticSummary(diagnostic) {
  if (!diagnostic) return;
  if (diagnostic.type === "frame") lastCameraFrameDiagnostic = diagnostic;
  const active = diagnostic.type === "frame" ? diagnostic : (lastCameraFrameDiagnostic ?? diagnostic);
  const pass = bestDiagnosticPass(active);
  const finderCount = Math.min(3, active.finderCount ?? pass?.finderCount ?? 0);
  const geometry = active.geometry ?? pass?.geometries?.[0] ?? null;
  const method = friendlyScanMethod(diagnostic.method ?? active.method);
  const finderMethod = active.finderMethod ?? pass?.finderMethod ?? null;
  const finderMethodText = friendlyFinderMethod(finderMethod);

  cameraMethodStat.textContent = finderMethodText ? `${method} · ${finderMethodText}` : method;
  cameraFinderStat.textContent = `${finderCount} / 3`;
  cameraGeometryStat.textContent = geometry
    ? `v${geometry.version} · ${Math.round((geometry.alignmentGridScore ?? geometry.alignmentScore ?? 0) * 100)}%`
    : (finderCount >= 3 ? "Validating" : "Not found");
  cameraFrameStat.textContent = active.frame
    ? `#${active.frame}${active.elapsedMs != null ? ` · ${Math.round(active.elapsedMs)} ms` : ""}`
    : "--";

  cameraFinderHud.textContent = `Finders ${finderCount}/3`;
  cameraFinderHud.classList.toggle("found", finderCount >= 3);
  cameraHudText.textContent = geometry ? `${method} · v${geometry.version}` : method;
  cameraLiveHud.classList.toggle("found", finderCount >= 3);
  cameraLiveHud.classList.toggle("scanning", diagnostic.state !== "decoded" && finderCount < 3);

  if (active.scanWidth && active.scanHeight) drawCameraFinderOverlay(active);
}

function handleCameraDiagnostic(diagnostic) {
  const now = performance.now();
  if (diagnostic.type !== "frame" || now - lastCameraUiUpdate >= 120) {
    updateCameraDiagnosticSummary(diagnostic);
    lastCameraUiUpdate = now;
  }

  const pass = bestDiagnosticPass(diagnostic);
  const finderCount = diagnostic.finderCount ?? pass?.finderCount ?? 0;
  const geometry = diagnostic.geometry ?? pass?.geometries?.[0] ?? null;

  if (diagnostic.type === "camera-ready") {
    appendCameraLog(diagnostic.message, "good", "camera-ready");
    return;
  }

  if (diagnostic.type === "method") {
    appendCameraLog(
      diagnostic.message,
      diagnostic.state === "failed" ? "warn" : "",
      `${diagnostic.method}:${diagnostic.state}`
    );
    return;
  }

  if (diagnostic.type === "success") {
    cameraLiveHud.classList.add("locked");
    appendCameraLog(diagnostic.message, "good", `success:${diagnostic.method}`);
    return;
  }

  if (diagnostic.type === "frame") {
    const geometryText = geometry
      ? ` · v${geometry.version} geometry ${Math.round((geometry.alignmentGridScore ?? geometry.alignmentScore ?? 0) * 100)}%`
      : "";
    const finderText = `${finderCount} finder${finderCount === 1 ? "" : "s"}`;
    const method = friendlyScanMethod(diagnostic.method);
    const finderMethod = diagnostic.finderMethod ?? pass?.finderMethod ?? null;
    const finderMethodText = friendlyFinderMethod(finderMethod);
    const finderPasses = Array.isArray(diagnostic.finderPasses) ? diagnostic.finderPasses : [];
    const passSummary = finderPasses.length > 1
      ? ` · locator ${finderPasses.map((item) => `${friendlyFinderMethod(item.method)}:${item.finderCount}`).join(" → ")}`
      : (finderMethodText ? ` · locator ${finderMethodText}` : "");

    // Log significant state transitions, not every 160 ms frame. This keeps
    // mobile DOM work tiny while the summary and overlay can still update live.
    const bucket = finderCount >= 3 ? "3+" : String(finderCount);
    const signature = `frame:${bucket}:${geometry?.version ?? "none"}:${Math.floor((diagnostic.missStreak ?? 0) / 8)}`;
    if (signature !== lastCameraLogSignature) {
      appendCameraLog(
        `${method} · ${finderText}${geometryText}${passSummary} · ${Math.round(diagnostic.elapsedMs ?? 0)} ms`,
        finderCount >= 3 ? "good" : "muted",
        signature
      );
    }
  }
}

async function copyCameraDiagnostics() {
  const snapshot = [
    `QuadQR camera diagnostics`,
    `Method: ${cameraMethodStat.textContent}`,
    `Finders: ${cameraFinderStat.textContent}`,
    `Geometry: ${cameraGeometryStat.textContent}`,
    `Frame: ${cameraFrameStat.textContent}`,
    "",
    ...cameraLogLines
  ].join("\n");
  try {
    await navigator.clipboard.writeText(snapshot);
    copyCameraLogBtn.textContent = "Copied";
    setTimeout(() => { copyCameraLogBtn.textContent = "Copy log"; }, 1200);
  } catch {
    copyCameraLogBtn.textContent = "Copy failed";
    setTimeout(() => { copyCameraLogBtn.textContent = "Copy log"; }, 1200);
  }
}

async function stopCamera() {
  cameraController?.stop();
  cameraController = null;
  clearFrozenCameraFrame();
  startCameraBtn.disabled = false;
  stopCameraBtn.disabled = true;
  setPill(cameraPill, "neutral", "Stopped");
  cameraHudText.textContent = "Stopped";
  cameraLiveHud.classList.remove("scanning", "found", "locked");
  clearCameraOverlay();
  appendCameraLog("Camera stopped", "muted", "camera-stopped");
}

function activateTab(tabName) {
  for (const button of tabButtons) {
    button.classList.toggle("active", button.dataset.tab === tabName);
  }
  for (const view of tabViews) {
    const active = view.dataset.view === tabName;
    view.classList.toggle("active", active);
    view.hidden = !active;
  }
  if (tabName !== "camera" && cameraController) stopCamera();
}

for (const button of tabButtons) {
  button.addEventListener("click", () => activateTab(button.dataset.tab));
}

generateBtn.addEventListener("click", generate);
securityModeEl.addEventListener("change", () => {
  updateSecurityUi();
  currentCode = null;
  downloadBtn.disabled = true;
  setPill(verificationPill, "neutral", "Security changed");
});
generateRawKeyBtn.addEventListener("click", () => {
  securityRawKeyEl.value = bytesToHex(generateRaw256Key());
  securityRawKeyEl.focus();
});
moduleSizeEl.addEventListener("change", () => currentCode && generate());
renderStyleEl.addEventListener("change", () => {
  const hints = {
    classic: "Classic keeps every module fully solid. Styles only change rendering, never the encoded data.",
    depth: "Depth deterministically mixes solid and lightly faded data tiles with subtle edge shading. Structural and calibration cells stay solid.",
    soft: "Soft rounds only data tiles while keeping locator, timing, alignment, and calibration structures square and solid.",
    inset: "Inset uses narrow recessed edge lighting while preserving the exact R/G/B/W center of every data tile."
  };
  styleHintEl.textContent = hints[renderStyleEl.value] || hints.classic;
  if (currentCode) generate();
});
eccLevelEl.addEventListener("change", () => {
  rebuildVersions();
  generate();
});

downloadBtn.addEventListener("click", () => {
  if (!currentCode) return;
  const link = document.createElement("a");
  link.download = `quadqr-v${currentCode.version}-${currentCode.eccLevel}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
});

scanFileEl.addEventListener("change", async () => {
  const file = scanFileEl.files?.[0];
  if (!file) return;
  scanResultEl.className = "scan-result";
  scanResultEl.textContent = "Scanning image...";

  try {
    const result = await scanFile(file);
    formatResult(scanResultEl, result, "Verified QuadQR");
  } catch (error) {
    scanResultEl.className = "scan-result bad";
    scanResultEl.textContent = error.message;
  }
});

startCameraBtn.addEventListener("click", async () => {
  if (cameraController) return;
  startCameraBtn.disabled = true;
  clearFrozenCameraFrame();
  resetCameraDiagnosticsUi();
  resetCameraLog();
  cameraHudText.textContent = "Requesting camera";
  cameraLiveHud.classList.add("scanning");
  cameraResultEl.className = "scan-result";
  cameraResultEl.textContent = "Requesting camera permission...";
  setPill(cameraPill, "neutral", "Starting");

  try {
    cameraController = await startCameraScanner(cameraVideo, {
      scanInterval: 160,
      maxDimension: 1080,
      stopOnResult: true,
      onDiagnostic: handleCameraDiagnostic,
      onResult(result, frameMeta) {
        // Freeze the exact frame buffer that produced this decode, not a fresh
        // read from the live video. This also lets us lock the overlay to the
        // diagnostics from the very same frame.
        freezeCapturedCameraFrame(frameMeta);
        if (frameMeta?.diagnostic) {
          lastCameraFrameDiagnostic = {
            type: "frame",
            state: "decoded",
            frame: frameMeta.frame,
            ...frameMeta.diagnostic
          };
          drawCameraFinderOverlay(lastCameraFrameDiagnostic);
        }
        formatResult(cameraResultEl, result, "Camera scan verified", {
          onSecurityState(state) {
            if (state === "locked") setPill(cameraPill, "neutral", "Secure QR");
            else if (state === "decrypted") setPill(cameraPill, "good", "Decrypted");
            else setPill(cameraPill, "good", "Decoded");
          }
        });
        cameraHudText.textContent = `Decoded v${result.version}`;
        cameraLiveHud.classList.remove("scanning");
        cameraLiveHud.classList.add("locked");
        cameraController = null;
        startCameraBtn.disabled = false;
        stopCameraBtn.disabled = true;
      },
      onScanMiss() {
        if (cameraController) setPill(cameraPill, "neutral", "Searching");
      }
    });

    stopCameraBtn.disabled = false;
    cameraResultEl.className = "scan-result empty";
    cameraResultEl.textContent = "Point the camera at a QuadQR code.";
    setPill(cameraPill, "neutral", "Searching");
  } catch (error) {
    cameraController = null;
    startCameraBtn.disabled = false;
    stopCameraBtn.disabled = true;
    setPill(cameraPill, "bad", "Camera error");
    cameraHudText.textContent = "Camera error";
    cameraLiveHud.classList.remove("scanning", "found", "locked");
    clearCameraOverlay();
    appendCameraLog(`Camera error · ${error.message}`, "warn", `camera-error:${error.message}`);
    cameraResultEl.className = "scan-result bad";
    cameraResultEl.textContent = error.message;
  }
});

copyCameraLogBtn.addEventListener("click", copyCameraDiagnostics);
window.addEventListener("resize", () => {
  if (lastCameraFrameDiagnostic) drawCameraFinderOverlay(lastCameraFrameDiagnostic);
});
stopCameraBtn.addEventListener("click", stopCamera);
benchmarkEccEl.addEventListener("change", renderCapacityBenchmark);
runBenchmarkBtn.addEventListener("click", runBenchmark);
window.addEventListener("pagehide", () => cameraController?.stop());

resetCameraDiagnosticsUi();
updateSecurityUi();
rebuildVersions();
renderCapacityBenchmark();
generate();
