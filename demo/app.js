import {
  encodeText,
  encodeSignedText,
  encodeSecureText,
  decryptDecoded,
  verifyDecodedSignature,
  generateSigningKeyPair,
  generateRaw256Key,
  bytesToHex,
  renderToCanvas,
  renderToSVG,
  scanImageData,
  scanFile,
  startCameraScanner,
  runImageStressTest,
  runReliabilityLab,
  runPerspectiveSweep,
  applyStressDistortion,
  estimateSafeLogoSize,
  getPrintGuidance,
  getVersionInfo,
  MAX_VERSION
} from "../library/quadqr.js";
import { buildCapacityComparison, benchmarkCodec, calculateCapacityPlan } from "../library/benchmark.js";

const payloadEl = document.querySelector("#payload");
const versionEl = document.querySelector("#version");
const eccLevelEl = document.querySelector("#eccLevel");
const highDensityModeEl = document.querySelector("#highDensityMode");
const imageSizeEl = document.querySelector("#imageSize");
const quietZoneEl = document.querySelector("#quietZone");
const renderStyleEl = document.querySelector("#renderStyle");
const renderModeEl = document.querySelector("#renderMode");
const styleHintEl = document.querySelector("#styleHint");
const compressionModeEl = document.querySelector("#compressionMode");
const logoFileEl = document.querySelector("#logoFile");
const logoUploadEl = document.querySelector("#logoUpload");
const logoFileNameEl = document.querySelector("#logoFileName");
const logoFileMetaEl = document.querySelector("#logoFileMeta");
const logoEnabledEl = document.querySelector("#logoEnabled");
const removeLogoBtn = document.querySelector("#removeLogoBtn");
const logoSizeEl = document.querySelector("#logoSize");
const logoClearBackgroundEl = document.querySelector("#logoClearBackground");
const signPayloadEl = document.querySelector("#signPayload");
const signingFieldsEl = document.querySelector("#signingFields");
const signingKeyIdEl = document.querySelector("#signingKeyId");
const generateSigningKeyBtn = document.querySelector("#generateSigningKeyBtn");
const signingKeyStatusEl = document.querySelector("#signingKeyStatus");
const securityModeEl = document.querySelector("#securityMode");
const passwordSecurityFieldsEl = document.querySelector("#passwordSecurityFields");
const rawKeySecurityFieldsEl = document.querySelector("#rawKeySecurityFields");
const securityPasswordEl = document.querySelector("#securityPassword");
const securityRawKeyEl = document.querySelector("#securityRawKey");
const generateRawKeyBtn = document.querySelector("#generateRawKeyBtn");
const securityHintEl = document.querySelector("#securityHint");
const generateBtn = document.querySelector("#generateBtn");
const downloadBtn = document.querySelector("#downloadBtn");
const downloadSvgBtn = document.querySelector("#downloadSvgBtn");
const canvas = document.querySelector("#qrCanvas");
const qrPreviewEl = document.querySelector("#qrPreview");
const verificationPill = document.querySelector("#verificationPill");
const statsEl = document.querySelector("#stats");
const scanabilityBtn = document.querySelector("#scanabilityBtn");
const scanabilityScoreEl = document.querySelector("#scanabilityScore");
const scanabilityMetaEl = document.querySelector("#scanabilityMeta");
const scanabilityResultsEl = document.querySelector("#scanabilityResults");
const errorBox = document.querySelector("#errorBox");
const scanFileEl = document.querySelector("#scanFile");
const scanResultEl = document.querySelector("#scanResult");
const scanDebugEl = document.querySelector("#scanDebug");
const scanDebugOutputEl = document.querySelector("#scanDebugOutput");
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
const capacityPayloadBytesEl = document.querySelector("#capacityPayloadBytes");
const capacityEccEl = document.querySelector("#capacityEcc");
const capacityHighDensityEl = document.querySelector("#capacityHighDensity");
const capacitySignedEl = document.querySelector("#capacitySigned");
const capacityCompressionEl = document.querySelector("#capacityCompression");
const calculateCapacityBtn = document.querySelector("#calculateCapacityBtn");
const capacityPlanResultEl = document.querySelector("#capacityPlanResult");
const stressCanvas = document.querySelector("#stressCanvas");
const reliabilityPill = document.querySelector("#reliabilityPill");
const reliabilityScoreEl = document.querySelector("#reliabilityScore");
const reliabilityRatingEl = document.querySelector("#reliabilityRating");
const reliabilityPassedEl = document.querySelector("#reliabilityPassed");
const reliabilityConfidenceEl = document.querySelector("#reliabilityConfidence");
const reliabilityWeakestEl = document.querySelector("#reliabilityWeakest");
const reliabilitySuiteEl = document.querySelector("#reliabilitySuite");
const reliabilityImageScaleEl = document.querySelector("#reliabilityImageScale");
const runReliabilityBtn = document.querySelector("#runReliabilityBtn");
const reliabilityStatusEl = document.querySelector("#reliabilityStatus");
const reliabilityResultsBody = document.querySelector("#reliabilityResultsBody");
const perspectivePitchEl = document.querySelector("#perspectivePitch");
const perspectiveYawEl = document.querySelector("#perspectiveYaw");
const perspectiveRollEl = document.querySelector("#perspectiveRoll");
const perspectivePitchValueEl = document.querySelector("#perspectivePitchValue");
const perspectiveYawValueEl = document.querySelector("#perspectiveYawValue");
const perspectiveRollValueEl = document.querySelector("#perspectiveRollValue");
const testPerspectiveBtn = document.querySelector("#testPerspectiveBtn");
const runPerspectiveSweepBtn = document.querySelector("#runPerspectiveSweepBtn");
const perspectiveSweepAxisEl = document.querySelector("#perspectiveSweepAxis");
const perspectiveResultEl = document.querySelector("#perspectiveResult");
const perspectiveSweepResultsEl = document.querySelector("#perspectiveSweepResults");

