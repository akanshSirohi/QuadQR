/**
 * Reed-Solomon codec over GF(2^8) = GF(256).
 *
 * Primitive polynomial: x^8 + x^4 + x^3 + x^2 + 1 (0x11d).
 * Each field symbol is one byte. QuadQR serializes every byte as
 * four 2-bit color cells, so RS symbol boundaries stay naturally aligned.
 */

export const FIELD_SIZE = 256;
export const FIELD_ORDER = 255;
export const MAX_CODEWORD_SYMBOLS = 255;

const PRIMITIVE_POLYNOMIAL = 0x11d;
const EXP = new Uint16Array(FIELD_ORDER * 2);
const LOG = new Int16Array(FIELD_SIZE);
LOG.fill(-1);

(function initTables() {
  let value = 1;
  for (let i = 0; i < FIELD_ORDER; i++) {
    EXP[i] = value;
    LOG[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= PRIMITIVE_POLYNOMIAL;
  }
  for (let i = FIELD_ORDER; i < EXP.length; i++) {
    EXP[i] = EXP[i - FIELD_ORDER];
  }
})();

function assertFieldValue(value) {
  if (!Number.isInteger(value) || value < 0 || value >= FIELD_SIZE) {
    throw new Error("GF(256) symbol must be an integer from 0 to 255.");
  }
}

export function gfAdd(a, b) {
  return a ^ b;
}

export function gfNeg(a) {
  return a;
}

export function gfSub(a, b) {
  return a ^ b;
}

export function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a] + LOG[b]) % FIELD_ORDER];
}

export function gfDiv(a, b) {
  if (b === 0) throw new Error("Division by zero in GF(256).");
  if (a === 0) return 0;
  let power = LOG[a] - LOG[b];
  if (power < 0) power += FIELD_ORDER;
  return EXP[power];
}

export function gfPow(a, power) {
  if (power === 0) return 1;
  if (a === 0) return 0;
  let p = (LOG[a] * power) % FIELD_ORDER;
  if (p < 0) p += FIELD_ORDER;
  return EXP[p];
}

export function gfAlphaPow(power) {
  let p = power % FIELD_ORDER;
  if (p < 0) p += FIELD_ORDER;
  return EXP[p];
}

function polyEvalHigh(coeffs, x) {
  let y = 0;
  for (const coeff of coeffs) y = gfAdd(gfMul(y, x), coeff);
  return y;
}

function locatorEvalLow(coeffs, x) {
  let y = 0;
  let xp = 1;
  for (const coeff of coeffs) {
    y = gfAdd(y, gfMul(coeff, xp));
    xp = gfMul(xp, x);
  }
  return y;
}

function buildGenerator(paritySymbols, firstConsecutiveRoot = 0) {
  let generator = [1];
  for (let i = 0; i < paritySymbols; i++) {
    const root = gfAlphaPow(firstConsecutiveRoot + i);
    const factor = [1, root]; // x - root === x + root in characteristic 2
    const next = new Array(generator.length + 1).fill(0);
    for (let a = 0; a < generator.length; a++) {
      for (let b = 0; b < factor.length; b++) {
        next[a + b] = gfAdd(next[a + b], gfMul(generator[a], factor[b]));
      }
    }
    generator = next;
  }
  return generator;
}

const GENERATOR_CACHE = new Map();
function getGenerator(paritySymbols, firstConsecutiveRoot = 0) {
  const key = `${paritySymbols}:${firstConsecutiveRoot}`;
  if (!GENERATOR_CACHE.has(key)) {
    GENERATOR_CACHE.set(key, buildGenerator(paritySymbols, firstConsecutiveRoot));
  }
  return GENERATOR_CACHE.get(key);
}

export function rsEncode(dataSymbols, paritySymbols, options = {}) {
  const data = Array.from(dataSymbols);
  const fcr = options.firstConsecutiveRoot ?? 0;

  if (!Number.isInteger(paritySymbols) || paritySymbols <= 0) {
    throw new Error("paritySymbols must be a positive integer.");
  }
  if (data.length + paritySymbols > MAX_CODEWORD_SYMBOLS) {
    throw new Error(`RS codeword exceeds ${MAX_CODEWORD_SYMBOLS} GF(256) symbols.`);
  }
  for (const value of data) assertFieldValue(value);

  const generator = getGenerator(paritySymbols, fcr);
  const work = data.concat(new Array(paritySymbols).fill(0));

  for (let i = 0; i < data.length; i++) {
    const coef = work[i];
    if (coef === 0) continue;
    for (let j = 0; j < generator.length; j++) {
      work[i + j] = gfSub(work[i + j], gfMul(coef, generator[j]));
    }
  }

  const parity = work.slice(data.length).map(gfNeg);
  return data.concat(parity);
}

