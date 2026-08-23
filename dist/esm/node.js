/**
 * Node.js adapters for QuadQR.
 *
 * Core encoding/decoding remains shared with the browser. This module adds
 * dependency-free PNG file/buffer helpers and can optionally use `sharp`, when
 * already installed by the host application, for JPEG/WebP/AVIF input.
 */

import { readFile, writeFile } from "node:fs/promises";
import { deflateSync, inflateSync } from "node:zlib";
import { webcrypto } from "node:crypto";

import { renderToImageData, renderToSVG, scanImageData } from "./quadqr.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

export * from "./quadqr.js";
export { initWasm, getWasmState, disableWasm } from "./wasm.js";

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function asUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(input);
}

function u32be(value) {
  return Uint8Array.from([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
}

function readU32(bytes, offset) {
  return (((bytes[offset] << 24) >>> 0) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

let PNG_CRC_TABLE = null;
function pngCrc32(bytes) {
  if (!PNG_CRC_TABLE) {
    PNG_CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      PNG_CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = PNG_CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function pngChunk(type, data = new Uint8Array(0)) {
  const typeBytes = Uint8Array.from(type.split("").map((char) => char.charCodeAt(0)));
  const body = concat(typeBytes, data);
  return concat(u32be(data.length), body, u32be(pngCrc32(body)));
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function unfilterRow(filter, row, previous, bpp) {
  const out = new Uint8Array(row.length);
  for (let x = 0; x < row.length; x++) {
    const left = x >= bpp ? out[x - bpp] : 0;
    const up = previous ? previous[x] : 0;
    const upLeft = previous && x >= bpp ? previous[x - bpp] : 0;
    const raw = row[x];
    switch (filter) {
      case 0: out[x] = raw; break;
      case 1: out[x] = (raw + left) & 255; break;
      case 2: out[x] = (raw + up) & 255; break;
      case 3: out[x] = (raw + Math.floor((left + up) / 2)) & 255; break;
      case 4: out[x] = (raw + paeth(left, up, upLeft)) & 255; break;
      default: throw new Error(`Unsupported PNG filter type ${filter}.`);
    }
  }
  return out;
}

function samplePacked(row, index, bitDepth) {
  if (bitDepth === 8) return row[index];
  const perByte = 8 / bitDepth;
  const byte = row[Math.floor(index / perByte)];
  const shift = (perByte - 1 - (index % perByte)) * bitDepth;
  const mask = (1 << bitDepth) - 1;
  return (byte >>> shift) & mask;
}

/** Decode a non-interlaced PNG into QuadQR's RGBA ImageData shape. */
export function decodePNG(input) {
  const bytes = asUint8Array(input);
  assert(bytes.length >= 33, "PNG input is too short.");
  assert(PNG_SIGNATURE.every((value, index) => bytes[index] === value), "Input is not a PNG image.");

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let palette = null;
  let transparency = null;
  const idat = [];

  while (offset + 12 <= bytes.length) {
    const length = readU32(bytes, offset);
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    const start = offset + 8;
    const end = start + length;
    assert(end + 4 <= bytes.length, "PNG chunk is truncated.");
    const data = bytes.slice(start, end);

    if (type === "IHDR") {
      width = readU32(data, 0);
      height = readU32(data, 4);
      bitDepth = data[8];
      colorType = data[9];
      assert(data[10] === 0 && data[11] === 0, "Unsupported PNG compression/filter method.");
      interlace = data[12];
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "tRNS") {
      transparency = data;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = end + 4;
  }

  assert(width > 0 && height > 0, "PNG has no valid IHDR dimensions.");
  assert(interlace === 0, "Interlaced PNG is not supported by the dependency-free Node decoder.");
  assert([0, 2, 3, 4, 6].includes(colorType), `Unsupported PNG color type ${colorType}.`);
  if (colorType === 3) assert([1, 2, 4, 8].includes(bitDepth), `Unsupported indexed PNG bit depth ${bitDepth}.`);
  else assert(bitDepth === 8, `Only 8-bit PNG is supported for color type ${colorType}.`);
  if (colorType === 3) assert(palette && palette.length >= 3, "Indexed PNG is missing its palette.");

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const rowBytes = Math.ceil(width * channels * bitDepth / 8);
  const bpp = Math.max(1, Math.ceil(channels * bitDepth / 8));
  const inflated = inflateSync(Buffer.from(concat(...idat)));
  assert(inflated.length === height * (rowBytes + 1), "PNG decompressed data length is unexpected.");

  const rgba = new Uint8ClampedArray(width * height * 4);
  let sourceOffset = 0;
  let previous = null;

  for (let y = 0; y < height; y++) {
    const filter = inflated[sourceOffset++];
    const filtered = inflated.subarray(sourceOffset, sourceOffset + rowBytes);
    sourceOffset += rowBytes;
    const row = unfilterRow(filter, filtered, previous, bpp);
    previous = row;

    for (let x = 0; x < width; x++) {
      const dest = (y * width + x) * 4;
      if (colorType === 6) {
        const src = x * 4;
        rgba[dest] = row[src]; rgba[dest + 1] = row[src + 1]; rgba[dest + 2] = row[src + 2]; rgba[dest + 3] = row[src + 3];
      } else if (colorType === 2) {
        const src = x * 3;
        rgba[dest] = row[src]; rgba[dest + 1] = row[src + 1]; rgba[dest + 2] = row[src + 2]; rgba[dest + 3] = 255;
      } else if (colorType === 4) {
        const src = x * 2;
        rgba[dest] = row[src]; rgba[dest + 1] = row[src]; rgba[dest + 2] = row[src]; rgba[dest + 3] = row[src + 1];
      } else if (colorType === 0) {
        const gray = row[x];
        rgba[dest] = gray; rgba[dest + 1] = gray; rgba[dest + 2] = gray; rgba[dest + 3] = 255;
      } else {
        const index = samplePacked(row, x, bitDepth);
        const src = index * 3;
        rgba[dest] = palette[src] ?? 0;
        rgba[dest + 1] = palette[src + 1] ?? 0;
        rgba[dest + 2] = palette[src + 2] ?? 0;
        rgba[dest + 3] = transparency?.[index] ?? 255;
      }
    }
  }

  return { width, height, data: rgba };
}

/** Encode an RGBA ImageData-like object as a PNG Buffer. */
export function encodePNG(imageData, options = {}) {
  const { width, height, data } = imageData ?? {};
  assert(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0, "Valid image dimensions are required.");
  assert(data && data.length === width * height * 4, "RGBA image data has an invalid length.");

  const raw = new Uint8Array(height * (1 + width * 4));
  let cursor = 0;
  for (let y = 0; y < height; y++) {
    raw[cursor++] = 0;
    const start = y * width * 4;
    raw.set(data.subarray ? data.subarray(start, start + width * 4) : Uint8Array.from(data).subarray(start, start + width * 4), cursor);
    cursor += width * 4;
  }

  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(width), 0);
  ihdr.set(u32be(height), 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const level = Math.max(0, Math.min(9, options.compressionLevel ?? 9));
  const compressed = new Uint8Array(deflateSync(Buffer.from(raw), { level }));
  return Buffer.from(concat(PNG_SIGNATURE, pngChunk("IHDR", ihdr), pngChunk("IDAT", compressed), pngChunk("IEND")));
}

/** Render a QuadQR code/matrix directly to a PNG Buffer. */
export function toPNG(codeOrMatrix, options = {}) {
  return encodePNG(renderToImageData(codeOrMatrix, options), options);
}

/** Render a QuadQR code/matrix and save it to disk. */
export async function savePNG(codeOrMatrix, filename, options = {}) {
  const png = toPNG(codeOrMatrix, options);
  await writeFile(filename, png);
  return { filename, bytes: png.length };
}

/** Render a QuadQR code/matrix directly to an SVG string. */
export function toSVG(codeOrMatrix, options = {}) {
  return renderToSVG(codeOrMatrix, options);
}

/** Render a QuadQR code/matrix and save it as SVG. */
export async function saveSVG(codeOrMatrix, filename, options = {}) {
  const svg = toSVG(codeOrMatrix, options);
  await writeFile(filename, svg, "utf8");
  return { filename, bytes: Buffer.byteLength(svg, "utf8") };
}

async function decodeWithOptionalSharp(buffer) {
  try {
    const { default: sharp } = await import("sharp");
    const result = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return {
      width: result.info.width,
      height: result.info.height,
      data: new Uint8ClampedArray(result.data.buffer, result.data.byteOffset, result.data.byteLength)
    };
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" || /Cannot find package 'sharp'|Cannot find module 'sharp'/.test(error?.message ?? "")) {
      throw new Error("This image format needs the optional 'sharp' package in Node.js. PNG works with no dependencies. Install sharp or pass RGBA data to scanImageData().");
    }
    throw error;
  }
}

/** Scan an image Buffer/Uint8Array. PNG is dependency-free; other formats use optional sharp. */
export async function scanBuffer(input, options = {}) {
  const bytes = asUint8Array(input);
  const imageData = PNG_SIGNATURE.every((value, index) => bytes[index] === value)
    ? decodePNG(bytes)
    : await decodeWithOptionalSharp(Buffer.from(bytes));
  return scanImageData(imageData, options);
}

/** Node.js file scanner. Overrides the browser File-based helper on the node subpath. */
export async function scanFile(filename, options = {}) {
  assert(typeof filename === "string" || filename instanceof URL, "Node scanFile expects a file path or file URL.");
  return scanBuffer(await readFile(filename), options);
}