let currentCode = null;
let currentRenderOptions = null;
let currentLogoImage = null;
let currentLogoDataUrl = null;
let signingKeyPair = null;
let cameraController = null;
let cameraLogLines = [];
let lastCameraLogSignature = "";
let lastCameraFrameDiagnostic = null;
let lastCameraUiUpdate = 0;

function highDensityEnabled(element) {
  return element?.value === "true";
}

function rebuildVersions() {
  const selected = versionEl.value || "auto";
  const ecc = eccLevelEl.value;
  versionEl.innerHTML = '<option value="auto">Auto smallest</option>';

  for (let version = 1; version <= MAX_VERSION; version++) {
    const info = getVersionInfo(version, { ecc, highDensity: highDensityEnabled(highDensityModeEl) });
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

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("Unable to read logo image."));
    reader.readAsDataURL(file);
  });
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to load the selected logo image."));
    image.src = source;
  });
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function updateLogoUploadUi(file = null) {
  const hasFile = Boolean(file);
  logoUploadEl.classList.toggle("has-file", hasFile);
  logoFileNameEl.textContent = file?.name || "Choose a logo";
  logoFileMetaEl.textContent = file
    ? [file.type?.replace("image/", "").replace("svg+xml", "SVG").toUpperCase(), formatFileSize(file.size)].filter(Boolean).join(" · ")
    : "PNG, JPG, WEBP or SVG";
  logoEnabledEl.disabled = !hasFile;
  removeLogoBtn.disabled = !hasFile;
  if (!hasFile) logoEnabledEl.checked = false;
}

function updateSvgPreview(svg) {
  qrPreviewEl.innerHTML = svg.replace(/^<\?xml[^>]*>\s*/i, "");
  const element = qrPreviewEl.querySelector("svg");
  if (!element) return;
  element.removeAttribute("width");
  element.removeAttribute("height");
  element.setAttribute("aria-hidden", "true");
}

function generatorRenderOptions({ svg = false } = {}) {
  const options = {
    imageSize: Number(imageSizeEl.value),
    quietZone: Number(quietZoneEl.value),
    style: renderStyleEl.value,
    mode: renderModeEl.value
  };

  if (logoEnabledEl.checked && currentLogoImage && currentLogoDataUrl) {
    options.logo = {
      source: svg ? currentLogoDataUrl : currentLogoImage,
      size: logoSizeEl.value === "auto" ? "auto" : Number(logoSizeEl.value),
      clearBackground: logoClearBackgroundEl.checked,
      padding: 0.65,
      radius: 0.8
    };
  }

  return options;
}

