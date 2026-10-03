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
| Paper space | Layouts are imported but the UI shows model space | Layout viewer with viewport clipping |
| Xrefs / images / OLE | Xrefs unresolved, raster images shown as frames, OLE not rendered | Attach xref files to the project; image texture rendering |
| External GNSS on Android | WebView has no Web Serial / Web Bluetooth: use the receiver's app with Android *mock location* (works with every RTK receiver) | Native Capacitor plugin for Bluetooth SPP + `GnssStatus` satellites |
| Satellites count | Not exposed by the phone location API (NMEA sources report it) | Same native plugin |
| Concurrent CAD edits | Sync is last-writer-wins per drawing working copy | Journal-based merge (transactions are already journaled) |
| Detection | Rule-based; drawings that repeat the map inside plot frames need a scope (visible area / boundary) | Rules are editable per project |
