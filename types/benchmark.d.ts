import type { EccLevel } from "./index.js";
export const STANDARD_QR_BYTE_CAPACITY: Readonly<Record<EccLevel, readonly number[]>>;
export function getStandardQrByteCapacity(version: number, ecc?: EccLevel): number;
export function compareCapacity(version: number, ecc?: EccLevel): Record<string, number | string>;
export function buildCapacityComparison(options?: { ecc?: EccLevel; versions?: number[] }): Array<Record<string, number | string>>;
export function benchmarkCodec(options?: Record<string, unknown>): Record<string, unknown>;
export function benchmarkReport(options?: Record<string, unknown>): string;
