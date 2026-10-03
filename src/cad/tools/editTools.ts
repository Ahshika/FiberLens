import { Tool, type ToolEvent, type ToolOption, parsePointInput } from './types';
import type { Camera } from '../render/camera';
import type { Entity, Vec2, PolylineEnt } from '../model/types';
import { drawPreview, drawRubber, drawLabel } from './preview';
import { transformEntity, moveGrip } from '../edit/transform';
import { matTranslate, matRotate, matScale, matMirror, angleOf, dist, type Mat2D } from '../geom/vec';
import { trimEntity, extendEntity, offsetEntity, filletLines, filletPolyline, explodeEntity, joinEntities, breakEntity, toPolyline, reversePolyline, addVertex, removeVertex } from '../edit/ops';
import { boxContains, boxIntersects, type BBox } from '../geom/bbox';
import { SelectTool } from './SelectTool';
import { snapPointsOf } from './snap';

const PREVIEW_LIMIT = 300;

/** Base: optional object-selection phase, then tool-specific steps. */
abstract class ModifyTool extends Tool {
  selecting = true;
  private box: { a: ToolEvent; b: ToolEvent } | null = null;
  abstract stepPrompt(): string;
  /** whether this tool needs a selection phase */
  needsSelection = true;

  protected onActivate() {
    const sel = this.editableSelection();
    this.selecting = this.needsSelection && sel.length === 0;
    if (this.needsSelection && sel.length) this.host.selection.set(sel);
    this.updatePrompt();
  }
  updatePrompt() { this.setPrompt(this.selecting ? 'Select objects (tap / window), then Enter' : this.stepPrompt()); }

  editableSelection(): number[] {
    const doc = this.host.doc;
    return this.host.selection.list.filter((id) => { const e = doc.get(id); return e && doc.isEditable(e); });
  }
  get ents(): Entity[] { return this.editableSelection().map((id) => this.host.doc.get(id)!).filter(Boolean); }

  click(e: ToolEvent) {
    if (this.selecting) {
      const id = this.host.doc.pick(e.raw, this.host.pickTol(e.pointerType === 'touch' ? 14 : 6));
      if (id !== null) { this.host.selection.toggle(id); }
      return;
    }
    this.step(e);
  }
  abstract step(e: ToolEvent): void;

  drag(e: ToolEvent, start: ToolEvent) { if (this.selecting) this.box = { a: start, b: e }; }
  dragEnd(e: ToolEvent, start: ToolEvent) {
    if (!this.selecting) return;
    this.box = null;
    const b: BBox = { minX: Math.min(start.raw.x, e.raw.x), maxX: Math.max(start.raw.x, e.raw.x), minY: Math.min(start.raw.y, e.raw.y), maxY: Math.max(start.raw.y, e.raw.y) };
    const st = new SelectTool(); st.host = this.host;
    this.host.selection.add(st.selectBox(b, e.sx < start.sx));
  }

  enter() {
    if (this.selecting) {
      if (!this.editableSelection().length) { this.host.notify('Nothing selected (or all on locked layers)'); return; }
      this.selecting = false; this.updatePrompt(); return;
    }
    this.host.finish();
  }

  input(t: string): boolean {
    if (this.selecting) return false;
    const p = parsePointInput(t, this.basePoint, this.cursor);
    if (p) { this.step({ p, raw: p, sx: 0, sy: 0, snap: null, button: 0, shift: false, ctrl: false, alt: false, pointerType: 'mouse' }); return true; }
    return this.inputValue(t);
  }
  inputValue(_t: string) { return false; }

  previewTransform(ctx: CanvasRenderingContext2D, cam: Camera, m: Mat2D) {
    const ents = this.ents.slice(0, PREVIEW_LIMIT);
    for (const e of ents) {
      try { drawPreview(ctx, cam, transformEntity(e, m), '#7fd4ff'); } catch { /* ignore */ }
    }
  }

