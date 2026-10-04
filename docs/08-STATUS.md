# Status, verification & known limits

## Verified
* **Real FTTH DWGs** (Huawei QuickODN, AC1032, 5–9 MB, ~30k–86k entities) open in ~4 s,
  render with layers, blocks, attributes, rotated text, linetypes, hatches.
* **Rendering**: 550k GPU segments, 23 MB GPU memory, < 1 ms GPU submit per frame, ~7 ms text pass.
* **Edit → DWG export** merges by handle into a copy of the original (kept/modified/added/deleted
  verified by re-reading the exported file).
* **GPS**: in UTM 36N the sample drawing resolves to Khorshed, Alexandria; auto CRS detection;
  simulator walk shows the marker inside the DWG; calibration math unit-tested (< 1 mm).
* **FTTH detection** on the sample: closures, FATs, X-BOX (FDT), Hubbox (FDH), CO/OLT, manholes,
  8.8k cables with lengths by type in ~0.2 s; parent links from `1NAME` attributes; trace FAT → OLT
  in ~30 ms.
* **Sync** against the reference server (push/pull/idempotency).
* **Unit tests**: 27 passing (geometry kernel, trim/extend/offset/fillet/join/break/explode,
  Helmert/affine fit, CRS, calibration, NMEA, DWG/DXF round trip incl. true colour and Arabic text).
* **Android**: debug APK builds (Capacitor 8, minSdk 24, targetSdk 36).

## Known limits (and the planned remedy)
| Area | Limit | Remedy |
|------|-------|--------|
| DWG versions | R13 and older (AC1012-) are not read by acad-ts | Save as DXF / DWG 2000+, or plug the ODA engine into `CadEngine` |
| DXF export | acad-ts DXF writer can drop some complex entities on very large drawings | Use DWG export (lossless merge) — DXF is fine for new/small drawings |
| Fonts | SHX glyphs are replaced by TrueType equivalents (licensing) | Configurable font map |
| Images / OLE | Raster images shown as frames, OLE not rendered (Xrefs: attach the referenced file in Project → Xrefs) | Image texture rendering |
| External GNSS on Android | Native plugin: Bluetooth Classic (SPP) NMEA receivers + `GnssStatus` satellites. BLE receivers on Android: use the vendor app with mock location | Native BLE GATT support |
| Concurrent CAD edits | Sync is last-writer-wins per drawing working copy | Journal-based merge (transactions are already journaled) |
| Detection | Rule-based; drawings that repeat the map inside plot frames need a scope (visible area / boundary) | Rules are editable per project |

## Android verification
* APK installed and launched on an Android 14 emulator (tablet, WebView Chrome 113): WebGL2
  available, all Capacitor plugins + the native `FiberLensGnss` plugin registered, location
  permission flow works, tablet layout renders correctly.
* Build: `npm run build && npx cap sync android && cd android && ./gradlew assembleDebug`
  (JDK 21 + Android SDK 36). For Play Store: `./gradlew bundleRelease` with your signing key.

## Field fix — "drawing shows nothing on the phone" (2026-10-04)
* **Root cause:** the importer identifies acad-ts entities by `constructor.name`; the production
  build minified class names, so every entity was dropped on the APK (0 entities, black view)
  while the dev server worked. Fixed with `esbuild.keepNames` in `vite.config.ts` — verified on
  the phone emulator: `3-Alex_Khorshed_FTTH_003` → 50,820 entities rendered.
* Fake Xref list (`Acad:XRef` placeholder on normal blocks) removed.
* Renderer robustness: GPU self-test (readPixels) → automatic Canvas2D fallback, context-loss
  recovery, Settings → Graphics renderer (auto / WebGL / Canvas). Layer-style textures are now
  keyed per scene (switching drawings could keep stale layer tables).
* Memory: streamed JSON-lines snapshot codec, no snapshot clones, import result reused on open.

