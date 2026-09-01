import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), "..");
const source = path.join(root, "library", "camera-scanner-worker-core.js");
const targetDir = path.join(root, "dist", "esm");
const target = path.join(targetDir, "camera-scanner-worker-core.js");

await mkdir(targetDir, { recursive: true });
await copyFile(source, target);
console.log("Copied camera scanner worker core to dist/esm.");
