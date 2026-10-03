import { Tool, type ToolEvent, type ToolOption, parsePointInput } from '../cad/tools/types';
import { extraTools } from '../cad/tools/registry';
import type { Camera } from '../cad/render/camera';
import type { Vec2, Entity, PolylineEnt } from '../cad/model/types';
import type { FtthKind, CableCategory } from '../data/db';
import { saveObject, saveCable, nearestObjects, useFtth } from './store';
import { KINDS, kindMeta, CABLE_CATEGORIES, FIBER_COUNTS } from './model';
import { drawRubber, drawLabel } from '../cad/tools/preview';
import { ask } from '../app/dialogs';
import { useApp } from '../app/store';
import { polylineLength } from '../cad/edit/measure';

function nextCode(kind: FtthKind): string {
  const prefix = kindMeta(kind).prefix;
  let max = 0;
  for (const o of useFtth.getState().objects.values()) {
    if (o.kind !== kind) continue;
    const m = new RegExp(`^${prefix}[-_ ]?(\\d+)`, 'i').exec(o.code);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

function nextCableCode(category: CableCategory): string {
  const prefix = category === 'drop' ? 'DR' : category === 'duct' || category === 'conduit' ? 'D' : 'F';
  let max = 0;
  for (const c of useFtth.getState().cables.values()) { const m = new RegExp(`^${prefix}-(\\d+)`).exec(c.code); if (m) max = Math.max(max, +m[1]); }
  return `${prefix}-${String(max + 1).padStart(4, '0')}`;
}

/** Place a smart FTTH object (tap on an existing block to link it, or anywhere to create a marker). */
export class PlaceObjectTool extends Tool {
  readonly id = 'ftth-place'; readonly label = 'Place FTTH object';
  static kind: FtthKind = 'FAT';
  options(): ToolOption[] { return [{ key: 'kind', label: 'Type', type: 'select', value: PlaceObjectTool.kind, choices: KINDS.map((k) => ({ value: k.kind, label: k.label })) }]; }
  setOption(k: string, v: any) { if (k === 'kind') { PlaceObjectTool.kind = v; this.setPrompt(this.msg()); } }
  msg() { return `Tap to place a ${PlaceObjectTool.kind} (tap an existing block to link it)`; }
  protected onActivate() { this.setPrompt(this.msg()); }
  async click(e: ToolEvent) {
    const doc = this.host.doc;
    const kind = PlaceObjectTool.kind;
    const id = doc.pick(e.raw, this.host.pickTol(e.pointerType === 'touch' ? 14 : 6), (en) => en.type === 'insert' || en.type === 'circle' || en.type === 'point');
    let ent = id !== null ? doc.get(id)! : null;
    const attrsCode = ent?.type === 'insert' ? ent.attribs?.find((a) => /NAME|ID|CODE/i.test(a.tag))?.value : undefined;
    const r = await ask(`New ${kind}`, [
      { key: 'code', label: 'ID / code', value: attrsCode || nextCode(kind) },
      { key: 'name', label: 'Name / address (optional)' },
      { key: 'status', label: 'Status', type: 'select', value: useApp.getState().mode === 'asbuilt' ? 'installed' : 'planned', options: ['planned', 'installed', 'in-service', 'pending', 'faulty'].map((s) => ({ value: s, label: s })) },
    ], { okLabel: 'Create' });
    if (!r) return;
    let p = e.p;
    if (!ent) {
      // create a CAD point marker so the object exists in the DWG too
      const layer = `FTTH-${kind}`;
      if (!doc.layer(layer)) doc.setLayers([...doc.drawing.layers, { name: layer, aci: 3, lineType: 'Continuous', lineWeight: -3, transparency: 0, on: true, frozen: false, locked: false, plot: true }], 'FTTH layer');
      const pt: Entity = { id: doc.newId(), type: 'circle', layer, aci: 256, c: p, r: 0.6 * ((window as any).fiberlens?.unitsPerMeter?.() ?? 1) } as Entity;
      const tx: Entity = { id: doc.newId(), type: 'text', layer, aci: 256, p: { x: p.x + 1, y: p.y + 1 }, h: 1.2, rot: 0, value: r.code } as Entity;
      doc.add([pt, tx], `Place ${kind}`);
      ent = pt;
    } else if ('p' in ent) p = (ent as any).p;
    try {
      await saveObject({ kind, code: r.code, name: r.name || undefined, status: r.status, props: {}, cad: { entityId: ent.id, handle: ent.handle, x: p.x, y: p.y } });
      this.host.notify(`${kind} ${r.code} created`, 'success');
    } catch (err) { this.host.notify((err as Error).message, 'error'); }
  }
}

/** Draw a smart fibre cable: a polyline whose ends snap to FTTH objects; length is computed automatically. */
export class DrawCableTool extends Tool {
  readonly id = 'ftth-cable'; readonly label = 'Draw cable';
  static category: CableCategory = 'distribution';
  static fibers = 48;
  pts: Vec2[] = [];
  options(): ToolOption[] {
    return [
      { key: 'cat', label: 'Type', type: 'select', value: DrawCableTool.category, choices: CABLE_CATEGORIES.map((c) => ({ value: c.id, label: c.label })) },
      { key: 'f', label: 'Fibres', type: 'select', value: DrawCableTool.fibers, choices: FIBER_COUNTS.map((n) => ({ value: n, label: `${n}F` })) },
    ];
  }
  setOption(k: string, v: any) { if (k === 'cat') DrawCableTool.category = v; if (k === 'f') DrawCableTool.fibers = +v; }
  protected onActivate() { this.setPrompt('Tap the start object (or point), then the route; Enter to finish'); }
  reset() { this.pts = []; this.basePoint = null; }
  click(e: ToolEvent) { this.add(this.snapToObject(e.p)); }
  input(t: string) { const p = parsePointInput(t, this.basePoint, this.cursor); if (!p) return false; this.add(p); return true; }
  snapToObject(p: Vec2): Vec2 {
    const tol = this.host.pickTol(18);
    const n = nearestObjects(p, 1)[0];
    return n && n.d <= tol ? { x: n.o.cad.x, y: n.o.cad.y } : p;
  }
  add(p: Vec2) { this.pts.push(p); this.basePoint = p; this.setPrompt(`${this.pts.length} points · Enter to finish`); this.host.view.invalidateOverlay(); }
  async enter() {
    if (this.pts.length < 2) { this.host.finish(); return; }
    const pts = this.pts.slice();
    this.reset();
    const doc = this.host.doc;
    const cat = DrawCableTool.category, fibers = cat === 'duct' || cat === 'conduit' ? 0 : DrawCableTool.fibers;
    const layer = cat === 'duct' || cat === 'conduit' ? 'FTTH-DUCT' : `FTTH-${cat.toUpperCase()}-${fibers}F`;
    const color = CABLE_CATEGORIES.find((c) => c.id === cat)!.color;
    if (!doc.layer(layer)) doc.setLayers([...doc.drawing.layers, { name: layer, aci: 7, rgb: parseInt(color.slice(1), 16), lineType: cat === 'duct' ? 'DASHED' : 'Continuous', lineWeight: 30, transparency: 0, on: true, frozen: false, locked: false, plot: true }], 'Cable layer');
    const pl: PolylineEnt = { id: doc.newId(), type: 'polyline', layer, aci: 256, pts: pts.flatMap((p) => [p.x, p.y]), closed: false } as PolylineEnt;
    doc.add([pl], 'Draw cable');
    const tol = this.host.pickTol(18);
    const a = nearestObjects(pts[0], 1)[0], b = nearestObjects(pts[pts.length - 1], 1)[0];
    let from = a && a.d <= tol ? a.o : undefined, to = b && b.d <= tol ? b.o : undefined;
    if (from && to && kindMeta(to.kind).level < kindMeta(from.kind).level) [from, to] = [to, from];
    try {
      const c = await saveCable({ code: nextCableCode(cat), category: cat, fiberCount: fibers, cad: { entityId: pl.id }, fromId: from?.id, toId: to?.id, status: useApp.getState().mode === 'asbuilt' ? 'installed' : 'planned' });
      this.host.notify(`Cable ${c.code} · ${c.length.toFixed(1)} m${from ? ` · ${from.code}` : ''}${to ? ` → ${to.code}` : ''}`, 'success');
    } catch (err) { this.host.notify((err as Error).message, 'error'); }
    this.setPrompt('Draw the next cable, or Esc');
  }
  escape() { if (this.pts.length) this.reset(); else this.host.finish(); }
  overlay(ctx: CanvasRenderingContext2D, cam: Camera) {
    const pts = this.cursor ? [...this.pts, this.snapToObject(this.cursor)] : this.pts;
    drawRubber(ctx, cam, pts, false, CABLE_CATEGORIES.find((c) => c.id === DrawCableTool.category)!.color);
    if (pts.length >= 2) {
      const last = cam.worldToScreen(pts[pts.length - 1].x, pts[pts.length - 1].y);
      const upm = (window as any).fiberlens?.unitsPerMeter?.() ?? 1;
      drawLabel(ctx, last.x, last.y, `${(polylineLength(pts) / upm).toFixed(1)} m`);
    }
  }
}

/** Turn an existing CAD entity into a smart FTTH object or cable */
export class LinkEntityTool extends Tool {
  readonly id = 'ftth-link'; readonly label = 'Link CAD → FTTH';
  wantsSnap = false;
  protected onActivate() { this.setPrompt('Tap a block (→ object) or a polyline (→ cable/duct)'); }
  async click(e: ToolEvent) {
    const doc = this.host.doc;
    const id = doc.pick(e.raw, this.host.pickTol(e.pointerType === 'touch' ? 14 : 6));
    if (id === null) return;
    const ent = doc.get(id)!;
    this.host.selection.set([id]);
    if (ent.type === 'polyline' || ent.type === 'line' || ent.type === 'arc' || ent.type === 'spline') {
      const r = await ask('Create cable from this line', [
        { key: 'code', label: 'Cable ID', value: nextCableCode('distribution') },
        { key: 'cat', label: 'Type', type: 'select', value: 'distribution', options: CABLE_CATEGORIES.map((c) => ({ value: c.id, label: c.label })) },
        { key: 'f', label: 'Fibres', type: 'select', value: '48', options: FIBER_COUNTS.map((n) => ({ value: String(n), label: `${n}F` })) },
      ]);
      if (!r) return;
      await saveCable({ code: r.code, category: r.cat, fiberCount: r.cat === 'duct' ? 0 : +r.f, cad: { entityId: ent.id, handle: ent.handle } });
      this.host.notify(`Cable ${r.code} linked`, 'success');
      return;
    }
    const p = 'p' in ent ? (ent as any).p as Vec2 : ent.type === 'circle' ? ent.c : e.raw;
    const r = await ask('Create FTTH object', [
      { key: 'kind', label: 'Type', type: 'select', value: 'FAT', options: KINDS.map((k) => ({ value: k.kind, label: k.label })) },
      { key: 'code', label: 'ID / code', value: ent.type === 'insert' ? (ent.attribs?.[0]?.value ?? '') : '' },
    ]);
    if (!r) return;
    await saveObject({ kind: r.kind, code: r.code || nextCode(r.kind), status: 'installed', props: {}, cad: { entityId: ent.id, handle: ent.handle, x: p.x, y: p.y } });
    this.host.notify(`${r.kind} linked`, 'success');
  }
}

extraTools.push({ id: 'ftth-place', make: () => new PlaceObjectTool() }, { id: 'ftth-cable', make: () => new DrawCableTool() }, { id: 'ftth-link', make: () => new LinkEntityTool() });