export function rsSyndromes(codeword, paritySymbols, options = {}) {
  const fcr = options.firstConsecutiveRoot ?? 0;
  const values = Array.from(codeword);
  return Array.from({ length: paritySymbols }, (_, i) =>
    polyEvalHigh(values, gfAlphaPow(fcr + i))
  );
}

function allZero(values) {
  return values.every((value) => value === 0);
}

function berlekampMassey(syndromes) {
  const n = syndromes.length;
  const C = new Array(n + 1).fill(0);
  const B = new Array(n + 1).fill(0);
  C[0] = 1;
  B[0] = 1;

  let L = 0;
  let m = 1;
  let b = 1;

  for (let index = 0; index < n; index++) {
    let discrepancy = syndromes[index];
    for (let i = 1; i <= L; i++) {
      discrepancy = gfAdd(discrepancy, gfMul(C[i], syndromes[index - i]));
    }

    if (discrepancy === 0) {
      m++;
      continue;
    }

    const T = C.slice();
    const scale = gfDiv(discrepancy, b);
    for (let i = 0; i + m < C.length; i++) {
      if (B[i] !== 0) C[i + m] = gfSub(C[i + m], gfMul(scale, B[i]));
    }

    if (2 * L <= index) {
      L = index + 1 - L;
      for (let i = 0; i < B.length; i++) B[i] = T[i];
      b = discrepancy;
      m = 1;
    } else {
      m++;
    }
  }

  return { locator: C.slice(0, L + 1), errorCount: L };
}

function findErrorPositions(locator, codewordLength) {
  const positions = [];
  for (let power = 0; power < codewordLength; power++) {
    const x = gfAlphaPow(-power);
    if (locatorEvalLow(locator, x) === 0) {
      positions.push(codewordLength - 1 - power);
    }
  }
  return positions;
}

function solveLinearSystem(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, r) => row.slice().concat([vector[r]]));

  for (let col = 0; col < n; col++) {
    let pivot = col;
    while (pivot < n && a[pivot][col] === 0) pivot++;
    if (pivot === n) throw new Error("Singular GF(256) system while solving RS magnitudes.");

    if (pivot !== col) [a[col], a[pivot]] = [a[pivot], a[col]];

    const invPivot = gfDiv(1, a[col][col]);
    for (let j = col; j <= n; j++) a[col][j] = gfMul(a[col][j], invPivot);

    for (let row = 0; row < n; row++) {
      if (row === col || a[row][col] === 0) continue;
      const factor = a[row][col];
      for (let j = col; j <= n; j++) {
        a[row][j] = gfSub(a[row][j], gfMul(factor, a[col][j]));
      }
    }
  }

  return a.map((row) => row[n]);
}

function solveErrorMagnitudes(syndromes, positions, codewordLength, firstConsecutiveRoot) {
  const count = positions.length;
  const matrix = Array.from({ length: count }, () => new Array(count).fill(0));
  const vector = syndromes.slice(0, count);

  for (let row = 0; row < count; row++) {
    const rootPower = firstConsecutiveRoot + row;
    for (let col = 0; col < count; col++) {
      const polynomialPower = codewordLength - 1 - positions[col];
      matrix[row][col] = gfAlphaPow(rootPower * polynomialPower);
    }
  }

  return solveLinearSystem(matrix, vector);
}

function normalizeErasurePositions(positions, codewordLength) {
  if (positions == null) return [];
  if (!Array.isArray(positions)) throw new Error("erasurePositions must be an array of symbol indexes.");
  const unique = [...new Set(positions)];
  for (const position of unique) {
    if (!Number.isInteger(position) || position < 0 || position >= codewordLength) {
      throw new Error(`Invalid Reed-Solomon erasure position ${position}.`);
    }
  }
  return unique.sort((a, b) => a - b);
}

