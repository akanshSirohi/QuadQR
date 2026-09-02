import assert from "node:assert/strict";
import { startCameraScanner } from "../library/quadqr.js";

console.log("Running camera lifecycle tests...");

let scanCount = 0;

class FakeWorker {
  constructor() {
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
      queueMicrotask(() => {
        if (!this.terminated) this.emit("message", { id: message.id, ok: true, result: {} });
      });
      return;
    }
    if (message.type === "scan") {
      scanCount++;
      queueMicrotask(() => {
        if (!this.terminated) this.emit("message", {
          id: message.id,
          ok: true,
          result: {
            ok: false,
            error: { name: "Error", message: "miss" },
            diagnostics: [{ type: "frame", state: "miss", finderCount: 0 }]
          }
        });
      });
      return;
    }
    throw new Error(`Unexpected worker message ${message.type}`);
  }
  terminate() { this.terminated = true; }
}

class FakeBitmap {
  constructor(width, height) { this.width = width; this.height = height; }
  close() {}
}
class FakeOffscreenCanvas {}

globalThis.Worker = FakeWorker;
globalThis.OffscreenCanvas = FakeOffscreenCanvas;
globalThis.createImageBitmap = async (...args) => {
  const options = args.at(-1);
  return new FakeBitmap(options?.resizeWidth ?? 1280, options?.resizeHeight ?? 720);
};
globalThis.getComputedStyle = () => ({ objectFit: "cover", objectPosition: "50% 50%" });

const documentListeners = new Map();
globalThis.document = {
  hidden: false,
  baseURI: "https://example.test/",
  addEventListener(type, callback) {
    const list = documentListeners.get(type) ?? [];
    list.push(callback);
    documentListeners.set(type, list);
  },
  removeEventListener(type, callback) {
    const list = documentListeners.get(type) ?? [];
    documentListeners.set(type, list.filter((item) => item !== callback));
  }
};
function emitDocument(type) {
  for (const callback of documentListeners.get(type) ?? []) callback();
}

function makeTrack() {
  const listeners = new Map();
  return {
    stopped: false,
    stop() { this.stopped = true; },
    getSettings() { return { width: 1280, height: 720, frameRate: 30 }; },
    getCapabilities() { return {}; },
    async applyConstraints() {},
    addEventListener(type, callback) {
      const list = listeners.get(type) ?? [];
      list.push(callback);
      listeners.set(type, list);
    },
    removeEventListener(type, callback) {
      const list = listeners.get(type) ?? [];
      listeners.set(type, list.filter((item) => item !== callback));
    },
    emit(type) {
      for (const callback of listeners.get(type) ?? []) callback();
    }
  };
}

const streams = [];
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    mediaDevices: {
      async getUserMedia() {
        const track = makeTrack();
        const stream = {
          track,
          getTracks() { return [track]; },
          getVideoTracks() { return [track]; }
        };
        streams.push(stream);
        return stream;
      }
    }
  }
});

function makeVideo() {
  let nextFrameCallback = 1;
  const timers = new Map();
  return {
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
        timers.delete(id);
        callback(performance.now(), {});
      }, 0);
      timers.set(id, timer);
      return id;
    },
    cancelVideoFrameCallback(id) {
      const timer = timers.get(id);
      if (timer) clearTimeout(timer);
      timers.delete(id);
    },
    getBoundingClientRect() { return { width: 640, height: 360 }; }
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Hidden tabs pause scheduling and resume from fresh state.
const controller = new AbortController();
const states = [];
const scanner = await startCameraScanner(makeVideo(), {
  continuous: true,
  scanInterval: 24,
  signal: controller.signal,
  onCameraState(event) { states.push(event.state); }
});
await sleep(70);
assert.ok(scanCount > 0, "Scanner should process frames while visible.");

document.hidden = true;
emitDocument("visibilitychange");
await sleep(15);
const scansWhilePaused = scanCount;
await sleep(70);
assert.equal(scanCount, scansWhilePaused, "Hidden documents should not keep scheduling camera scans.");
assert.equal(scanner.paused, true);

document.hidden = false;
emitDocument("visibilitychange");
await sleep(70);
assert.ok(scanCount > scansWhilePaused, "Scanner should resume when the document becomes visible.");
assert.equal(scanner.paused, false);

controller.abort();
await sleep(10);
assert.equal(streams[0].track.stopped, true, "AbortSignal should stop and clean up the active camera.");
assert.ok(states.includes("paused") && states.includes("running") && states.includes("stopped"));

// Unexpected track termination should also clean up the scanner.
const endedStates = [];
const endedScanner = await startCameraScanner(makeVideo(), {
  continuous: true,
  scanInterval: 24,
  onCameraState(event) { endedStates.push(event.state); }
});
streams[1].track.emit("ended");
await sleep(10);
assert.equal(streams[1].track.stopped, true);
assert.ok(endedStates.includes("ended"));
assert.ok(endedStates.includes("stopped"));
endedScanner.stop();

// Already-aborted signals fail before camera acquisition.
const preAborted = new AbortController();
preAborted.abort();
await assert.rejects(
  () => startCameraScanner(makeVideo(), { signal: preAborted.signal }),
  (error) => error?.name === "AbortError"
);
assert.equal(streams.length, 2, "Pre-aborted scanner must not request a camera stream.");

console.log("Camera lifecycle tests passed.");