  overlay(ctx: CanvasRenderingContext2D, _cam: Camera) {
    if (this.box) {
      const { a, b } = this.box;
      const crossing = b.sx < a.sx;
      ctx.save();
      ctx.strokeStyle = crossing ? '#28c85a' : '#2878ff';
      ctx.fillStyle = crossing ? 'rgba(40,200,90,0.1)' : 'rgba(40,120,255,0.1)';
      if (crossing) ctx.setLineDash([6, 4]);
      ctx.fillRect(Math.min(a.sx, b.sx), Math.min(a.sy, b.sy), Math.abs(a.sx - b.sx), Math.abs(a.sy - b.sy));
      ctx.strokeRect(Math.min(a.sx, b.sx), Math.min(a.sy, b.sy), Math.abs(a.sx - b.sx), Math.abs(a.sy - b.sy));
      ctx.restore();
    }
  }

  apply(m: Mat2D, label: string, copy = false) {
    const doc = this.host.doc;
    const ents = this.ents;
    if (copy) {
      const out = ents.map((e) => { const t = transformEntity(structuredClone(e), m); return { ...t, id: doc.newId(), handle: undefined } as Entity; });
      doc.add(out, label);
      return out.map((e) => e.id);
    }
    doc.modify(ents.map((e) => transformEntity(e, m)), label);
    return ents.map((e) => e.id);
  }
}

export class MoveTool extends ModifyTool {
  readonly id: string = 'move'; readonly label: string = 'Move';
  copy = false;
  stepPrompt(): string { return this.basePoint ? 'Specify second point (or @dx,dy)' : 'Specify base point'; }
  reset() { this.basePoint = null; }
  step(e: ToolEvent) {
    if (!this.basePoint) { this.basePoint = e.p; this.updatePrompt(); return; }
    const m = matTranslate(e.p.x - this.basePoint.x, e.p.y - this.basePoint.y);
    this.apply(m, this.copy ? 'Copy' : 'Move', this.copy);
    if (this.copy) { this.updatePrompt(); return; } // keep copying from same base
    this.host.finish();
  }
  overlay(ctx: CanvasRenderingContext2D, cam: Camera) {
    super.overlay(ctx, cam);
    if (this.basePoint && this.cursor) {
      this.previewTransform(ctx, cam, matTranslate(this.cursor.x - this.basePoint.x, this.cursor.y - this.basePoint.y));
      drawRubber(ctx, cam, [this.basePoint, this.cursor]);
    }
  }
}
export class CopyTool extends MoveTool {
  readonly id = 'copy'; readonly label = 'Copy';
  copy = true;
  stepPrompt() { return this.basePoint ? 'Specify destination (repeat for multiple copies, Enter to finish)' : 'Specify base point'; }
}

export class RotateTool extends ModifyTool {
  readonly id = 'rotate'; readonly label = 'Rotate';
  copyMode = false;
  options(): ToolOption[] { return [{ key: 'copy', label: 'Copy', type: 'toggle', value: this.copyMode }]; }
  setOption(k: string, v: any) { if (k === 'copy') this.copyMode = !!v; }
  stepPrompt() { return this.basePoint ? 'Specify rotation angle (point or degrees)' : 'Specify base point'; }
  reset() { this.basePoint = null; }
  step(e: ToolEvent) {
    if (!this.basePoint) { this.basePoint = e.p; this.updatePrompt(); return; }
    this.apply(matRotate(angleOf(this.basePoint, e.p), this.basePoint), 'Rotate', this.copyMode);
    this.host.finish();
  }
  inputValue(t: string) {
    const a = parseFloat(t);
    if (!this.basePoint || !Number.isFinite(a)) return false;
    this.apply(matRotate((a * Math.PI) / 180, this.basePoint), 'Rotate', this.copyMode);
    this.host.finish();
    return true;
  }
  input(t: string) { return /^-?[\d.]+$/.test(t.trim()) && this.basePoint ? this.inputValue(t) : super.input(t); }
  overlay(ctx: CanvasRenderingContext2D, cam: Camera) {
    super.overlay(ctx, cam);
    if (this.basePoint && this.cursor) {
      const a = angleOf(this.basePoint, this.cursor);
      this.previewTransform(ctx, cam, matRotate(a, this.basePoint));
      drawRubber(ctx, cam, [this.basePoint, this.cursor]);
      const s = cam.worldToScreen(this.cursor.x, this.cursor.y);
      drawLabel(ctx, s.x, s.y, `${((a * 180) / Math.PI).toFixed(2)}°`);
    }
  }
}

