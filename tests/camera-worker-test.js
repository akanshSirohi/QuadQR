import assert from "node:assert/strict";
import { encodeText, renderToImageData, applyStressDistortion } from "../library/quadqr.js";

console.log("Running camera worker tests...");

let messageHandler = null;
const pending = new Map();
let offscreenCanvasAllocations = 0;

class FakeImageBitmap {
  constructor(imageData) {
    this.width = imageData.width;
    this.height = imageData.height;
    this.data = new Uint8ClampedArray(imageData.data);
    this.closed = false;
  }

  close() {
    this.closed = true;
  }
}

class FakeOffscreenCanvas {
  constructor(width, height) {
    offscreenCanvasAllocations++;
    this._width = width;
    this._height = height;
    this._data = new Uint8ClampedArray(width * height * 4);
    this._context = null;
  }

  get width() { return this._width; }
  set width(value) {
    this._width = value;
    this._data = new Uint8ClampedArray(this._width * this._height * 4);
  }

  get height() { return this._height; }
  set height(value) {
    this._height = value;
    this._data = new Uint8ClampedArray(this._width * this._height * 4);
  }

  getContext(type) {
    if (type !== "2d") return null;
    if (this._context) return this._context;
    const canvas = this;
    this._context = {
      imageSmoothingEnabled: true,
      imageSmoothingQuality: "high",
      drawImage(bitmap, sx, sy, sw, sh, dx, dy, dw, dh) {
        // The worker smoke cases intentionally stay below maxDimension, so no
        // resize is expected. This tiny fake verifies worker orchestration and
        // scanner behavior without adding a native canvas dependency to tests.
        assert.equal(sx, 0);
        assert.equal(sy, 0);
        assert.equal(sw, bitmap.width);
        assert.equal(sh, bitmap.height);
        assert.equal(dx, 0);
        assert.equal(dy, 0);
        assert.equal(dw, canvas.width);
        assert.equal(dh, canvas.height);
        assert.equal(dw, bitmap.width);
        assert.equal(dh, bitmap.height);
        canvas._data = new Uint8ClampedArray(bitmap.data);
      },
      getImageData(x, y, width, height) {
        assert.equal(x, 0);
        assert.equal(y, 0);
        assert.equal(width, canvas.width);
        assert.equal(height, canvas.height);
        return {
          width,
          height,
          data: new Uint8ClampedArray(canvas._data)
        };
      }
    };
    return this._context;
  }
}

globalThis.ImageBitmap = FakeImageBitmap;
globalThis.OffscreenCanvas = FakeOffscreenCanvas;
globalThis.self = {
  addEventListener(type, callback) {
    if (type === "message") messageHandler = callback;
  },
  postMessage(message) {
    pending.get(message.id)?.(message);
  }
};

await import(`../library/camera-scanner-worker.js?test=${Date.now()}`);
assert.equal(typeof messageHandler, "function", "Camera worker did not register its message handler.");

let nextId = 1;
async function request(type, payload = {}) {
  const id = `camera-worker-test-${nextId++}`;
  const response = new Promise((resolve) => pending.set(id, resolve));
  await messageHandler({ data: { id, type, ...payload } });
  pending.delete(id);
  return response;
}

const initialized = await request("init", {
  options: {
    maxDimension: 640,
    finderRecovery: true,
    autoEnhanceRecovery: true,
    cameraGeometryReuse: true
  }
});
assert.equal(initialized.ok, true);
assert.equal(initialized.result.worker, true);
assert.equal(initialized.result.offscreenCanvas, true);

const text = `QuadQR camera worker full scanner ${"worker ".repeat(24)}`;
const code = encodeText(text, { ecc: "H" });
const image = renderToImageData(code, { imageSize: 420, quietZone: 4 });

const cleanBitmap = new FakeImageBitmap(image);
const clean = await request("scan", {
  bitmap: cleanBitmap,
  source: { x: 0, y: 0, width: image.width, height: image.height, cropped: false },
  frame: 1
});
assert.equal(clean.ok, true);
assert.equal(clean.result.ok, true, clean.result.error?.message);
assert.equal(clean.result.result.text, text);
assert.equal(cleanBitmap.closed, true, "Worker must close transferred camera bitmaps after scanning.");

// Exercise the same worker with a projective distortion. This verifies that
// moving scanning off-thread did not replace the perspective-capable scanner
// with a reduced/fast-only decoder.
const perspectiveImage = applyStressDistortion(image, "perspective", 0.22);
const perspectiveBitmap = new FakeImageBitmap(perspectiveImage);
const perspective = await request("scan", {
  bitmap: perspectiveBitmap,
  source: {
    x: 0,
    y: 0,
    width: perspectiveImage.width,
    height: perspectiveImage.height,
    cropped: false
  },
  frame: 2
});
assert.equal(perspective.ok, true);
assert.equal(perspective.result.ok, true, perspective.result.error?.message);
assert.equal(perspective.result.result.text, text);
assert.equal(perspective.result.result.perspectiveCorrected, true);
assert.equal(perspectiveBitmap.closed, true);
// Strong color cast + blur + perspective must still use the complete recovery
// stack inside the worker. This guards against replacing the worker with a
// reduced "fast-only" scanner in future optimizations.
const recoveryText = `Worker recovery stress ${"damage ".repeat(35)}`;
const recoveryCode = encodeText(recoveryText, { ecc: "H" });
let recoveryImage = renderToImageData(recoveryCode, { imageSize: 620, quietZone: 4 });
recoveryImage = applyStressDistortion(recoveryImage, "color-cast", 0.38);
recoveryImage = applyStressDistortion(recoveryImage, "blur", 0.16);
recoveryImage = applyStressDistortion(recoveryImage, "perspective", 0.18);
const recoveryBitmap = new FakeImageBitmap(recoveryImage);
const recovery = await request("scan", {
  bitmap: recoveryBitmap,
  source: { x: 0, y: 0, width: recoveryImage.width, height: recoveryImage.height, cropped: false },
  frame: 3
});
assert.equal(recovery.ok, true);
assert.equal(recovery.result.ok, true, recovery.result.error?.message);
assert.equal(recovery.result.result.text, recoveryText);
assert.equal(recoveryBitmap.closed, true);

// Experimental Triangle16 also needs the same projective scanner in worker
// mode, since dense half-cell color regions are more geometry-sensitive.
const denseText = `Worker Triangle16 perspective ${"dense ".repeat(30)}`;
const denseCode = encodeText(denseText, { ecc: "H", highDensity: true });
let denseImage = renderToImageData(denseCode, { imageSize: 620, quietZone: 4 });
denseImage = applyStressDistortion(denseImage, "perspective", 0.20);
const denseBitmap = new FakeImageBitmap(denseImage);
const dense = await request("scan", {
  bitmap: denseBitmap,
  source: { x: 0, y: 0, width: denseImage.width, height: denseImage.height, cropped: false },
  frame: 4
});
assert.equal(dense.ok, true);
assert.equal(dense.result.ok, true, dense.result.error?.message);
assert.equal(dense.result.result.text, denseText);
assert.equal(dense.result.result.highDensity, true);
assert.equal(denseBitmap.closed, true);

assert.equal(
  offscreenCanvasAllocations,
  1,
  "Camera worker should reuse its pooled OffscreenCanvas across clean, damaged, and dense frames."
);

console.log("Camera worker tests passed.");
