'use strict';

/*
 * QuadQR Format v6 structure diagram generator.
 * Geometry mirrors the current QuadQR repository (master, 2026-09-03):
 * - size = 21 + 4 * (version - 1)
 * - 3 primary 7x7 finder patterns + 1-cell white separators
 * - timing modules on row 6 / column 6 between finder regions
 * - standard QR alignment-center schedule for v2..v40, rendered as 5x5 nested eyes
 * - v1 legacy bottom-right 5x5 bootstrap alignment eye + separator
 * - movable 2x6 RGB calibration strip (three adjacent 2x2 patches)
 * - physical data positions enumerated in a two-column vertical zig-zag, skipping reserved cells
 *
 * Reserved physical cells are classified into two groups:
 * - structural reserved: finder, separator, timing, alignment
 * - calibration reserved: the movable 2x6 R/G/B strip
 * Everything else is a normal data position. Protected header, ECC, CRC, payload,
 * and padding are logical stream contents, not fixed physical reserved regions.
 *
 * Payload colors shown in the blueprint are deterministic illustrative RGBW values.
 * They are NOT intended to be a decodable payload. Structural geometry is the point of this diagram.
 */

const fs = typeof require === 'function' ? require('fs') : null;

const ALIGNMENT_PATTERN_AXES = [
  null,
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
  [6, 28, 50, 72, 94],
  [6, 26, 50, 74, 98],
  [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110],
  [6, 30, 58, 86, 114],
  [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126],
  [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138],
  [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150],
  [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162],
  [6, 26, 54, 82, 110, 138, 166],
  [6, 30, 58, 86, 114, 142, 170]
];

const TYPE = Object.freeze({
  DATA: 'data',
  FINDER_BLACK: 'finder-black',
  FINDER_WHITE: 'finder-white',
  SEPARATOR: 'separator',
  TIMING_BLACK: 'timing-black',
  TIMING_WHITE: 'timing-white',
  ALIGN_BLACK: 'align-black',
  ALIGN_WHITE: 'align-white',
  CAL_RED: 'cal-red',
  CAL_GREEN: 'cal-green',
  CAL_BLUE: 'cal-blue'
});

const RESERVED_CLASS = Object.freeze({
  DATA: 'data-position',
  STRUCTURAL: 'structural-reserved',
  CALIBRATION: 'calibration-reserved'
});

function reservedClassForType(type) {
  if (type === TYPE.DATA) return RESERVED_CLASS.DATA;
  if (type === TYPE.CAL_RED || type === TYPE.CAL_GREEN || type === TYPE.CAL_BLUE) {
    return RESERVED_CLASS.CALIBRATION;
  }
  return RESERVED_CLASS.STRUCTURAL;
}

const PALETTE = Object.freeze({
  black: '#10151d',
  white: '#f8fbff',
  red: '#ef233c',
  green: '#16a34a',
  blue: '#2563eb',
  blueprint: '#071827',
  blueprint2: '#0a2136',
  cyan: '#56d8ff',
  cyanDim: '#2b7d99',
  text: '#eff9ff',
  muted: '#a9c9d7',
  grid: '#12344a',
  yellow: '#ffd166',
  violet: '#b993ff'
});

function sizeForVersion(version) {
  if (!Number.isInteger(version) || version < 1 || version > 40) {
    throw new Error('Version must be an integer from 1 to 40.');
  }
  return 21 + 4 * (version - 1);
}

function alignmentDefinitions(version) {
  const size = sizeForVersion(version);
  if (version === 1) {
    const center = size - 4;
    return [{ row: center, col: center, size: 5, primary: true, bootstrap: true, separator: true }];
  }
  const axes = ALIGNMENT_PATTERN_AXES[version];
  const last = axes[axes.length - 1];
  const out = [];
  for (const row of axes) {
    for (const col of axes) {
      if ((row === 6 && col === 6) || (row === 6 && col === last) || (row === last && col === 6)) continue;
      out.push({ row, col, size: 5, primary: row === last && col === last, bootstrap: false, separator: false });
    }
  }
  return out;
}

