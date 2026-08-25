# Triangle16 experimental data-cell profile

Triangle16 is an experimental QuadQR data-cell encoding for the high-density branch. It keeps the existing QuadQR geometry, finder patterns, timing pattern, alignment patterns, calibration, Spectrum ECC, CRC, security envelope, compression, and signing behavior, but changes how payload data cells are represented.

## Physical cell

A Triangle16 payload cell is split by one fixed `/` diagonal:

```text
+---------+
| AAAAAA /|
| AAAAA /B|
| AAAA /BB|
| AAA /BBB|
| AA /BBBB|
| A /BBBBB|
| /BBBBBBB|
+---------+
```

`A` is the upper-left triangle and `B` is the lower-right triangle. Each triangle independently uses the existing RGBW alphabet:

```text
R = 00
G = 01
B = 10
W = 11
```

The pair therefore has 16 states:

```text
R/R  R/G  R/B  R/W
G/R  G/G  G/B  G/W
B/R  B/G  B/B  B/W
W/R  W/G  W/B  W/W
```

The first triangle carries the high 2 bits and the second triangle carries the low 2 bits. One Triangle16 body cell therefore carries 4 raw bits, so one byte occupies two body cells instead of four RGBW cells.

## Protected header stays solid

The protected bootstrap/header intentionally does not use mixed-color triangles. Its normal RGBW header cells are represented as same-color pairs such as `R/R`, `G/G`, `B/B`, and `W/W`.

This uses four cells per protected header byte, exactly like RGBW, but makes it much easier for the decoder to recover the mode flag when the image is blurred, skewed, resized, or color-shifted. Header flag bit 6 declares Triangle16 for the ECC-protected body.

## Scanner sampling

The scanner does not sample the diagonal or the exact module center. For each data cell it samples two small regions well inside the triangles, approximately around `(0.28, 0.28)` and `(0.72, 0.72)` in normalized module coordinates.

Each triangle is classified independently against the calibrated RGBW palette. The cell confidence is the weaker of the two triangle confidences. That confidence feeds the existing confidence-aware Spectrum ECC path, allowing an ambiguous triangle pair to become a useful erasure candidate instead of an arbitrary hard error.

The normal image and camera scanner automatically attempts Triangle16 sampling. No separate scan mode is required. If ordinary finder/alignment geometry is good enough to locate the symbol but not precise enough to decode the half-cell regions, the scanner performs one bounded **precise-alignment recovery** pass. That pass uses denser alignment-pattern probes and a finer sub-module search, then retries the same dual-triangle classifier.

## Rendering rules

Triangle16 uses exact hard-edged triangular payload cells. Decorative payload styles are intentionally bypassed in this profile because rounded, inset, soft, or depth effects can reduce the usable sampling area or contaminate the diagonal boundary. Structural modules keep the normal QuadQR rendering behavior.

PNG/ImageData, Canvas, SVG, browser, and Node rendering all support Triangle16.

## API

```js
import { encodeText, CELL_ENCODINGS } from "quadqr-js";

const code = encodeText("High-density QuadQR", {
  ecc: "M",
  cellEncoding: CELL_ENCODINGS.TRIANGLE16
});
```

The string form is also accepted:

```js
const code = encodeText("High-density QuadQR", {
  cellEncoding: "triangle16"
});
```

`rgbw` remains the library default so existing callers are not silently moved to an experimental physical format.

## Capacity

Raw body density is:

```text
RGBW       4 states   2 bits/body cell
Triangle16 16 states  4 bits/body cell
```

The protected header remains RGBW-equivalent, and ECC/CRC overhead is unchanged at the byte level, so usable payload capacity is close to but not exactly 2x for a fixed matrix version.

Use `getVersionInfo(version, { ecc, cellEncoding: "triangle16" })` or the demo capacity calculator for the exact value.

## Reliability caveat

Triangle16 doubles raw body bits per cell, but it also halves the spatial area available to each independently classified color. Its meaningful real-world metric is not only bits per matrix cell. It is reliable payload bytes at a fixed physical size, camera distance, angle, lighting condition, resize/compression pipeline, and print quality.

The branch should therefore be stress-tested before treating Triangle16 as a stable format. Important cases include:

- perspective and partial finder degradation;
- defocus and motion blur;
- low camera pixel coverage per module;
- JPEG compression and repeated image resizing;
- shadows, glare, white-balance shifts, and saturation changes;
- cheap printing, ink spread, paper tint, and camera recapture.

If full 16-state reliability becomes the limiting factor, a restricted triangle alphabet can be explored later without changing the basic physical-cell experiment.