export class ScaleTool extends ModifyTool {
  readonly id = 'scale'; readonly label = 'Scale';
  ref: number | null = null;
  copyMode = false;
  options(): ToolOption[] { return [{ key: 'copy', label: 'Copy', type: 'toggle', value: this.copyMode }]; }
  setOption(k: string, v: any) { if (k === 'copy') this.copyMode = !!v; }
  stepPrompt() { return !this.basePoint ? 'Specify base point' : this.ref === null ? 'Type scale factor, or pick reference length point' : 'Pick new length point'; }
  reset() { this.basePoint = null; this.ref = null; }
  step(e: ToolEvent) {
    if (!this.basePoint) { this.basePoint = e.p; this.updatePrompt(); return; }
    if (this.ref === null) { this.ref = dist(this.basePoint, e.p); this.updatePrompt(); return; }
    const f = dist(this.basePoint, e.p) / (this.ref || 1);
    if (f > 0) this.apply(matScale(f, f, this.basePoint), 'Scale', this.copyMode);
    this.host.finish();
  }
  input(t: string) {
    const f = parseFloat(t);
    if (this.basePoint && /^[\d.]+$/.test(t.trim()) && f > 0) { this.apply(matScale(f, f, this.basePoint), 'Scale', this.copyMode); this.host.finish(); return true; }
    return super.input(t);
  }
  overlay(ctx: CanvasRenderingContext2D, cam: Camera) {
    super.overlay(ctx, cam);
    if (this.basePoint && this.cursor && this.ref) {
      const f = dist(this.basePoint, this.cursor) / this.ref;
      this.previewTransform(ctx, cam, matScale(f, f, this.basePoint));
      const s = cam.worldToScreen(this.cursor.x, this.cursor.y);
      drawLabel(ctx, s.x, s.y, `× ${f.toFixed(4)}`);
    }
  }
}

export class MirrorTool extends ModifyTool {
  readonly id = 'mirror'; readonly label = 'Mirror';
  keep = true;
  options(): ToolOption[] { return [{ key: 'keep', label: 'Keep source', type: 'toggle', value: this.keep }]; }
  setOption(k: string, v: any) { if (k === 'keep') this.keep = !!v; }
  stepPrompt() { return this.basePoint ? 'Specify second point of mirror line' : 'Specify first point of mirror line'; }
  reset() { this.basePoint = null; }
  step(e: ToolEvent) {
    if (!this.basePoint) { this.basePoint = e.p; this.updatePrompt(); return; }
    if (dist(this.basePoint, e.p) < 1e-12) return;
    this.apply(matMirror(this.basePoint, e.p), 'Mirror', this.keep);
    this.host.finish();
  }
  overlay(ctx: CanvasRenderingContext2D, cam: Camera) {
    super.overlay(ctx, cam);
    if (this.basePoint && this.cursor && dist(this.basePoint, this.cursor) > 0) {
      this.previewTransform(ctx, cam, matMirror(this.basePoint, this.cursor));
      drawRubber(ctx, cam, [this.basePoint, this.cursor], false, '#ff9f40');
    }
  }
}

