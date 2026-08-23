# QuadQR Format v5

## Status

Experimental custom symbology. It is not ISO QR Code.

Only this RGBW format is implemented. Earlier RGB/ternary formats are intentionally not supported.

## Matrix sizes

```text
size = 21 + 4 * (version - 1)
```

Supported versions: 1 through 40.

## Cell alphabet

Structural black:

```text
BLACK = -1
```

Four data states:

| Cell | 2-bit value | Internal value |
|---|---|---:|
| Red | `00` | 0 |
| Green | `01` | 1 |
| Blue | `10` | 2 |
| White | `11` | 3 |

Structural white and data white intentionally share the same visible/internal value. Reserved-position geometry distinguishes their roles.

## Finder structures

Three 7×7 black/white finder structures are placed at top-left, top-right, and bottom-left, with white separator cells where they fit inside the matrix.

## Alignment patterns

QuadQR always keeps exactly three primary 7×7 finder patterns. Larger versions do **not** add more primary finders. Instead, versions 2 through 40 use distributed black/white alignment markers following the same center-position schedule used by standard QR Code versions. Exactly one bottom-right **primary alignment marker remains 5×5**. Every additional distributed alignment marker is **3×3**, encoded as a black outer ring with a white center.

The three alignment positions that would overlap the primary finder corners are omitted. This produces progressively more alignment references as the matrix grows. Examples:

```text
v2   -> 1 alignment pattern
v7   -> 6 alignment patterns
v14  -> 13 alignment patterns
v28  -> 33 alignment patterns
v40  -> 46 alignment patterns
```

Version 1 is a QuadQR-specific exception. Standard QR v1 has no alignment pattern, but QuadQR keeps one legacy 5×5 bottom-right bootstrap alignment marker with a one-cell white separator so the camera scanner still has a fourth projective reference point.

For versions 2 through 40, the scanner uses the 5×5 bottom-right member of the distributed alignment grid as the primary fourth homography reference and then scores the full expected grid, including the 3×3 secondary markers, to strengthen version/geometry validation.

## Timing structures

Alternating black/white timing cells use row 6 and column 6 between the main finder regions.

## Color calibration

Twelve reserved cells provide three 2×2 color patches:

- 4 red cells
- 4 green cells
- 4 blue cells

Known finder/separator/alignment cells provide black and white references. Therefore white is calibrated without requiring a separate white swatch.

## Data placement

Data positions use a two-column vertical zig-zag beginning at the bottom-right. Reserved finder, separator, timing, alignment, and calibration cells are skipped.

## Byte-to-cell mapping

Each byte is serialized most-significant pair first:

```text
bits 7..6 -> cell 0
bits 5..4 -> cell 1
bits 3..2 -> cell 2
bits 1..0 -> cell 3
```

Example:

```text
11001001
11 00 10 01
 W  R  B  G
```

Therefore:

```text
1 byte = exactly 4 RGBW data cells
1 RGBW data cell = exactly 2 raw bits
```

## Masks

Four masks are defined. Each returns a 2-bit value 0..3:

```text
mask 0 = (row + col) mod 4
mask 1 = (2*row + col) mod 4
mask 2 = (row + 2*col) mod 4
mask 3 = (row*col + row + col) mod 4
```

Encoding and decoding use XOR:

```text
visible = raw XOR mask
raw     = visible XOR mask
```

The encoder evaluates all four masks using run-length and four-state balance penalties. The mask ID is not serialized. The decoder tries all four and accepts only a path whose protected header, ECC, and CRC validate.

## Header

### Versions 2 through 40

The normal logical header is 10 bytes.

| Offset | Size | Meaning |
|---|---:|---|
| 0 | 4 | ASCII magic `QQRW` |
| 4 | 1 | format version `5` |
| 5 | 1 | flags |
| 6 | 4 | payload byte length, big-endian |

It is protected with 8 RS parity bytes:

```text
10 data bytes + 8 parity bytes = 18 RS bytes
18 bytes * 4 cells/byte = 72 data cells
```

The normal header can correct up to four damaged byte symbols.

### Version 1 compact header

The 21×21 symbol uses a compact 4-byte header because the matrix size already identifies version 1.

| Offset | Size | Meaning |
|---|---:|---|
| 0 | 1 | compact format marker `0xC3` |
| 1 | 1 | flags |
| 2 | 1 | payload byte length |
| 3 | 1 | payload length XOR `0xFF` |

