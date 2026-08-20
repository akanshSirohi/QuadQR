/**
 * Optional QuadQR WASM acceleration.
 *
 * The library does not require WASM. Calling initWasm() installs the bundled
 * CRC-32 helper into the normal synchronous codec path; failure leaves the
 * JavaScript fallback untouched.
 */

import { installCrc32Accelerator } from "./quadqr.js";

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

function makeCrc32(instance) {
  const { memory, crc32_bytes: crc32Bytes } = instance.exports;
  if (!(memory instanceof WebAssembly.Memory) || typeof crc32Bytes !== "function") {
    throw new Error("QuadQR WASM exports are invalid.");
  }

  const rawHeapBase = instance.exports.__heap_base;
  const heapBase = Number(rawHeapBase?.value ?? rawHeapBase ?? 65536);

  return (input) => {
    const bytes = toUint8Array(input);
    const required = heapBase + bytes.length;
    if (required > memory.buffer.byteLength) {
      const pages = Math.ceil((required - memory.buffer.byteLength) / 65536);
      memory.grow(pages);
    }
    new Uint8Array(memory.buffer, heapBase, bytes.length).set(bytes);
    return crc32Bytes(heapBase, bytes.length) >>> 0;
  };
}

/**
 * Load QuadQR's bundled WebAssembly helper and install it into the codec.
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
    installCrc32Accelerator(crc32);

    state = Object.freeze({
      enabled: true,
      module: "quadqr-core",
      accelerators: Object.freeze(["crc32"]),
      bytes: bytes.length
    });
    return state;
  })();

  try {
    return await loading;
  } catch (error) {
    loading = null;
    throw error;
  }
}

export function getWasmState() {
  return state;
}

export function disableWasm() {
  installCrc32Accelerator(null);
  state = null;
  loading = null;
}
