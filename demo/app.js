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

async function stopCamera() {
  cameraController?.stop();
  cameraController = null;
  startCameraBtn.disabled = false;
  stopCameraBtn.disabled = true;
  setPill(cameraPill, "neutral", "Stopped");
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
  cameraResultEl.className = "scan-result";
  cameraResultEl.textContent = "Requesting camera permission...";
  setPill(cameraPill, "neutral", "Starting");

  try {
    cameraController = await startCameraScanner(cameraVideo, {
      scanInterval: 160,
      maxDimension: 900,
      stopOnResult: true,
      onResult(result) {
        formatResult(cameraResultEl, result, "Camera scan verified", {
          onSecurityState(state) {
            if (state === "locked") setPill(cameraPill, "neutral", "Secure QR");
            else if (state === "decrypted") setPill(cameraPill, "good", "Decrypted");
            else setPill(cameraPill, "good", "Decoded");
          }
        });
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
    cameraResultEl.className = "scan-result bad";
    cameraResultEl.textContent = error.message;
  }
});

stopCameraBtn.addEventListener("click", stopCamera);
benchmarkEccEl.addEventListener("change", renderCapacityBenchmark);
runBenchmarkBtn.addEventListener("click", runBenchmark);
window.addEventListener("pagehide", () => cameraController?.stop());

updateSecurityUi();
rebuildVersions();
renderCapacityBenchmark();
generate();
