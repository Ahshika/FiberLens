import { Tool, type ToolEvent } from './types';
import type { Camera } from '../render/camera';
import type { Vec2 } from '../model/types';
import { moveGrip } from '../edit/transform';
import { boxContains, boxIntersects, type BBox } from '../geom/bbox';
import { segSegIntersect } from '../geom/intersect';

/** Default tool: pick, window/crossing selection, grip editing. */
export class SelectTool extends Tool {
  readonly id = 'select';
  readonly label = 'Select';
  private box: { a: ToolEvent; b: ToolEvent } | null = null;
  private hotGrip: { p: Vec2; id: number } | null = null;
  private dragGrip: { p: Vec2; id: number } | null = null;
  /** called when the user taps an entity (UI shows info card) */
  static onPick: ((id: number | null) => void) | null = null;

  reset() { this.box = null; this.hotGrip = null; this.dragGrip = null; this.basePoint = null; }
  protected onActivate() { this.setPrompt('Tap to select · drag (mouse) or long-press (touch) for window · grips to edit'); }

  private gripAt(e: ToolEvent): { p: Vec2; id: number } | null {
    const tol = this.host.pickTol(e.pointerType === 'touch' ? 18 : 8);
    for (const g of this.host.selection.grips()) {
      if (Math.abs(g.p.x - e.raw.x) <= tol && Math.abs(g.p.y - e.raw.y) <= tol) return { p: g.p, id: g.id };
    }
    return null;
  }

  down(e: ToolEvent) {
    if (e.button !== 0) return;
    const g = this.gripAt(e);
    if (g) { this.dragGrip = g; this.basePoint = g.p; }
  }

  move(e: ToolEvent) {
    super.move(e);
    if (!this.hotGrip && e.pointerType === 'mouse' && !this.box) {
      const doc = this.host.doc;
      const id = doc.pick(e.raw, this.host.pickTol(6));
      this.host.selection.setHover(id);
    }
  }

  click(e: ToolEvent) {
    const sel = this.host.selection;
    const doc = this.host.doc;
    if (this.hotGrip) {
      this.applyGrip(this.hotGrip, e.p);
      this.hotGrip = null; this.basePoint = null;
      return;
    }
    const g = this.dragGrip ?? this.gripAt(e);
    this.dragGrip = null;
    if (g) {
      this.hotGrip = g; this.basePoint = g.p;
      this.setPrompt('Grip: pick new location (Esc to cancel)');
      return;
    }
    const id = doc.pick(e.raw, this.host.pickTol(e.pointerType === 'touch' ? 14 : 6));
    if (id === null) {
      if (!e.shift && !e.ctrl) sel.clear();
      SelectTool.onPick?.(null);
      return;
    }
    const ent = doc.get(id)!;
    if (!doc.isEditable(ent)) this.host.notify(`Layer "${ent.layer}" is locked`, 'info');
    if (e.shift) sel.toggle(id);
    else if (e.ctrl) sel.add([id]);
    else sel.set([id]);
    SelectTool.onPick?.(id);
  }

  drag(e: ToolEvent, start: ToolEvent) {
    if (this.dragGrip) { this.cursor = e.p; return; }
    this.box = { a: start, b: e };
  }

  dragEnd(e: ToolEvent, start: ToolEvent) {
    if (this.dragGrip) {
      this.applyGrip(this.dragGrip, e.p);
      this.dragGrip = null; this.basePoint = null;
      return;
    }
    this.box = null;
    const crossing = e.sx < start.sx;
    const b: BBox = {
      minX: Math.min(start.raw.x, e.raw.x), maxX: Math.max(start.raw.x, e.raw.x),
      minY: Math.min(start.raw.y, e.raw.y), maxY: Math.max(start.raw.y, e.raw.y),
    };
    const ids = this.selectBox(b, crossing);
    const sel = this.host.selection;
    if (e.shift) sel.remove(ids);
    else if (e.ctrl || sel.size) sel.add(ids);
    else sel.set(ids);
    this.host.notify(`${ids.length} selected (${crossing ? 'crossing' : 'window'})`);
  }