The compact header is protected with 4 RS parity bytes:

```text
4 data bytes + 4 parity bytes = 8 RS bytes
8 bytes * 4 cells/byte = 32 data cells
```

It corrects up to two damaged header byte symbols. The complemented length byte provides an additional structural validity check.

Flags for both header forms:

```text
bit 0      UTF-8 text flag
bits 1..2  ECC profile id
bit 3      Secure Payload envelope flag
bits 4..7  reserved
```

ECC ids:

```text
0 = L
1 = M
2 = Q
3 = H
```

## Secure Payload v1

When header flag bit 3 is set, the body payload bytes contain a versioned encrypted envelope instead of plaintext application bytes. Spectrum ECC and CRC operate on the envelope exactly like any other byte payload.

The envelope begins with this fixed 24-byte metadata block:

| Offset | Size | Field |
|---:|---:|---|
| 0 | 4 | ASCII magic `QSEC` |
| 4 | 1 | Secure Payload version (`1`) |
| 5 | 1 | Mode (`1` password, `2` raw 256-bit key) |
| 6 | 1 | Algorithm (`1` AES-256-GCM) |
| 7 | 1 | KDF (`1` PBKDF2-HMAC-SHA-256, `0` none) |
| 8 | 1 | Security flags |
| 9 | 1 | Salt length |
| 10 | 1 | Nonce length |
| 11 | 1 | Authentication-tag length |
| 12 | 1 | Key-ID length |
| 13 | 3 | Reserved, zero |
| 16 | 4 | PBKDF2 iterations, big-endian (`0` for raw-key mode) |
| 20 | 4 | Plaintext byte length, big-endian |

The fixed header is followed by:

```text
keyId || salt || nonce || ciphertext || GCM tag
```

Current required sizes:

```text
AES-GCM nonce = 12 bytes
AES-GCM tag   = 16 bytes
password salt = 16 bytes
```

### Password mode

Password bytes are UTF-8 encoded and processed with:

```text
PBKDF2-HMAC-SHA-256
output = 256-bit AES key
default iterations = 600000
```

A fresh random 16-byte salt and 12-byte nonce are generated for every encryption operation.

### Raw 256-bit key mode

The application supplies an exact 32-byte key. No password KDF or salt is used. Unless disabled or overridden, the encoder stores the first 8 bytes of `SHA-256(rawKey)` as a non-secret key fingerprint. This key ID is only a routing hint and is not sufficient to decrypt the payload.

### Authentication

AES-256-GCM additional authenticated data (AAD) is:

```text
fixed security header || keyId || salt || nonce
```

Therefore the mode, KDF settings, key ID, salt, nonce, plaintext length, ciphertext, and authentication tag are cryptographically bound. Decryption must fail if the password/key is wrong or authenticated envelope data was changed.

The QuadQR CRC still protects the decoded encrypted envelope against scanner/ECC corruption before any decryption is attempted. AES-GCM authentication then protects the secure payload cryptographically.

## Payload and CRC

CRC-32 is calculated over:

```text
header || payload
```

Four CRC bytes are appended to the payload before body ECC.

## GF(256) Reed-Solomon

Header and body ECC use:

```text
GF(2^8) = GF(256)
```

Primitive polynomial:

```text
x^8 + x^4 + x^3 + x^2 + 1
0x11d
```

A codeword is limited to 255 byte symbols.

## ECC profiles

### Versions 2 through 40

| Profile | Parity bytes per body block | Correctable byte symbols per block |
|---|---:|---:|
| L | 12 | 6 |
| M | 24 | 12 |
| Q | 36 | 18 |
| H | 48 | 24 |

### Version 1 compact body ECC

| Profile | Parity bytes | Correctable byte symbols |
|---|---:|---:|
| L | 4 | 2 |
| M | 8 | 4 |
| Q | 12 | 6 |
| H | 16 | 8 |

This scaling prevents fixed parity overhead from consuming the entire 21×21 symbol. With the unchanged geometry and CRC-32, v1-M now carries 24 user payload bytes.

For each profile:

```text
max data bytes per block = 255 - parityBytes
```

Larger bodies are split into multiple RS blocks.

## Interleaving

### Reed-Solomon block interleaving

Encoded RS blocks are interleaved column-wise:

