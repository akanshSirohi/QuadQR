export type EccLevel = "L" | "M" | "Q" | "H";
export type RenderStyle = "classic" | "depth" | "soft" | "inset";
export type RenderMode = "screen" | "print";
export type CompressionMode = "none" | "auto" | "lz";
export type SecurityMode = "password" | "raw-key";

export interface Palette {
  black?: string;
  white?: string;
  red?: string;
  green?: string;
  blue?: string;
}

export interface EncodeOptions {
  version?: number | "auto";
  minVersion?: number;
  maxVersion?: number;
  ecc?: EccLevel;
  maskId?: number;
  text?: boolean;
  compression?: CompressionMode;
}

export interface SigningOptions {
  /** Private Ed25519 key used to create the signature. Never embed or distribute it. */
  privateKey: CryptoKey | Uint8Array | ArrayBuffer;
  /** Optional compact identifier stored with the signature so a verifier can select a trusted public key. */
  keyId?: string;
  /** Optional public key used only when embedPublicKey is explicitly enabled. */
  publicKey?: CryptoKey | Uint8Array | ArrayBuffer;
  /** Embed the public key for self-contained integrity checks. Default: false. */
  embedPublicKey?: boolean;
}

export interface SignedEncodeOptions extends EncodeOptions, SigningOptions {}

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
  signing?: SigningOptions;
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
  compressed?: boolean;
  compression?: "none" | "lz";
  signed?: boolean;
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

export interface ScanDiagnostics {
  confidence: number;
  cellConfidence: number;
  structureConfidence: number;
  geometryConfidence: number;
  calibrationConfidence: number;
  eccUtilization: number;
  correctedErrors: number;
  erasureSymbols: number;
  stages?: Record<string, boolean>;
  failedStage?: string | null;
  geometryCandidates?: unknown[];
  sampled?: Record<string, unknown> | null;
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
  protectedPayload?: Uint8Array;
  compressed?: boolean;
  compression?: "none" | "lz";
  signed?: boolean;
  /** Legacy v1 signer label, if decoding an older signed symbol. */
  signer?: string | null;
  signingKeyId?: string | null;
  hasEmbeddedPublicKey?: boolean;
  signatureVerified?: boolean | null;
  signatureTrusted?: boolean | null;
  signatureTrustSource?: "external" | "embedded" | null;
  confidence?: number;
  geometryConfidence?: number;
  calibrationConfidence?: number;
  structureConfidence?: number;
  correctedErrors?: number;
  eccUtilization?: number;
  diagnostics?: ScanDiagnostics;
  [key: string]: unknown;
}