function updateStats(code) {
  const values = [
    `${code.size}×${code.size} (v${code.version})`,
    `${Number(imageSizeEl.value)}×${Number(imageSizeEl.value)} px`,
    code.sourcePayloadBytes !== code.payloadBytes ? `${code.sourcePayloadBytes} B source · ${code.payloadBytes} B encoded` : `${code.payloadBytes} B`,
    `${code.capacityBytes} B`,
    `${code.bitsPerDataCell} bits/cell · ${code.highDensity ? "High Density · Experimental" : "Normal RGBW"}`,
    `${code.eccLevel} · ${code.eccParitySymbols} parity bytes`,
    `${code.alignmentPatterns} pattern${code.alignmentPatterns === 1 ? "" : "s"}`,
    `${code.eccBlocks} · correct ${code.correctableSymbolsPerBlock}/block`,
    String(code.maskId),
    `${(code.utilization * 100).toFixed(1)}%`,
    [
      code.compressed ? "LZ compressed" : null,
      code.signed ? "Ed25519 signed" : null,
      code.secure ? `${code.security?.mode === "raw-key" ? "Raw key" : "Password"} encrypted` : null
    ].filter(Boolean).join(" · ") || "None",
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


function signingOptionsFromGenerator() {
  if (!signPayloadEl.checked) return null;
  if (!signingKeyPair) throw new Error("Generate an Ed25519 signing key pair before creating a signed QuadQR.");
  return {
    privateKey: signingKeyPair.privateKey,
    keyId: signingKeyIdEl.value.trim() || signingKeyPair.keyId
  };
}

function updateSigningUi() {
  signingFieldsEl.classList.toggle("hidden", !signPayloadEl.checked);
  if (!signPayloadEl.checked) return;
  signingKeyStatusEl.textContent = signingKeyPair
    ? `Ready · key ID ${signingKeyPair.keyId} · public key kept outside QR`
    : "No signing key generated.";
}

function updateRenderModeUi() {
  const print = renderModeEl.value === "print";
  renderStyleEl.disabled = print;
  if (print && Number(quietZoneEl.value) < 4) quietZoneEl.value = "4";
  if (print) {
    styleHintEl.textContent = "Print mode forces Classic rendering, a minimum 4-module quiet zone, and darker print-safe RGB primaries. Use getPrintGuidance() when physical dimensions are known.";
  }
}

async function encodeGeneratorPayload(commonOptions, security, signing) {
  const compression = compressionModeEl.value;
  if (security) {
    return encodeSecureText(payloadEl.value, {
      ...commonOptions,
      compression,
      security,
      ...(signing ? { signing } : {})
    });
  }
  if (signing) {
    return encodeSignedText(payloadEl.value, {
      ...commonOptions,
      compression,
      ...signing
    });
  }
  return encodeText(payloadEl.value, { ...commonOptions, compression });
}

function demoSignatureVerificationOptions(result) {
  if (!signingKeyPair || !result?.signed) return null;
  if (result.signingKeyId && result.signingKeyId !== signingKeyPair.keyId && result.signingKeyId !== signingKeyIdEl.value.trim()) return null;
  return { publicKey: signingKeyPair.publicKey };
}

async function tryVerifyWithDemoKey(result) {
  const options = demoSignatureVerificationOptions(result);
  if (!options) return result;
  try {
    return await verifyDecodedSignature(result, options);
  } catch {
    return result;
  }
}

async function fullyVerifyDecoded(result, security = null) {
  let verified = result;
  if (verified.secure && verified.requiresDecryption) verified = await decryptDecoded(verified, security);
  if (verified.signed) {
    const options = demoSignatureVerificationOptions(verified);
    if (!options) throw new Error("A trusted public key is required to verify this signed QuadQR.");
    verified = await verifyDecodedSignature(verified, options);
  }
  return verified;
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
  const recovery = result.softDecoded
    ? `Spectrum ECC 2.0 soft recovery (${result.softSubstitutions ?? 0} cell substitution${result.softSubstitutions === 1 ? "" : "s"})`
    : result.confidenceAssisted
      ? `${result.erasureSymbols ?? 0} confidence erasure(s) used`
      : "hard-decision ECC sufficient";
  meta.textContent =
    `v${result.version}, ECC ${result.eccLevel}, mask ${result.maskId}, ` +
    `${result.alignmentPatterns ?? result.geometry?.alignment?.patterns ?? 1} alignment pattern(s), ` +
    `${result.correctedSymbols ?? 0} RS byte symbols corrected, ${recovery}, ${spectrum}, ` +
    `${geometry}, ${calibration}, confidence ${Math.round((result.confidence ?? result.diagnostics?.confidence ?? 0) * 100)}%, ` +
    `CRC ${result.crc32.toString(16).padStart(8, "0").toUpperCase()}`;

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

  if (result.compressed || result.signed) {
    const payloadMeta = document.createElement("div");
    payloadMeta.className = "security-meta";
    payloadMeta.textContent = [
      result.compressed ? "LZ compressed" : null,
      result.signed ? `Ed25519 signed${result.signingKeyId ? ` · key ID ${result.signingKeyId}` : ""}` : null,
      result.signed && result.signatureVerified === true && result.signatureTrusted === true ? "trusted signature verified" : null,
      result.signed && result.signatureVerified === true && result.signatureTrusted !== true ? "signature valid · signer not trusted" : null,
      result.signed && result.signatureVerified !== true ? "needs trusted public key" : null
    ].filter(Boolean).join(" · ");
    container.appendChild(payloadMeta);
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
        let decrypted = await decryptDecoded(result, credentials);
        if (decrypted.signed) decrypted = await tryVerifyWithDemoKey(decrypted);
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
    const signing = signingOptionsFromGenerator();
    const commonOptions = {
      version: requestedVersion,
      ecc: eccLevelEl.value,
      highDensity: highDensityEnabled(highDensityModeEl)
    };
    const code = await encodeGeneratorPayload(commonOptions, security, signing);

    const renderOptions = generatorRenderOptions();
    renderToCanvas(code, canvas, renderOptions);

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    drawImageDataToStressCanvas(imageData);
    const scanned = scanImageData(imageData, {
      minVersion: code.version,
      maxVersion: code.version
    });
    const verified = await fullyVerifyDecoded(scanned, security);

    if (verified.text !== payloadEl.value) {
      throw new Error("Generated image decoded, but payload did not match.");
    }

    currentCode = code;
    currentRenderOptions = renderOptions;
    updateSvgPreview(renderToSVG(code, generatorRenderOptions({ svg: true })));
    updateStats(code);
    scanabilityBtn.disabled = true;
    scanabilityScoreEl.textContent = "Testing…";
    scanabilityMetaEl.textContent = "Running the automatic pre-export distortion suite.";
    scanabilityResultsEl.innerHTML = "";
    await new Promise((resolve) => requestAnimationFrame(resolve));
    try {
      const report = runImageStressTest(currentCanvasImageData(scanabilityImageSize()), {
        version: code.version,
        crc32: code.crc32
      });
      scanabilityScoreEl.textContent = `${report.score.toFixed(0)}/100 · ${report.rating}`;
      scanabilityMetaEl.textContent =
        `${report.passed}/${report.total} scenarios decoded · weighted pass ${report.passPercent.toFixed(0)}%` +
        (logoEnabledEl.checked && currentLogoImage && logoSizeEl.value === "auto"
          ? ` · auto logo ${(estimateSafeLogoSize(code, renderOptions) * 100).toFixed(1)}%`
          : "");
      renderStressReport(report);
    } catch (safetyError) {
      scanabilityScoreEl.textContent = "Safety test unavailable";
      scanabilityMetaEl.textContent = safetyError.message;
    }
    downloadBtn.disabled = false;
    downloadSvgBtn.disabled = false;
    scanabilityBtn.disabled = false;
    setPill(
      verificationPill,
      "good",
      [code.signed ? "Signed" : null, code.secure ? "Secure" : null, "Spectrum ECC verified"].filter(Boolean).join(" + ")
    );
  } catch (error) {
    currentCode = null;
    currentRenderOptions = null;
    qrPreviewEl.innerHTML = "";
    downloadBtn.disabled = true;
    downloadSvgBtn.disabled = true;
    scanabilityBtn.disabled = true;
    setPill(verificationPill, "bad", "Verification failed");
    showError(error.message);
  } finally {
    generateBtn.disabled = false;
  }
}



function currentCanvasImageData(maxSize = null) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!maxSize || Math.max(canvas.width, canvas.height) <= maxSize) {
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }
  const scale = maxSize / Math.max(canvas.width, canvas.height);
  const width = Math.max(1, Math.round(canvas.width * scale));
  const height = Math.max(1, Math.round(canvas.height * scale));
  const scratch = document.createElement("canvas");
  scratch.width = width;
  scratch.height = height;
  const scratchCtx = scratch.getContext("2d", { willReadFrequently: true });
  scratchCtx.imageSmoothingEnabled = true;
  scratchCtx.imageSmoothingQuality = "high";
  scratchCtx.drawImage(canvas, 0, 0, width, height);
  return scratchCtx.getImageData(0, 0, width, height);
}

