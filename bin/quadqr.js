#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import {
  bytesToHex,
  decryptDecoded,
  encodeSecureText,
  encodeSignedText,
  encodeText,
  generateRaw256Key,
  generateSigningKeyPair,
  verifyDecodedSignature
} from "../dist/index.js";
import { savePNG, saveSVG, scanFile } from "../dist/node.js";

function help() {
  console.log(`QuadQR CLI\n\nUsage:\n  quadqr encode <text> [-o file.png|file.svg] [--ecc M] [--version auto|1..40]\n  quadqr encode <text> [--compression auto]\n  quadqr encode <text> --sign-key signing-key.json [--key-id issuer-main]\n  quadqr encode <text> --password <password> [-o file.png|file.svg]\n  quadqr decode <file.png> [--password <password> | --key <64-hex-key>] [--verify-key signing-key.json] [--debug]\n  quadqr keygen\n  quadqr signkeygen [-o signing-key.json]\n\nOptions:\n  -o, --output <file>       Output PNG/SVG path, or signing-key JSON for signkeygen\n  --ecc <L|M|Q|H>          ECC profile (default: M)\n  --version <auto|1..40>    Symbol version (default: auto)\n  --compression <mode>      none|auto|lz (default: auto)\n  --sign-key <file>         Sign using a signkeygen JSON bundle\n  --key-id <id>             Override the signing key ID stored in the QuadQR\n  --embed-public-key        Also embed the public key for untrusted/self-contained checks\n  --verify-key <file>       Verify a signed QuadQR with a trusted key bundle\n  --password <text>         Encrypt/decrypt with password mode\n  --key <hex>               Encrypt/decrypt with raw 256-bit key mode\n  --print                   Use the print-safe render profile\n  --image-size <px>         Exact square output size (default: 720)\n  --module-size <px>        Legacy pixels-per-module sizing\n  --quiet-zone <modules>    Quiet zone in modules (default: 4)\n  --debug                   Emit scanner diagnostics to stderr on decode\n  -h, --help                Show help\n`);
}

