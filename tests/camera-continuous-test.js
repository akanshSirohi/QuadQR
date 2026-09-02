import assert from "node:assert/strict";
import { startCameraScanner } from "../library/quadqr.js";

console.log("Running camera continuous-mode tests...");

let workerIndex = 0;
let fastScans = 0;
let recoveryScans = 0;
let recoveryReplies = 0;
const workers = [];

class FakeWorker {
  constructor() {
    this.index = ++workerIndex;
    this.listeners = new Map();
    this.terminated = false;
    workers.push(this);
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
        result: { worker: true, offscreenCanvas: true, wasm: { enabled: true } }
      }));
      return;
    }
    if (message.type === "reset") {
      queueMicrotask(() => {
        if (!this.terminated) this.emit("message", { id: message.id, ok: true, result: { reset: true } });
      });
      return;
    }
    if (message.type !== "scan") throw new Error(`Unexpected worker message ${message.type}`);

    if (this.index === 1) {
      fastScans++;
      const scanNumber = fastScans;
      queueMicrotask(() => {
        if (this.terminated) return;
        if (scanNumber === 1) {
          this.emit("message", {
            id: message.id,
            ok: true,
            result: {
              ok: false,
              error: { name: "Error", message: "candidate miss" },
              diagnostics: [{ type: "frame", state: "miss", finderCount: 2 }]
            }
          });
          return;
        }

        const isB = scanNumber >= 4;
        this.emit("message", {
          id: message.id,
          ok: true,
          result: {
            ok: true,
            result: {
              format: "QuadQR",
              formatVersion: 6,
              version: 6,
              eccLevel: "M",
              text: isB ? "B" : "A",
              crc32: isB ? 222 : 111
            },
            frameMeta: null,
            diagnostics: []
          }
        });
      });
      return;
    }

    recoveryScans++;
    setTimeout(() => {
      recoveryReplies++;
      if (this.terminated) return;
      this.emit("message", {
        id: message.id,
        ok: true,
        result: {
          ok: true,
          result: {
            format: "QuadQR",
            formatVersion: 6,
            version: 6,
            eccLevel: "M",
            text: "STALE-A",
            crc32: 111
          },
          frameMeta: null,
          diagnostics: []
        }
      });
    }, 160);
  }

  terminate() {
    this.terminated = true;
  }
}

class FakeBitmap {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.closed = false;
  }
  close() { this.closed = true; }
}

class FakeOffscreenCanvas {}

globalThis.Worker = FakeWorker;
globalThis.OffscreenCanvas = FakeOffscreenCanvas;
globalThis.createImageBitmap = async (...args) => {
  const options = args.at(-1);
  if (options && typeof options === "object" && Number.isFinite(options.resizeWidth)) {
    return new FakeBitmap(options.resizeWidth, options.resizeHeight);
  }
  return new FakeBitmap(1280, 720);
};
globalThis.getComputedStyle = () => ({ objectFit: "cover", objectPosition: "50% 50%" });

const track = {
  stopped: false,
  stop() { this.stopped = true; },
  getSettings() { return { width: 1280, height: 720, frameRate: 30, facingMode: "environment" }; },
  getCapabilities() { return {}; },
  async applyConstraints() {}
};
const stream = {
  getTracks() { return [track]; },
  getVideoTracks() { return [track]; }
};
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    mediaDevices: {
      async getUserMedia() { return stream; }
    }
  }
});

let nextFrameCallback = 1;
const frameTimers = new Map();
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
  requestVideoFrameCallback(callback) {
    const id = nextFrameCallback++;
    const timer = setTimeout(() => {
      frameTimers.delete(id);
      callback(performance.now(), {});
    }, 0);
    frameTimers.set(id, timer);
    return id;
  },
  cancelVideoFrameCallback(id) {
    const timer = frameTimers.get(id);
    if (timer) clearTimeout(timer);
    frameTimers.delete(id);
  },
  getBoundingClientRect() { return { width: 640, height: 360 }; }
};

const results = [];
let scanner = null;
const done = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Continuous scanner test timed out")), 1600);
  startCameraScanner(video, {
    continuous: true,
    duplicateCooldown: 1000,
    scanInterval: 24,
    cameraRecoveryStrongFinderInterval: 80,
    onResult(result) {
      results.push(result.text);
      if (result.text === "B") {
        clearTimeout(timeout);
        scanner?.stop();
        resolve();
      }
    }
  }).then((value) => {
    scanner = value;
    assert.equal(scanner.continuous, true, "continuous:true should keep the scanner active after a result.");
  }).catch((error) => {
    clearTimeout(timeout);
    reject(error);
  });
});

await done;
await new Promise((resolve) => setTimeout(resolve, 220));

assert.deepEqual(results, ["A", "B"], "Continuous scanning should suppress immediate duplicates and stale recovery results.");
assert.ok(fastScans >= 4, "Fast lane should continue scanning after the first result.");
assert.ok(recoveryScans >= 1, "Recovery should have started from finder evidence.");
assert.equal(recoveryReplies, 1, "The deliberately stale recovery job should complete in the test harness.");
assert.equal(track.stopped, true, "Manual stop should stop the camera after continuous scanning.");
assert.ok(workers.length >= 2, "Continuous test should exercise independent fast and recovery workers.");

console.log("Camera continuous-mode tests passed.");
