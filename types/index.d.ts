export type EccLevel = "L" | "M" | "Q" | "H";
export type RenderStyle = "classic" | "depth" | "soft" | "inset";
export type SecurityMode = "password" | "raw-key";

export interface Palette {
  black?: string;
  white?: string;
  red?: string;
  green?: string;
  blue?: string;
}

export interface EncodeOptions {
  version?: number;
  ecc?: EccLevel;
  maskId?: number;
  text?: boolean;
}

export interface PasswordSecurity {
  mode: "password";
  password: string;
  iterations?: number;
  keyId?: string | Uint8Array | false;
}

export interface RawKeySecurity {
  mode: "raw-key";
  key: string | Uint8Array | ArrayBuffer;
  keyId?: string | Uint8Array | false;
}

export interface SecureEncodeOptions extends EncodeOptions {
  security: PasswordSecurity | RawKeySecurity;
}

export interface QuadQRCode {
  matrix: number[][];
  version: number;
  size: number;
  formatVersion: number;
  eccLevel: EccLevel;
  payloadBytes: number;
  capacityBytes: number;
  secure?: boolean;
  security?: SecurityMetadata | null;
  [key: string]: unknown;
}

export interface SecurityMetadata {
  securePayloadVersion?: number;
  mode?: SecurityMode;
  algorithm?: string;
  kdf?: string | null;
  iterations?: number | null;
  keyId?: string | null;
  keyIdHex?: string | null;
  keyIdAuto?: boolean;
  authenticated?: boolean;
  decrypted?: boolean;
  [key: string]: unknown;
}

export interface DecodeResult {
  payload: Uint8Array;
  text: string | null;
  version: number;
  size: number;
  formatVersion: number;
  eccLevel: EccLevel;
  secure: boolean;
  requiresDecryption?: boolean;
  decrypted?: boolean;
  security?: SecurityMetadata | null;
  encryptedPayload?: Uint8Array;
  [key: string]: unknown;
}