// Remove the contribution of known erasure locations from the syndrome
// sequence. Berlekamp-Massey can then solve only for the remaining unknown
// errors. This is the standard Forney-syndrome reduction, expressed using the
// same coefficient/root convention as the rest of this small codec.
function forneySyndromes(syndromes, erasurePositions, codewordLength) {
  const reduced = syndromes.slice();
  for (const position of erasurePositions) {
    const polynomialPower = codewordLength - 1 - position;
    const x = gfAlphaPow(polynomialPower);
    for (let i = 0; i < reduced.length - 1; i++) {
      reduced[i] = gfAdd(gfMul(reduced[i], x), reduced[i + 1]);
    }
    reduced.pop();
  }
  return reduced;
}

export function rsDecode(codeword, paritySymbols, options = {}) {
  const values = Array.from(codeword);
  const fcr = options.firstConsecutiveRoot ?? 0;

  if (values.length > MAX_CODEWORD_SYMBOLS) {
    throw new Error(`RS codeword exceeds ${MAX_CODEWORD_SYMBOLS} GF(256) symbols.`);
  }
  if (paritySymbols <= 0 || paritySymbols >= values.length) {
    throw new Error("Invalid Reed-Solomon parity length.");
  }
  for (const value of values) assertFieldValue(value);

  const erasurePositions = normalizeErasurePositions(options.erasurePositions, values.length);
  if (erasurePositions.length > paritySymbols) {
    throw new Error(
      `Reed-Solomon has ${erasurePositions.length} erasures but only ${paritySymbols} parity symbols.`
    );
  }

  const syndromes = rsSyndromes(values, paritySymbols, { firstConsecutiveRoot: fcr });
  if (allZero(syndromes)) {
    return {
      corrected: values,
      data: values.slice(0, values.length - paritySymbols),
      correctedSymbols: 0,
      erasureSymbols: 0,
      unknownErrorSymbols: 0,
      errorPositions: []
    };
  }

  let unknownPositions = [];
  if (erasurePositions.length < paritySymbols) {
    const reducedSyndromes = erasurePositions.length
      ? forneySyndromes(syndromes, erasurePositions, values.length)
      : syndromes;

    if (!allZero(reducedSyndromes)) {
      const { locator, errorCount } = berlekampMassey(reducedSyndromes);
      const unknownCorrectionLimit = Math.floor((paritySymbols - erasurePositions.length) / 2);
      if (errorCount <= 0 || errorCount > unknownCorrectionLimit) {
        throw new Error(
          `Reed-Solomon found ${errorCount} unknown symbol errors with ${erasurePositions.length} erasures; ` +
          `limit is ${unknownCorrectionLimit} unknown errors.`
        );
      }

      unknownPositions = findErrorPositions(locator, values.length)
        .filter((position) => !erasurePositions.includes(position));
      if (unknownPositions.length !== errorCount) {
        throw new Error(`Reed-Solomon locator found ${unknownPositions.length}/${errorCount} unknown error positions.`);
      }
    }
  }

  const positions = [...new Set(erasurePositions.concat(unknownPositions))].sort((a, b) => a - b);
  if (positions.length === 0) {
    throw new Error("Reed-Solomon syndromes are non-zero but no correction positions were found.");
  }
  if (2 * unknownPositions.length + erasurePositions.length > paritySymbols) {
    throw new Error(
      `Reed-Solomon error/erasure budget exceeded: 2*${unknownPositions.length} + ` +
      `${erasurePositions.length} > ${paritySymbols}.`
    );
  }

  const magnitudes = solveErrorMagnitudes(syndromes, positions, values.length, fcr);
  const corrected = values.slice();
  for (let i = 0; i < positions.length; i++) {
    corrected[positions[i]] = gfSub(corrected[positions[i]], magnitudes[i]);
  }

  const check = rsSyndromes(corrected, paritySymbols, { firstConsecutiveRoot: fcr });
  if (!allZero(check)) throw new Error("Reed-Solomon correction failed syndrome verification.");

  return {
    corrected,
    data: corrected.slice(0, corrected.length - paritySymbols),
    correctedSymbols: positions.length,
    erasureSymbols: erasurePositions.length,
    unknownErrorSymbols: unknownPositions.length,
    errorPositions: positions
  };
}

export const gf256Internals = Object.freeze({
  EXP,
  LOG,
  PRIMITIVE_POLYNOMIAL,
  buildGenerator,
  berlekampMassey,
  findErrorPositions
});
