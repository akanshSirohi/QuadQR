/**
 * QuadQR Secure Payload v1
 *
 * Security is intentionally layered above the QuadQR matrix/ECC codec.
 * The encrypted envelope is treated as an ordinary byte payload by Spectrum ECC.
 *
 * v1 algorithms:
 * - AES-256-GCM authenticated encryption
 * - Password mode: PBKDF2-HMAC-SHA-256 -> 256-bit AES key
 * - Raw-key mode: caller supplies an exact 256-bit key
 */

export const SECURE_PAYLOAD_VERSION = 1;
export const DEFAULT_PBKDF2_ITERATIONS = 600_000;
export const MIN_PBKDF2_ITERATIONS = 100_000;
export const MAX_PBKDF2_ITERATIONS = 2_000_000;

export const SECURITY_MODES = Object.freeze({
  PASSWORD: "password",
  RAW_KEY: "raw-key"
});

export const SECURITY_ALGORITHMS = Object.freeze({
  AES_256_GCM: "AES-256-GCM"
});

const MAGIC = new Uint8Array([0x51, 0x53, 0x45, 0x43]); // QSEC
const MODE_PASSWORD = 1;
const MODE_RAW_KEY = 2;
const ALGORITHM_AES_256_GCM = 1;
const KDF_NONE = 0;
const KDF_PBKDF2_SHA256 = 1;
const FLAG_KEY_ID_UTF8 = 1;
const FLAG_KEY_ID_AUTO = 1 << 1;
const FIXED_HEADER_BYTES = 24;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const AUTO_KEY_ID_BYTES = 8;
const MAX_KEY_ID_BYTES = 32;

const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
const decoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8", { fatal: false }) : null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function cryptoApi() {
  const api = globalThis.crypto;
  assert(api?.subtle && typeof api.getRandomValues === "function", "Web Crypto API is required for QuadQR secure payloads.");
  return api;
}

function concatBytes(...arrays) {
  const length = arrays.reduce((sum, value) => sum + value.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const value of arrays) {
    output.set(value, offset);
    offset += value.length;
  }
  return output;
}

function u32be(value) {
  const v = value >>> 0;
  return new Uint8Array([
    (v >>> 24) & 0xff,
    (v >>> 16) & 0xff,
    (v >>> 8) & 0xff,
    v & 0xff
  ]);
}

function readU32be(bytes, offset) {
  return (
    ((bytes[offset] << 24) >>> 0) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  ) >>> 0;
}

function equalPrefix(bytes, prefix) {
  if (bytes.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index++) {
    if (bytes[index] !== prefix[index]) return false;
  }
  return true;
}

function toBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  return new Uint8Array(value);
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex) {
  const clean = String(hex).trim().replace(/^0x/i, "").replace(/[\s:-]/g, "");
  assert(clean.length % 2 === 0 && /^[0-9a-f]*$/i.test(clean), "Expected a hexadecimal byte string.");
  const output = new Uint8Array(clean.length / 2);
  for (let index = 0; index < output.length; index++) {
    output[index] = parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

export function normalizeRaw256Key(key) {
  const bytes = typeof key === "string" ? hexToBytes(key) : toBytes(key);
  assert(bytes.length === 32, "Raw QuadQR encryption key must be exactly 32 bytes (256 bits / 64 hex characters).");
  return bytes;
}

export function generateRaw256Key() {
  const key = new Uint8Array(32);
  cryptoApi().getRandomValues(key);
  return key;
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  cryptoApi().getRandomValues(bytes);
  return bytes;
}

function normalizeMode(mode) {
  const value = String(mode ?? "").toLowerCase();
  if (["password", "passphrase"].includes(value)) return SECURITY_MODES.PASSWORD;
  if (["raw-key", "raw", "key", "raw256", "raw-256"].includes(value)) return SECURITY_MODES.RAW_KEY;
  throw new Error('Security mode must be "password" or "raw-key".');
}

function encodeKeyId(keyId) {
  if (keyId == null || keyId === false) return { bytes: new Uint8Array(0), utf8: false, auto: false };
  if (typeof keyId === "string") {
    assert(encoder, "TextEncoder is required for string key IDs.");
    const bytes = encoder.encode(keyId);
    assert(bytes.length > 0 && bytes.length <= MAX_KEY_ID_BYTES, `Key ID must be 1..${MAX_KEY_ID_BYTES} UTF-8 bytes.`);
    return { bytes, utf8: true, auto: false };
  }
  const bytes = toBytes(keyId);
  assert(bytes.length > 0 && bytes.length <= MAX_KEY_ID_BYTES, `Key ID must be 1..${MAX_KEY_ID_BYTES} bytes.`);
  return { bytes, utf8: false, auto: false };
}

async function autoKeyId(rawKey) {
  const digest = new Uint8Array(await cryptoApi().subtle.digest("SHA-256", rawKey));
  return digest.slice(0, AUTO_KEY_ID_BYTES);
}

async function derivePasswordKey(password, salt, iterations, usages) {
  assert(typeof password === "string" && password.length > 0, "A non-empty password is required.");
  assert(encoder, "TextEncoder is required for password encryption.");
  assert(Number.isInteger(iterations), "PBKDF2 iteration count must be an integer.");
  assert(
    iterations >= MIN_PBKDF2_ITERATIONS && iterations <= MAX_PBKDF2_ITERATIONS,
    `PBKDF2 iterations must be ${MIN_PBKDF2_ITERATIONS}..${MAX_PBKDF2_ITERATIONS}.`
  );

  const baseKey = await cryptoApi().subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return cryptoApi().subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    usages
  );
}

async function importRawAesKey(rawKey, usages) {
  return cryptoApi().subtle.importKey(
    "raw",
    normalizeRaw256Key(rawKey),
    { name: "AES-GCM", length: 256 },
    false,
    usages
  );
}

function makeFixedHeader({ modeId, kdfId, flags, saltLength, nonceLength, keyIdLength, iterations, plaintextLength }) {
  const header = new Uint8Array(FIXED_HEADER_BYTES);
  header.set(MAGIC, 0);
  header[4] = SECURE_PAYLOAD_VERSION;
  header[5] = modeId;
  header[6] = ALGORITHM_AES_256_GCM;
  header[7] = kdfId;
  header[8] = flags;
  header[9] = saltLength;
  header[10] = nonceLength;
  header[11] = TAG_BYTES;
  header[12] = keyIdLength;
  header[13] = 0;
  header[14] = 0;
  header[15] = 0;
  header.set(u32be(iterations), 16);
  header.set(u32be(plaintextLength), 20);
  return header;
}

function parseEnvelope(envelope) {
  const bytes = toBytes(envelope);
  assert(bytes.length >= FIXED_HEADER_BYTES + NONCE_BYTES + TAG_BYTES, "Secure payload envelope is too short.");
  assert(equalPrefix(bytes, MAGIC), "Secure payload magic mismatch.");
  assert(bytes[4] === SECURE_PAYLOAD_VERSION, `Unsupported secure payload version ${bytes[4]}.`);
  assert(bytes[6] === ALGORITHM_AES_256_GCM, `Unsupported secure payload algorithm id ${bytes[6]}.`);

  const modeId = bytes[5];
  const kdfId = bytes[7];
  const flags = bytes[8];
  const saltLength = bytes[9];
  const nonceLength = bytes[10];
  const tagLength = bytes[11];
  const keyIdLength = bytes[12];
  const iterations = readU32be(bytes, 16);
  const plaintextLength = readU32be(bytes, 20);

  assert(nonceLength === NONCE_BYTES, `Unsupported AES-GCM nonce length ${nonceLength}.`);
  assert(tagLength === TAG_BYTES, `Unsupported AES-GCM tag length ${tagLength}.`);
  assert(keyIdLength <= MAX_KEY_ID_BYTES, "Secure payload key ID is too long.");

  let mode;
  if (modeId === MODE_PASSWORD) {
    mode = SECURITY_MODES.PASSWORD;
    assert(kdfId === KDF_PBKDF2_SHA256, "Password payload uses an unsupported KDF.");
    assert(saltLength === SALT_BYTES, `Password payload salt must be ${SALT_BYTES} bytes.`);
    assert(iterations >= MIN_PBKDF2_ITERATIONS && iterations <= MAX_PBKDF2_ITERATIONS, "Password payload PBKDF2 iteration count is outside the supported safety range.");
  } else if (modeId === MODE_RAW_KEY) {
    mode = SECURITY_MODES.RAW_KEY;
    assert(kdfId === KDF_NONE, "Raw-key payload must not declare a password KDF.");
    assert(saltLength === 0, "Raw-key payload must not contain a password salt.");
    assert(iterations === 0, "Raw-key payload must not declare PBKDF2 iterations.");
  } else {
    throw new Error(`Unsupported secure payload mode id ${modeId}.`);
  }

  const metadataLength = FIXED_HEADER_BYTES + keyIdLength + saltLength + nonceLength;
  const expectedLength = metadataLength + plaintextLength + tagLength;
  assert(bytes.length === expectedLength, `Secure payload length mismatch: expected ${expectedLength} bytes, got ${bytes.length}.`);

  let cursor = FIXED_HEADER_BYTES;
  const keyIdBytes = bytes.slice(cursor, cursor + keyIdLength);
  cursor += keyIdLength;
  const salt = bytes.slice(cursor, cursor + saltLength);
  cursor += saltLength;
  const nonce = bytes.slice(cursor, cursor + nonceLength);
  cursor += nonceLength;
  const ciphertextWithTag = bytes.slice(cursor);
  const aad = bytes.slice(0, cursor);
  const keyIdUtf8 = Boolean(flags & FLAG_KEY_ID_UTF8);
  const keyIdAuto = Boolean(flags & FLAG_KEY_ID_AUTO);

  return {
    bytes,
    mode,
    modeId,
    kdfId,
    flags,
    salt,
    nonce,
    iterations,
    plaintextLength,
    keyIdBytes,
    keyIdUtf8,
    keyIdAuto,
    ciphertextWithTag,
    aad
  };
}

export function inspectSecureEnvelope(envelope) {
  const parsed = parseEnvelope(envelope);
  return {
    securePayloadVersion: SECURE_PAYLOAD_VERSION,
    mode: parsed.mode,
    algorithm: SECURITY_ALGORITHMS.AES_256_GCM,
    kdf: parsed.mode === SECURITY_MODES.PASSWORD ? "PBKDF2-HMAC-SHA-256" : null,
    iterations: parsed.mode === SECURITY_MODES.PASSWORD ? parsed.iterations : null,
    keyId: parsed.keyIdUtf8 && decoder ? decoder.decode(parsed.keyIdBytes) : null,
    keyIdHex: parsed.keyIdBytes.length ? bytesToHex(parsed.keyIdBytes) : null,
    keyIdAuto: parsed.keyIdAuto,
    plaintextBytes: parsed.plaintextLength,
    envelopeBytes: parsed.bytes.length,
    overheadBytes: parsed.bytes.length - parsed.plaintextLength,
    authenticated: true
  };
}

export async function encryptSecurePayload(input, security = {}) {
  const plaintext = toBytes(input);
  const mode = normalizeMode(security.mode);
  const nonce = randomBytes(NONCE_BYTES);
  let aesKey;
  let salt = new Uint8Array(0);
  let iterations = 0;
  let modeId;
  let kdfId;
  let keyId = { bytes: new Uint8Array(0), utf8: false, auto: false };

  if (mode === SECURITY_MODES.PASSWORD) {
    modeId = MODE_PASSWORD;
    kdfId = KDF_PBKDF2_SHA256;
    iterations = security.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
    salt = randomBytes(SALT_BYTES);
    aesKey = await derivePasswordKey(security.password, salt, iterations, ["encrypt"]);
    if (security.keyId != null && security.keyId !== false) keyId = encodeKeyId(security.keyId);
  } else {
    modeId = MODE_RAW_KEY;
    kdfId = KDF_NONE;
    const rawKey = normalizeRaw256Key(security.key);
    aesKey = await importRawAesKey(rawKey, ["encrypt"]);
    if (security.keyId === false) {
      keyId = { bytes: new Uint8Array(0), utf8: false, auto: false };
    } else if (security.keyId != null) {
      keyId = encodeKeyId(security.keyId);
    } else {
      keyId = { bytes: await autoKeyId(rawKey), utf8: false, auto: true };
    }
  }

  const flags = (keyId.utf8 ? FLAG_KEY_ID_UTF8 : 0) | (keyId.auto ? FLAG_KEY_ID_AUTO : 0);
  const fixedHeader = makeFixedHeader({
    modeId,
    kdfId,
    flags,
    saltLength: salt.length,
    nonceLength: nonce.length,
    keyIdLength: keyId.bytes.length,
    iterations,
    plaintextLength: plaintext.length
  });
  const aad = concatBytes(fixedHeader, keyId.bytes, salt, nonce);
  const ciphertextWithTag = new Uint8Array(await cryptoApi().subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: TAG_BYTES * 8 },
    aesKey,
    plaintext
  ));
  const envelope = concatBytes(aad, ciphertextWithTag);

  return {
    envelope,
    metadata: inspectSecureEnvelope(envelope)
  };
}

