# Reproducible Android build

The `fdroid` flavor of the Android app carries the built web app inside the
APK (`assets/`), so what runs is what this source tree builds — not whatever
the live site serves. Two clean builds of it give the same unsigned APK.

## Build

Pinned toolchain: Bun 1.3.9 (`packageManager` in package.json), JDK 21,
Android SDK build-tools 35, Gradle 8.12 (android/gradle/wrapper), AGP 8.7.3.

```sh
bun install --frozen-lockfile
HAL_NO_SW=1 bun run build          # dist/ without the service worker
cd android
COINOS_UNSIGNED=1 gradle assembleFdroidRelease   # unsigned
# app/build/outputs/apk/fdroid/release/app-fdroid-release-unsigned.apk
```

Without `COINOS_UNSIGNED` and with `android/keystore.properties` present, the
same command produces the signed release.

## Verify

Build twice from clean and compare:

```sh
sha256sum app/build/outputs/apk/fdroid/release/app-fdroid-release-unsigned.apk
```

To compare a signed release against your own unsigned build, strip the
signature first (`apksigcopier compare`, or `diffoscope` on the two APKs —
only `META-INF/` should differ).

## What's inside

- `assets/index.html`, `assets/app-<hash>.js`, `assets/chunk-*.js`, locales,
  icons, punks: the split web build, content-addressed.
- No service worker: inside the WebView the page is served from these
  assets by `Assets.java`, and a worker would fetch the live site over them.
- The page still lives at the `https://v3.coinos.io/` origin, so storage,
  links and gift URLs behave as on the web; only the site's live API paths
  (`/electrum`, `/esplora/`, `/sp/`, `/lnurlp/`, `/.well-known/`, `/api/`)
  reach the network.

## Release

1. Bump `versionCode`/`versionName` in `android/app/build.gradle`.
2. Tag `fdroid-v<versionName>` (the F-Droid recipe watches these tags).
3. Attach the signed APK to the GitHub release as `coinos-fdroid-<versionName>.apk`
   — F-Droid rebuilds, compares, and publishes this file when they match.

The F-Droid recipe lives in `fdroid/io.coinos.fdroid.yml` (a copy goes into
fdroiddata as `metadata/io.coinos.fdroid.yml`).