function scanabilityImageSize() {
  if (!currentCode) return 480;
  const matrixModules = currentCode.matrix?.length ?? (21 + 4 * (currentCode.version - 1));
  const quietZone = Math.max(0, Number(quietZoneEl.value) || 0);
  const totalModules = matrixModules + quietZone * 2;
  // Keep roughly 10 pixels/module when the rendered output has them available.
  // Dense versions should not be penalized simply because the benchmark used
  // to force every symbol through the same 480 px intermediate image.
  const densityAwareTarget = Math.ceil(totalModules * 10);
  return Math.min(
    Math.max(canvas.width, canvas.height),
    Math.max(480, densityAwareTarget)
  );
}

function drawImageDataToStressCanvas(imageData) {
  stressCanvas.width = imageData.width;
  stressCanvas.height = imageData.height;
  const ctx = stressCanvas.getContext("2d");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height), 0, 0);
}

function renderStressReport(report, container = scanabilityResultsEl) {
  container.innerHTML = "";
  for (const item of report.results) {
    const chip = document.createElement("div");
    chip.className = `stress-result-chip ${item.passed ? "good" : "bad"}`;
    chip.textContent = `${item.passed ? "✓" : "✕"} ${item.label} · ${item.passed ? `${Math.round((item.confidence ?? 0) * 100)}%` : "failed"}`;
    container.appendChild(chip);
  }
}

async function runScanabilityTest() {
  if (!currentCode) return;
  scanabilityBtn.disabled = true;
  scanabilityScoreEl.textContent = "Testing…";
  scanabilityMetaEl.textContent = "Applying camera-style distortions and decoding each result.";
  await new Promise((resolve) => requestAnimationFrame(resolve));
  try {
    const report = runImageStressTest(currentCanvasImageData(scanabilityImageSize()), {
      version: currentCode.version,
      crc32: currentCode.crc32
    });
    scanabilityScoreEl.textContent = `${report.score.toFixed(0)}/100 · ${report.rating}`;
    scanabilityMetaEl.textContent = `${report.passed}/${report.total} scenarios decoded · weighted pass ${report.passPercent.toFixed(0)}%`;
    renderStressReport(report);
  } catch (error) {
    scanabilityScoreEl.textContent = "Test failed";
    scanabilityMetaEl.textContent = error.message;
  } finally {
    scanabilityBtn.disabled = false;
  }
}