/** STRETCH: crossing window picks vertices; they move by a displacement. */
export class StretchTool extends Tool {
  readonly id = 'stretch'; readonly label = 'Stretch';
  private win: BBox | null = null;
  private box: { a: ToolEvent; b: ToolEvent } | null = null;
  private ids: number[] = [];
  protected onActivate() { this.setPrompt('Drag a crossing window around the vertices to stretch'); }
  reset() { this.win = null; this.box = null; this.ids = []; this.basePoint = null; }
  drag(e: ToolEvent, s: ToolEvent) { if (!this.win) this.box = { a: s, b: e }; }
  dragEnd(e: ToolEvent, s: ToolEvent) {
    if (this.win) return;
    this.box = null;
    this.win = { minX: Math.min(s.raw.x, e.raw.x), maxX: Math.max(s.raw.x, e.raw.x), minY: Math.min(s.raw.y, e.raw.y), maxY: Math.max(s.raw.y, e.raw.y) };
    const doc = this.host.doc;
    this.ids = doc.search(this.win).filter((id) => { const en = doc.get(id); return en && doc.isEditable(en) && doc.isVisible(en); });
    this.host.selection.set(this.ids);
    this.setPrompt(`${this.ids.length} objects · specify base point`);
  }
  click(e: ToolEvent) {
    if (!this.win) { this.setPrompt('Drag (mouse) or long-press-drag (touch) a window first'); return; }
    if (!this.basePoint) { this.basePoint = e.p; this.setPrompt('Specify second point'); return; }
    this.host.doc.modify(this.compute(e.p), 'Stretch');
    this.host.finish();
  }
  compute(to: Vec2): Entity[] {
    const doc = this.host.doc, win = this.win!;
    const dx = to.x - this.basePoint!.x, dy = to.y - this.basePoint!.y;
    const inside = (p: Vec2) => p.x >= win.minX && p.x <= win.maxX && p.y >= win.minY && p.y <= win.maxY;
    const out: Entity[] = [];
    for (const id of this.ids) {
      let e = doc.get(id)!;
      const b = doc.box(id)!;
      if (boxContains(win, b)) { out.push(transformEntity(e, matTranslate(dx, dy))); continue; }
      if (!boxIntersects(win, b)) continue;
      if (e.type === 'polyline' || e.type === 'line' || e.type === 'solid' || e.type === 'leader' || e.type === 'hatch') {
        const pts = snapPointsOf(e).filter((s) => s.kind === 'end' && inside(s.p)).map((s) => s.p);
        for (const p of pts) e = moveGrip(e, p, { x: p.x + dx, y: p.y + dy }, 1e-9);
        out.push(e);
      } else if ('p' in e && inside((e as any).p)) out.push(transformEntity(e, matTranslate(dx, dy)));
    }
    return out;
  }
  overlay(ctx: CanvasRenderingContext2D, cam: Camera) {
    if (this.box) {
      const { a, b } = this.box;
      ctx.save(); ctx.strokeStyle = '#28c85a'; ctx.setLineDash([6, 4]);
      ctx.strokeRect(Math.min(a.sx, b.sx), Math.min(a.sy, b.sy), Math.abs(a.sx - b.sx), Math.abs(a.sy - b.sy)); ctx.restore();
    }
    if (this.basePoint && this.cursor && this.win) {
      for (const e of this.compute(this.cursor).slice(0, PREVIEW_LIMIT)) drawPreview(ctx, cam, e, '#7fd4ff');
      drawRubber(ctx, cam, [this.basePoint, this.cursor]);
    }
  }
}

/** TRIM / EXTEND: select cutting/boundary edges (Enter = all), then pick objects. */
abstract class EdgeTool extends ModifyTool {
  edges: number[] | null = null;
  protected onActivate() {
    const sel = this.editableSelection();
    this.selecting = true;
    if (sel.length) { this.edges = sel; this.selecting = false; }
    this.updatePrompt();
  }
  updatePrompt() { this.setPrompt(this.selecting ? `Select ${this.id === 'trim' ? 'cutting' : 'boundary'} edges (Enter = use all visible objects)` : this.stepPrompt()); }
  enter() {
    if (this.selecting) {
      const sel = this.host.selection.list;
      this.edges = sel.length ? sel : null;
      this.selecting = false;
      this.host.selection.clear();
      this.updatePrompt();
      return;
    }
    this.host.finish();
  }
  boundaryEntities(near: Vec2, target: number): Entity[] {
    const doc = this.host.doc;
    if (this.edges) return this.edges.filter((id) => id !== target).map((id) => doc.get(id)!).filter(Boolean);
    // quick mode: every visible object around the target
    const b = doc.box(target)!;
    const pad = Math.max(b.maxX - b.minX, b.maxY - b.minY) * (this.id === 'extend' ? 4 : 0.05) + this.host.pickTol(20);
    void near;
    return doc.search({ minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad })
      .filter((id) => id !== target).map((id) => doc.get(id)!).filter((e) => e && doc.isVisible(e) && e.type !== 'text' && e.type !== 'mtext' && e.type !== 'insert').slice(0, 2000);
  }
  pickTarget(e: ToolEvent): Entity | null {
    const doc = this.host.doc;
    const id = doc.pick(e.raw, this.host.pickTol(e.pointerType === 'touch' ? 14 : 6), (en) => ['line', 'arc', 'circle', 'polyline', 'ellipse', 'spline'].includes(en.type));
    if (id === null) return null;
    const en = doc.get(id)!;
    if (!doc.isEditable(en)) { this.host.notify('Layer is locked', 'error'); return null; }
    return en;
  }
}

