/**
 * Shared QuadQR matrix geometry helpers.
 *
 * Versions 2..40 use the same alignment-pattern center schedule as standard
 * QR Code matrices. QuadQR remains its own symbology, but reuses that proven
 * spatial distribution for alignment references. QuadQR uses one 5x5 primary
 * alignment reference at the bottom-right and compact 3x3 secondary markers.
 * Version 1 keeps the legacy QuadQR bottom-right bootstrap marker because standard QR v1 has no
 * alignment pattern and the QuadQR camera scanner needs a fourth projective
 * reference point.
 */

export const MIN_GEOMETRY_VERSION = 1;
export const MAX_GEOMETRY_VERSION = 40;

// Index by version. Entry 0 is unused. Values are module indices of alignment
// pattern centers, matching the standard QR Code version layout for v2..v40.
export const ALIGNMENT_PATTERN_AXES = Object.freeze([
  null,
  Object.freeze([]),
  Object.freeze([6, 18]),
  Object.freeze([6, 22]),
  Object.freeze([6, 26]),
  Object.freeze([6, 30]),
  Object.freeze([6, 34]),
  Object.freeze([6, 22, 38]),
  Object.freeze([6, 24, 42]),
  Object.freeze([6, 26, 46]),
  Object.freeze([6, 28, 50]),
  Object.freeze([6, 30, 54]),
  Object.freeze([6, 32, 58]),
  Object.freeze([6, 34, 62]),
  Object.freeze([6, 26, 46, 66]),
  Object.freeze([6, 26, 48, 70]),
  Object.freeze([6, 26, 50, 74]),
  Object.freeze([6, 30, 54, 78]),
  Object.freeze([6, 30, 56, 82]),
  Object.freeze([6, 30, 58, 86]),
  Object.freeze([6, 34, 62, 90]),
  Object.freeze([6, 28, 50, 72, 94]),
  Object.freeze([6, 26, 50, 74, 98]),
  Object.freeze([6, 30, 54, 78, 102]),
  Object.freeze([6, 28, 54, 80, 106]),
  Object.freeze([6, 32, 58, 84, 110]),
  Object.freeze([6, 30, 58, 86, 114]),
  Object.freeze([6, 34, 62, 90, 118]),
  Object.freeze([6, 26, 50, 74, 98, 122]),
  Object.freeze([6, 30, 54, 78, 102, 126]),
  Object.freeze([6, 26, 52, 78, 104, 130]),
  Object.freeze([6, 30, 56, 82, 108, 134]),
  Object.freeze([6, 34, 60, 86, 112, 138]),
  Object.freeze([6, 30, 58, 86, 114, 142]),
  Object.freeze([6, 34, 62, 90, 118, 146]),
  Object.freeze([6, 30, 54, 78, 102, 126, 150]),
  Object.freeze([6, 24, 50, 76, 102, 128, 154]),
  Object.freeze([6, 28, 54, 80, 106, 132, 158]),
  Object.freeze([6, 32, 58, 84, 110, 136, 162]),
  Object.freeze([6, 26, 54, 82, 110, 138, 166]),
  Object.freeze([6, 30, 58, 86, 114, 142, 170])
]);

function assertVersion(version) {
  if (!Number.isInteger(version) || version < MIN_GEOMETRY_VERSION || version > MAX_GEOMETRY_VERSION) {
    throw new Error(`Version must be ${MIN_GEOMETRY_VERSION}..${MAX_GEOMETRY_VERSION}.`);
  }
}

export function sizeForVersion(version) {
  assertVersion(version);
  return 21 + 4 * (version - 1);
}

export function versionFromSize(size) {
  const delta = size - 21;
  if (delta < 0 || delta % 4 !== 0) return null;
  const version = delta / 4 + 1;
  return Number.isInteger(version) && version >= MIN_GEOMETRY_VERSION && version <= MAX_GEOMETRY_VERSION
    ? version
    : null;
}

export function alignmentPatternCentersForVersion(version) {
  assertVersion(version);
  const size = sizeForVersion(version);

  if (version === 1) {
    const center = size - 4;
    return [{
      row: center,
      col: center,
      size: 5,
      primary: true,
      bootstrap: true,
      separator: true
    }];
  }

  const axes = ALIGNMENT_PATTERN_AXES[version];
  const last = axes[axes.length - 1];
  const centers = [];

  for (const row of axes) {
    for (const col of axes) {
      // These three locations are occupied by the primary finder patterns.
      if (
        (row === 6 && col === 6) ||
        (row === 6 && col === last) ||
        (row === last && col === 6)
      ) {
        continue;
      }
      const primary = row === last && col === last;
      centers.push({
        row,
        col,
        size: primary ? 5 : 3,
        primary,
        bootstrap: false,
        separator: false
      });
    }
  }

  return centers;
}

export function primaryAlignmentPatternForVersion(version) {
  const centers = alignmentPatternCentersForVersion(version);
  return centers.find((pattern) => pattern.primary) ?? centers[centers.length - 1];
}

export function alignmentPatternRadius(pattern) {
  return pattern.size === 3 ? 1 : 2;
}

export function alignmentPatternIsBlack(pattern, rowOffset, colOffset) {
  const radius = alignmentPatternRadius(pattern);
  if (Math.abs(rowOffset) > radius || Math.abs(colOffset) > radius) return null;

  if (pattern.size === 3) {
    // Compact secondary marker: black 3x3 ring with a white center.
    return rowOffset !== 0 || colOffset !== 0;
  }

  // Primary 5x5 marker: black outer ring, white inner ring, black center.
  const outer = Math.abs(rowOffset) === 2 || Math.abs(colOffset) === 2;
  const center = rowOffset === 0 && colOffset === 0;
  return outer || center;
}
