# Secure Payloads

QuadQR Secure Payload v1 is an optional authenticated-encryption layer above the matrix codec and Spectrum ECC.

```text
plaintext
  -> encryption + authentication
  -> secure envelope
  -> QuadQR framing
  -> Spectrum ECC
  -> RGBW matrix
```

Normal QuadQR symbols are unencrypted by default. Secure Payload is used only when explicitly requested.

## Which mode should I use?

| Mode | Use it when |
| --- | --- |
| Password | A person will enter or share a secret password to unlock the payload |
| Raw 256-bit key | Your application, service, device, or scanner already manages cryptographic keys |

Both modes use AES-256-GCM for confidentiality and authenticated integrity.

## Password mode

Password mode uses:

- PBKDF2-HMAC-SHA-256
- random 16-byte salt
- configurable iteration count, default 600,000
- AES-256-GCM
- random 12-byte nonce
- authenticated envelope metadata

```js
import { encodeSecureText } from "quadqr-js";

const code = await encodeSecureText("private", {
  security: {
    mode: "password",
    password: "long unique password"
  }
});
```

The password is never stored in the QuadQR symbol.

## Raw 256-bit key mode

Raw-key mode accepts exactly 32 secret bytes, either as bytes or a 64-character hexadecimal string.

```js
import {
  encodeSecureText,
  generateRaw256Key
} from "quadqr-js";

const key = generateRaw256Key();

const code = await encodeSecureText("machine secret", {
  security: {
    mode: "raw-key",
    key
  }
});
```

By default, the secure envelope can include a short SHA-256 key fingerprint/key ID. This is a non-secret routing hint that can help an application choose the correct key. The actual secret key is never embedded in the symbol.

## Scanning secure QuadQR

Scanning does not automatically reveal protected plaintext. The scanner first returns a locked result:

```js
const locked = await scanFile(file);

console.log(locked.secure);              // true
console.log(locked.requiresDecryption);  // true
console.log(locked.security.mode);       // password | raw-key
console.log(locked.text);                // null
```

Then unlock it with the correct credential:

```js
const unlocked = await decryptDecoded(locked, {
  password: "long unique password"
});

console.log(unlocked.text);
```

For raw-key mode:

```js
const unlocked = await decryptDecoded(locked, { key });
```

Image upload, camera, matrix, RGBA, and Node.js scan results all use the same secure-result model.

## Authentication behavior

AES-GCM authentication rejects:

- an incorrect password;
- an incorrect raw key;
- modified ciphertext;
- modified authenticated secure-envelope metadata.

QuadQR's CRC and Spectrum ECC still handle matrix/image corruption before decryption is attempted. Cryptographic authentication is a separate final security check.

## Key management guidance

- Use long, unique passwords for password mode.
- Generate raw keys with `generateRaw256Key()` or another cryptographically secure random source.
- Store long-lived raw keys in an appropriate secret manager, operating-system key store, HSM, or equivalent secure storage for your application.
- Do not put the secret password or raw key inside the same QuadQR symbol.
- Do not hard-code a long-lived raw key in public client-side JavaScript if it is intended to remain secret.

## Security boundaries

Secure Payload protects payload confidentiality and integrity, but it does not solve every application-security problem:

- It does not hide the fact that a QuadQR symbol exists.
- A photographed symbol can still be copied.
- Encryption by itself is not replay protection.
- Ticket/access systems should use server-side state, nonces, expiry, signatures, or another replay-control mechanism appropriate to the application.
- Decoded plaintext is still untrusted application input and should be validated before use.
