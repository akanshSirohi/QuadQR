/**
 * Optional QuadQR WASM acceleration.
 *
 * The library never requires WASM. Calling initWasm() installs the bundled
 * CRC-32 and scanner pixel-preprocessing accelerators into the normal
 * synchronous codec/scanner paths. Any load/runtime failure leaves the
 * JavaScript fallbacks available.
 */

import { installCrc32Accelerator } from "./quadqr.js";
import { installVisionAccelerator } from "./vision.js";

let state = null;
let loading = null;

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(input);
}

async function loadBytes(url) {
  if (url.protocol === "file:" && typeof process !== "undefined" && process.versions?.node) {
    const [{ readFile }, { fileURLToPath }] = await Promise.all([
      import("node:fs/promises"),
      import("node:url")
    ]);
    return new Uint8Array(await readFile(fileURLToPath(url)));
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to load QuadQR WASM (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

function heapBaseOf(instance) {
  const rawHeapBase = instance.exports.__heap_base;
  return Number(rawHeapBase?.value ?? rawHeapBase ?? 65536);
}

function ensureMemory(memory, required) {
  if (required <= memory.buffer.byteLength) return;
  const pages = Math.ceil((required - memory.buffer.byteLength) / 65536);
  memory.grow(pages);
}

function makeCrc32(instance) {
  const { memory, crc32_bytes: crc32Bytes } = instance.exports;
  if (!(memory instanceof WebAssembly.Memory) || typeof crc32Bytes !== "function") {
    throw new Error("QuadQR WASM exports are invalid.");
  }

  const heapBase = heapBaseOf(instance);
  return (input) => {
    const bytes = toUint8Array(input);
    const required = heapBase + bytes.length;
    ensureMemory(memory, required);
    new Uint8Array(memory.buffer, heapBase, bytes.length).set(bytes);
    return crc32Bytes(heapBase, bytes.length) >>> 0;
  };
}

function makeVisionAccelerator(instance) {
  const { memory, build_binary_rgba: buildBinaryRgba } = instance.exports;
  if (!(memory instanceof WebAssembly.Memory) || typeof buildBinaryRgba !== "function") return null;

  const heapBase = heapBaseOf(instance);
  const align16 = (value) => (value + 15) & ~15;

  return Object.freeze({
    buildBinary(imageData, options = {}) {
      const width = Number(imageData?.width) || 0;
      const height = Number(imageData?.height) || 0;
      const pixels = width * height;
      if (!pixels || !imageData?.data || imageData.data.length < pixels * 4) {
        throw new Error("Valid ImageData is required for WASM preprocessing.");
      }

      const rgba = toUint8Array(imageData.data);
      const rgbaBytes = pixels * 4;
      const inputPtr = align16(heapBase);
      const grayPtr = align16(inputPtr + rgbaBytes);
      const binaryPtr = align16(grayPtr + pixels);
      const required = binaryPtr + pixels;
      ensureMemory(memory, required);

      new Uint8Array(memory.buffer, inputPtr, rgbaBytes).set(rgba.subarray(0, rgbaBytes));
      const grayMode = options.grayMode === "value" ? 0 : 1;
      const thresholdOffset = Math.round(Number(options.thresholdOffset) || 0);
      const packed = buildBinaryRgba(
        inputPtr,
        pixels,
        grayMode,
        thresholdOffset,
        grayPtr,
        binaryPtr
      ) >>> 0;

      const threshold = packed & 0xff;
      const baseThreshold = (packed >>> 8) & 0xff;
      // Copy results out of WASM memory because a later memory.grow() can detach
      // previously-created views. Scanner callers expect stable Uint8Arrays.
      const gray = new Uint8Array(pixels);
      const binary = new Uint8Array(pixels);
      gray.set(new Uint8Array(memory.buffer, grayPtr, pixels));
      binary.set(new Uint8Array(memory.buffer, binaryPtr, pixels));
      return {
        gray,
        binary,
        threshold,
        baseThreshold,
        grayMode: options.grayMode ?? "luminance",
        accelerated: "wasm"
      };
    }
  });
}

/**
 * Load QuadQR's bundled WebAssembly helper and install it into the codec and
 * scanner. Calling this once accelerates subsequent synchronous scanImageData()
 * and camera-scanner work without changing their return values or API shape.
 * @param {{url?: string|URL, bytes?: Uint8Array|ArrayBuffer}} options
 */
export async function initWasm(options = {}) {
  if (state) return state;
  if (loading) return loading;

  loading = (async () => {
    const bytes = options.bytes
      ? toUint8Array(options.bytes)
      : await loadBytes(options.url ? new URL(options.url, import.meta.url) : new URL("../wasm/quadqr-core.wasm", import.meta.url));

    const { instance } = await WebAssembly.instantiate(bytes, {});
    const crc32 = makeCrc32(instance);
    const vision = makeVisionAccelerator(instance);
    installCrc32Accelerator(crc32);
    if (vision) installVisionAccelerator(vision);

    const accelerators = ["crc32"];
    if (vision) accelerators.push("scanner-preprocess");
    state = Object.freeze({
      enabled: true,
      module: "quadqr-core",
      accelerators: Object.freeze(accelerators),
      bytes: bytes.length
    });
    return state;
  })();

  try {
    return await loading;
  } catch (error) {
    loading = null;
    installCrc32Accelerator(null);
    installVisionAccelerator(null);
    throw error;
  }
}

export function getWasmState() {
  return state;
}

export function disableWasm() {
  installCrc32Accelerator(null);
  installVisionAccelerator(null);
  state = null;
  loading = null;
}
