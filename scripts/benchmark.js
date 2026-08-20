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
const report = benchmarkReport(options);

if (options.json) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log(`QuadQR benchmark · ECC ${report.performance.ecc}`);
console.log(report.caveat);
console.log("\nSame-size capacity comparison (byte mode for standard QR):");
console.table(report.capacity.map((row) => ({
  version: `v${row.version}`,
  matrix: `${row.size}x${row.size}`,
  QuadQR_B: row.quadqrBytes,
  QR_B: row.standardQrBytes,
  gain_B: row.differenceBytes,
  ratio: ratio(row.ratio)
})));

console.log(`\nCodec performance (${report.performance.iterations} measured iterations per payload):`);
console.table(report.performance.results.map((row) => row.skipped ? {
  payload_B: row.payloadBytes,
  result: "skipped",
  reason: row.reason
} : {
  payload_B: row.payloadBytes,
  matrix: `${row.size}x${row.size}`,
  version: `v${row.version}`,
  encode_mean: ms(row.encode.meanMs),
  encode_p95: ms(row.encode.p95Ms),
  decode_mean: ms(row.decode.meanMs),
  decode_p95: ms(row.decode.p95Ms)
}));
