export * from "./index.js";
import type { DecodeResult, ImageDataLike, QuadQRCode, RenderOptions, ScanOptions } from "./index.js";

export function decodePNG(input: Uint8Array | ArrayBuffer): ImageDataLike;
export function encodePNG(imageData: ImageDataLike, options?: { compressionLevel?: number }): Buffer;
export function toPNG(codeOrMatrix: QuadQRCode | number[][], options?: RenderOptions & { compressionLevel?: number }): Buffer;
export function savePNG(codeOrMatrix: QuadQRCode | number[][], filename: string | URL, options?: RenderOptions & { compressionLevel?: number }): Promise<{ filename: string | URL; bytes: number }>;
export function toSVG(codeOrMatrix: QuadQRCode | number[][], options?: RenderOptions): string;
export function saveSVG(codeOrMatrix: QuadQRCode | number[][], filename: string | URL, options?: RenderOptions): Promise<{ filename: string | URL; bytes: number }>;
export function scanBuffer(input: Uint8Array | ArrayBuffer, options?: ScanOptions): Promise<DecodeResult>;
export function scanFile(filename: string | URL, options?: ScanOptions): Promise<DecodeResult>;