export class TrimTool extends EdgeTool {
  readonly id = 'trim'; readonly label = 'Trim';
  stepPrompt() { return 'Tap the part of an object to remove (Enter to finish)'; }
  step(e: ToolEvent) {
    const t = this.pickTarget(e);
    if (!t) return;
    const res = trimEntity(t, this.boundaryEntities(e.raw, t.id), e.raw);
    if (res === null) { this.host.notify('No intersection to trim at'); return; }
    this.replace(t, res, 'Trim');
  }
  replace(t: Entity, pieces: Entity[], label: string) { replaceWithPieces(this.host.doc, t, pieces, label); }
}

export class ExtendTool extends EdgeTool {
  readonly id = 'extend'; readonly label = 'Extend';
  stepPrompt() { return 'Tap near the end of an object to extend (Enter to finish)'; }
  step(e: ToolEvent) {
    const t = this.pickTarget(e);
    if (!t) return;
    const r = extendEntity(t, this.boundaryEntities(e.raw, t.id), e.raw);
    if (!r) { this.host.notify('No boundary found in that direction'); return; }
    this.host.doc.modify([r], 'Extend');
  }
}

export class OffsetTool extends Tool {
  readonly id = 'offset'; readonly label = 'Offset';
  distance = 1;
  private target: Entity | null = null;
  options(): ToolOption[] { return [{ key: 'd', label: 'Distance', type: 'number', value: this.distance }]; }
  setOption(k: string, v: any) { if (k === 'd') this.distance = Math.max(0, +v || 0); }
  protected onActivate() { this.setPrompt('Set distance, then tap the object to offset'); }
  reset() { this.target = null; }
  input(t: string) { const d = parseFloat(t); if (d > 0) { this.distance = d; this.host.refresh(); return true; } return false; }
  click(e: ToolEvent) {
    const doc = this.host.doc;
    if (!this.target) {
      const id = doc.pick(e.raw, this.host.pickTol(e.pointerType === 'touch' ? 14 : 6), (en) => ['line', 'arc', 'circle', 'polyline', 'ellipse', 'spline'].includes(en.type));
      if (id === null) return;
      this.target = doc.get(id)!;
      this.host.selection.set([id]);
      this.setPrompt('Tap the side to offset to');
      return;
    }
    const o = offsetEntity(this.target, this.distance, e.raw);
    if (o) doc.add([{ ...o, id: doc.newId(), handle: undefined } as Entity], 'Offset');
    else this.host.notify('Cannot offset by this distance', 'error');
    this.target = null;
    this.host.selection.clear();
    this.setPrompt('Tap the next object to offset (Enter to finish)');
  }
  overlay(ctx: CanvasRenderingContext2D, cam: Camera) {
    if (this.target && this.cursor) {
      const o = offsetEntity(this.target, this.distance, this.cursor);
      if (o) drawPreview(ctx, cam, o, '#7fd4ff');
    }
  }
}

