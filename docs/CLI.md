# Command Line Interface

The npm package includes the `quadqr` executable and can be used directly through `npx`.

## Encode text

```bash
npx quadqr-js encode "Hello QuadQR" -o hello.png
npx quadqr-js encode "Hello QuadQR" -o hello.svg
```

Optional encoding controls:

```bash
npx quadqr-js encode "Hello" --ecc M --version auto --image-size 720 --quiet-zone 4 -o hello.png
```

## Decode an image

```bash
npx quadqr-js decode hello.png
```

For an unencrypted text payload, the decoded text is printed to stdout.

## Password-protected payloads

Encode:

```bash
npx quadqr-js encode "Private data" --password "my-password" -o secure.png
```

Decode:

```bash
npx quadqr-js decode secure.png --password "my-password"
```

If an encrypted symbol is decoded without a credential, the CLI reports that decryption is required instead of exposing plaintext.

## Raw 256-bit key mode

Generate a random 256-bit key:

```bash
npx quadqr-js keygen
```

The output is a 64-character hexadecimal key. Store it securely and do not place it inside the same QuadQR symbol.

Encode using the key:

```bash
npx quadqr-js encode "Application secret" --key <64-hex-key> -o secure-key.png
```

Decode using the key:

```bash
npx quadqr-js decode secure-key.png --key <64-hex-key>
```

## Options

| Option | Purpose |
| --- | --- |
| `-o, --output <file>` | Output PNG or SVG path. `.svg` selects vector export. Default: `quadqr.png` |
| `--ecc <L|M|Q|H>` | QuadQR ECC profile. Default: `M` |
| `--version <auto|1..40>` | Symbol version. Default: `auto` |
| `--password <text>` | Password-mode encryption/decryption |
| `--key <hex>` | Raw 256-bit key encryption/decryption |
| `--image-size <px>` | Exact square output size in pixels. Default: `720` |
| `--module-size <px>` | Legacy pixels-per-module sizing. Used when `--image-size` is omitted |
| `--quiet-zone <modules>` | Quiet-zone size in modules. Default: `4` |
| `-h, --help` | Show CLI help |

Password mode and raw-key mode are mutually exclusive for a single operation.