```text
block0[0], block1[0], block2[0], ...,
block0[1], block1[1], block2[1], ...
```

The decoder derives block lengths from payload length and ECC profile, reverses the interleaving, and corrects each block independently.

### Spectral-spatial cell interleaving

After bytes are split into four 2-bit RGBW cells, the complete logical data-cell stream is mapped through a deterministic version/length-dependent permutation before being written to physical data positions. The permutation is a seeded Fisher-Yates shuffle and contains every physical data-position index exactly once.

This layer has **zero capacity overhead**: no extra cells or parity symbols are added. Its purpose is to spread adjacent logical codeword cells across distant physical modules so localized damage is distributed over many RS symbols.

Masking is applied using the final physical row/column position. Decoding therefore performs operations in this order:

```text
physical sampled cells
  -> physical-position unmasking
  -> reverse spectral-spatial permutation
  -> byte reconstruction
  -> RS block deinterleaving
```

The decoder also tries legacy physical order as a fallback for older QuadQR matrices.

## Padding

Unused data positions are filled with deterministic pseudo-random values in the range 0..3. Padding is not semantically decoded.

## Confidence-aware error/erasure decoding

For image/camera scans, classification retains more than the winning RGBW state. Each sampled module also receives a confidence score derived from the separation between its nearest and second-nearest calibrated palette states.

One GF(256) symbol corresponds to four 2-bit data cells. The symbol confidence is the minimum confidence of those four constituent cells because an error in any one cell changes the reconstructed byte.

Decoding first attempts normal hard-decision Reed-Solomon correction. If that fails, low-confidence byte positions are progressively promoted to known erasures and the decoder retries error/erasure RS correction. Valid correction requires syndrome verification and the complete QuadQR payload still must pass CRC-32.

The RS budget follows the usual error/erasure relationship:

```text
2 * unknownErrors + knownErasures <= paritySymbols
```

No additional parity is added for this feature, so payload capacity is unchanged.

## Scanner pipeline

```text
RGB frame
  -> grayscale conversion
  -> global Otsu threshold for structural detection
  -> 1:1:3:1:1 finder candidate detection
  -> three-finder geometric ordering
  -> candidate version estimation
  -> primary bottom-right alignment search
  -> four-point homography
  -> distributed alignment-grid validation
  -> projective module sampling
  -> observed black/white/R/G/B calibration
  -> nearest calibrated RGBW classification + confidence
  -> four-state XOR unmasking
  -> reverse spectral-spatial permutation
  -> protected header GF(256) hard RS decode
  -> confidence-guided error/erasure retry when needed
  -> body block deinterleaving
  -> body GF(256) error/erasure correction
  -> CRC-32 verification
```

The scanner also has an axis-aligned fallback.

## Rotation

Matrix decoding tries 0°, 90°, 180°, and 270° rotations.

## Compatibility

Format v5 is intentionally incompatible with standard QR scanners and with the project's older ternary prototypes. The current encoder writes codeword cells using spectral-spatial placement. The current decoder also tries the pre-interleaver physical order as a compatibility fallback for older RGBW QuadQR matrices. Version 5 keeps the distributed alignment-center schedule introduced in v4, but shrinks every non-primary alignment marker from 5×5 to 3×3 while retaining the bottom-right primary marker at 5×5. Because reserved-cell geometry changed, v4 and v5 large-symbol matrices are not wire-compatible.

## Rendering profiles are not part of the wire format

The canonical QuadQR matrix is independent of presentation style. Renderers may offer styles such as `classic`, `depth`, `soft`, or `inset`, provided structural finder/timing/alignment/calibration references remain sufficiently faithful for decoding. Style selection is not encoded in the payload/header and does not change matrix cell values.

## Compression and signature flags

Format v5 keeps the physical matrix and ECC framing unchanged while reserving two protected-header flags for optional internal payload metadata:

```text
bit 4 = internal payload-extension metadata present
bit 5 = signed-payload hint
```

These bits are not a public payload-type mode. Applications continue to encode normal UTF-8 text or arbitrary bytes. Compression and Ed25519 signing use a compact internal extension envelope only when metadata is required. The envelope, print profile, diagnostics, and scanability test model are specified in [`SPECIFICATION.md`](./SPECIFICATION.md). None of these features changes RGBW cell mapping or Spectrum ECC.
