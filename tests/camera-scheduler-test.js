import assert from "node:assert/strict";
import { startCameraScanner } from "../library/quadqr.js";

console.log("Running camera scheduler tests...");

let workerIndex = 0;
let fastScans = 0;
let recoveryScans = 0;
let recoveryCompleted = 0;
let firstRecoveryTriggeredAfterFastScan = null;
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

    if (message.type !== "scan") throw new Error(`Unexpected worker message ${message.type}`);

    if (this.index === 1) {
      fastScans++;
      const scanNumber = fastScans;
      queueMicrotask(() => {
        if (this.terminated) return;
        if (scanNumber >= 4) {
          this.emit("message", {
            id: message.id,
            ok: true,
            result: {
              ok: true,
              result: { version: 6, eccLevel: "H", text: "fast-fresh-frame" },
              frameMeta: {
                imageData: {
                  width: 16,
                  height: 16,
                  data: new Uint8ClampedArray(16 * 16 * 4)
                }
              },
              diagnostics: []
            }
          });
        } else {
          this.emit("message", {
            id: message.id,
            ok: true,
            result: {
              ok: false,
              error: { name: "Error", message: "miss" },
              diagnostics: [{ type: "frame", state: "miss", finderCount: scanNumber === 3 ? 2 : 0 }]
            }
          });
        }
      });
      return;
    }

    recoveryScans++;
    if (firstRecoveryTriggeredAfterFastScan == null) firstRecoveryTriggeredAfterFastScan = fastScans;
    // Deliberately keep the full-recovery worker busy longer than several
    // fresh-frame scans. The fast worker must still reach its successful third
    // frame without waiting for this timeout.
    setTimeout(() => {
      recoveryCompleted++;
      if (this.terminated) return;
      this.emit("message", {
        id: message.id,
        ok: true,
        result: {
          ok: false,
          error: { name: "Error", message: "slow recovery miss" },
          diagnostics: [{ type: "frame", state: "miss", finderCount: 0 }]
        }
      });
    }, 250);
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
      async getUserMedia(constraints) {
        assert.equal(constraints.video.width.ideal, 1280);
        assert.equal(constraints.video.height.ideal, 720);
        return stream;
      }
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

const decoded = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Camera scheduler test timed out")), 1500);
  startCameraScanner(video, {
    scanInterval: 24,
    maxDimension: 640,
    cameraHighResolutionMaxDimension: 960,
    stopOnResult: true,
    onResult(result) {
      clearTimeout(timeout);
      resolve(result);
    }
  }).catch((error) => {
    clearTimeout(timeout);
    reject(error);
  });
});

const result = await decoded;
assert.equal(result.text, "fast-fresh-frame");
assert.equal(fastScans, 4, "Fresh-frame worker should keep scanning while recovery is busy.");
assert.ok(recoveryScans >= 1, "Full recovery worker should be dispatched after finder evidence appears.");
assert.equal(firstRecoveryTriggeredAfterFastScan, 3, "Empty frames must not start recovery before a plausible QuadQR candidate appears.");
assert.equal(recoveryCompleted, 0, "Successful fresh scan should not wait for slow recovery completion.");
assert.equal(track.stopped, true, "Successful stopOnResult scan should stop the camera track.");
assert.ok(workers.length >= 2, "Camera scanner should use independent fast and recovery workers.");

console.log("Camera scheduler tests passed.");