function calculateCapacityUi() {
  const plan = calculateCapacityPlan({
    payloadBytes: Number(capacityPayloadBytesEl.value),
    ecc: capacityEccEl.value,
    highDensity: highDensityEnabled(capacityHighDensityEl),
    signed: capacitySignedEl.value === "true",
    compression: capacityCompressionEl.value
  });
  capacityPlanResultEl.className = `scan-result ${plan.quadqrVersion ? "good" : "bad"}`;
  if (!plan.quadqrVersion) {
    capacityPlanResultEl.textContent = `The requested payload does not fit QuadQR v1–v40 with ECC ${plan.ecc}.`;
    return;
  }
  const standard = plan.standardQrVersion
    ? `Standard QR byte mode: v${plan.standardQrVersion} (${plan.standardQrSize}×${plan.standardQrSize})`
    : "Standard QR byte mode: exceeds v40";
  capacityPlanResultEl.textContent =
    `QuadQR: v${plan.quadqrVersion} (${plan.quadqrSize}×${plan.quadqrSize}), ${plan.encodedBytes} encoded bytes, ` +
    `${plan.remainingBytes} bytes remaining, ${plan.utilizationPercent.toFixed(1)}% used. ${standard}.` +
    (plan.matrixWidthSavingsPercent != null ? ` Matrix width reduction: ${plan.matrixWidthSavingsPercent.toFixed(1)}%.` : "") +
    (plan.compression === "unknown" ? " Compression cannot be predicted from a byte count alone, so this estimate assumes no compression gain." : "");
}

function reliabilityImageSize() {
  if (!currentCode) return 520;
  const matrixModules = currentCode.matrix?.length ?? (21 + 4 * (currentCode.version - 1));
  const quietZone = Math.max(0, Number(quietZoneEl.value) || 0);
  const pixelsPerModule = Math.max(6, Number(reliabilityImageScaleEl.value) || 10);
  const target = Math.ceil((matrixModules + quietZone * 2) * pixelsPerModule);
  return Math.min(Math.max(canvas.width, canvas.height), Math.max(360, target));
}

function renderReliabilityReport(report) {
  reliabilityResultsBody.innerHTML = "";
  for (const item of report.results) {
    const tr = document.createElement("tr");
    const values = [
      item.label,
      item.category ?? "Other",
      item.passed ? "Passed" : "Failed",
      item.passed && Number.isFinite(item.confidence) ? `${Math.round(item.confidence * 100)}%` : "--",
      item.correctedSymbols == null ? "--" : String(item.correctedSymbols),
      `${item.elapsedMs.toFixed(1)} ms`
    ];
    const labels = ["Scenario", "Category", "Result", "Confidence", "RS corrected", "Time"];
    values.forEach((value, index) => {
      const td = document.createElement("td");
      td.textContent = value;
      td.dataset.label = labels[index];
      if (index === 2) td.className = item.passed ? "reliability-pass" : "reliability-fail";
      tr.appendChild(td);
    });
    reliabilityResultsBody.appendChild(tr);
  }
}

async function runReliabilityUi() {
  if (!currentCode) {
    reliabilityStatusEl.className = "scan-result bad";
    reliabilityStatusEl.textContent = "Generate a QuadQR first.";
    return;
  }
  runReliabilityBtn.disabled = true;
  setPill(reliabilityPill, "neutral", "Running");
  reliabilityStatusEl.className = "scan-result";
  reliabilityStatusEl.textContent = "Running deterministic camera and perspective scenarios…";
  reliabilityResultsBody.innerHTML = '<tr><td colspan="6" class="muted-cell">Running reliability tests…</td></tr>';
  await new Promise((resolve) => requestAnimationFrame(resolve));
  try {
    const report = runReliabilityLab(
      currentCanvasImageData(reliabilityImageSize()),
      { version: currentCode.version, crc32: currentCode.crc32 },
      { suite: reliabilitySuiteEl.value }
    );
    reliabilityScoreEl.textContent = `${report.score.toFixed(0)}/100`;
    reliabilityRatingEl.textContent = `${report.rating} · ${report.suite}`;
    reliabilityPassedEl.textContent = `${report.passed}/${report.total}`;
    reliabilityConfidenceEl.textContent = `${Math.round(report.averageConfidence * 100)}%`;
    reliabilityWeakestEl.textContent = report.weakestCategory
      ? `${report.weakestCategory.category} ${report.weakestCategory.score.toFixed(0)}%`
      : "--";
    reliabilityStatusEl.className = `scan-result ${report.score >= 75 ? "good" : "bad"}`;
    reliabilityStatusEl.textContent =
      `${report.rating} · weighted pass ${report.passPercent.toFixed(0)}% · ` +
      `${report.passed}/${report.total} CRC-verified scenarios decoded.`;
    setPill(reliabilityPill, report.score >= 75 ? "good" : "bad", `${report.score.toFixed(0)}/100`);
    renderReliabilityReport(report);
  } catch (error) {
    setPill(reliabilityPill, "bad", "Failed");
    reliabilityStatusEl.className = "scan-result bad";
    reliabilityStatusEl.textContent = error.message;
    reliabilityResultsBody.innerHTML = `<tr><td colspan="6" class="muted-cell">${error.message}</td></tr>`;
  } finally {
    runReliabilityBtn.disabled = false;
  }
}

