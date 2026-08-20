# Publishing QuadQR to npm

QuadQR is published on npm as [`quadqr-js`](https://www.npmjs.com/package/quadqr-js). The repository package name is `quadqr-js`.

The QuadQR project/brand, browser global (`QuadQR`), CLI executable (`quadqr`), and generated filenames remain unchanged. Only the npm package identifier is `quadqr-js`.

## 1. Create/sign in to npm

Create an account at https://www.npmjs.com/ and enable two-factor authentication.

Then authenticate the CLI:

```bash
npm login
```

Check the active account:

```bash
npm whoami
```

## 2. Install repository dependencies

QuadQR currently has no runtime dependencies, but run:

```bash
npm install
```

so your local package lock and npm metadata are synchronized.

## 3. Verify the package metadata

```bash
npm view quadqr-js
```

Confirm the published package and current version before releasing an update.

## 4. Run the full release checks

```bash
npm test
npm run benchmark
npm run pack:check
```

`pack:check` rebuilds `dist/` and displays exactly what npm will include.

You can inspect the final tarball too:

```bash
npm pack
```

## 5. Publish

The package is an unscoped public package and `publishConfig.access` is already set to `public`, so publish with:

```bash
npm publish
```

npm publishing requires an account that satisfies npm's current 2FA/authentication requirements.

## 6. Verify installation from a clean directory

```bash
mkdir quadqr-consumer-test
cd quadqr-consumer-test
npm init -y
npm install quadqr-js
```

Then test ESM, Node PNG, and the CLI.

```bash
npx quadqr-js keygen
npx quadqr-js encode "Hello from npm" -o hello.png
npx quadqr-js decode hello.png
```

## 7. Verify CDN availability

After npm and CDN caches update, test:

```text
https://cdn.jsdelivr.net/npm/quadqr-js@0.7.0/dist/quadqr.min.js
https://unpkg.com/quadqr-js@0.7.0/dist/quadqr.min.js
```

Then call `QuadQR.encodeText(...)` from a plain HTML page.

## Releasing the next version

Use semantic versioning:

```bash
npm version patch
# or
npm version minor
# or
npm version major
```

Then run the release checks again and publish.

Never reuse an npm version that has already been published. Published package versions are immutable.