export interface ImageDataLike {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export interface CameraFinderDiagnostic {
  x: number;
  y: number;
  moduleSize: number;
  confirmations?: number;
  score?: number;
}

export interface CameraGeometryDiagnostic {
  version: number;
  size: number;
  score: number;
  estimatedSize?: number;
  alignmentScore?: number;
  alignmentGridScore?: number;
  finders?: {
    topLeft: CameraFinderDiagnostic;
    topRight: CameraFinderDiagnostic;
    bottomLeft: CameraFinderDiagnostic;
  };
  [key: string]: unknown;
}

export interface CameraDiagnosticEvent {
  type: "camera-ready" | "frame" | "method" | "success" | string;
  timestamp: number;
  frame: number;
  state?: "trying" | "miss" | "failed" | "decoded" | string;
  method?: string;
  message?: string;
  elapsedMs?: number;
  missStreak?: number;
  scanWidth?: number;
  scanHeight?: number;
  finderCount?: number;
  finders?: CameraFinderDiagnostic[];
  finderMethod?: string | null;
  finderPasses?: Array<{ method: string; finderCount: number; threshold?: number; geometryCount?: number }>;
  geometry?: CameraGeometryDiagnostic | null;
  [key: string]: unknown;
}

export interface RenderOptions {
  moduleSize?: number;
  quietZone?: number;
  palette?: Palette;
  style?: RenderStyle;
  [key: string]: unknown;
}

export interface ScanOptions {
  minVersion?: number;
  maxVersion?: number;
  perspective?: boolean;
  axisAlignedFallback?: boolean;
  maxDimension?: number;
  sampleRadius?: number;
  robustSampleRadius?: number;
  adaptiveSampling?: boolean;
  spatialColorNormalization?: boolean;
  structureTolerance?: number;
  maxErasureConfidence?: number;
  geometryRefinement?: boolean;
  finderRecovery?: boolean;
  finderAutoColorBlackClip?: number;
  finderAutoColorWhiteClip?: number;
  finderAutoColorHighlightPercentile?: number;
  finderAutoColorOutputHighlight?: number;
  finderAutoColorAnalysisInset?: number;
  finderAutoColorMinimumInputRange?: number;
  finderAutoColorTargetSamples?: number;
  autoEnhanceRecovery?: boolean;
  autoEnhanceWhenNoGeometry?: boolean;
  autoEnhanceBlackClip?: number;
  autoEnhanceWhiteClip?: number;
  autoEnhanceSaturation?: number;
  autoEnhanceTargetSamples?: number;
  fullFrameAutoEnhanceRecovery?: boolean;
  rectifiedAutoEnhanceRecovery?: boolean;
  rectifiedRecoveryModuleSize?: number;
  rectifiedRecoveryRadiusRatio?: number;
  rectifiedAutoEnhanceBlackClip?: number;
  rectifiedAutoEnhanceWhiteClip?: number;
  rectifiedAutoEnhanceSaturation?: number;
  rectifiedAutoEnhanceHighlightFraction?: number;
  videoCropMode?: "visible" | "full";
  videoObjectFit?: string;
  videoObjectPosition?: string;
  videoCropInset?: number;
  refinementOffset?: number;
  refinementStructureThreshold?: number;
  refinementDecodeThreshold?: number;
  refinementDecodeCandidates?: number;
  [key: string]: unknown;
}

export interface CameraFrameMeta {
  frame: number;
  imageData: ImageDataLike;
  scanWidth: number;
  scanHeight: number;
  sourceRect?: { x: number; y: number; width: number; height: number; cropped?: boolean } | null;
  diagnostic?: Record<string, unknown> | null;
}

export interface CameraScanOptions extends ScanOptions {
  scanInterval?: number;
  stopOnResult?: boolean;
  multiFrame?: boolean;
  multiFrameWindow?: number;
  multiFrameMinFrames?: number;
  cameraAutoColorRecovery?: boolean;
  cameraAutoColorEvery?: number;
  cameraAutoColorBlackClip?: number;
  cameraAutoColorWhiteClip?: number;
  cameraAutoColorHighlightPercentile?: number;
  cameraAutoColorOutputHighlight?: number;
  cameraAutoColorAnalysisInset?: number;
  cameraAutoColorMinimumInputRange?: number;
  cameraAutoColorTargetSamples?: number;
  cameraAutoEnhanceEvery?: number;
  cameraFinderRecoveryEvery?: number;
  constraints?: MediaStreamConstraints;
  onResult?: (result: DecodeResult, frame?: CameraFrameMeta | null) => void | Promise<void>;
  onDecode?: (result: DecodeResult, frame?: CameraFrameMeta | null) => void | Promise<void>;
  onScanMiss?: (error: Error) => void;
  onDiagnostic?: (event: CameraDiagnosticEvent) => void;
}

export const FORMAT_VERSION: number;
export const MIN_VERSION: number;
export const MAX_VERSION: number;
export const DEFAULT_ECC_LEVEL: EccLevel;
export const CELL: Readonly<{ BLACK: -1; RED: 0; GREEN: 1; BLUE: 2; WHITE: 3 }>;
export const DEFAULT_PALETTE: Readonly<Required<Palette>>;
export const RENDER_STYLES: Readonly<Record<string, RenderStyle>>;
export const ECC_LEVELS: Readonly<Record<EccLevel, { id: number; paritySymbols: number; correctableSymbolsPerBlock: number }>>;
export const SECURITY_MODES: Readonly<{ PASSWORD: "password"; RAW_KEY: "raw-key" }>;
export const SECURITY_ALGORITHMS: Readonly<{ AES_256_GCM: "AES-256-GCM" }>;
export const SECURE_PAYLOAD_VERSION: number;
export const DEFAULT_PBKDF2_ITERATIONS: number;

export function encodeText(text: string, options?: EncodeOptions): QuadQRCode;
export function encodeBytes(input: Uint8Array | ArrayBuffer | ArrayLike<number>, options?: EncodeOptions): QuadQRCode;
export function encodeSecureText(text: string, options: SecureEncodeOptions): Promise<QuadQRCode>;
export function encodeSecureBytes(input: Uint8Array | ArrayBuffer | ArrayLike<number>, options: SecureEncodeOptions): Promise<QuadQRCode>;
export function decodeMatrix(matrix: number[][], options?: Record<string, unknown>): DecodeResult;
export function decryptDecoded(result: DecodeResult, credentials: { password: string } | { key: string | Uint8Array | ArrayBuffer }): Promise<DecodeResult>;
export function renderToCanvas(codeOrMatrix: QuadQRCode | number[][], canvas: HTMLCanvasElement, options?: RenderOptions): HTMLCanvasElement;
export function renderToImageData(codeOrMatrix: QuadQRCode | number[][], options?: RenderOptions): ImageDataLike;
export function scanImageData(imageData: ImageDataLike, options?: ScanOptions): DecodeResult;
export function scanFile(file: Blob, options?: ScanOptions): Promise<DecodeResult>;
export function scanVideoFrame(video: HTMLVideoElement, options?: ScanOptions): DecodeResult;
export function startCameraScanner(video: HTMLVideoElement, options?: CameraScanOptions): Promise<{ stop(): void; scanNow(): DecodeResult; stream: MediaStream; video: HTMLVideoElement }>;
export function rectifyDetectedCode(imageData: ImageDataLike, options?: Record<string, unknown>): ImageDataLike;
export function rotateMatrix(matrix: number[][], quarterTurns?: number): number[][];
export function getVersionInfo(version: number, options?: { ecc?: EccLevel }): Record<string, unknown>;
export function crc32(bytes: Uint8Array): number;
export function installCrc32Accelerator(accelerator?: ((bytes: Uint8Array) => number) | null): void;
export function generateRaw256Key(): Uint8Array;
export function normalizeRaw256Key(key: string | Uint8Array | ArrayBuffer): Uint8Array;
export function bytesToHex(bytes: Uint8Array): string;

export function initWasm(options?: { url?: string | URL; bytes?: Uint8Array | ArrayBuffer }): Promise<{ enabled: true; module: string; accelerators: readonly string[]; bytes: number }>;
export function getWasmState(): { enabled: true; module: string; accelerators: readonly string[]; bytes: number } | null;
export function disableWasm(): void;

export const internals: Readonly<Record<string, unknown>>;
