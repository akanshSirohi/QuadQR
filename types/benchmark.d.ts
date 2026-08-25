import type { EccLevel } from "./index.js";
export const STANDARD_QR_BYTE_CAPACITY: Readonly<Record<EccLevel, readonly number[]>>;
export function getStandardQrByteCapacity(version: number, ecc?: EccLevel): number;
export function compareCapacity(version: number, ecc?: EccLevel, options?: { highDensity?: boolean }): Record<string, number | string | null>;
export function calculateCapacityPlan(options?: { payload?: string | Uint8Array; payloadBytes?: number; ecc?: EccLevel; highDensity?: boolean; compression?: "none" | "auto" | "lz"; signed?: boolean; keyId?: string; embedPublicKey?: boolean }): Record<string, unknown>;
export function buildCapacityComparison(options?: { ecc?: EccLevel; highDensity?: boolean; versions?: number[] }): Array<Record<string, number | string | null>>;
export function benchmarkCodec(options?: Record<string, unknown>): Record<string, unknown>;
export function benchmarkReport(options?: Record<string, unknown>): Record<string, unknown>;
