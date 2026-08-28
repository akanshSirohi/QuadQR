import { encodeText, renderToImageData } from "../library/quadqr.js";

let handler = null;
const pending = new Map();

globalThis.self = {
  addEventListener(type, callback) {
    if (type === "message") handler = callback;
  },
  postMessage(message) {
    pending.get(message.id)?.(message);
  }
};

await import(`../demo/compute-worker.js?test=${Date.now()}`);
if (typeof handler !== "function") throw new Error("Demo compute worker did not register a message handler.");

let nextId = 1;
function run(task, payload) {
  const id = nextId++;
  return new Promise(async (resolve) => {
    pending.set(id, resolve);
    await handler({ data: { id, task, payload } });
  });
}

const text = "hello ".repeat(1000);
const encoded = await run("encode", {
  text,
  commonOptions: { version: "auto", ecc: "M", highDensity: false },
  compression: "auto",
  security: null,
  signing: null
});
if (!encoded.ok) throw new Error(encoded.error?.message || "Worker encode failed.");
if (encoded.result.compression !== "brotli") throw new Error(`Expected Auto to choose Brotli, got ${encoded.result.compression}.`);

const sourceCode = encodeText("demo worker scan", { compression: "auto", ecc: "M" });
const image = renderToImageData(sourceCode, { imageSize: 420, quietZone: 4 });
const scanned = await run("scan", {
  imageData: { width: image.width, height: image.height, data: image.data },
  options: { minVersion: sourceCode.version, maxVersion: sourceCode.version }
});
if (!scanned.ok) throw new Error(scanned.error?.message || "Worker scan failed.");
if (scanned.result.text !== "demo worker scan") throw new Error("Worker scan payload mismatch.");

const benchmark = await run("benchmark", {
  options: { ecc: "M", iterations: 1, payloadSizes: [32] }
});
if (!benchmark.ok) throw new Error(benchmark.error?.message || "Worker benchmark failed.");
if (benchmark.result.normal.results.length !== 1 || benchmark.result.highDensity.results.length !== 1) {
  throw new Error("Worker benchmark returned unexpected results.");
}

console.log("Demo worker tests passed.");