## GPS — automatic georeference (2026-10-04)
* Drawings already in real coordinates are georeferenced on open, no GPS or control points
  needed: the median entity point is tested against WGS84 UTM 36N/35N/37N and the Egypt 1907
  belts (`guessCrsFromPoint`, tests in `tests/crsguess.test.ts`). The Alexandria samples →
  UTM 36N, Khorshed (31.2066 N, 30.0323 E). Existing projects are calibrated on next open.
* Ambiguous zone numbers default to 36N; the first real GPS fix re-checks and switches CRS if
  another one puts the user inside the drawing.
* No more "Could not obtain location in time": a slow first fix is a soft "still searching"
  status, the watch is re-armed, and a recent cached fix (≤15 s) is used at once.
* Locate me far from the drawing (> 2 km): shows the distance and zooms to show both.
* Verified: GPS fix → CAD round-trip exact on a cable vertex; marker rendered on the street map.
  (The Android emulator's Play-services location ignores mock fixes, so the device path was
  verified up to the permission/watch stage.)

## Text fix — block attributes upside-down / misplaced (2026-10-04)
* acad-ts transforms ATTRIB insertion point, rotation and height by the INSERT a second time
  (the alignment point is read correctly). Repair v2 (`cad/io/repair.ts`) undoes all three and
  keeps the alignment point; v1 had kept the doubled rotation (texts upside down, e.g. "S01X")
  and replaced the alignment point by the start point (centred labels shifted out of the
  sub-box circles). Stored projects get a one-time legacy pass (`meta.attrRepair`).
  Check on 003: 36,884 attributes, all match attdef rotation/height except 12 intentional 180° flips.
* TrueType text is sized by the em (capitals ≈ 0.72 × height) like AutoCAD; SHX by capital height.
  Previously Arial text was drawn ~1.4× too large.

## All sample files checked (2026-10-04)
* 5 DWGs in `Desktop/New folder` (29k–86k entities): all open; ~180k block attributes all within
  normal distance of their attribute definitions after repair.
* Hatches were never drawn: acad-ts names the class `_Hatch` (also `_Viewport`). Entity types are
  now resolved from the library's export names (`CLASS_NAMES` in acadImport.ts), which survive
  minification — `keepNames` is no longer needed.
* Doubled attribute transforms are detected per insert by comparing both hypotheses with the
  attribute definitions (also catches inserts near the origin, e.g. Miami ODFXBOX at 1250,0).
* Not rendered: OLE objects (embedded Excel/images, 1–9 per file).
* Projects imported before this fix keep their missing hatches: re-import the file to get them.

## iPhone (iOS) build (2026-10-04)
* `ios/` Capacitor project (Swift Package Manager, no CocoaPods). Info.plist: location, camera,
  photos, motion; DWG/DXF document types so "Open in FiberLens" from Files/WhatsApp imports the
  drawing (handled in `ui/ftth/integration.tsx`); file sharing enabled.
* GPS sources are filtered per platform (iOS: phone GNSS incl. MFi receivers + simulator; no
  Bluetooth SPP / Web Serial / Web Bluetooth in WKWebView).
* Windows cannot build iOS: `.github/workflows/ios.yml` builds an unsigned IPA on a GitHub macOS
  runner (artifact "FiberLens-ios"). Install with Sideloadly/AltStore + Apple ID (free ID: re-sign
  every 7 days) or sign with an Apple Developer account for TestFlight.
* Web app / PWA (no Apple device or account needed): manifest + icons, iOS meta tags, generated
  service worker (`src/sw-template.js`, precaches every built file; verified: app + DWG engine
  work with the server stopped). `.github/workflows/pages.yml` publishes it to GitHub Pages.
  iPhone: Safari → Share → Add to Home Screen. iOS tweaks: file picker accepts all files (iOS greys
  out .dwg), exports go through the share sheet ("Save to Files"), persistent storage requested.
* Live web app: https://fiberlens-ftth.netlify.app (Netlify project `fiberlens-ftth`).
  Update: `npm run deploy:web` (needs `npx netlify-cli login` once on the machine).