function buildLayout(version = 7) {
  const size = sizeForVersion(version);
  const types = Array.from({ length: size }, () => Array(size).fill(TYPE.DATA));
  const reserved = Array.from({ length: size }, () => Array(size).fill(false));

  function set(row, col, type) {
    if (row < 0 || col < 0 || row >= size || col >= size) return;
    reserved[row][col] = true;
    types[row][col] = type;
  }

  function drawFinder(top, left) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = top + r;
        const cc = left + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        if (r === -1 || c === -1 || r === 7 || c === 7) set(rr, cc, TYPE.SEPARATOR);
      }
    }
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const outer = r === 0 || c === 0 || r === 6 || c === 6;
        const center = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        set(top + r, left + c, outer || center ? TYPE.FINDER_BLACK : TYPE.FINDER_WHITE);
      }
    }
  }

  function drawAlignment(def) {
    const radius = 2;
    if (def.separator) {
      const sr = radius + 1;
      for (let r = -sr; r <= sr; r++) {
        for (let c = -sr; c <= sr; c++) {
          if (Math.abs(r) === sr || Math.abs(c) === sr) set(def.row + r, def.col + c, TYPE.SEPARATOR);
        }
      }
    }
    for (let r = -radius; r <= radius; r++) {
      for (let c = -radius; c <= radius; c++) {
        const outer = Math.abs(r) === 2 || Math.abs(c) === 2;
        const center = r === 0 && c === 0;
        set(def.row + r, def.col + c, outer || center ? TYPE.ALIGN_BLACK : TYPE.ALIGN_WHITE);
      }
    }
  }

  function isAreaFree(row, col, height, width) {
    if (row < 0 || col < 0 || row + height > size || col + width > size) return false;
    for (let r = row; r < row + height; r++) {
      for (let c = col; c < col + width; c++) {
        if (reserved[r][c]) return false;
      }
    }
    return true;
  }

  function findCalibrationStripOrigin() {
    const preferred = { row: size - 6, col: size - 13 };
    if (isAreaFree(preferred.row, preferred.col, 2, 6)) return preferred;
    for (let row = size - 8; row >= 8; row--) {
      for (let col = size - 8; col >= 8; col--) {
        if (isAreaFree(row, col, 2, 6)) return { row, col };
      }
    }
    throw new Error(`Unable to reserve calibration strip for version ${version}.`);
  }

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  for (let col = 8; col < size - 8; col++) {
    set(6, col, col % 2 === 0 ? TYPE.TIMING_BLACK : TYPE.TIMING_WHITE);
  }
  for (let row = 8; row < size - 8; row++) {
    set(row, 6, row % 2 === 0 ? TYPE.TIMING_BLACK : TYPE.TIMING_WHITE);
  }

  const alignments = alignmentDefinitions(version);
  alignments.forEach(drawAlignment);

  const calibration = findCalibrationStripOrigin();
  const calTypes = [TYPE.CAL_RED, TYPE.CAL_GREEN, TYPE.CAL_BLUE];
  for (let i = 0; i < 3; i++) {
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) set(calibration.row + r, calibration.col + i * 2 + c, calTypes[i]);
    }
  }

  const dataPositions = [];
  let upward = true;
  let col = size - 1;
  while (col >= 0) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let dx = 0; dx < 2; dx++) {
        const c = col - dx;
        if (c < 0) continue;
        if (!reserved[row][c]) dataPositions.push([row, c]);
      }
    }
    upward = !upward;
    col -= 2;
  }

  const counts = {
    structuralReserved: 0,
    calibrationReserved: 0,
    dataPositions: dataPositions.length
  };
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const cls = reservedClassForType(types[r][c]);
      if (cls === RESERVED_CLASS.STRUCTURAL) counts.structuralReserved++;
      else if (cls === RESERVED_CLASS.CALIBRATION) counts.calibrationReserved++;
    }
  }

  return { version, size, types, reserved, alignments, calibration, dataPositions, counts };
}

