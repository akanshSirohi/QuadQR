# QuadQR Documentation

QuadQR is an experimental RGBW matrix symbology. Default RGBW cells carry two bits using red, green, blue, or white. The experimental High Density Mode splits payload cells into two RGBW triangles and carries four raw bits per body data cell. The JavaScript library supports encoding, canvas/RGBA/SVG rendering, adjustable quiet zones, optional centered logos with transparent or cleared backgrounds, matrix decoding, image and camera scanning, Spectrum ECC, optional authenticated encryption, Node.js PNG/SVG workflows, CDN usage, a CLI, TypeScript declarations, and optional prebuilt WebAssembly acceleration.

## Live links

- [Documentation Site](https://akanshsirohi.github.io/QuadQR/docs-site/)
- [Interactive Demo](https://akanshsirohi.github.io/QuadQR/demo/)
- [quadqr-js on npm](https://www.npmjs.com/package/quadqr-js)
- [GitHub Repository](https://github.com/akanshsirohi/QuadQR)

## Documentation

- [Getting Started](./GETTING_STARTED.md)
- [API Reference](./API.md)
- [High Density Mode (Experimental)](./HIGH_DENSITY_MODE.md)
- [Browser and CDN](./BROWSER_CDN.md)
- [Node.js](./NODE.md)
- [CLI](./CLI.md)
- [Secure Payloads](./SECURITY.md)
- [WebAssembly](./WASM.md)
- [Wire Format](../FORMAT.md)
- [Technical Specification](../SPECIFICATION.md)

## Package entry points

| Entry | Purpose |
| --- | --- |
| `quadqr-js` | Runtime-neutral core API, rendering, scanning, secure payloads, utilities, and optional WASM |
| `quadqr-js/browser` | Browser ESM entry for canvas, files, video, and camera workflows |
| `quadqr-js/node` | Node.js core plus PNG/SVG, file, and buffer helpers |
| `quadqr-js/benchmark` | Capacity and codec benchmark helpers |
| `quadqr-js/quadqr.min.js` | Classic browser global bundle for CDN/script-tag usage |

The matrix codec is shared across runtimes. Browser and Node.js adapters only handle environment-specific input and output.

## Compatibility note

QuadQR is a custom experimental format, not ISO QR Code. Standard QR scanner applications cannot decode QuadQR symbols.

## License

QuadQR is licensed under AGPL-3.0. See [`LICENSE`](../LICENSE).

## Advanced reliability and payload features

The current library also includes:

- normal text/byte payloads with optional internal LZ compression;
- portable automatic LZ compression;
- first-class binary `Uint8Array` APIs;
- Ed25519 signed QuadQR payloads and trusted-key verification;
- signed + AES-256-GCM encrypted composition;
- screen and print rendering modes;
- ECC-aware automatic logo sizing;
- normalized scanner confidence and detailed debug mode;
- deterministic scanability/torture testing;
- an interactive browser stress-test lab and capacity calculator.

See [`../SPECIFICATION.md`](../SPECIFICATION.md) for the layering and interoperability rules and [`API.md`](./API.md) for the public APIs.