function parse(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "-h" || token === "--help") flags.help = true;
    else if (token === "-o" || token === "--output") flags.output = argv[++i];
    else if (token === "--ecc") flags.ecc = argv[++i];
    else if (token === "--version") flags.version = argv[++i];
    else if (token === "--password") flags.password = argv[++i];
    else if (token === "--key") flags.key = argv[++i];
    else if (token === "--compression") flags.compression = argv[++i];
    else if (token === "--sign-key") flags.signKey = argv[++i];
    else if (token === "--key-id") flags.keyId = argv[++i];
    else if (token === "--embed-public-key") flags.embedPublicKey = true;
    else if (token === "--verify-key") flags.verifyKey = argv[++i];
    else if (token === "--print") flags.print = true;
    else if (token === "--debug") flags.debug = true;
    else if (token === "--image-size") flags.imageSize = Number(argv[++i]);
    else if (token === "--module-size") flags.moduleSize = Number(argv[++i]);
    else if (token === "--quiet-zone") flags.quietZone = Number(argv[++i]);
    else args.push(token);
  }
  return { args, flags };
}

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is missing from signing key bundle.`);
  return new Uint8Array(Buffer.from(value, "base64"));
}

async function readSigningBundle(filename) {
  const parsed = JSON.parse(await readFile(filename, "utf8"));
  if (parsed.algorithm && parsed.algorithm !== "Ed25519") throw new Error(`Unsupported signing algorithm ${parsed.algorithm}.`);
  return {
    privateKey: parsed.privateKeyPkcs8 ? base64ToBytes(parsed.privateKeyPkcs8, "privateKeyPkcs8") : null,
    publicKey: base64ToBytes(parsed.publicKeyRaw || parsed.publicKeyBytes, "publicKeyRaw"),
    keyId: parsed.keyId || null
  };
}

async function main() {
  const { args, flags } = parse(process.argv.slice(2));
  if (flags.help || !args.length) {
    help();
    return;
  }

  const command = args.shift();
  if (command === "keygen") {
    console.log(bytesToHex(generateRaw256Key()));
    return;
  }

  if (command === "signkeygen") {
    const pair = await generateSigningKeyPair();
    const bundle = JSON.stringify({
      format: "quadqr-ed25519-key-v1",
      algorithm: pair.algorithm,
      privateKeyPkcs8: bytesToBase64(pair.privateKeyPkcs8),
      publicKeyRaw: bytesToBase64(pair.publicKeyBytes),
      keyId: pair.keyId
    }, null, 2) + "\n";
    if (flags.output) {
      await writeFile(flags.output, bundle, { mode: 0o600 });
      console.log(`Saved ${flags.output}. Keep the private key file secret.`);
    } else {
      process.stdout.write(bundle);
    }
    return;
  }

  if (command === "encode") {
    const text = args.join(" ");
    if (!text) throw new Error("encode requires text.");
    if (flags.password && flags.key) throw new Error("Choose password mode or raw-key mode, not both.");

    const options = {
      ecc: flags.ecc || "M",
      compression: flags.compression || "auto",
      ...(flags.version && flags.version !== "auto" ? { version: Number(flags.version) } : {})
    };
    const signingBundle = flags.signKey ? await readSigningBundle(flags.signKey) : null;
    const signing = signingBundle ? {
      privateKey: signingBundle.privateKey,
      keyId: flags.keyId || signingBundle.keyId || undefined,
      ...(flags.embedPublicKey ? { publicKey: signingBundle.publicKey, embedPublicKey: true } : {})
    } : null;
    const security = flags.password
      ? { mode: "password", password: flags.password }
      : flags.key
        ? { mode: "raw-key", key: flags.key }
        : null;

    let code;
    if (security) {
      code = await encodeSecureText(text, { ...options, security, ...(signing ? { signing } : {}) });
    } else if (signing) {
      code = await encodeSignedText(text, { ...options, ...signing });
    } else {
      code = encodeText(text, options);
    }

    const output = flags.output || "quadqr.png";
    const renderOptions = {
      quietZone: Number.isFinite(flags.quietZone) ? flags.quietZone : 4,
      ...(flags.print ? { mode: "print" } : {}),
      ...(Number.isFinite(flags.imageSize)
        ? { imageSize: flags.imageSize }
        : Number.isFinite(flags.moduleSize)
          ? { moduleSize: flags.moduleSize }
          : { imageSize: 720 })
    };
    const saved = output.toLowerCase().endsWith(".svg")
      ? await saveSVG(code, output, renderOptions)
      : await savePNG(code, output, renderOptions);
    console.log(`Saved ${output} (${saved.bytes} bytes, v${code.version}, ${code.size}x${code.size}, ECC ${code.eccLevel}).`);
    return;
  }

  if (command === "decode") {
    const filename = args[0];
    if (!filename) throw new Error("decode requires an image filename.");
    let result = await scanFile(filename, flags.debug ? { debug: true } : {});
    if (result.secure) {
      if (!flags.password && !flags.key) {
        console.log(JSON.stringify({
          secure: true,
          mode: result.security?.mode,
          algorithm: result.security?.algorithm,
          keyId: result.security?.keyId || result.security?.keyIdHex || null,
          requiresDecryption: true
        }, null, 2));
        process.exitCode = 2;
        return;
      }
      result = await decryptDecoded(result, flags.password ? { password: flags.password } : { key: flags.key });
    }
    if (result.signed && flags.verifyKey) {
      const verifier = await readSigningBundle(flags.verifyKey);
      result = await verifyDecodedSignature(result, { publicKey: verifier.publicKey });
    }
    if (flags.debug) {
      console.error(JSON.stringify({
        confidence: result.confidence ?? null,
        geometryConfidence: result.geometryConfidence ?? null,
        calibrationConfidence: result.calibrationConfidence ?? null,
        eccUtilization: result.eccUtilization ?? null,
        signed: Boolean(result.signed),
        signatureVerified: result.signatureVerified ?? null,
        signatureTrusted: result.signatureTrusted ?? null,
        signingKeyId: result.signingKeyId ?? null,
        diagnostics: result.diagnostics ?? null
      }, null, 2));
    }
    if (result.text != null) console.log(result.text);
    else process.stdout.write(Buffer.from(result.payload));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`QuadQR: ${error.message}`);
  process.exitCode = 1;
});
