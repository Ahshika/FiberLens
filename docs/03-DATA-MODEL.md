# Data Model & Database Schema

Storage: IndexedDB (Dexie). All tables are keyed by string UUIDs except CAD entity ids (numeric,
per drawing). Every row that can be synced carries `projectId`, `updatedAt`, `updatedBy`, `rev`.

## 1. CAD geometry (per drawing)

```ts
Drawing {
  meta: { name, version, units, extMin, extMax, codePage, sourceFormat }
  layers: Layer[]          // name, color(aci|rgb), lineType, lineWeight, transparency, on, frozen, locked, plot
  lineTypes: LineType[]    // name, description, pattern[]
  textStyles: TextStyle[]  // name, font, bigFont, widthFactor, oblique
  blocks: Record<name, Block>   // base point + entities (block coordinates)
  entities: Entity[]       // model space
  layouts: Layout[]        // paper space entities (basic)
  geo?: GeoInfo            // from DWG GEODATA (design point, reference point, CRS WKT/proj)
}
Entity = Line | Polyline | Circle | Arc | Ellipse | Spline | Text | MText | Insert | Hatch |
         Point | Solid | Dimension | Leader | Image(frame)
common: { id, type, layer, aci?, rgb?, lineType?, ltScale?, lineWeight?, transparency?, handle? }
```

`handle` is the original DWG handle — the key used to merge edits back into the original file.

## 2. Tables

| Table | Key | Main fields | Notes |
|-------|-----|-------------|-------|
| `users` | id | username, displayName, role, pwdHash, salt, active | PBKDF2-SHA256 |
| `projects` | id | name, code, client, createdAt, ownerId, activeDrawingId, settings | |
| `projectMembers` | [projectId+userId] | role override | project permissions |
| `files` | id | projectId, kind(`original`/`attachment`/`export`), name, mime, size, sha256, blob | originals are immutable |
| `drawings` | id | projectId, fileId(original), name, snapshotBlob(gz), journalSeq, calibrationId | current working copy |
| `journal` | [drawingId+seq] | op (command delta), userId, at | crash-safe ops log / sync source |
| `versions` | id | projectId, drawingId, label(V1..Vn / As-Built), kind(design/asbuilt), snapshotBlob, ftthSnapshot, createdAt, userId, summary, parentId | restore = copy back |
| `calibrations` | id | projectId, drawingId, crs, method(helmert/affine/crs), points[{cad,geo,residual}], params, rms | |
| `tracks` | id | projectId, name, startedAt, endedAt, points[{t,lat,lon,x,y,acc,alt,spd,hdg}] | |
| `ftthObjects` | id | projectId, kind, code, name, status, props{}, cad{entityIds,handle,x,y}, parentId, mode(design/asbuilt) | OLT…Joint, Customer, Building |
| `cables` | id | projectId, code, category(feeder/distribution/drop/duct/conduit), fiberCount, fromId, toId, entityId, lengthMode(auto/manual), length, slack, status | |
| `cores` | [cableId+index] | color, tube, status(used/spare/reserved/damaged/available), assignment{kind,id}, notes | TIA-598 colours |
| `splitters` | id | projectId, code, ratio(2..64), parentId(device), inputCable/core, outputs[{port, cableId, core, customerId}], status | |
| `splices` | id | projectId, closureId, a{cableId,core}, b{cableId,core}, loss | core-level continuity |
| `photos` | id | projectId, objectId?, noteId?, surveyId?, blob, thumb, lat, lon, x, y, takenAt, userId | |
| `media` | id | as photos for video/audio | |
| `notes` | id | projectId, objectId?, x, y, lat, lon, title, text, issue, status, userId, createdAt | |
| `surveys` | id | projectId, name, startedAt, endedAt, userId | |
| `surveyItems` | id | surveyId, kind(point/photo/note/object/damage/inspection/installation), x,y,lat,lon,payload | |
| `faults` | id | projectId, objectId, customerId?, severity, description, status, openedAt, closedAt, traceResult | |
| `maintenance` | id | projectId, objectId, action(inspect/repair/replace), technician, date, notes, photoIds, faultId? | history |
| `reports` | id | projectId, kind, createdAt, fileId | generated outputs |
| `auditLog` | ++seq | at, userId, projectId, action, target, details | append-only |
| `syncOutbox` | ++seq | table, rowId, op, hlc, payload | pending uploads |
| `settings` | key | value | app prefs |

## 3. Separation of topology and geometry

```
ftthObjects.cad.entityIds ──► Drawing.entities[id]   (block insert, circle, ...)
cables.entityId           ──► Drawing.entities[id]   (polyline route)
cores, splitters, splices      (pure topology — no geometry)
```
* Deleting/redrawing geometry never deletes topology: links become *orphaned* and are flagged.
* Cable length (`lengthMode=auto`) = polyline length × unit factor (calibration scale when
  available) + slack; recomputed whenever the linked entity changes.

## 4. Versioning

```
Original (immutable file) → V1 (import snapshot) → V2 … → As-Built
```
A version stores the drawing snapshot + an FTTH snapshot (all FTTH tables for the project),
author, date, change summary (counts of added/modified/deleted entities) and parent version.
Restore creates a *new* version (non-destructive history).