export class FilletTool extends Tool {
  readonly id: string = 'fillet'; readonly label: string = 'Fillet';
  radius = 0;
  d1 = 1; d2 = 1;
  chamfer = false;
  private first: { e: Entity; p: Vec2 } | null = null;
  options(): ToolOption[] {
    return this.chamfer
      ? [{ key: 'd1', label: 'Dist 1', type: 'number', value: this.d1 }, { key: 'd2', label: 'Dist 2', type: 'number', value: this.d2 }]
      : [{ key: 'r', label: 'Radius', type: 'number', value: this.radius }, { key: 'poly', label: 'Whole polyline', type: 'action' }];
  }
  setOption(k: string, v: any) {
    if (k === 'r') this.radius = Math.max(0, +v || 0);
    if (k === 'd1') this.d1 = Math.max(0, +v || 0);
    if (k === 'd2') this.d2 = Math.max(0, +v || 0);
    if (k === 'poly') this.polyMode = true, this.setPrompt('Tap a polyline to fillet all its corners');
  }
  polyMode = false;
  protected onActivate() { this.setPrompt(`Tap the first line (${this.chamfer ? 'chamfer' : 'radius ' + this.radius})`); }
  reset() { this.first = null; this.polyMode = false; }
  click(e: ToolEvent) {
    const doc = this.host.doc;
    const id = doc.pick(e.raw, this.host.pickTol(e.pointerType === 'touch' ? 14 : 6), (en) => en.type === 'line' || en.type === 'polyline');
    if (id === null) return;
    const en = doc.get(id)!;
    if (!doc.isEditable(en)) { this.host.notify('Layer is locked', 'error'); return; }
    if (this.polyMode && en.type === 'polyline') {
      doc.modify([filletPolyline(en, this.radius)], 'Fillet polyline');
      this.polyMode = false;
      return;
    }
    if (!this.first) { this.first = { e: en, p: e.raw }; this.host.selection.set([id]); this.setPrompt('Tap the second line'); return; }
    if (this.first.e.id === id) { this.host.notify('Pick a different line'); return; }
    const r = filletLines(this.first.e, this.first.p, en, e.raw, this.radius, this.chamfer ? { d1: this.d1, d2: this.d2 } : undefined);
    if (!r) { this.host.notify('These objects cannot be filleted (parallel or not straight)', 'error'); }
    else {
      const added = r.extra ? [{ ...r.extra, id: doc.newId() } as Entity] : [];
      doc.commit({ label: this.label, added, removed: [], modified: [{ before: this.first.e, after: r.e1 }, { before: en, after: r.e2 }] });
    }
    this.first = null;
    this.host.selection.clear();
    this.setPrompt('Tap the first line (Enter to finish)');
  }
}
export class ChamferTool extends FilletTool {
  readonly id = 'chamfer'; readonly label = 'Chamfer';
  chamfer = true;
}

export class BreakTool extends Tool {
  readonly id = 'break'; readonly label = 'Break';
  atPoint = false;
  private target: Entity | null = null;
  private p1: Vec2 | null = null;
  options(): ToolOption[] { return [{ key: 'at', label: 'Break at point', type: 'toggle', value: this.atPoint }]; }
  setOption(k: string, v: any) { if (k === 'at') this.atPoint = !!v; }
  protected onActivate() { this.setPrompt('Tap the object at the first break point'); }
  reset() { this.target = null; this.p1 = null; }
  click(e: ToolEvent) {
    const doc = this.host.doc;
    if (!this.target) {
      const id = doc.pick(e.raw, this.host.pickTol(e.pointerType === 'touch' ? 14 : 6), (en) => ['line', 'arc', 'circle', 'polyline'].includes(en.type));
      if (id === null) return;
      this.target = doc.get(id)!;
      this.p1 = e.p;
      if (this.atPoint) return this.finishBreak(e.p);
      this.setPrompt('Specify second break point');
      return;
    }
    this.finishBreak(e.p);
  }
  private finishBreak(p2: Vec2) {
    const t = this.target!;
    const pieces = breakEntity(t, this.p1!, p2);
    if (pieces) replaceWithPieces(this.host.doc, t, pieces, 'Break');
    this.reset();
    this.setPrompt('Tap the next object to break (Enter to finish)');
  }
}

export class ExplodeTool extends ModifyTool {
  readonly id = 'explode'; readonly label = 'Explode';
  stepPrompt() { return ''; }
  protected onActivate() { super.onActivate(); if (!this.selecting) this.run(); }
  enter() { if (this.selecting) { super.enter(); if (!this.selecting) this.run(); } else this.host.finish(); }
  step() { /* none */ }
  run() {
    const doc = this.host.doc;
    const removed: Entity[] = [], added: Entity[] = [];
    for (const e of this.ents) {
      const parts = explodeEntity(e, doc.blocks);
      if (!parts) continue;
      removed.push(e);
      for (const p of parts) added.push({ ...p, id: doc.newId() } as Entity);
    }
    if (!removed.length) { this.host.notify('Nothing explodable selected'); this.host.finish(); return; }
    doc.commit({ label: 'Explode', added, removed, modified: [] });
    this.host.selection.set(added.map((e) => e.id));
    this.host.notify(`Exploded ${removed.length} → ${added.length} objects`, 'success');
    this.host.finish();
  }
}

