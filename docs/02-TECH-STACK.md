# Technology Stack & CAD Engine Decision

## Selected stack

| Concern | Choice | Why |
|---------|--------|-----|
| App shell (Android) | **Capacitor 8** (Android WebView) | One TypeScript codebase for Android, tablets and desktop browser; native plugins for GPS, files, camera. |
| UI | React 18 + TypeScript + Vite | Mature, fast HMR, large ecosystem. |
| State | zustand | Small, no boilerplate, works outside React (engine callbacks). |
| CAD I/O engine | **acad-ts** (MIT, TypeScript port of ACadSharp) behind `CadEngine` adapter | Reads DWG R14–2018+ (AC1014–AC1032) and DXF R12+; **writes DWG and DXF**. Pure TS → runs offline in a Web Worker. Verified on real FTTH drawings (85k entities, 8.9 MB, ~4 s). |
| Rendering | Custom **WebGL2** renderer (instanced segments, RTC chunks) + Canvas 2D overlay | GPU acceleration, linetypes/lineweights in shaders, no float32 jitter on UTM coordinates. |
| Spatial index | rbush (R-tree) | Picking, snapping, nearest-object, culling. |
| Polygon fill | earcut | Hatch/solid triangulation with holes. |
| CRS | proj4js + built-in definitions (WGS84, UTM, Egypt Red/Purple belts, EPSG) | Offline coordinate transformations. |
| Local DB | IndexedDB via **Dexie 4** | Large blobs (DWG, photos), indexes, transactions; works in Android WebView. |
| Compression | fflate (gzip/zip) | Snapshots, KMZ, backups. |
| Reports | SheetJS (xlsx), jsPDF, qrcode | Offline Excel/PDF/QR generation. |
| Tests | Vitest | Geometry, transforms, topology, I/O round-trips. |

## CAD engine evaluation

| Engine | DWG read | DWG write | Platform | License | Verdict |
|--------|----------|-----------|----------|---------|---------|
| **ODA Drawings SDK (Teigha)** | All versions, highest fidelity | Yes | C++ (Android NDK), WASM via Visualize | Commercial membership (~$2.5k+/yr), no source redistribution | **Best fidelity.** Recommended production upgrade; plug into `CadEngine` adapter. |
| Autodesk RealDWG | Reference | Yes | Windows/.NET only | Commercial, no Android | Not usable on Android. |
| **acad-ts / ACadSharp** | R14 → 2018 (AC1014–AC1032) | Yes | TypeScript / C# | **MIT** | **Selected for V1/V2**: permissive, on-device, read+write. Gaps: R13 and older DWG (use DXF), some proxy objects. |
| LibreDWG (+ WASM builds) | Most versions | Partial/experimental | C / WASM | **GPL-3.0** | GPL would force the whole app to be GPL. Rejected for a commercial product. |
| dxf-parser / dxf libs | DXF only | Some | JS | MIT | Insufficient (no DWG). |
| Open Design Viewer / Autodesk Platform Services (cloud) | Yes | Yes | Cloud API | Commercial, online | Violates offline-first. |

### Licensing notes
* **DWG** is a proprietary format. Reading/writing it with independent libraries (acad-ts, ODA)
  is legal; the *"DWG"* trademark rules (Autodesk v. ODA settlement) mean the product must not
  claim "TrustedDWG" compatibility. FiberLens says "DWG files" descriptively only.
* acad-ts is MIT: bundle the license text (done in `THIRD_PARTY_NOTICES.md`).
* SHX fonts are Autodesk-copyrighted: FiberLens maps SHX styles to system TrueType fonts
  (with Arabic support) and never ships SHX files.

### Upgrade path to ODA
`src/cad/io/engine.ts` defines `CadEngine { read(bytes, name) → Drawing; write(drawing, original?, format) → bytes }`.
An ODA implementation (Android native plugin via Capacitor or ODA Web SDK in a worker) can be
selected at runtime without touching the renderer, editor, FTTH or persistence layers.

## Platform requirements
* Android 7.0+ (API 24), WebView with WebGL2 (Chrome ≥ 79; essentially all devices since 2019).
* Build: JDK 21, Android SDK 36, Node 20+.
