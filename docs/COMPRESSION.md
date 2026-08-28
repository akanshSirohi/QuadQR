# Compression 3.0

QuadQR keeps compression as an internal transport detail around normal text or byte payloads. It does not introduce a payload type system, and the decompressor does not need to know which compression level was used.

## Modes

```js
encodeText(text, { compression: "none" });
encodeText(text, { compression: "auto" });
encodeText(text, { compression: "smart" });
encodeText(text, { compression: "brotli" });
encodeText(text, { compression: "deflate" });
encodeText(text, { compression: "lz" });
```

- `none` stores the application payload directly.
- `auto` is the fast balanced mode. It performs one pass with LZ level 6, DEFLATE level 6, and Brotli quality 6, compares the complete stored sizes, and keeps the smallest result.
- `smart` is the opt-in CPU-heavy mode. It starts with the same balanced candidates as `auto`, checks the resulting QuadQR version, and only spends more CPU on stronger DEFLATE/Brotli passes when a smaller physical QuadQR is realistically reachable.
- `brotli` forces the bundled Brotli codec.
- `deflate` forces the portable raw-DEFLATE codec.
- `lz` forces the original QuadQR LZSS-style stream for compatibility and testing.

For unsigned payloads, `auto` and `smart` include the 16-byte internal extension-envelope cost when deciding whether compression helps. If compression would not make the complete stored representation smaller, the original payload is kept with no compression envelope. Signed payloads already require the extension envelope, so their comparison includes the fixed signing metadata automatically. Secure payload planning also includes the fixed encryption-envelope overhead when Smart evaluates version boundaries.

## Auto versus Smart

`auto` intentionally avoids expensive maximum-quality passes:

```text
Raw
LZ level 6
DEFLATE level 6
Brotli quality 6
       ↓
smallest final representation
```

`smart` begins the same way, then considers the next smaller QuadQR version. When that boundary is close enough to be plausible, it escalates in stages:

```text
Balanced pass
  LZ 6
  DEFLATE 6
  Brotli 6
      ↓
Is a smaller QuadQR version realistically reachable?
      ↓ yes
Strong pass
  DEFLATE 8
  Brotli 9
      ↓
Still close to another/same smaller-version boundary?
      ↓ yes
Maximum pass
  DEFLATE 9
  Brotli 11
```

Smart is deliberately CPU-heavy and should be used when minimizing the physical matrix matters more than generation time. If an exact `version` is requested and the balanced pass does not fit, Smart may also escalate to stronger levels when that can plausibly make the requested version fit. The current plausibility gates are intentionally conservative: the strong stage is considered when the next boundary is within 30% of the current stored size or 192 bytes, and the maximum stage when it is within 16% or 96 bytes. The demo runs Smart in a Web Worker so the browser UI remains responsive.

The generated code object includes generation-only diagnostics such as `compressionLevel`, `compressionStrategy`, and `smartCompression`. Compression level is not stored in the QuadQR because LZ, DEFLATE, and Brotli decoders do not need it.

## Explicit compression levels

Use the generic `compressionLevel` option when you explicitly select LZ, DEFLATE, or Brotli:

```js
const lz = encodeText(text, {
  compression: "lz",
  compressionLevel: 9
});

const deflated = encodeText(text, {
  compression: "deflate",
  compressionLevel: 9
});

const brotlied = encodeText(text, {
  compression: "brotli",
  compressionLevel: 11
});
```

Ranges and defaults:

| Algorithm | Range | Explicit default |
| --- | ---: | ---: |
| Legacy LZ | 1..9 | 6 |
| DEFLATE | 1..9 | 6 |
| Brotli | 0..11 | 11 |

Algorithm-specific aliases are also accepted: `lzLevel`, `deflateLevel`, and `brotliQuality`. `compressionLevel` is the recommended public option.

Levels only affect encoder CPU/search effort and output size. They do not change the compression ID or decoder behavior.

## Legacy LZ profile

Compression ID `1` keeps the original QuadQR LZSS-style wire format. Levels `1..9` only control how much encoder work is spent walking candidate history and, at stronger levels, bounded lazy-match lookahead. Level 6 preserves the historical 32-candidate QuadQR search depth, so existing callers that do not pass a level keep the same default behavior.

The direct helpers are:

```js
compressPayload(bytes, { level: 9 });
decompressPayload(compressedBytes, originalLength);
```

The LZ window remains 4095 bytes and each back-reference still represents a 3..18 byte match. The compressed stream format is identical at every level, so the level is never serialized and old/new LZ decoders remain compatible. Auto and Smart use LZ level 6; Smart does not escalate LZ because its additional staged CPU budget is reserved for the stronger DEFLATE/Brotli candidates.

## Brotli profile

Compression ID `3` is a standard Brotli stream. QuadQR vendors the codec into the library so Brotli compression and decompression are synchronous and available in browser ESM, the classic browser bundle, Web Workers, and server-side Node.js without a runtime package or native binding.

The direct helpers are:

```js
compressBrotliPayload(bytes, { quality: 9 });
decompressBrotliPayload(compressedBytes, originalLength);
```

Brotli quality accepts integers `0..11`. Explicit `compression: "brotli"` defaults to quality 11 for backward compatibility. `auto` starts at quality 6. `smart` starts at 6 and may test 9 and 11 when a smaller QuadQR version is plausible.

## Portable DEFLATE profile

Compression ID `2` is a raw RFC 1951 DEFLATE stream. QuadQR's bundled encoder uses a fixed-Huffman block with level-dependent LZ77 match-search effort. It supports:

- a 32 KiB LZ77 window;
- match distances up to 32768 bytes;
- match lengths up to 258 bytes;
- DEFLATE levels `1..9`;
- progressively deeper candidate search and lazy matching at stronger levels;
- deterministic synchronous output;
- no runtime dependency.

The direct helpers are:

```js
compressDeflatePayload(bytes, { level: 9 });
decompressDeflatePayload(compressedBytes, originalLength);
```

The stream remains standard raw DEFLATE at every level. The level is not serialized.

## Node.js and browser portability

All payload compression paths are bundled JavaScript. The library does not import `node:zlib`, use browser `CompressionStream`, depend on DOM APIs, or fetch a codec at runtime.

```js
import { encodeText, decodeMatrix } from "quadqr-js";

const code = encodeText("hello ".repeat(1000), {
  compression: "smart"
});

const decoded = decodeMatrix(code.matrix);
console.log(code.compression, code.compressionLevel);
console.log(decoded.compression); // decoder only needs the algorithm ID
```

## Compression IDs and compatibility

The internal envelope keeps the stable IDs:

```text
0 = none
1 = legacy LZ
2 = raw DEFLATE
3 = Brotli
```

Compression level is intentionally not part of the envelope. Existing LZ, DEFLATE, and Brotli decoders remain compatible with streams produced at any supported level.
