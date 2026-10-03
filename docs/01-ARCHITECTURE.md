# FiberLens — System Architecture

FiberLens is a **Smart CAD + FTTH Field Engineering Platform**. The CAD drawing *is* the map:
GPS fixes are transformed into drawing coordinates and rendered inside the DWG itself. There is
no separate basemap.

## 1. Guiding principles

| Principle | Consequence |
|-----------|-------------|
| CAD is the geographic canvas | GPS → CRS / calibration → CAD XY. No web maps. |
| Offline first | Everything (parse, render, edit, GPS, FTTH, reports) runs on-device. Network only for sync/backup. |
| Never touch the original | Original file is stored read-only; all edits go to a project copy + operation journal + versions. |
| Engine independence | The CAD *engine* (DWG/DXF I/O) is behind an adapter. Today: acad-ts (MIT). Drop-in: ODA Drawings SDK (commercial). |
| FTTH topology ≠ CAD geometry | FTTH objects live in their own tables and *link* to CAD entities by id/handle. Geometry changes update cable lengths; topology survives redraws. |
| Big drawings are normal | 100k+ entities: worker parsing, chunked GPU buffers, spatial indexes, LOD, incremental rebuilds. |

## 2. Layered architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│ UI (React)  TopBar · CAD Canvas · Tool dock · Panels (Layers, Props,      │
│             FTTH, Search, Measure, GPS, Survey, Notes, Photos, Reports)   │
├──────────────────────────────────────────────────────────────────────────┤
│ Application stores (zustand)  app · gps · ftth · project · session        │
├───────────────┬───────────────┬──────────────┬───────────────┬───────────┤
│ CAD Core      │ Geo           │ GPS          │ FTTH Engine   │ Reports   │
│ model, doc,   │ CRS (proj4),  │ sources:     │ object model, │ BOQ, CSV, │
│ commands,     │ Helmert /     │ phone, NMEA  │ detection,    │ XLSX, PDF,│
│ edit ops,     │ affine LSQ,   │ (serial/BLE),│ topology graph│ GeoJSON,  │
│ snap, pick,   │ residuals,    │ simulator;   │ trace, cores, │ KML/KMZ   │
│ renderer(GL)  │ GEODATA       │ tracking     │ splitters     │           │
├───────────────┴───────────────┴──────────────┴───────────────┴───────────┤
│ Engine adapter (Web Worker): acad-ts DWG/DXF read · DWG/DXF write         │
├──────────────────────────────────────────────────────────────────────────┤
│ Persistence: IndexedDB (Dexie) — projects, files, snapshots, journal,     │
│ FTTH tables, media blobs, users, audit log, sync outbox                   │
├──────────────────────────────────────────────────────────────────────────┤
│ Platform: Capacitor (Android) · Browser/PWA (desktop) — same codebase     │
└──────────────────────────────────────────────────────────────────────────┘
```

## 3. CAD pipeline

```
DWG/DXF bytes ──(worker)──► acad-ts CadDocument ──import──► FiberLens Drawing model
                                                              │
        ┌─────────────────────────────────────────────────────┤
        ▼                                                     ▼
  SpatialIndex (rbush, f64)                         SceneBuilder (chunked)
  pick / snap / search / nearest                    • tessellate entities (f64)
                                                    • explode INSERTs (ByBlock/Layer 0 rules)
                                                    • RTC chunk origins → f32 buffers
                                                    • segments (instanced quads, linetype,
                                                      lineweight), triangles (hatch/solid/width)
                                                    • text items (canvas overlay, LOD)
                                                              ▼
                                                 WebGL2 renderer + 2D overlay
                                                 (layer state texture: on/off/freeze/
                                                  color/transparency without rebuild)
```

* **Relative-to-center chunks**: drawings in UTM have coordinates ~3.4·10⁶. Each chunk stores
  float32 vertices relative to its own origin; the camera offset is computed in float64 per frame,
  so there is no jitter at any zoom.
* **Incremental rebuild**: an edit only re-tessellates the chunks that contain changed entities.
* **Layer state texture**: toggling visibility/freeze, layer colour or transparency is a
  128-byte texture upload — no geometry rebuild.
* **LOD**: entities/text smaller than a pixel threshold are skipped; text below ~3 px renders as
  a bar, linetype patterns collapse to solid when the pattern is sub-pixel.

## 4. Editing model

* Every mutation is a **Command** (`{added, removed, modified:[before,after]}`) → exact undo/redo.
* Commands are appended to a persistent **operation journal** (crash safety + future sync).
* Saving a **version** writes a compressed snapshot (gzip JSON) and clears the journal.
* **DWG/DXF export** re-opens the *original* file in the engine and applies the delta by entity
  handle (modified → updated in place, deleted → removed, new → added). Everything FiberLens does
  not understand (xdata, dictionaries, layouts, dim styles, proxies) is preserved.

## 5. Georeferencing

```
WGS84 (lat,lon) ─► projected plane P (CRS from DWG GEODATA / user CRS / auto-UTM)
                ─► calibration T (identity | Helmert 4p | affine 6p, least squares)
                ─► CAD (x,y)
```
Inverse path is used for exports (GeoJSON/KML) and for showing lat/lon of a CAD point.
Residuals (per point + RMS) are reported; calibration is stored per project/drawing.

## 6. GPS

`GpsSource` interface with implementations: phone GNSS (Capacitor/Geolocation API — also picks
up external receivers exposed as Android mock-location providers), NMEA 0183 over Web Serial/USB,
NMEA over BLE (Nordic UART), and a simulator. NMEA gives satellites, HDOP, fix type (RTK fixed /
float). Modes: Locate, Follow, North-up, Heading-up, Tracking (persisted sessions).

## 7. FTTH engine (V2)

Objects (OLT, ODF, FDH, FDT, FAT, FTB, Cabinet, Manhole, Handhole, Pole, Closure, Splitter,
Customer, Building, Joint) and Cables (feeder/distribution/drop/duct/conduit) form a graph.
Cables reference a CAD polyline → length is recomputed on geometry change. Cores carry TIA-598
colours and status; splitters map input → outputs; splices connect cores. Trace walks the graph
upstream (customer → OLT) or downstream (OLT port → customers) and highlights CAD entities.
A rule-based **detector** turns existing DWG content (layers, block names, attributes) into smart
objects so real drawings become intelligent without redrawing.

## 8. Security & sync

Local accounts (PBKDF2-SHA256), role → permission matrix (Admin, Engineer, Designer, Technician,
Viewer), per-project membership, audit log of every mutation, AES-GCM encrypted backups/sync
payloads. Sync uses an outbox of journal operations with hybrid logical clocks; the server
contract is documented in `06-SYNC.md`, with a reference server in `server/`.
