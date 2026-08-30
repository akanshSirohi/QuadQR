import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), "..");
const wasmRootDir = path.join(root, "wasm");
const sourcePath = path.join(root, "wasm-src", "quadqr_core.c");
const outputPath = path.join(wasmRootDir, "quadqr-core.wasm");
const metadataPath = path.join(wasmRootDir, "quadqr-core.build.json");
const BUILD_METADATA_VERSION = 1;

const compileArgsTemplate = [
  "--target=wasm32",
  "-O3",
  "-fno-builtin",
  "-nostdlib",
  "-Wl,--no-entry",
  "-Wl,--export=crc32_bytes",
  "-Wl,--export=build_binary_rgba",
  "-Wl,--export=__heap_base",
  "-Wl,--export-memory",
  "-Wl,--stack-first",
  "-Wl,-z,stack-size=32768",
  "-Wl,--initial-memory=131072",
  "-Wl,--max-memory=67108864"
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readOptional(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readMetadata() {
  const raw = await readOptional(metadataPath);
  if (!raw) return null;
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
}

function isWasmBinary(bytes) {
  return Boolean(
    bytes &&
    bytes.length >= 8 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x61 &&
    bytes[2] === 0x73 &&
    bytes[3] === 0x6d
  );
}

async function getExpectedBuildState() {
  const source = await readFile(sourcePath);
  const sourceSha256 = sha256(source.toString("utf8").replace(/\r\n/g, "\n"));
  const flagsSha256 = sha256(JSON.stringify(compileArgsTemplate));
  const buildFingerprint = sha256(`${BUILD_METADATA_VERSION}\n${sourceSha256}\n${flagsSha256}`);
  return { source, sourceSha256, flagsSha256, buildFingerprint };
}

async function verifyPrebuilt(expected) {
  const [metadata, wasm] = await Promise.all([
    readMetadata(),
    readOptional(outputPath)
  ]);

  if (!metadata || !wasm || !isWasmBinary(wasm)) {
    return { current: false, reason: !wasm ? "missing WASM binary" : !metadata ? "missing build metadata" : "invalid WASM binary" };
  }

  if (metadata.metadataVersion !== BUILD_METADATA_VERSION) {
    return { current: false, reason: "build metadata version changed" };
  }
  if (metadata.sourceSha256 !== expected.sourceSha256) {
    return { current: false, reason: "WASM C source changed" };
  }
  if (metadata.flagsSha256 !== expected.flagsSha256) {
    return { current: false, reason: "WASM compiler flags changed" };
  }
  if (metadata.buildFingerprint !== expected.buildFingerprint) {
    return { current: false, reason: "WASM build fingerprint changed" };
  }

  const wasmSha256 = sha256(wasm);
  if (metadata.wasmSha256 !== wasmSha256) {
    return { current: false, reason: "prebuilt WASM binary does not match its recorded hash" };
  }

  return { current: true, metadata, wasmSha256 };
}

function compilerVersion() {
  const result = spawnSync("clang", ["--version"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return String(result.stdout || "").split(/\r?\n/, 1)[0].trim() || "clang";
}

function compileWithClang(outputFile) {
  const args = [
    ...compileArgsTemplate,
    "-o",
    outputFile,
    sourcePath
  ];
  return spawnSync("clang", args, { encoding: "utf8" });
}

function compilerFailureMessage(result, reason) {
  const detail = result?.stderr || result?.stdout || result?.error?.message || "clang is not available in PATH";
  return [
    `QuadQR WASM is stale (${reason}) and cannot be rebuilt.`,
    "Install LLVM/Clang and ensure `clang` is available in PATH, then run `npm run build:wasm`.",
    "The build is intentionally stopped instead of silently reusing an outdated WASM binary.",
    String(detail).trim()
  ].filter(Boolean).join("\n");
}

export async function ensureWasmBuild(options = {}) {
  const force = options.force === true;
  const requireCompiler = options.requireCompiler === true;
  const log = options.log === false ? null : console;

  await mkdir(wasmRootDir, { recursive: true });
  const expected = await getExpectedBuildState();
  const verification = await verifyPrebuilt(expected);

  if (!force && verification.current) {
    log?.log("QuadQR WASM: verified prebuilt accelerator is current.");
    return Object.freeze({ rebuilt: false, verified: true, outputPath, metadataPath });
  }

  const staleReason = force ? "explicit rebuild requested" : verification.reason || "unknown build mismatch";
  const version = compilerVersion();
  if (!version) {
    if (!force && verification.current && !requireCompiler) {
      return Object.freeze({ rebuilt: false, verified: true, outputPath, metadataPath });
    }
    throw new Error(compilerFailureMessage(null, staleReason));
  }

  const tempOutputPath = `${outputPath}.tmp-${process.pid}`;
  await rm(tempOutputPath, { force: true });
  const result = compileWithClang(tempOutputPath);
  if (result.status !== 0) {
    await rm(tempOutputPath, { force: true });
    throw new Error(compilerFailureMessage(result, staleReason));
  }

  const wasm = await readFile(tempOutputPath);
  if (!isWasmBinary(wasm)) {
    await rm(tempOutputPath, { force: true });
    throw new Error("clang completed but did not produce a valid WebAssembly binary.");
  }

  await rename(tempOutputPath, outputPath);

  const metadata = {
    metadataVersion: BUILD_METADATA_VERSION,
    source: "wasm-src/quadqr_core.c",
    output: "wasm/quadqr-core.wasm",
    sourceSha256: expected.sourceSha256,
    flagsSha256: expected.flagsSha256,
    buildFingerprint: expected.buildFingerprint,
    wasmSha256: sha256(wasm),
    compiler: version,
    compileArgs: compileArgsTemplate
  };
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

  log?.log(`QuadQR WASM: rebuilt accelerator with ${version}.`);
  return Object.freeze({ rebuilt: true, verified: true, outputPath, metadataPath, metadata });
}

export const wasmBuildPaths = Object.freeze({
  sourcePath,
  outputPath,
  metadataPath
});
