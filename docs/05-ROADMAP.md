# Modules & Phases

## Modules

| Module | Path | Responsibility |
|--------|------|----------------|
| cad/model | `src/cad/model` | Entity types, ACI colours, drawing container |
| cad/geom | `src/cad/geom` | Vectors, bulges, tessellation, intersections, offset, measurement, transforms |
| cad/io | `src/cad/io` | Engine adapter (acad-ts), import, delta export DWG/DXF, worker |
| cad/doc | `src/cad/doc` | Live document, spatial index, commands, undo/redo, journal |
| cad/render | `src/cad/render` | Scene builder, WebGL2 renderer, text overlay, camera |
| cad/tools | `src/cad/tools` | Interactive tools: select, draw, edit, text, measure; snap/ortho/grid |
| geo | `src/geo` | CRS, Helmert/affine LSQ, calibration, GEODATA detection |
| gps | `src/gps` | Sources (phone, NMEA serial/BLE, simulator), store, tracking |
| ftth | `src/ftth` | Smart objects, detection, cables/cores/splitters, topology, trace, nearest, BOQ |
| data | `src/data` | Dexie schema, repositories, versions, compression, audit, sync outbox |
| auth | `src/auth` | Users, roles/permissions, crypto |
| reports | `src/reports` | CSV/XLSX/PDF/GeoJSON/KML/KMZ/PNG exports and reports |
| ui | `src/ui` | React components |

## Phases

### Phase 0 — Foundation ✅
Architecture, stack, data model, UI/UX, module plan (this folder).

### V1 — Smart CAD + GPS (Phases 1–4)
1. **CAD core**: DWG/DXF import in worker, model, chunked WebGL renderer, text, layers,
   blocks/attributes, hatches, linetypes, lineweights, transparency; viewer tools (zoom/pan/fit,
   zoom object/layer/GPS, select, window/crossing, grid, snap, ortho, coordinates).
2. **Editing**: command/undo framework, Move/Copy/Paste/Delete/Rotate/Mirror/Scale/Stretch/Trim/
   Extend/Offset/Fillet/Chamfer/Explode/Join/Break/PEdit, properties panel, layer manager.
3. **Drawing & text tools**, measurement tools, exports DWG/DXF/PDF/PNG/JPG.
4. **GPS + georeferencing + offline projects**: sources, YOU ARE HERE marker, modes, tracking,
   calibration wizard (Helmert/affine + residuals), CRS/GEODATA detection, projects, file safety,
   versions.

### V2 — FTTH Intelligence (Phases 5–7)
5. **FTTH model**: smart objects, detection rules from DWG, cables (auto length), cores,
   splitters, splices, topology graph, Trace Fiber (both directions), FTTH search, nearest object +
   navigate.
6. **Field**: survey sessions, photos/video/voice, notes, As-Built mode + Design vs As-Built
   compare, QR codes (generate/scan), maintenance & faults.
7. **Outputs**: BOQ, 10 reports, Excel/CSV/PDF, GeoJSON/KML/KMZ.

### Phase 8 — Platform
Users/roles/permissions, audit log, encryption, sync architecture + reference server,
Android build (Capacitor).