function updatePerspectiveLabels() {
  perspectivePitchValueEl.textContent = `${perspectivePitchEl.value}°`;
  perspectiveYawValueEl.textContent = `${perspectiveYawEl.value}°`;
  perspectiveRollValueEl.textContent = `${perspectiveRollEl.value}°`;
}

function currentPerspectiveOptions() {
  return {
    pitchDegrees: Number(perspectivePitchEl.value),
    yawDegrees: Number(perspectiveYawEl.value),
    rollDegrees: Number(perspectiveRollEl.value),
    fill: 0.84,
    cameraDistance: 3
  };
}

async function testPerspectiveUi() {
  if (!currentCode) {
    perspectiveResultEl.className = "scan-result bad";
    perspectiveResultEl.textContent = "Generate a QuadQR first.";
    return;
  }
  testPerspectiveBtn.disabled = true;
  const transform = currentPerspectiveOptions();
  const distorted = applyStressDistortion(
    currentCanvasImageData(),
    "perspective-3d",
    0.5,
    transform
  );
  drawImageDataToStressCanvas(distorted);
  perspectiveResultEl.className = "scan-result";
  perspectiveResultEl.textContent = "Scanning transformed image…";
  await new Promise((resolve) => requestAnimationFrame(resolve));
  try {
    const decoded = scanImageData(distorted, {
      minVersion: currentCode.version,
      maxVersion: currentCode.version
    });
    const matches = decoded.crc32 === currentCode.crc32;
    perspectiveResultEl.className = `scan-result ${matches ? "good" : "bad"}`;
    const gridScore = decoded.geometry?.alignment?.gridScore;
    perspectiveResultEl.textContent = matches
      ? `Decoded · X ${transform.pitchDegrees}° · Y ${transform.yawDegrees}° · Z ${transform.rollDegrees}° · ` +
        `confidence ${Math.round((decoded.confidence ?? 0) * 100)}% · ` +
        `${decoded.correctedSymbols ?? 0} RS corrected` +
        (Number.isFinite(gridScore) ? ` · geometry ${(gridScore * 100).toFixed(0)}%` : "")
      : "A symbol decoded, but the payload CRC did not match.";
  } catch (error) {
    perspectiveResultEl.className = "scan-result bad";
    perspectiveResultEl.textContent = `Failed at X ${transform.pitchDegrees}° · Y ${transform.yawDegrees}° · Z ${transform.rollDegrees}° · ${error.message}`;
  } finally {
    testPerspectiveBtn.disabled = false;
  }
}

async function runPerspectiveSweepUi() {
  if (!currentCode) {
    perspectiveResultEl.className = "scan-result bad";
    perspectiveResultEl.textContent = "Generate a QuadQR first.";
    return;
  }
  runPerspectiveSweepBtn.disabled = true;
  perspectiveSweepResultsEl.innerHTML = "";
  perspectiveResultEl.className = "scan-result";
  perspectiveResultEl.textContent = "Sweeping camera angles…";
  await new Promise((resolve) => requestAnimationFrame(resolve));
  try {
    const axis = perspectiveSweepAxisEl.value;
    const base = currentPerspectiveOptions();
    const angles = axis === "roll" ? [0, 20, 35, 50, 65, 75] : [0, 15, 25, 35, 45, 55];
    const report = runPerspectiveSweep(
      currentCanvasImageData(),
      { version: currentCode.version, crc32: currentCode.crc32 },
      { axis, angles, ...base }
    );
    const axisLabel = axis === "roll" ? "Z rotation" : axis === "pitch" ? "X pitch" : "Y yaw";
    perspectiveResultEl.className = `scan-result ${report.passed >= Math.ceil(report.total * 0.65) ? "good" : "bad"}`;
    perspectiveResultEl.textContent =
      `${axisLabel} sweep · ${report.passed}/${report.total} passed · ` +
      `maximum passing test angle ${report.maxPassedAngle == null ? "none" : `${report.maxPassedAngle}°`}.`;
    for (const item of report.results) {
      const chip = document.createElement("div");
      chip.className = `stress-result-chip ${item.passed ? "good" : "bad"}`;
      chip.textContent = `${item.passed ? "✓" : "✕"} ${item.angle}°${item.passed ? ` · ${Math.round((item.confidence ?? 0) * 100)}%` : ""}`;
      perspectiveSweepResultsEl.appendChild(chip);
    }
  } catch (error) {
    perspectiveResultEl.className = "scan-result bad";
    perspectiveResultEl.textContent = error.message;
  } finally {
    runPerspectiveSweepBtn.disabled = false;
  }
}

function formatMs(value) {
  return `${value.toFixed(3)} ms`;
}