function esc(value) {
  return String(value).replace(/[&<>\"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function deterministicDataColor(row, col, index) {
  // Stable, visually balanced illustration only. Not a real payload encoder.
  let x = (((row + 1) * 0x45d9f3b) ^ ((col + 3) * 0x119de1f3) ^ ((index + 7) * 0x27d4eb2d)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  return x & 3;
}

function typeFill(type, row, col, dataIndex) {
  if (type === TYPE.FINDER_BLACK || type === TYPE.TIMING_BLACK || type === TYPE.ALIGN_BLACK) return PALETTE.black;
  if (type === TYPE.FINDER_WHITE || type === TYPE.SEPARATOR || type === TYPE.TIMING_WHITE || type === TYPE.ALIGN_WHITE) return PALETTE.white;
  if (type === TYPE.CAL_RED) return PALETTE.red;
  if (type === TYPE.CAL_GREEN) return PALETTE.green;
  if (type === TYPE.CAL_BLUE) return PALETTE.blue;
  return [PALETTE.red, PALETTE.green, PALETTE.blue, PALETTE.white][deterministicDataColor(row, col, dataIndex)];
}

function generateSVG(options = {}) {
  const version = Number(options.version ?? 7);
  const layout = buildLayout(version);
  const { size, types, alignments, calibration, dataPositions, counts } = layout;

  const W = Number(options.width ?? 1680);
  const H = Number(options.height ?? 1270);
  const quiet = 4;
  const module = Math.min(15, Math.floor(700 / (size + quiet * 2)));
  const symbolModules = size + quiet * 2;
  const symbolPx = symbolModules * module;
  const matrixPx = size * module;
  const ox = 385;
  const oy = 188;
  const mx = ox + quiet * module;
  const my = oy + quiet * module;

  const dataIndexMap = new Map(dataPositions.map((p, i) => [`${p[0]},${p[1]}`, i]));
  const svg = [];
  const push = s => svg.push(s);

  function rect(x, y, w, h, fill, extra = '') {
    push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" ${extra}/>`);
  }
  function line(x1, y1, x2, y2, stroke = PALETTE.cyan, sw = 2, extra = '') {
    push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}" ${extra}/>`);
  }
  function text(x, y, content, sizePx = 18, fill = PALETTE.text, weight = 500, anchor = 'start', extra = '') {
    push(`<text x="${x}" y="${y}" fill="${fill}" font-size="${sizePx}" font-family="Inter,Segoe UI,Arial,sans-serif" font-weight="${weight}" text-anchor="${anchor}" ${extra}>${esc(content)}</text>`);
  }
  function labelBox(x, y, width, title, lines, accent = PALETTE.cyan) {
    const height = 54 + lines.length * 24;
    push(`<g>`);
    rect(x, y, width, height, '#0b2237', `rx="12" stroke="${accent}" stroke-opacity="0.45" stroke-width="1.5"`);
    rect(x, y, 5, height, accent, `rx="2"`);
    text(x + 20, y + 29, title, 20, PALETTE.text, 700);
    lines.forEach((l, i) => text(x + 20, y + 58 + i * 23, l, 14.5, PALETTE.muted, 450));
    push(`</g>`);
    return { x, y, width, height };
  }
  function cellCenter(row, col) {
    return { x: mx + (col + 0.5) * module, y: my + (row + 0.5) * module };
  }
  function callout(box, target, side = 'right', accent = PALETTE.cyan) {
    const sx = side === 'right' ? box.x + box.width : box.x;
    const sy = box.y + Math.min(box.height * 0.5, 48);
    const bendX = side === 'right' ? sx + 48 : sx - 48;
    push(`<polyline points="${sx},${sy} ${bendX},${sy} ${target.x},${target.y}" fill="none" stroke="${accent}" stroke-width="2" stroke-linejoin="round"/>`);
    push(`<circle cx="${target.x}" cy="${target.y}" r="4" fill="${accent}"/>`);
  }

  push(`<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="display:block;width:100%;height:auto;max-width:${W}px" role="img" aria-labelledby="title desc">`);
  push(`<title id="title">QuadQR Format v6 basic structure diagram, Version ${version}</title>`);
  push(`<desc id="desc">Accurate structural blueprint showing QuadQR finder patterns, timing patterns, distributed alignment eyes, RGB calibration strip, quiet zone, and RGBW data cells.</desc>`);
  push(`<defs>
    <pattern id="bp-grid-small" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M 20 0 L 0 0 0 20" fill="none" stroke="#0d3047" stroke-width="1"/></pattern>
    <pattern id="bp-grid-large" width="100" height="100" patternUnits="userSpaceOnUse"><rect width="100" height="100" fill="url(#bp-grid-small)"/><path d="M100 0H0V100" fill="none" stroke="#154765" stroke-width="1.2"/></pattern>
    <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L6,3 z" fill="${PALETTE.yellow}"/></marker>
  </defs>`);

  rect(0, 0, W, H, PALETTE.blueprint);
  rect(0, 0, W, H, 'url(#bp-grid-large)', 'opacity="0.75"');
  rect(22, 22, W - 44, H - 44, 'none', `rx="18" stroke="${PALETTE.cyanDim}" stroke-width="1.5"`);

  text(70, 78, 'QuadQR Basic Structure', 42, PALETTE.text, 760);
  text(70, 112, `Format v6 · Version ${version} · ${size}×${size} matrix`, 18, PALETTE.cyan, 600);
  text(70, 142, 'Geometry is derived from the current QuadQR repository. Colored payload values are illustrative.', 15, PALETTE.muted, 450);

  // Symbol backing / quiet zone.
  rect(ox, oy, symbolPx, symbolPx, '#f8fbff', `rx="4" stroke="${PALETTE.cyan}" stroke-width="2"`);
  rect(mx, my, matrixPx, matrixPx, '#ffffff', `stroke="#6fbdd6" stroke-width="1"`);

  // Matrix modules.
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const type = types[r][c];
      const idx = dataIndexMap.get(`${r},${c}`) ?? -1;
      const fill = typeFill(type, r, c, idx);
      const x = mx + c * module;
      const y = my + r * module;
      const reservedClass = reservedClassForType(type);
      let stroke = '#d8e4ea';
      let strokeWidth = 0.36;
      if (reservedClass === RESERVED_CLASS.STRUCTURAL) {
        stroke = '#53d8ff';
        strokeWidth = 0.58;
      } else if (reservedClass === RESERVED_CLASS.CALIBRATION) {
        stroke = '#ff78a6';
        strokeWidth = 0.9;
      }
      rect(x, y, module, module, fill, `stroke="${stroke}" stroke-width="${strokeWidth}"`);
    }
  }

  // Matrix and quiet-zone dimensions.
  push(`<rect x="${mx}" y="${my}" width="${matrixPx}" height="${matrixPx}" fill="none" stroke="${PALETTE.cyan}" stroke-opacity="0.65" stroke-width="2"/>`);
  push(`<rect x="${ox}" y="${oy}" width="${symbolPx}" height="${symbolPx}" fill="none" stroke="${PALETTE.violet}" stroke-opacity="0.6" stroke-width="1.5" stroke-dasharray="6 6"/>`);

  // Explicit outline around the 12-cell calibration-reserved region.
  push(`<rect x="${mx + calibration.col * module - 2}" y="${my + calibration.row * module - 2}" width="${6 * module + 4}" height="${2 * module + 4}" fill="none" stroke="#ff78a6" stroke-width="2.4" rx="3"/>`);

  // A short, explicit physical zig-zag sample at the bottom-right.
  const pathPoints = dataPositions.slice(0, Math.min(24, dataPositions.length)).map(([r,c]) => cellCenter(r,c));
  if (pathPoints.length > 1) {
    push(`<polyline points="${pathPoints.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="${PALETTE.yellow}" stroke-width="2.2" stroke-opacity="0.85" stroke-dasharray="4 4" marker-end="url(#arrow)"/>`);
  }

  // Left callouts.
  const finderBox = labelBox(65, 220, 270, 'Finder patterns', ['Three primary 7×7 eyes', 'Top-left, top-right, bottom-left'], PALETTE.cyan);
  callout(finderBox, cellCenter(3, 3), 'right', PALETTE.cyan);

  const sepBox = labelBox(65, 350, 270, 'Finder separators', ['1-module structural white border', 'reserved wherever it fits'], '#8ee7ff');
  callout(sepBox, cellCenter(7, 3), 'right', '#8ee7ff');

  const timingBox = labelBox(65, 480, 270, 'Timing patterns', ['Alternating black / white', 'row 6 and column 6'], PALETTE.violet);
  callout(timingBox, cellCenter(6, Math.min(13, size - 10)), 'right', PALETTE.violet);
  const timingVertical = cellCenter(Math.min(17, size - 10), 6);
  line(timingBox.x + timingBox.width, timingBox.y + timingBox.height - 18, timingVertical.x, timingVertical.y, PALETTE.violet, 1.5, 'stroke-opacity="0.8"');

  const quietBox = labelBox(65, 620, 270, 'Quiet zone', ['Renderer default: 4 modules', 'outside the encoded matrix'], '#7dd3fc');
  callout(quietBox, { x: ox + module * 1.8, y: oy + symbolPx * 0.58 }, 'right', '#7dd3fc');

  // Right callouts.
  const alignTarget = alignments.find(a => a.row !== 6 && a.col !== 6) || alignments[0];
  const alignBox = labelBox(1190, 220, 420, 'Distributed alignment eyes', [
    `${alignments.length} nested 5×5 eyes in Version ${version}`,
    'scheduled positions refine perspective geometry'
  ], PALETTE.yellow);
  callout(alignBox, cellCenter(alignTarget.row, alignTarget.col), 'left', PALETTE.yellow);

  const calBox = labelBox(1190, 365, 420, 'RGB calibration strip', [
    '12 physically reserved cells: RR | GG | BB',
    `2×6 strip origin: row ${calibration.row}, col ${calibration.col}`,
    'black / white calibration comes from structure'
  ], '#ff8fa3');
  callout(calBox, cellCenter(calibration.row, calibration.col + 2.5), 'left', '#ff8fa3');

  const dataSample = dataPositions[Math.floor(dataPositions.length * 0.58)];
  const dataBox = labelBox(1190, 535, 420, 'RGBW data cells', [
    'All non-reserved cells belong to the data plane',
    'R / G / B / W = 2 raw bits in normal mode',
    `${counts.dataPositions} physical data positions in this geometry`
  ], '#72f1b8');
  callout(dataBox, cellCenter(dataSample[0], dataSample[1]), 'left', '#72f1b8');

  const pathBox = labelBox(1190, 715, 420, 'Physical position order', [
    'Two-column vertical zig-zag starts bottom-right',
    'reserved cells are skipped',
    'logical cells are spectrally permuted before placement'
  ], PALETTE.yellow);
  callout(pathBox, pathPoints[Math.min(12, pathPoints.length - 1)], 'left', PALETTE.yellow);

  // Reserved-area classification and legend.
  const infoY = 900;
  text(70, infoY - 18, 'Physical cell classes', 19, PALETTE.text, 700);

  const classItems = [
    ['Structural reserved', PALETTE.cyan, `${counts.structuralReserved} cells · finder / separator / timing / alignment`],
    ['Calibration reserved', '#ff78a6', `${counts.calibrationReserved} cells · movable 12-cell RGB calibration strip`],
    ['Data positions', '#72f1b8', `${counts.dataPositions} cells · logical stream is mapped here`]
  ];
  let classX = 70;
  classItems.forEach(([name, accent, detail]) => {
    const boxW = 475;
    rect(classX, infoY, boxW, 64, '#0b2237', `rx="10" stroke="${accent}" stroke-opacity="0.48" stroke-width="1.4"`);
    rect(classX, infoY, 5, 64, accent, 'rx="2"');
    text(classX + 18, infoY + 25, name, 16, PALETTE.text, 700);
    text(classX + 18, infoY + 48, detail, 12.5, PALETTE.muted, 450);
    classX += boxW + 18;
  });

  const noteY = 986;
  const noteH = 86;
  rect(70, noteY, W - 140, noteH, '#091e31', `rx="12" stroke="${PALETTE.violet}" stroke-opacity="0.45" stroke-width="1.3"`);
  text(90, noteY + 27, 'Logical data is not a fixed reserved region', 16, PALETTE.violet, 700);
  text(90, noteY + 52, 'Protected header, body ECC, CRC-32, payload and padding all occupy ordinary data positions after logical framing and spectral-spatial placement.', 13.5, PALETTE.muted, 450);
  text(90, noteY + 73, 'QuadQR has no standard QR format-information block, version-information block, or fixed dark module.', 13.5, PALETTE.cyan, 600);

  // Visible cell colors are intentionally separate from physical cell roles.
  // White is shared by structural-white and data-white cells. Red/green/blue
  // are also used both by payload data and the physically reserved calibration strip.
  const paletteTitleY = 1104;
  const paletteBoxY = 1120;
  const paletteBoxH = 76;
  const paletteBoxX = 70;
  const paletteBoxW = W - 140;
  text(paletteBoxX, paletteTitleY, 'Visible cell colors', 15, PALETTE.text, 700);
  rect(paletteBoxX, paletteBoxY, paletteBoxW, paletteBoxH, '#091e31', `rx="10" stroke="${PALETTE.cyanDim}" stroke-opacity="0.55" stroke-width="1.2"`);

  const legend = [
    ['Black', 'structural only', PALETTE.black],
    ['Red', 'data / calibration', PALETTE.red],
    ['Green', 'data / calibration', PALETTE.green],
    ['Blue', 'data / calibration', PALETTE.blue],
    ['White', 'data / structural', PALETTE.white]
  ];
  const legendColW = paletteBoxW / legend.length;
  legend.forEach(([name, role, color], i) => {
    const colX = paletteBoxX + i * legendColW;
    if (i > 0) {
      line(colX, paletteBoxY + 12, colX, paletteBoxY + paletteBoxH - 12, '#163d54', 1);
    }
    const centerX = colX + legendColW / 2;
    rect(centerX - 10, paletteBoxY + 10, 20, 20, color, 'stroke="#7fa7b8" stroke-width="1"');
    text(centerX, paletteBoxY + 49, name, 12.8, PALETTE.text, 650, 'middle');
    text(centerX, paletteBoxY + 66, role, 11.5, PALETTE.muted, 450, 'middle');
  });

  text(W - 70, H - 34, 'QuadQR Format v6', 12.5, PALETTE.cyanDim, 600, 'end');

  push(`</svg>`);
  return svg.join('\n');
}

function mountQuadQRStructure(target, options = {}) {
  const el = typeof target === 'string' ? document.querySelector(target) : target;
  if (!el) throw new Error('Target element not found.');
  el.innerHTML = generateSVG(options);
  return el.querySelector('svg');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { generateSVG, buildLayout, alignmentDefinitions, sizeForVersion, reservedClassForType, RESERVED_CLASS, mountQuadQRStructure };

  if (require.main === module) {
    const versionArg = Number(process.argv[2] || 7);
    const output = process.argv[3] || `quadqr-structure-v${versionArg}.svg`;
    fs.writeFileSync(output, generateSVG({ version: versionArg }), 'utf8');
    console.log(`Wrote ${output}`);
  }
}

if (typeof window !== 'undefined') {
  window.QuadQRStructureDiagram = { generateSVG, buildLayout, alignmentDefinitions, sizeForVersion, reservedClassForType, RESERVED_CLASS, mountQuadQRStructure };
}