export class JoinTool extends ModifyTool {
  readonly id = 'join'; readonly label = 'Join';
  stepPrompt() { return ''; }
  protected onActivate() { super.onActivate(); if (!this.selecting) this.run(); }
  enter() { if (this.selecting) { super.enter(); if (!this.selecting) this.run(); } else this.host.finish(); }
  step() { /* none */ }
  run() {
    const doc = this.host.doc;
    const r = joinEntities(this.ents, this.host.pickTol(0.5));
    if (!r) { this.host.notify('Select at least two lines/arcs/polylines touching end to end', 'error'); this.host.finish(); return; }
    const removed = r.used.map((id) => doc.get(id)!);
    const res = { ...r.result, id: doc.newId() } as Entity;
    doc.commit({ label: 'Join', added: [res], removed, modified: [] });
    this.host.selection.set([res.id]);
    this.host.notify(`Joined ${removed.length} objects${(res as PolylineEnt).closed ? ' (closed)' : ''}`, 'success');
    this.host.finish();
  }
}

export class PEditTool extends Tool {
  readonly id = 'pedit'; readonly label = 'Edit Polyline';
  private target: PolylineEnt | null = null;
  private mode: 'none' | 'add' | 'remove' = 'none';
  width = 0;
  protected onActivate() {
    const sel = this.host.selection.list.map((id) => this.host.doc.get(id)).find((e) => e && ['polyline', 'line', 'arc', 'circle'].includes(e.type));
    if (sel) this.take(sel);
    else this.setPrompt('Tap a polyline (lines/arcs are converted)');
  }
  reset() { this.target = null; this.mode = 'none'; }
  private take(e: Entity) {
    const doc = this.host.doc;
    let pl: PolylineEnt;
    if (e.type === 'polyline') pl = e;
    else {
      const conv = toPolyline(e);
      if (!conv) return;
      pl = { ...conv, id: doc.newId(), handle: undefined };
      doc.commit({ label: 'Convert to polyline', removed: [e], added: [pl], modified: [] });
    }
    this.target = pl;
    this.width = pl.width ?? 0;
    this.host.selection.set([pl.id]);
    this.setPrompt('Choose an option above; Add/Remove vertex then tap on the polyline');
    this.host.refresh();
  }
  options(): ToolOption[] {
    if (!this.target) return [];
    return [
      { key: 'close', label: this.target.closed ? 'Open' : 'Close', type: 'action' },
      { key: 'reverse', label: 'Reverse', type: 'action' },
      { key: 'add', label: 'Add vertex', type: 'action' },
      { key: 'remove', label: 'Remove vertex', type: 'action' },
      { key: 'straighten', label: 'Straighten arcs', type: 'action' },
      { key: 'width', label: 'Width', type: 'number', value: this.width },
    ];
  }
  setOption(k: string, v: any) {
    const doc = this.host.doc;
    const t = this.target && doc.get(this.target.id) as PolylineEnt;
    if (!t) return;
    if (k === 'close') doc.modify([{ ...t, closed: !t.closed }], t.closed ? 'Open polyline' : 'Close polyline');
    if (k === 'reverse') doc.modify([reversePolyline(t)], 'Reverse polyline');
    if (k === 'straighten') doc.modify([{ ...t, bulges: undefined }], 'Straighten polyline');
    if (k === 'width') { this.width = Math.max(0, +v || 0); doc.modify([{ ...t, width: this.width || undefined, widths: undefined }], 'Polyline width'); }
    if (k === 'add') { this.mode = 'add'; this.setPrompt('Tap where to add a vertex'); }
    if (k === 'remove') { this.mode = 'remove'; this.setPrompt('Tap the vertex to remove'); }
    this.target = doc.get(t.id) as PolylineEnt;
  }
  click(e: ToolEvent) {
    const doc = this.host.doc;
    if (!this.target) {
      const id = doc.pick(e.raw, this.host.pickTol(e.pointerType === 'touch' ? 14 : 6), (en) => ['polyline', 'line', 'arc', 'circle'].includes(en.type));
      if (id !== null) this.take(doc.get(id)!);
      return;
    }
    const t = doc.get(this.target.id) as PolylineEnt;
    if (this.mode === 'add') doc.modify([addVertex(t, e.p)], 'Add vertex');
    if (this.mode === 'remove') { const r = removeVertex(t, e.raw); if (r) doc.modify([r], 'Remove vertex'); }
    this.target = doc.get(t.id) as PolylineEnt;
  }
}

