#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";
import {
  bytesToHex,
  decryptDecoded,
  encodeSecureText,
  encodeText,
  generateRaw256Key
} from "../dist/index.js";
import { savePNG, saveSVG, scanFile } from "../dist/node.js";

function help() {
  console.log(`QuadQR CLI\n\nUsage:\n  quadqr encode <text> [-o file.png|file.svg] [--ecc M] [--version auto|1..40]\n  quadqr encode <text> --password <password> [-o file.png|file.svg]\n  quadqr encode <text> --key <64-hex-key> [-o file.png|file.svg]\n  quadqr decode <file.png> [--password <password> | --key <64-hex-key>]\n  quadqr keygen\n\nOptions:\n  -o, --output <file>       Output PNG or SVG path (default: quadqr.png)\n  --ecc <L|M|Q|H>          ECC profile (default: M)\n  --version <auto|1..40>    Symbol version (default: auto)\n  --password <text>         Encrypt/decrypt with password mode\n  --key <hex>               Encrypt/decrypt with raw 256-bit key mode\n  --image-size <px>         Exact square output size (default: 720)\n  --module-size <px>        Legacy pixels-per-module sizing\n  --quiet-zone <modules>    Quiet zone in modules (default: 4)\n  -h, --help                Show help\n`);
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
    else if (token === "--image-size") flags.imageSize = Number(argv[++i]);
    else if (token === "--module-size") flags.moduleSize = Number(argv[++i]);
    else if (token === "--quiet-zone") flags.quietZone = Number(argv[++i]);
    else args.push(token);
  }
  return { args, flags };
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

  if (command === "encode") {
    const text = args.join(" ");
    if (!text) throw new Error("encode requires text.");
    if (flags.password && flags.key) throw new Error("Choose password mode or raw-key mode, not both.");

    const options = {
      ecc: flags.ecc || "M",
      ...(flags.version && flags.version !== "auto" ? { version: Number(flags.version) } : {})
    };
    const code = flags.password
      ? await encodeSecureText(text, { ...options, security: { mode: "password", password: flags.password } })
      : flags.key
        ? await encodeSecureText(text, { ...options, security: { mode: "raw-key", key: flags.key } })
        : encodeText(text, options);

    const output = flags.output || "quadqr.png";
    const renderOptions = {
      quietZone: Number.isFinite(flags.quietZone) ? flags.quietZone : 4,
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
    let result = await scanFile(filename);
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
