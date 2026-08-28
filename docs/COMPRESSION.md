# Compression 2.0

QuadQR Compression 2.0 keeps compression as an internal transport detail around normal text or byte payloads. It does not introduce a payload type system.

## Modes

```js
encodeText(text, { compression: "none" });
encodeText(text, { compression: "auto" });
encodeText(text, { compression: "brotli" });
encodeText(text, { compression: "deflate" });
encodeText(text, { compression: "lz" });
```

- `none` stores the application payload directly.
- `auto` compares bundled Brotli at quality 6, portable DEFLATE, and the legacy LZ codec, then selects the smallest candidate only when the complete stored representation is smaller. The balanced Brotli setting avoids the large browser CPU cost of quality 11 while retaining nearly all of its QR-sized compression benefit.
- `brotli` forces the bundled Brotli codec.
- `deflate` forces the raw-DEFLATE codec.
- `lz` forces the original QuadQR LZSS-style stream for compatibility and testing.

For unsigned payloads, `auto` includes the 16-byte internal extension-envelope cost when deciding whether compression helps. This means Auto remains zero-overhead when none of the compressed representations actually reduces the final payload. Signed payloads already require the extension envelope, so Auto compares body sizes directly.

## Brotli profile

Compression ID `3` is a standard Brotli stream. QuadQR vendors the codec into the library so Brotli compression and decompression are both synchronous and available in browser ESM, the classic browser bundle, workers, and server-side Node.js without a runtime package or native binding.

The public helpers are:

```js
compressBrotliPayload(bytes);
decompressBrotliPayload(compressedBytes, originalLength);
```

The compressor accepts an optional `{ quality }` object for direct helper use. Forced `compression: "brotli"` retains the codec default quality, while `compression: "auto"` uses quality 6 as the balanced candidate. Normal `encodeText()` / `encodeBytes()` compression keeps algorithm selection internal.

## Portable DEFLATE profile

Compression ID `2` is a raw RFC 1951 DEFLATE stream. The QuadQR encoder deliberately uses a fixed-Huffman block rather than a large dynamic-Huffman implementation. It supports:

- a 32 KiB LZ77 window;
- match distances up to 32768 bytes;
- match lengths up to 258 bytes;
- deterministic synchronous output;
- no runtime dependency.

The stream is valid raw DEFLATE and can be inflated by standard RFC 1951 implementations. QuadQR's bundled decoder handles the stored/fixed block forms emitted by QuadQR itself.

## Node.js and browser portability

All compression paths used by the payload layer are bundled JavaScript. The library does not import `node:zlib`, use browser `CompressionStream`, depend on DOM APIs, or fetch a codec at runtime.

```js
import { encodeText, decodeMatrix } from "quadqr-js";

const code = encodeText("hello ".repeat(1000), {
  compression: "auto"
});

const decoded = decodeMatrix(code.matrix);
console.log(decoded.compression); // typically "brotli" for this payload
```

## Backward compatibility

Compression ID `1`, the original portable LZ codec, is retained and remains decodable. Compression ID `2` remains the portable raw-DEFLATE codec. Compression ID `3` adds Brotli. New decoders understand all three algorithms; older decoders that predate Brotli will reject a Brotli-compressed envelope rather than silently decode it incorrectly.
