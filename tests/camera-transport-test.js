import assert from "node:assert/strict";

console.log("Running camera transport fallback tests...");

let workerIndex = 0;
let imageDataProbeSeen = false;
let imageDataScanSeen = false;

class FakeWorker {
  constructor() {
    this.index = ++workerIndex;
    this.listeners = new Map();
    this.terminated = false;
  }
  addEventListener(type, callback) {
    const list = this.listeners.get(type) ?? [];
    list.push(callback);
    this.listeners.set(type, list);
  }
  emit(type, data) {
    for (const callback of this.listeners.get(type) ?? []) callback({ data });
  }
  postMessage(message) {
    if (this.terminated) throw new Error("Worker terminated");
    if (message.type === "init") {
      queueMicrotask(() => this.emit("message", {
        id: message.id,
        ok: true,
        result: { worker: true, offscreenCanvas: true, wasm: null }
      }));
      return;
    }
    if (message.type === "reset") {
      queueMicrotask(() => this.emit("message", { id: message.id, ok: true, result: { reset: true } }));
      return;
    }
    if (message.type === "probe") {
      imageDataProbeSeen ||= Boolean(message.imageData?.data);
      queueMicrotask(() => this.emit("message", {
        id: message.id,
        ok: true,
        result: { probe: true, transport: message.imageData ? "image-data" : "bitmap" }
      }));
      return;
    }
    if (message.type !== "scan" && message.type !== "scan-full") {
      throw new Error(`Unexpected worker message ${message.type}`);
    }
    imageDataScanSeen ||= Boolean(message.imageData?.data);
    if (this.index === 1) {
      queueMicrotask(() => this.emit("message", {
        id: message.id,
        ok: true,
        result: {
          ok: false,
          locatorOnly: true,
          candidate: { finderCount: 3 },
          error: { name: "Error", message: "candidate" },
          diagnostics: [{ type: "frame", state: "candidate", finderCount: 3 }]
        }
      }));
      return;
    }
    queueMicrotask(() => this.emit("message", {
      id: message.id,
      ok: true,
      result: {
        ok: true,
        result: { format: "QuadQR", formatVersion: 6, version: 4, eccLevel: "M", text: "safari-image-data", crc32: 123 },
        frameMeta: null,
        diagnostics: []
      }
    }));
  }
  terminate() { this.terminated = true; }
}

class FakeOffscreenCanvas {}
globalThis.Worker = FakeWorker;
globalThis.OffscreenCanvas = FakeOffscreenCanvas;
globalThis.createImageBitmap = async () => { throw new Error("Safari video ImageBitmap path unavailable"); };
globalThis.getComputedStyle = () => ({ objectFit: "cover", objectPosition: "50% 50%" });

const documentListeners = new Map();
globalThis.document = {
  hidden: false,
  baseURI: "https://example.test/",
  createElement(tag) {
    assert.equal(tag, "canvas");
    return {
      width: 0,
      height: 0,
      getContext(type) {
        assert.equal(type, "2d");
        return {
          imageSmoothingEnabled: true,
          imageSmoothingQuality: "medium",
          drawImage() {},
          getImageData(x, y, width, height) {
            return { width, height, data: new Uint8ClampedArray(width * height * 4) };
          }
        };
      }
    };
  },
  addEventListener(type, callback) {
    const list = documentListeners.get(type) ?? [];
    list.push(callback);
    documentListeners.set(type, list);
  },
  removeEventListener() {}
};

const track = {
  stopped: false,
  stop() { this.stopped = true; },
  getSettings() { return { width: 1280, height: 720, frameRate: 30 }; },
  getCapabilities() { return {}; },
  async applyConstraints() {},
  addEventListener() {},
  removeEventListener() {}
};
const stream = {
  getTracks() { return [track]; },
  getVideoTracks() { return [track]; }
};
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { mediaDevices: { async getUserMedia() { return stream; } } }
});

let nextFrame = 1;
const timers = new Map();
const video = {
  videoWidth: 1280,
  videoHeight: 720,
  clientWidth: 640,
  clientHeight: 360,
  readyState: 4,
  srcObject: null,
  muted: false,
  setAttribute() {},
  async play() {},
  getBoundingClientRect() { return { width: 640, height: 360 }; },
  requestVideoFrameCallback(callback) {
    const id = nextFrame++;
    const timer = setTimeout(() => {
      timers.delete(id);
      callback(performance.now(), {});
    }, 0);
    timers.set(id, timer);
    return id;
  },
  cancelVideoFrameCallback(id) {
    clearTimeout(timers.get(id));
    timers.delete(id);
  }
};

const { startCameraScanner } = await import(`../library/quadqr.js?transport=${Date.now()}`);
const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("ImageData fallback test timed out")), 1500);
  startCameraScanner(video, {
    scanInterval: 24,
    stopOnResult: true,
    onResult(value) {
      clearTimeout(timeout);
      resolve(value);
    }
  }).catch((error) => {
    clearTimeout(timeout);
    reject(error);
  });
});

assert.equal(result.text, "safari-image-data");
assert.equal(imageDataProbeSeen, true, "Startup probe should fall back to ImageData when video ImageBitmap capture fails.");
assert.equal(imageDataScanSeen, true, "Live locator/recovery frames should continue through transferable ImageData.");
assert.equal(track.stopped, true);
console.log("Camera transport fallback tests passed.");
