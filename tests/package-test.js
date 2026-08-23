import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";

import * as esm from "../dist/index.js";
import * as nodeApi from "../dist/node.js";
import * as benchmarkApi from "../dist/benchmark.js";

console.log("Running package distribution tests...");

// ESM core entry and the v1.1 public feature surface.
{
  const code = esm.encodeText("npm ESM roundtrip", { ecc: "M" });
  assert.equal(esm.decodeMatrix(code.matrix).text, "npm ESM roundtrip");
  for (const name of [
    "encodeUint8Array",
    "encodeSignedText",
    "generateSigningKeyPair",
    "deriveSigningKeyId",
    "verifyDecodedSignature",
    "debugScanImageData",
    "assessScanability",
    "estimateSafeLogoSize",
    "findMaxSafeLogoSize",
    "getPrintGuidance"
  ]) assert.equal(typeof esm[name], "function", `${name} must be exported from the ESM entry.`);
  assert.equal(typeof benchmarkApi.calculateCapacityPlan, "function");
}

// CommonJS wrapper on supported modern Node.
{
  const require = createRequire(import.meta.url);
  const cjs = require("../dist/index.cjs");
  const code = cjs.encodeText("npm CommonJS roundtrip");
  assert.equal(cjs.decodeMatrix(code.matrix).text, "npm CommonJS roundtrip");
}

// Prebuilt WASM is loadable and transparently preserves CRC behavior.
{
  const before = esm.crc32(new TextEncoder().encode("QuadQR WASM"));
  const state = await esm.initWasm();
  assert.equal(state.enabled, true);
  assert.ok(state.bytes > 0);
  const after = esm.crc32(new TextEncoder().encode("QuadQR WASM"));
  assert.equal(after, before);
  esm.disableWasm();
}

// Node PNG generation and image scanning use the same shared scanner.
{
  const dir = await mkdtemp(path.join(os.tmpdir(), "quadqr-package-"));
  try {
    const output = path.join(dir, "plain.png");
    const code = esm.encodeText("Node PNG file scan", { ecc: "M" });
    await nodeApi.savePNG(code, output, { moduleSize: 10, quietZone: 4 });
    const result = await nodeApi.scanFile(output);
    assert.equal(result.text, "Node PNG file scan");

    const bytes = await readFile(output);
    const fromBuffer = await nodeApi.scanBuffer(bytes);
    assert.equal(fromBuffer.text, "Node PNG file scan");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Secure Node PNG scan/decryption.
{
  const secure = await esm.encodeSecureText("Node secure payload", {
    ecc: "M",
    security: { mode: "password", password: "quadqr-package-test" }
  });
  const png = nodeApi.toPNG(secure, { moduleSize: 10, quietZone: 4 });
  const locked = await nodeApi.scanBuffer(png);
  assert.equal(locked.secure, true);
  assert.equal(locked.requiresDecryption, true);
  const unlocked = await esm.decryptDecoded(locked, { password: "quadqr-package-test" });
  assert.equal(unlocked.text, "Node secure payload");
}

// CLI encode/decode smoke test.
{
  const dir = await mkdtemp(path.join(os.tmpdir(), "quadqr-cli-"));
  try {
    const output = path.join(dir, "cli.png");
    // fileURLToPath() is required here instead of URL.pathname so Windows
    // drive-letter paths are passed to Node as D:\\... rather than /D:/....
    const cliPath = fileURLToPath(new URL("../bin/quadqr.js", import.meta.url));
    let command = spawnSync(process.execPath, [cliPath, "encode", "CLI roundtrip", "-o", output], { encoding: "utf8" });
    assert.equal(command.status, 0, command.stderr);
    command = spawnSync(process.execPath, [cliPath, "decode", output], { encoding: "utf8" });
    assert.equal(command.status, 0, command.stderr);
    assert.equal(command.stdout.trim(), "CLI roundtrip");

    const compressedOutput = path.join(dir, "compressed.svg");
    command = spawnSync(process.execPath, [cliPath, "encode", "CLI compressed roundtrip repeated repeated repeated", "--compression", "auto", "--print", "-o", compressedOutput], { encoding: "utf8" });
    assert.equal(command.status, 0, command.stderr);
    assert.match(await readFile(compressedOutput, "utf8"), /<svg\b/);

    const signingKey = path.join(dir, "signing-key.json");
    const signedOutput = path.join(dir, "signed.png");
    command = spawnSync(process.execPath, [cliPath, "signkeygen", "-o", signingKey], { encoding: "utf8" });
    assert.equal(command.status, 0, command.stderr);
    command = spawnSync(process.execPath, [cliPath, "encode", "CLI signed roundtrip", "--sign-key", signingKey, "-o", signedOutput], { encoding: "utf8" });
    assert.equal(command.status, 0, command.stderr);
    command = spawnSync(process.execPath, [cliPath, "decode", signedOutput, "--verify-key", signingKey], { encoding: "utf8" });
    assert.equal(command.status, 0, command.stderr);
    assert.equal(command.stdout.trim(), "CLI signed roundtrip");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Classic CDN/global bundle exposes an immediate QuadQR global.
{
  const source = await readFile(new URL("../dist/quadqr.min.js", import.meta.url), "utf8");
  const context = vm.createContext({
    console,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Uint8ClampedArray,
    Uint32Array,
    ArrayBuffer,
    WebAssembly,
    performance,
    globalThis: null
  });
  context.globalThis = context;
  vm.runInContext(source, context, { filename: "quadqr.min.js" });
  assert.ok(context.QuadQR);
  const code = context.QuadQR.encodeText("CDN global roundtrip");
  assert.equal(context.QuadQR.decodeMatrix(code.matrix).text, "CDN global roundtrip");
  assert.equal(typeof context.QuadQR.assessScanability, "function");
  assert.equal(typeof context.QuadQR.generateSigningKeyPair, "function");
}

console.log("Package distribution tests passed.");