export interface ImageDataLike {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export interface LogoRenderOptions {
  /** Loaded CanvasImageSource in canvas rendering, ImageDataLike in pixel rendering, or URL/data URL in SVG rendering. */
  source: CanvasImageSource | ImageDataLike | string;
  /** Logo width/height as a fraction of the symbol area. Clamped to 0.05..0.30. Default: 0.18. */
  size?: number | "auto";
  /** Clear the modules behind the logo with a solid background before drawing it. */
  clearBackground?: boolean;
  /** Background padding around the logo in modules. Default: 0.65. */
  padding?: number;
  /** Rounded background corner radius in modules. Default: 0.8. */
  radius?: number;
  /** Background color used when clearBackground is enabled. Default: palette white. */
  backgroundColor?: string;
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
  frameWidth?: number;
  frameHeight?: number;
  scanRect?: { x: number; y: number; width: number; height: number };
  finderCount?: number;
  finders?: CameraFinderDiagnostic[];
  finderMethod?: string | null;
  finderPasses?: Array<{ method: string; finderCount: number; threshold?: number; geometryCount?: number }>;
  geometry?: CameraGeometryDiagnostic | null;
  [key: string]: unknown;
}

export interface RenderOptions {
  /** Exact square output size in pixels. If neither imageSize nor moduleSize is supplied, defaults to 720. */
  imageSize?: number;
  /** Legacy/low-level pixels per module sizing. Used when imageSize is not supplied. */
  moduleSize?: number;
  quietZone?: number;
  palette?: Palette;
  style?: RenderStyle;
  /** Screen defaults or print-safe palette/quiet-zone/classic-style behavior. */
  mode?: RenderMode;
  renderMode?: RenderMode;
  allowStyledPrint?: boolean;
  allowUnsafePrintQuietZone?: boolean;
  logo?: CanvasImageSource | ImageDataLike | string | LogoRenderOptions;
  logoSize?: number;
  logoClearBackground?: boolean;
  logoPadding?: number;
  logoRadius?: number;
  logoBackgroundColor?: string;
  [key: string]: unknown;
}

export interface ScanOptions {
  debug?: boolean;
  debugMatrices?: boolean;
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
  /** Refine a valid projective solution with reliable secondary alignment markers on dense versions. */
  alignmentRefinement?: boolean;
  alignmentRefinePatternThreshold?: number;
  alignmentRefineMaxPoints?: number;
  alignmentRefineMaxDisplacement?: number;
  alignmentRefineCandidateMargin?: number;
  alignmentRefineSkipScore?: number;
  finderAutoColorBlackClip?: number;
  finderAutoColorWhiteClip?: number;
  finderAutoColorHighlightPercentile?: number;
  finderAutoColorOutputHighlight?: number;
  finderAutoColorAnalysisInset?: number;
  finderAutoColorAnalysisInsets?: number[];
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
  enhancedImageData?: ImageDataLike | null;
  enhancedRect?: { x: number; y: number; width: number; height: number } | null;
  enhancement?: { method?: string; cropInset?: number; analysisInset?: number; [key: string]: unknown } | null;
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
  cameraAutoColorAnalysisInsets?: number[];
  cameraAutoColorCropInsets?: number[];
  cameraAutoColorMinimumInputRange?: number;
  cameraAutoColorTargetSamples?: number;
  cameraAutoEnhanceEvery?: number;
  cameraFinderRecoveryEvery?: number;
  /** Retry a dense/partial geometry frame at higher resolution after at least two finders are detected. */
  cameraHighResolutionRecovery?: boolean;
  cameraHighResolutionMaxDimension?: number;
  cameraHighResolutionEvery?: number;
  cameraHighResolutionMinFinders?: number;
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
export const RENDER_MODES: Readonly<{ SCREEN: "screen"; PRINT: "print" }>;
export const PRINT_PALETTE: Readonly<Required<Palette>>;
export const COMPRESSION_MODES: Readonly<Record<string, CompressionMode>>;
export const SIGNATURE_ALGORITHMS: Readonly<{ ED25519: "Ed25519" }>;
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
export function encodeUint8Array(input: Uint8Array | ArrayBuffer | ArrayLike<number>, options?: EncodeOptions): QuadQRCode;
export function encodeSignedText(text: string, options: SignedEncodeOptions): Promise<QuadQRCode>;
export function encodeSignedBytes(input: Uint8Array | ArrayBuffer | ArrayLike<number>, options: SignedEncodeOptions): Promise<QuadQRCode>;
export function encodeSecureText(text: string, options: SecureEncodeOptions): Promise<QuadQRCode>;
export function encodeSecureBytes(input: Uint8Array | ArrayBuffer | ArrayLike<number>, options: SecureEncodeOptions): Promise<QuadQRCode>;
export function compressPayload(input: Uint8Array | ArrayBuffer | ArrayLike<number>): Uint8Array;
export function decompressPayload(input: Uint8Array | ArrayBuffer | ArrayLike<number>, expectedLength?: number | null): Uint8Array;
export function deriveSigningKeyId(publicKey: CryptoKey | Uint8Array | ArrayBuffer, bytes?: number): Promise<string>;
export function generateSigningKeyPair(): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey; privateKeyPkcs8: Uint8Array; publicKeyBytes: Uint8Array; keyId: string; algorithm: "Ed25519" }>;
export function decodeMatrix(matrix: number[][], options?: Record<string, unknown>): DecodeResult;
export function decodeUint8Array(matrix: number[][], options?: Record<string, unknown>): Uint8Array;
export function decryptDecoded(result: DecodeResult, credentials: { password: string } | { key: string | Uint8Array | ArrayBuffer }): Promise<DecodeResult>;
export function verifyDecodedSignature(result: DecodeResult, options?: {
  publicKey?: CryptoKey | Uint8Array | ArrayBuffer;
  trustedPublicKey?: CryptoKey | Uint8Array | ArrayBuffer;
  trustedKeys?: Record<string, CryptoKey | Uint8Array | ArrayBuffer> | Map<string, CryptoKey | Uint8Array | ArrayBuffer>;
  allowEmbeddedKey?: boolean;
}): Promise<DecodeResult>;
export function renderToCanvas(codeOrMatrix: QuadQRCode | number[][], canvas: HTMLCanvasElement, options?: RenderOptions): HTMLCanvasElement;
export function renderToImageData(codeOrMatrix: QuadQRCode | number[][], options?: RenderOptions): ImageDataLike;
export function renderToSVG(codeOrMatrix: QuadQRCode | number[][], options?: RenderOptions): string;
export function estimateSafeLogoSize(codeOrMatrix: QuadQRCode | number[][], options?: RenderOptions & { ecc?: EccLevel; utilization?: number }): number;
export function findMaxSafeLogoSize(code: QuadQRCode, options: RenderOptions & { minSize?: number; maxSize?: number; iterations?: number }): { safeSize: number; testedMax: number; iterations: number; empirical: boolean };
export function getPrintGuidance(codeOrMatrix: QuadQRCode | number[][], options?: { quietZone?: number; physicalSizeMm?: number; dpi?: number; minimumModuleMm?: number }): Record<string, unknown>;
export function scanImageData(imageData: ImageDataLike, options?: ScanOptions): DecodeResult;
export function debugScanImageData(imageData: ImageDataLike, options?: ScanOptions): { ok: boolean; result?: DecodeResult; error?: string; debug?: ScanDiagnostics | null };
export function scanFile(file: Blob, options?: ScanOptions): Promise<DecodeResult>;
export function scanVideoFrame(video: HTMLVideoElement, options?: ScanOptions): DecodeResult;
export function startCameraScanner(video: HTMLVideoElement, options?: CameraScanOptions): Promise<{ stop(): void; scanNow(): DecodeResult; stream: MediaStream; video: HTMLVideoElement }>;
export function applyStressDistortion(imageData: ImageDataLike, type: string, severity?: number, options?: Record<string, unknown>): ImageDataLike;
export const STRESS_PROFILES: readonly Readonly<{ id: string; label: string; type: string; severity: number; weight: number }>[];
export function runImageStressTest(imageData: ImageDataLike, expected?: { version?: number; crc32?: number }, options?: Record<string, unknown>): Record<string, unknown>;
export function assessScanability(code: QuadQRCode, renderOptions?: RenderOptions, options?: Record<string, unknown>): Record<string, unknown>;
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