function renderCapacityBenchmark() {
  const options = {
    ecc: benchmarkEccEl.value,
    versions: [1, 2, 5, 10, 20, 30, 40]
  };
  const normalRows = buildCapacityComparison({ ...options, highDensity: false });
  const highDensityRows = buildCapacityComparison({ ...options, highDensity: true });

  capacityBenchmarkBody.innerHTML = "";
  for (let index = 0; index < normalRows.length; index++) {
    const normal = normalRows[index];
    const dense = highDensityRows[index];
    const tr = document.createElement("tr");
    const normalRatio = normal.ratio == null ? "n/a" : `${normal.ratio.toFixed(2)}×`;
    const denseRatio = dense.ratio == null ? "n/a" : `${dense.ratio.toFixed(2)}×`;
    const values = [
      `v${normal.version}`,
      `${normal.size}×${normal.size}`,
      `${normal.quadqrBytes} B`,
      `${dense.quadqrBytes} B`,
      `${normal.standardQrBytes} B`,
      normalRatio,
      denseRatio
    ];
    const labels = [
      "Version",
      "Matrix",
      "QuadQR",
      "High Density Triangle16 (Experimental)",
      "Standard QR",
      "Normal ratio",
      "High density ratio"
    ];
    values.forEach((value, valueIndex) => {
      const td = document.createElement("td");
      td.textContent = value;
      td.dataset.label = labels[valueIndex];
      tr.appendChild(td);
    });
    capacityBenchmarkBody.appendChild(tr);
  }
}

