import { benchmarkReport } from "../library/benchmark.js";

function parseArgs(argv) {
  const options = { ecc: "M", iterations: 30, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--ecc") options.ecc = argv[++i] ?? "M";
    else if (arg.startsWith("--ecc=")) options.ecc = arg.slice(6);
    else if (arg === "--iterations") options.iterations = Number(argv[++i] ?? 30);
    else if (arg.startsWith("--iterations=")) options.iterations = Number(arg.slice(13));
    else if (arg === "--sizes") {
      options.payloadSizes = String(argv[++i] ?? "")
        .split(",")
        .filter(Boolean)
        .map(Number);
    } else if (arg.startsWith("--sizes=")) {
      options.payloadSizes = arg.slice(8).split(",").filter(Boolean).map(Number);
    }
  }
  return options;
}

function ms(value) {
  return `${value.toFixed(3)} ms`;
}

function ratio(value) {
  return value == null ? "n/a" : `${value.toFixed(2)}x`;
}

const options = parseArgs(process.argv.slice(2));
const normalReport = benchmarkReport({ ...options, highDensity: false });
const denseReport = benchmarkReport({ ...options, highDensity: true });

if (options.json) {
  console.log(JSON.stringify({ normal: normalReport, highDensityExperimental: denseReport }, null, 2));
  process.exit(0);
}

console.log(`QuadQR benchmark · ECC ${normalReport.performance.ecc}`);
console.log(normalReport.caveat);
console.log("\nSame-size capacity comparison (byte mode for standard QR):");
console.table(normalReport.capacity.map((row, index) => ({
  version: `v${row.version}`,
  matrix: `${row.size}x${row.size}`,
  QuadQR_B: row.quadqrBytes,
  High_Density_Experimental_B: denseReport.capacity[index].quadqrBytes,
  QR_B: row.standardQrBytes,
  normal_ratio: ratio(row.ratio),
  high_density_ratio: ratio(denseReport.capacity[index].ratio)
})));

console.log(`\nCodec performance (${normalReport.performance.iterations} measured iterations per payload):`);
const performanceRows = [];
for (const [mode, performance] of [
  ["Normal RGBW", normalReport.performance],
  ["High Density (Experimental)", denseReport.performance]
]) {
  for (const row of performance.results) {
    performanceRows.push(row.skipped ? {
      mode,
      payload_B: row.payloadBytes,
      result: "skipped",
      reason: row.reason
    } : {
      mode,
      payload_B: row.payloadBytes,
      matrix: `${row.size}x${row.size}`,
      version: `v${row.version}`,
      encode_mean: ms(row.encode.meanMs),
      encode_p95: ms(row.encode.p95Ms),
      decode_mean: ms(row.decode.meanMs),
      decode_p95: ms(row.decode.p95Ms)
    });
  }
}
console.table(performanceRows);