export async function decryptSecurePayload(envelope, security = {}) {
  const parsed = parseEnvelope(envelope);
  let aesKey;

  if (parsed.mode === SECURITY_MODES.PASSWORD) {
    aesKey = await derivePasswordKey(security.password, parsed.salt, parsed.iterations, ["decrypt"]);
  } else {
    aesKey = await importRawAesKey(security.key, ["decrypt"]);

    // Key IDs are routing hints, not secrets. When the envelope has an auto
    // fingerprint ID, verify it before doing the more expensive GCM operation.
    if (parsed.keyIdBytes.length && parsed.keyIdAuto && security.verifyKeyId !== false) {
      const expected = await autoKeyId(normalizeRaw256Key(security.key));
      if (expected.length === parsed.keyIdBytes.length) {
        let mismatch = 0;
        for (let index = 0; index < expected.length; index++) mismatch |= expected[index] ^ parsed.keyIdBytes[index];
        assert(mismatch === 0, "Raw encryption key does not match this QuadQR key ID.");
      }
    }
  }

  try {
    const plaintext = new Uint8Array(await cryptoApi().subtle.decrypt(
      { name: "AES-GCM", iv: parsed.nonce, additionalData: parsed.aad, tagLength: TAG_BYTES * 8 },
      aesKey,
      parsed.ciphertextWithTag
    ));
    assert(plaintext.length === parsed.plaintextLength, "Secure payload plaintext length mismatch after decryption.");
    return plaintext;
  } catch (error) {
    if (/key ID/i.test(error?.message ?? "")) throw error;
    throw new Error("Secure QuadQR decryption failed. The password/key is wrong or the encrypted payload was modified.");
  }
}

export const securityInternals = Object.freeze({
  FIXED_HEADER_BYTES,
  SALT_BYTES,
  NONCE_BYTES,
  TAG_BYTES,
  AUTO_KEY_ID_BYTES,
  parseEnvelope
});