async function runBenchmark() {
  runBenchmarkBtn.disabled = true;
  setPill(benchmarkPill, "neutral", "Running");
  speedBenchmarkBody.innerHTML = '<tr><td colspan="7" class="muted-cell">Running benchmark...</td></tr>';

  // Let the UI paint before the synchronous benchmark loop starts.
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));

  try {
    renderCapacityBenchmark();
    const benchmarkOptions = {
      ecc: benchmarkEccEl.value,
      iterations: Number(benchmarkIterationsEl.value),
      payloadSizes: [32, 128, 512, 1024, 2048]
    };
    const reports = [
      { label: "Normal RGBW", report: benchmarkCodec({ ...benchmarkOptions, highDensity: false }) },
      { label: "High Density · Experimental", report: benchmarkCodec({ ...benchmarkOptions, highDensity: true }) }
    ];

    speedBenchmarkBody.innerHTML = "";
    for (const { label: modeLabel, report } of reports) {
      for (const row of report.results) {
        const tr = document.createElement("tr");
        if (row.skipped) {
          const mode = document.createElement("td");
          mode.textContent = modeLabel;
          mode.dataset.label = "Mode";
          const payload = document.createElement("td");
          payload.textContent = `${row.payloadBytes} B`;
          payload.dataset.label = "Payload";
          const reason = document.createElement("td");
          reason.colSpan = 5;
          reason.textContent = row.reason;
          reason.className = "muted-cell";
          tr.append(mode, payload, reason);
        } else {
          const values = [
            modeLabel,
            `${row.payloadBytes} B`,
            `${row.size}×${row.size} (v${row.version})`,
            formatMs(row.encode.meanMs),
            formatMs(row.encode.p95Ms),
            formatMs(row.decode.meanMs),
            formatMs(row.decode.p95Ms)
          ];
          const labels = ["Mode", "Payload", "Matrix", "Encode mean", "Encode p95", "Decode mean", "Decode p95"];
          values.forEach((value, index) => {
            const td = document.createElement("td");
            td.textContent = value;
            td.dataset.label = labels[index];
            tr.appendChild(td);
          });
        }
        speedBenchmarkBody.appendChild(tr);
      }
    }
    setPill(benchmarkPill, "good", "Complete");
  } catch (error) {
    speedBenchmarkBody.innerHTML = "";
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 7;
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
    "high-resolution-geometry-recovery": "High-res geometry",
    "camera-auto-color": "Camera Auto Color",
    "progressive-color-recovery": "Color recovery",
    "qr-region-auto-enhance": "QR color enhance",
    "module-grid-auto-tone-contrast-color": "Module auto enhance",
    "rectified-auto-tone-contrast-color": "Rectified auto enhance",
    "multi-frame-vote": "Multi-frame ECC",
    "multi-frame-confidence-fusion": "Multi-frame fusion",
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
    "rgb-value-otsu-two-finder-recovery": "RGB value/two-finder recovery",
    "auto-color-value-otsu": "Auto Color value/Otsu",
    "rgb-value-high-threshold": "RGB value/high threshold",
    "rgb-value-low-threshold": "RGB value/low threshold",
    "luminance-otsu": "Luminance/Otsu"
  };
  if (!method) return "";
  if (names[method]) return names[method];
  if (String(method).endsWith("-two-finder-recovery")) return `${String(method).replace("-two-finder-recovery", "").replaceAll("-", " ")} / two-finder recovery`;
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
scanabilityBtn.addEventListener("click", runScanabilityTest);
compressionModeEl.addEventListener("change", () => currentCode && generate());
signPayloadEl.addEventListener("change", () => { updateSigningUi(); generate(); });
signingKeyIdEl.addEventListener("change", () => signPayloadEl.checked && generate());
generateSigningKeyBtn.addEventListener("click", async () => {
  generateSigningKeyBtn.disabled = true;
  signingKeyStatusEl.textContent = "Generating…";
  try {
    signingKeyPair = await generateSigningKeyPair();
    signingKeyIdEl.value = signingKeyPair.keyId;
    updateSigningUi();
    if (signPayloadEl.checked) await generate();
  } catch (error) {
    signingKeyStatusEl.textContent = error.message;
  } finally {
    generateSigningKeyBtn.disabled = false;
  }
});
renderModeEl.addEventListener("change", () => { updateRenderModeUi(); generate(); });
securityModeEl.addEventListener("change", () => {
  updateSecurityUi();
  currentCode = null;
  currentRenderOptions = null;
  downloadBtn.disabled = true;
  downloadSvgBtn.disabled = true;
  setPill(verificationPill, "neutral", "Security changed");
});
generateRawKeyBtn.addEventListener("click", () => {
  securityRawKeyEl.value = bytesToHex(generateRaw256Key());
  securityRawKeyEl.focus();
});
imageSizeEl.addEventListener("change", () => currentCode && generate());
quietZoneEl.addEventListener("change", () => currentCode && generate());
logoSizeEl.addEventListener("change", () => currentCode && generate());
logoClearBackgroundEl.addEventListener("change", () => currentCode && generate());
logoEnabledEl.addEventListener("change", () => currentCode && generate());
removeLogoBtn.addEventListener("click", async () => {
  currentLogoImage = null;
  currentLogoDataUrl = null;
  logoFileEl.value = "";
  updateLogoUploadUi();
  if (currentCode) await generate();
});
logoFileEl.addEventListener("change", async () => {
  const file = logoFileEl.files?.[0];
  if (!file) {
    currentLogoImage = null;
    currentLogoDataUrl = null;
    updateLogoUploadUi();
    if (currentCode) generate();
    return;
  }

  try {
    const dataUrl = await readFileAsDataUrl(file);
    const image = await loadImage(dataUrl);
    currentLogoDataUrl = dataUrl;
    currentLogoImage = image;
    logoEnabledEl.checked = true;
    updateLogoUploadUi(file);
    await generate();
  } catch (error) {
    currentLogoImage = null;
    currentLogoDataUrl = null;
    logoFileEl.value = "";
    updateLogoUploadUi();
    showError(error.message);
  }
});
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
highDensityModeEl.addEventListener("change", () => {
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

downloadSvgBtn.addEventListener("click", () => {
  if (!currentCode) return;
  const svg = renderToSVG(currentCode, generatorRenderOptions({ svg: true }));
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.download = `quadqr-v${currentCode.version}-${currentCode.eccLevel}.svg`;
  link.href = url;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
});

scanFileEl.addEventListener("change", async () => {
  const file = scanFileEl.files?.[0];
  if (!file) return;
  scanResultEl.className = "scan-result";
  scanResultEl.textContent = "Scanning image...";
  scanDebugOutputEl.classList.add("hidden");

  try {
    let result = await scanFile(file, { debug: scanDebugEl.checked });
    if (result.signed && !result.requiresDecryption) result = await tryVerifyWithDemoKey(result);
    formatResult(scanResultEl, result, "Verified QuadQR");
    if (scanDebugEl.checked) {
      scanDebugOutputEl.textContent = JSON.stringify(result.diagnostics, null, 2);
      scanDebugOutputEl.classList.remove("hidden");
    }
  } catch (error) {
    scanResultEl.className = "scan-result bad";
    scanResultEl.textContent = error.message;
    if (scanDebugEl.checked && error.debug) {
      scanDebugOutputEl.textContent = JSON.stringify(error.debug, null, 2);
      scanDebugOutputEl.classList.remove("hidden");
    }
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
        void tryVerifyWithDemoKey(result).then((checkedResult) => {
          formatResult(cameraResultEl, checkedResult, "Camera scan verified", {
            onSecurityState(state) {
              if (state === "locked") setPill(cameraPill, "neutral", "Secure QR");
              else if (state === "decrypted") setPill(cameraPill, "good", "Decrypted");
              else setPill(cameraPill, "good", "Decoded");
            }
          });
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
calculateCapacityBtn.addEventListener("click", calculateCapacityUi);
runReliabilityBtn.addEventListener("click", runReliabilityUi);
perspectivePitchEl.addEventListener("input", updatePerspectiveLabels);
perspectiveYawEl.addEventListener("input", updatePerspectiveLabels);
perspectiveRollEl.addEventListener("input", updatePerspectiveLabels);
testPerspectiveBtn.addEventListener("click", testPerspectiveUi);
runPerspectiveSweepBtn.addEventListener("click", runPerspectiveSweepUi);
window.addEventListener("pagehide", () => cameraController?.stop());

resetCameraDiagnosticsUi();
updateLogoUploadUi();
updateSecurityUi();
updateSigningUi();
updateRenderModeUi();
rebuildVersions();
renderCapacityBenchmark();
calculateCapacityUi();
updatePerspectiveLabels();
generate();