  selectBox(b: BBox, crossing: boolean): number[] {
    const doc = this.host.doc;
    const out: number[] = [];
    for (const id of doc.search(b)) {
      const e = doc.get(id);
      if (!e || !doc.isVisible(e)) continue;
      const eb = doc.box(id)!;
      if (boxContains(b, eb)) { out.push(id); continue; }
      if (crossing && boxIntersects(b, eb) && this.geomCrosses(id, b)) out.push(id);
    }
    return out;
  }

  private geomCrosses(id: number, b: BBox): boolean {
    const g = this.host.doc.geometry(id);
    if (!g) return false;
    const inside = (x: number, y: number) => x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
    const edges: [Vec2, Vec2][] = [
      [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }], [{ x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }],
      [{ x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }], [{ x: b.minX, y: b.maxY }, { x: b.minX, y: b.minY }],
    ];
    const test = (a: number[], closed: boolean) => {
      for (let i = 0; i < a.length; i += 2) if (inside(a[i], a[i + 1])) return true;
      const n = a.length / 2;
      for (let k = 0; k < (closed ? n : n - 1); k++) {
        const i = k * 2, j = ((k + 1) % n) * 2;
        const p = { x: a[i], y: a[i + 1] }, q = { x: a[j], y: a[j + 1] };
        for (const [u, v] of edges) if (segSegIntersect(p, q, u, v)) return true;
      }
      return false;
    };
    for (const p of g.paths) if (test(p.pts, p.closed)) return true;
    for (const f of g.fills) for (const l of f) if (test(l, true)) return true;
    for (const t of g.texts) if (inside(t.x, t.y)) return true;
    return false;
  }

  private applyGrip(g: { p: Vec2; id: number }, to: Vec2) {
    const doc = this.host.doc;
    const e = doc.get(g.id);
    if (!e) return;
    if (!doc.isEditable(e)) { this.host.notify('Layer is locked', 'error'); return; }
    const tol = Math.max(1e-9, this.host.pickTol(1) * 0.01);
    // move this grip on every selected entity that shares it (AutoCAD behaviour)
    const changed = [];
    for (const id of this.host.selection.list) {
      const s = doc.get(id);
      if (!s || !doc.isEditable(s)) continue;
      const before = JSON.stringify(s);
      const m = moveGrip(s, g.p, to, tol);
      if (JSON.stringify(m) !== before && (id === g.id || this.sharesPoint(s, g.p, tol))) changed.push(m);
    }
    if (!changed.length) changed.push(moveGrip(e, g.p, to, tol));
    doc.modify(changed, 'Grip edit');
    this.setPrompt('Grip edited');
  }

  private sharesPoint(e: any, p: Vec2, tol: number): boolean {
    const pts: Vec2[] = [];
    if (e.p1) pts.push(e.p1, e.p2);
    if (e.pts) for (let i = 0; i < e.pts.length; i += 2) pts.push({ x: e.pts[i], y: e.pts[i + 1] });
    return pts.some((q) => Math.abs(q.x - p.x) <= tol && Math.abs(q.y - p.y) <= tol);
  }

  escape() {
    if (this.hotGrip) { this.hotGrip = null; this.basePoint = null; this.setPrompt('Grip cancelled'); return; }
    this.host.selection.clear();
    SelectTool.onPick?.(null);
  }
  enter() { /* nothing */ }

  overlay(ctx: CanvasRenderingContext2D, cam: Camera) {
    if (this.box) {
      const { a, b } = this.box;
      const crossing = b.sx < a.sx;
      ctx.save();
      ctx.fillStyle = crossing ? 'rgba(40,200,90,0.12)' : 'rgba(40,120,255,0.12)';
      ctx.strokeStyle = crossing ? '#28c85a' : '#2878ff';
      ctx.lineWidth = 1.2;
      if (crossing) ctx.setLineDash([6, 4]);
      const x = Math.min(a.sx, b.sx), y = Math.min(a.sy, b.sy), w = Math.abs(a.sx - b.sx), h = Math.abs(a.sy - b.sy);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    }
    const g = this.dragGrip ?? this.hotGrip;
    if (g && this.cursor) {
      const p0 = cam.worldToScreen(g.p.x, g.p.y), p1 = cam.worldToScreen(this.cursor.x, this.cursor.y);
      ctx.save();
      ctx.strokeStyle = '#ff5050'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
      ctx.fillStyle = '#ff3030';
      ctx.fillRect(p0.x - 5, p0.y - 5, 10, 10);
      ctx.restore();
    }
  }
}