export class MatchPropsTool extends Tool {
  readonly id = 'match'; readonly label = 'Match Properties';
  private src: Entity | null = null;
  wantsSnap = false;
  protected onActivate() { this.setPrompt('Tap the source object'); }
  reset() { this.src = null; }
  click(e: ToolEvent) {
    const doc = this.host.doc;
    const id = doc.pick(e.raw, this.host.pickTol(e.pointerType === 'touch' ? 14 : 6));
    if (id === null) return;
    const en = doc.get(id)!;
    if (!this.src) { this.src = en; this.setPrompt('Tap destination objects (Enter to finish)'); return; }
    if (!doc.isEditable(en)) return;
    const s = this.src;
    doc.modify([{ ...en, layer: s.layer, aci: s.aci, rgb: s.rgb, lineType: s.lineType, ltScale: s.ltScale, lineWeight: s.lineWeight, transparency: s.transparency } as Entity], 'Match properties');
  }
}

const CLIP_KEY = 'fl.clipboard';
export class CopyClipTool extends ModifyTool {
  readonly id = 'copyclip'; readonly label = 'Copy to clipboard';
  stepPrompt() { return 'Specify base point'; }
  step(e: ToolEvent) {
    const ents = this.ents.map((x) => transformEntity(structuredClone(x), matTranslate(-e.p.x, -e.p.y)));
    try { localStorage.setItem(CLIP_KEY, JSON.stringify(ents)); } catch { (window as any).__flClip = ents; }
    (window as any).__flClip = ents;
    this.host.notify(`${ents.length} objects copied`, 'success');
    this.host.finish();
  }
}
export class PasteTool extends Tool {
  readonly id = 'paste'; readonly label = 'Paste';
  private ents: Entity[] = [];
  protected onActivate() {
    try { this.ents = JSON.parse(localStorage.getItem(CLIP_KEY) || '[]'); } catch { this.ents = (window as any).__flClip ?? []; }
    if (!this.ents.length) { this.host.notify('Clipboard is empty'); this.host.finish(); return; }
    this.setPrompt(`Specify insertion point (${this.ents.length} objects)`);
  }
  click(e: ToolEvent) {
    const doc = this.host.doc;
    const out = this.ents.map((x) => ({ ...transformEntity(structuredClone(x), matTranslate(e.p.x, e.p.y)), id: doc.newId(), handle: undefined }) as Entity);
    for (const o of out) if (!doc.layer(o.layer)) o.layer = '0';
    doc.add(out, 'Paste');
    this.host.selection.set(out.map((o) => o.id));
  }
  overlay(ctx: CanvasRenderingContext2D, cam: Camera) {
    if (!this.cursor) return;
    for (const x of this.ents.slice(0, PREVIEW_LIMIT)) drawPreview(ctx, cam, transformEntity(x, matTranslate(this.cursor.x, this.cursor.y)), '#7fd4ff');
  }
}

export class DeleteTool extends ModifyTool {
  readonly id = 'delete'; readonly label = 'Delete';
  stepPrompt() { return ''; }
  protected onActivate() { super.onActivate(); if (!this.selecting) this.run(); }
  enter() { if (this.selecting) { super.enter(); if (!this.selecting) this.run(); } else this.host.finish(); }
  step() { /* none */ }
  run() { const ids = this.editableSelection(); this.host.doc.remove(ids, `Delete ${ids.length}`); this.host.selection.clear(); this.host.finish(); }
}

/** replace an entity by trim/break pieces (first piece keeps id + handle when the type is unchanged) */
export function replaceWithPieces(doc: import('../doc/CadDoc').CadDoc, t: Entity, pieces: Entity[], label: string) {
  if (!pieces.length) { doc.remove([t.id], label); return; }
  const [first, ...rest] = pieces;
  const added = rest.map((p) => ({ ...p, id: doc.newId(), handle: undefined }) as Entity);
  if (first.type !== t.type) {
    doc.commit({ label, removed: [t], added: [{ ...first, id: doc.newId(), handle: undefined } as Entity, ...added], modified: [] });
  } else {
    doc.commit({ label, removed: [], added, modified: [{ before: t, after: { ...first, id: t.id, handle: t.handle } as Entity }] });
  }
}
