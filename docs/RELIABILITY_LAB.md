# Reliability Lab

QuadQR includes a deterministic Reliability Lab for regression testing generated symbols against camera-style damage. It is intended for comparing scanner changes, render settings, ECC profiles, output size, and the experimental High Density Mode under repeatable conditions.

The lab verifies the decoded payload CRC. Finding three locators is not counted as success unless the final payload is recovered correctly.

## Browser demo

Open the **Reliability Lab** tab after generating a QuadQR. The lab provides:

- Quick, Full, and Extreme suites;
- per-scenario pass/fail, confidence, Reed-Solomon correction count, and decode time;
- category-level scoring for optics, lighting, color, resampling, sensor damage, and perspective;
- a 3D perspective playground with X pitch, Y yaw, and Z rotation controls;
- angle sweeps to find the largest tested pitch, yaw, or Z rotation that still decodes.

X pitch and Y yaw simulate a code plane tilting in depth. Z rotation is an in-plane rotation. The controls can be combined.

## Public API

```js
import {
  applyStressDistortion,
  runReliabilityLab,
  runPerspectiveSweep
} from "quadqr-js";

const transformed = applyStressDistortion(imageData, "perspective-3d", 0.5, {
  pitchDegrees: 20,
  yawDegrees: 45,
  rollDegrees: 15
});

const report = runReliabilityLab(imageData, {
  version: encoded.version,
  crc32: encoded.crc32
}, {
  suite: "full"
});

const sweep = runPerspectiveSweep(imageData, {
  version: encoded.version,
  crc32: encoded.crc32
}, {
  axis: "yaw",
  angles: [0, 15, 25, 35, 45, 55]
});
```

## Suites

The Reliability Lab extends the smaller scanability suite with deterministic cases for lens blur, motion blur, low/high exposure, gradient shadow, glare, warm/cool color casts, contrast loss, sensor noise, JPEG-like damage, downscaling, projective skew, 3D pitch/yaw, Z rotation, and combined 3D tilt.

The **Extreme** suite adds stronger perspective cases. These are deliberately demanding and may fail at low pixels-per-module even when the same angle succeeds at a larger rendered size.

## Perspective scanner recovery

The scanner keeps its normal fast path for ordinary frames. When locator scale differences indicate projective foreshortening, the geometry stage can perform a bounded coarse-to-fine search for the primary alignment reference. The fine stage uses denser sub-cell scoring so payload cells are less likely to impersonate the alignment marker. This improves steep-angle recovery without weakening normal structure checks globally.

Distributed secondary alignment references are still used to validate the resulting homography.

## Interpreting results

Synthetic results are regression aids, not a substitute for real phone-camera and print testing. A useful practical metric is the largest reliable angle at the intended physical size and scanning distance, not only the theoretical bits per cell.
