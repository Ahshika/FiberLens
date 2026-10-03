# UI / UX

## Layout

```
┌────────────────────────────────────────────────────────────────────┐
│ ☰ Project ▾ │ ● GPS 3D ±2.1m │ X 236512.31 Y 3462011.08 │ ↶ ↷ │ 👤 │  ← TopBar (48px)
├────────────────────────────────────────────────────────────────────┤
│                                                     ┌────────────┐ │
│                                                     │  Side panel │ │  ← tablet/landscape:
│                 CAD CANVAS (full bleed)             │  (Layers,   │ │    right side sheet
│                 📍 YOU ARE HERE                      │  Props, …)  │ │    phone/portrait:
│                                                     └────────────┘ │    bottom sheet
│  [mode chips: Snap Ortho Grid]          [GPS FAB ◎] [Fit ⤢]        │
├────────────────────────────────────────────────────────────────────┤
│ Layers Draw Edit Text FTTH Search Measure GPS Survey Notes Photos ⋯ │  ← Dock (56px, scrollable)
└────────────────────────────────────────────────────────────────────┘
```

* The canvas is always visible; panels never cover more than 40% (landscape) / 55% (portrait).
* Contextual **tool bar** appears above the dock for the active tool (e.g. Trim: "select cutting
  edges → Enter"). A command prompt line explains every step (CAD-style prompts).
* Touch: one-finger pan, pinch zoom, tap = pick, long-press = context menu / window select,
  two-finger tap = undo. Mouse: wheel zoom at cursor, middle-drag pan, left-drag window/crossing
  (left→right = window, right→left = crossing), keyboard shortcuts (Del, Ctrl+Z/Y, Esc, F8 ortho,
  F3 osnap, F7 grid).
* Snap markers use AutoCAD conventions (□ endpoint, △ midpoint, ○ center, ✕ intersection,
  ◇ quadrant, ⊥ perpendicular, ⧖ nearest).
* Dark CAD theme by default (black canvas, ACI 7 renders white), light theme available (ACI 7
  renders black — same as AutoCAD).
* Large touch targets (≥ 44 px), high contrast for outdoor sunlight readability.

## Screens & panels

| Dock item | Panel |
|-----------|-------|
| Layers | search, visibility/freeze/lock toggles, colour, linetype, lineweight, transparency, new/rename/delete, set current, isolate, zoom to layer |
| Draw | Line, Polyline, Arc, Circle, Rectangle, Triangle, Polygon, Ellipse, Cloud, Arrow, Freehand, Point, Hatch, Leader + style bar (colour picker, layer, linetype, width, transparency, fill) |
| Edit | Move, Copy, Paste, Delete, Rotate, Mirror, Scale, Stretch, Trim, Extend, Offset, Fillet, Chamfer, Explode, Join, Break, PEdit, Match props |
| Text | Text, MText, edit, font, size, bold/italic, alignment, colour, background mask |
| Properties | selection-aware property grid (multi-selection shows *varies*) |
| FTTH | object browser by type, smart object card, cables/cores table, splitters, trace, detection rules, QR |
| Search | global search (FTTH codes, text, attributes, layers) → zoom/flash |
| Measure | distance, polyline distance, area, angle, cable/duct length, object-to-object |
| GPS | source, status, lat/lon/alt/acc/speed/heading/sats, modes (Locate/Follow/North/Heading), tracking, calibration wizard |
| Survey | sessions, add point/photo/video/voice/note/object/damage/inspection |
| Notes / Photos | lists linked to location/object, filters |
| ⋯ More | Project, Versions, Reports & BOQ, Export, Maintenance, Users, Sync, Settings |

## Calibration wizard (9 steps)
1 Open drawing → 2 tap CAD point (with snap) → 3 capture GPS (averaged N fixes) or type lat/lon
→ 4 add control point → 5 repeat (≥2 Helmert, ≥3 affine) → 6 compute → 7 show residuals and RMS,
disable outliers → 8 save → 9 GPS enabled inside CAD.
