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
if (encoded.result.compressionLevel !== 6) throw new Error(`Expected Auto Brotli quality 6, got ${encoded.result.compressionLevel}.`);

const explicitLz = await run("encode", {
  text: "worker explicit LZ level ".repeat(80),
  commonOptions: { version: "auto", ecc: "M", highDensity: false, compressionLevel: 9 },
  compression: "lz",
  security: null,
  signing: null
});
if (!explicitLz.ok) throw new Error(explicitLz.error?.message || "Worker explicit LZ encode failed.");
if (explicitLz.result.compression !== "lz" || explicitLz.result.compressionLevel !== 9) {
  throw new Error("Worker did not preserve explicit LZ level 9.");
}

const explicit = await run("encode", {
  text: "worker explicit deflate ".repeat(80),
  commonOptions: { version: "auto", ecc: "M", highDensity: false, compressionLevel: 9 },
  compression: "deflate",
  security: null,
  signing: null
});
if (!explicit.ok) throw new Error(explicit.error?.message || "Worker explicit DEFLATE encode failed.");
if (explicit.result.compression !== "deflate" || explicit.result.compressionLevel !== 9) {
  throw new Error("Worker did not preserve explicit DEFLATE level 9.");
}

const smartRows = [];
for (let i = 0; i < 20; i++) {
  smartRows.push(JSON.stringify({ id: i, name: `product-${i % 17}`, category: `cat-${i % 7}`, description: `Repeated product description ${i % 23} with shared words and values`, tags: [`t${i % 5}`, `t${i % 9}`] }));
}
const smartText = smartRows.join("\n");
const autoBoundary = await run("encode", { text: smartText, commonOptions: { version: "auto", ecc: "M", highDensity: false }, compression: "auto", security: null, signing: null });
const smartBoundary = await run("encode", { text: smartText, commonOptions: { version: "auto", ecc: "M", highDensity: false }, compression: "smart", security: null, signing: null });
if (!autoBoundary.ok || !smartBoundary.ok) throw new Error("Worker Smart compression comparison failed.");
if (smartBoundary.result.version > autoBoundary.result.version) throw new Error("Smart compression must not produce a larger version than Auto.");
if (smartBoundary.result.compressionStrategy !== "smart") throw new Error("Worker Smart compression metadata missing.");

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
